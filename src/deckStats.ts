import { db } from './db'
import { DECK_CATALOG, deckLabel, isValidDeckId } from './deckCatalog'
import { logDeckBackfill } from './deckLog'

export type DeckStatRow = {
  deckId: string
  label: string
  events: number
  wins: number
}

export type DeckProfilePayload = {
  activeDeckId: string | null
  activeDeckLabel: string | null
  catalog: { id: string; label: string }[]
  stats: DeckStatRow[]
}

export async function getDeckProfile(userId: number): Promise<DeckProfilePayload> {
  const userRes = await db.query(
    `SELECT active_deck_id AS "activeDeckId" FROM users WHERE id = $1`,
    [userId]
  )
  const activeDeckId = (userRes.rows[0]?.activeDeckId as string | null) ?? null

  const rows = await db.query<{
    deck_id: string
    events: string
    wins: string
  }>(
    `
      WITH deck_events AS (
        SELECT event_id, deck_id
        FROM event_attendance
        WHERE user_id = $1
          AND attended = TRUE
          AND deck_id IS NOT NULL
      ),
      match_wins_by_deck AS (
        SELECT
          de.deck_id,
          COUNT(*)::int AS match_wins
        FROM deck_events de
        INNER JOIN event_matches m ON m.event_id = de.event_id
        WHERE (m.player_a_id = $1 AND m.outcome = 'a_wins')
           OR (m.player_b_id = $1 AND m.outcome = 'b_wins')
        GROUP BY de.deck_id
      )
      SELECT
        de.deck_id,
        COUNT(DISTINCT de.event_id)::int AS events,
        (
          COALESCE(mw.match_wins, 0)
          + COUNT(*) FILTER (WHERE ea.placement = 1)
        )::int AS wins
      FROM deck_events de
      INNER JOIN event_attendance ea
        ON ea.user_id = $1
        AND ea.event_id = de.event_id
        AND ea.deck_id = de.deck_id
      LEFT JOIN match_wins_by_deck mw ON mw.deck_id = de.deck_id
      GROUP BY de.deck_id, mw.match_wins
      HAVING COUNT(DISTINCT de.event_id) > 0
      ORDER BY wins DESC, events DESC
    `,
    [userId]
  )

  const stats: DeckStatRow[] = rows.rows.map((r) => ({
    deckId: r.deck_id,
    label: deckLabel(r.deck_id),
    events: Number(r.events),
    wins: Number(r.wins),
  }))

  return {
    activeDeckId,
    activeDeckLabel: activeDeckId ? deckLabel(activeDeckId) : null,
    catalog: DECK_CATALOG.map((d) => ({ id: d.id, label: d.label })),
    stats,
  }
}

export type CommunityDeckMetaPayload = {
  stats: DeckStatRow[]
  totalEvents: number
}

/** All players — deck usage at events (for Home meta share). */
export async function getCommunityDeckMeta(): Promise<CommunityDeckMetaPayload> {
  const rows = await db.query<{
    deck_id: string
    events: string
    wins: string
  }>(
    `
      WITH deck_events AS (
        SELECT user_id, event_id, deck_id
        FROM event_attendance
        WHERE attended = TRUE
          AND deck_id IS NOT NULL
      ),
      match_wins_by_deck AS (
        SELECT
          de.deck_id,
          COUNT(*)::int AS match_wins
        FROM deck_events de
        INNER JOIN event_matches m ON m.event_id = de.event_id
        WHERE (m.player_a_id = de.user_id AND m.outcome = 'a_wins')
           OR (m.player_b_id = de.user_id AND m.outcome = 'b_wins')
        GROUP BY de.deck_id
      )
      SELECT
        de.deck_id,
        COUNT(*)::int AS events,
        COALESCE(mw.match_wins, 0)::int AS wins
      FROM deck_events de
      LEFT JOIN match_wins_by_deck mw ON mw.deck_id = de.deck_id
      GROUP BY de.deck_id, mw.match_wins
      ORDER BY events DESC, wins DESC
      LIMIT 12
    `
  )

  const stats: DeckStatRow[] = rows.rows.map((r) => ({
    deckId: r.deck_id,
    label: deckLabel(r.deck_id),
    events: Number(r.events),
    wins: Number(r.wins),
  }))

  const totalEvents = stats.reduce((s, r) => s + r.events, 0)
  return { stats, totalEvents }
}

