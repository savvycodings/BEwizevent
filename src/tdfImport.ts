import { db } from './db'
import {
  hintFromFileName,
  matchesForRound,
  parseTdfXml,
  type TdfFileHint,
  type TdfMatch,
} from './tdfParser'

export type TdfImportResult = {
  fileKind: TdfFileHint['kind']
  roundNumber: number | null
  tournamentName: string | null
  attendanceMarked: number
  pairingsImported: number
  resultsImported: number
  placementsSet: number
  unknownPopIds: string[]
  skippedMatches: number
}

async function resolvePopId(popId: string): Promise<number | null> {
  const r = await db.query<{ id: number }>(`SELECT id FROM users WHERE pop_id = $1 LIMIT 1`, [
    popId,
  ])
  return r.rows[0]?.id ?? null
}

function toStoredOutcome(
  p1: number,
  p2: number,
  tdfOutcome: number
): 'pending' | 'a_wins' | 'b_wins' | 'draw' {
  const low = Math.min(p1, p2)
  const high = Math.max(p1, p2)
  if (tdfOutcome === 0) return 'pending'
  if (tdfOutcome === 3) return 'draw'
  const p1Won = tdfOutcome === 1
  const p2Won = tdfOutcome === 2
  if (!p1Won && !p2Won) return 'pending'
  if (p1 === low) {
    if (p1Won) return 'a_wins'
    if (p2Won) return 'b_wins'
    return 'draw'
  }
  if (p2Won) return 'a_wins'
  if (p1Won) return 'b_wins'
  return 'draw'
}

async function markAttended(eventId: number, userIds: number[]): Promise<number> {
  let n = 0
  for (const userId of userIds) {
    const u = await db.query<{ activeDeckId: string | null }>(
      `SELECT active_deck_id AS "activeDeckId" FROM users WHERE id = $1`,
      [userId]
    )
    const deckId = u.rows[0]?.activeDeckId ?? null
    await db.query(
      `
        INSERT INTO event_attendance (user_id, event_id, attended, deck_id)
        VALUES ($1, $2, TRUE, $3)
        ON CONFLICT (user_id, event_id) DO UPDATE SET
          attended = TRUE,
          deck_id = CASE
            WHEN event_attendance.deck_id IS NULL THEN EXCLUDED.deck_id
            ELSE event_attendance.deck_id
          END,
          updated_at = NOW()
      `,
      [userId, eventId, deckId]
    )
    n += 1
  }
  return n
}

async function upsertMatch(
  eventId: number,
  roundNumber: number,
  playerAId: number,
  playerBId: number,
  outcome: 'pending' | 'a_wins' | 'b_wins' | 'draw'
): Promise<void> {
  await db.query(
    `
      INSERT INTO event_matches (event_id, round_number, player_a_id, player_b_id, outcome)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (event_id, round_number, player_a_id, player_b_id)
      DO UPDATE SET outcome = EXCLUDED.outcome, updated_at = NOW()
    `,
    [eventId, roundNumber, playerAId, playerBId, outcome]
  )
}

async function importMatches(
  eventId: number,
  matches: TdfMatch[],
  mode: 'pairings' | 'results'
): Promise<{ imported: number; unknownPopIds: Set<string>; skipped: number }> {
  const unknownPopIds = new Set<string>()
  let imported = 0
  let skipped = 0

  for (const m of matches) {
    if (mode === 'pairings' && m.outcome !== 0) continue
    if (mode === 'results' && m.outcome === 0) continue

    const id1 = await resolvePopId(m.player1PopId)
    const id2 = await resolvePopId(m.player2PopId)
    if (!id1) unknownPopIds.add(m.player1PopId)
    if (!id2) unknownPopIds.add(m.player2PopId)
    if (!id1 || !id2 || id1 === id2) {
      skipped += 1
      continue
    }

    const low = Math.min(id1, id2)
    const high = Math.max(id1, id2)
    const outcome = toStoredOutcome(id1, id2, m.outcome)
    if (mode === 'pairings' && outcome !== 'pending') continue

    await upsertMatch(eventId, m.roundNumber, low, high, outcome)
    await markAttended(eventId, [id1, id2])
    imported += 1
  }

  return { imported, unknownPopIds, skipped }
}

export async function importTdfForEvent(
  eventId: number,
  xml: string,
  fileName: string
): Promise<TdfImportResult> {
  const hint = hintFromFileName(fileName)
  const parsed = parseTdfXml(xml)
  const unknownPopIds = new Set<string>()
  let attendanceMarked = 0
  let pairingsImported = 0
  let resultsImported = 0
  let placementsSet = 0
  let skippedMatches = 0

  const eventCheck = await db.query(`SELECT id FROM events WHERE id = $1`, [eventId])
  if (!eventCheck.rows[0]) {
    throw new Error('Event not found')
  }

  if (hint.kind === 'start') {
    const ids: number[] = []
    for (const p of parsed.players) {
      const id = await resolvePopId(p.popId)
      if (id) ids.push(id)
      else unknownPopIds.add(p.popId)
    }
    attendanceMarked = await markAttended(eventId, ids)
    await db.query(`UPDATE events SET use_match_tracking = TRUE WHERE id = $1`, [eventId])
    const maxRound = parsed.matches.reduce((mx, m) => Math.max(mx, m.roundNumber), 0)
    if (maxRound > 0) {
      await db.query(
        `
          UPDATE events
          SET scheduled_rounds = GREATEST(COALESCE(scheduled_rounds, 0), $2)
          WHERE id = $1
        `,
        [eventId, maxRound]
      )
    }
  } else if (hint.kind === 'begin' && hint.roundNumber) {
    const roundMatches = matchesForRound(parsed, hint.roundNumber)
    const res = await importMatches(eventId, roundMatches, 'pairings')
    pairingsImported = res.imported
    skippedMatches = res.skipped
    res.unknownPopIds.forEach((id) => unknownPopIds.add(id))
    await db.query(`UPDATE events SET use_match_tracking = TRUE WHERE id = $1`, [eventId])
    await db.query(
      `
        UPDATE events
        SET scheduled_rounds = GREATEST(COALESCE(scheduled_rounds, 0), $2)
        WHERE id = $1
      `,
      [eventId, hint.roundNumber]
    )
  } else if (hint.kind === 'end' && hint.roundNumber) {
    const roundMatches = matchesForRound(parsed, hint.roundNumber)
    const res = await importMatches(eventId, roundMatches, 'results')
    resultsImported = res.imported
    skippedMatches = res.skipped
    res.unknownPopIds.forEach((id) => unknownPopIds.add(id))
  } else if (hint.kind === 'final') {
    const pairRes = await importMatches(
      eventId,
      parsed.matches.filter((m) => m.outcome === 0),
      'pairings'
    )
    const resultRes = await importMatches(
      eventId,
      parsed.matches.filter((m) => m.outcome !== 0),
      'results'
    )
    pairingsImported = pairRes.imported
    resultsImported = resultRes.imported
    skippedMatches = pairRes.skipped + resultRes.skipped
    ;[...pairRes.unknownPopIds, ...resultRes.unknownPopIds].forEach((id) =>
      unknownPopIds.add(id)
    )

    const maxRound = parsed.matches.reduce((mx, m) => Math.max(mx, m.roundNumber), 0)
    if (maxRound > 0) {
      await db.query(
        `
          UPDATE events
          SET scheduled_rounds = GREATEST(COALESCE(scheduled_rounds, 0), $2),
              use_match_tracking = TRUE
          WHERE id = $1
        `,
        [eventId, maxRound]
      )
    }

    for (const s of parsed.standings) {
      const userId = await resolvePopId(s.popId)
      if (!userId) {
        unknownPopIds.add(s.popId)
        continue
      }
      await db.query(
        `
          INSERT INTO event_attendance (user_id, event_id, attended, placement)
          VALUES ($1, $2, TRUE, $3)
          ON CONFLICT (user_id, event_id) DO UPDATE SET
            attended = TRUE,
            placement = EXCLUDED.placement,
            updated_at = NOW()
        `,
        [userId, eventId, s.place]
      )
      placementsSet += 1
    }
  }

  return {
    fileKind: hint.kind,
    roundNumber: hint.roundNumber ?? null,
    tournamentName: parsed.tournamentName,
    attendanceMarked,
    pairingsImported,
    resultsImported,
    placementsSet,
    unknownPopIds: [...unknownPopIds].sort(),
    skippedMatches,
  }
}