/** Profile deck only — never updates event_attendance.deck_id (historical event decks). */
export async function setUserActiveDeck(userId: number, deckId: string | null): Promise<void> {
  if (deckId != null && !isValidDeckId(deckId)) {
    throw new Error('Invalid deck')
  }
  await db.query(`UPDATE users SET active_deck_id = $2 WHERE id = $1`, [userId, deckId])
}

export type AttendanceDeckSnapshot = {
  deckId: string | null
  placement: number | null
  attended: boolean
}

/** Current deck/placement on a player's event attendance row (if any). */
export async function getAttendanceDeckSnapshot(
  userId: number,
  eventId: number
): Promise<AttendanceDeckSnapshot> {
  const res = await db.query<{
    deckId: string | null
    placement: number | null
    attended: boolean
  }>(
    `
      SELECT deck_id AS "deckId", placement, attended
      FROM event_attendance
      WHERE user_id = $1 AND event_id = $2
    `,
    [userId, eventId]
  )
  const row = res.rows[0]
  return {
    deckId: row?.deckId ?? null,
    placement: row?.placement != null ? Number(row.placement) : null,
    attended: Boolean(row?.attended),
  }
}

/**
 * One-time snapshot: copy profile deck onto event attendance only when deck_id is still null.
 * Never overwrites a deck already recorded for that event (even if the user changes profile later).
 */
export async function ensureAttendanceDeckFromActive(
  userId: number,
  eventId: number
): Promise<string | null> {
  const res = await db.query<{ deckId: string | null }>(
    `
      UPDATE event_attendance ea
      SET deck_id = u.active_deck_id, updated_at = NOW()
      FROM users u
      WHERE ea.user_id = u.id
        AND ea.user_id = $1
        AND ea.event_id = $2
        AND ea.deck_id IS NULL
        AND u.active_deck_id IS NOT NULL
      RETURNING ea.deck_id AS "deckId"
    `,
    [userId, eventId]
  )
  const deckId = res.rows[0]?.deckId ?? null
  if (deckId) {
    logDeckBackfill({ userId, eventId, deckId, source: 'active_deck' })
  }
  return deckId
}

/** Snapshot profile deck onto event rows for each player (only while event deck_id is null). */
export async function ensureAttendanceDecksFromActive(
  eventId: number,
  userIds: number[]
): Promise<void> {
  const unique = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))]
  await Promise.all(unique.map((userId) => ensureAttendanceDeckFromActive(userId, eventId)))
}

export async function countUserMatchWins(userId: number): Promise<number> {
  const res = await db.query<{ c: string }>(
    `
      SELECT COUNT(*)::int AS c
      FROM event_matches m
      WHERE (m.player_a_id = $1 AND m.outcome = 'a_wins')
         OR (m.player_b_id = $1 AND m.outcome = 'b_wins')
    `,
    [userId]
  )
  return Number(res.rows[0]?.c ?? 0)
}

/** Admin override: set the deck recorded for this specific event (historical record). */
export async function setAttendanceDeck(
  userId: number,
  eventId: number,
  deckId: string | null
): Promise<void> {
  if (deckId != null && !isValidDeckId(deckId)) {
    throw new Error('Invalid deck')
  }
  await db.query(
    `
      INSERT INTO event_attendance (user_id, event_id, attended, deck_id)
      VALUES ($1, $2, TRUE, $3)
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET
        deck_id = EXCLUDED.deck_id,
        attended = TRUE,
        updated_at = NOW()
    `,
    [userId, eventId, deckId]
  )
}
