import { db } from './db'
import { getJudgedAwardBonusXp } from './judgedAwards'
import { deckLabel } from './deckCatalog'
import { getRankForXp, getXpForPlacement, type RankTier } from './ranking'
import { normalizeHomeStore, type HomeStore } from './stores'

export type SeasonXpBreakdown = {
  seasonXp: number
  challengeXp: number
  cupXp: number
}

export type SeasonLeaderboardRow = {
  id: number
  name: string
  rank: RankTier
  lifetimeXp: number
  seasonXp: number
  challengeXp: number
  cupXp: number
  homeStore: HomeStore | null
  activeDeckId: string | null
  activeDeckLabel: string
}

export type SeasonLeaderboardPayload = {
  seasonYear: number
  scope: 'combined' | HomeStore
  rows: SeasonLeaderboardRow[]
  challengeLeader: SeasonLeaderboardRow | null
  cupChampion: SeasonLeaderboardRow | null
}

export function currentSeasonYear(): number {
  return new Date().getFullYear()
}

export function seasonBoundsForYear(year: number): { start: Date; end: Date } {
  return {
    start: new Date(year, 0, 1, 0, 0, 0, 0),
    end: new Date(year, 11, 31, 23, 59, 59, 999),
  }
}

function eventInSeason(
  eventDate: string | Date | null,
  fallbackAt: string | Date,
  start: Date,
  end: Date
): boolean {
  let ts: number
  if (eventDate != null) {
    const raw = eventDate instanceof Date ? eventDate.toISOString() : String(eventDate)
    const d = new Date(raw.includes('T') ? raw : `${raw}T12:00:00`)
    ts = d.getTime()
  } else {
    const d = fallbackAt instanceof Date ? fallbackAt : new Date(fallbackAt)
    ts = d.getTime()
  }
  if (Number.isNaN(ts)) return false
  return ts >= start.getTime() && ts <= end.getTime()
}

function addXp(
  map: Map<number, SeasonXpBreakdown>,
  userId: number,
  xp: number,
  eventTier: string | null
) {
  const cur = map.get(userId) ?? { seasonXp: 0, challengeXp: 0, cupXp: 0 }
  cur.seasonXp += xp
  if (eventTier === 'challenge') cur.challengeXp += xp
  if (eventTier === 'cup') cur.cupXp += xp
  map.set(userId, cur)
}

export async function loadSeasonXpByUser(year?: number): Promise<Map<number, SeasonXpBreakdown>> {
  const seasonYear = year ?? currentSeasonYear()
  const { start, end } = seasonBoundsForYear(seasonYear)
  const map = new Map<number, SeasonXpBreakdown>()

  const placements = await db.query<{
    userId: number
    placement: number
    eventTier: string | null
    eventDate: string | Date | null
    updatedAt: string | Date
  }>(
    `
      SELECT
        a.user_id AS "userId",
        a.placement,
        e.event_tier AS "eventTier",
        e.event_date AS "eventDate",
        a.updated_at AS "updatedAt"
      FROM event_attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.placement IS NOT NULL
    `
  )

  for (const row of placements.rows) {
    if (!eventInSeason(row.eventDate, row.updatedAt, start, end)) continue
    const xp = getXpForPlacement(row.placement, row.eventTier)
    if (xp > 0) addXp(map, row.userId, xp, row.eventTier)
  }

  const judged = await db.query<{
    userId: number
    eventTier: string | null
    eventDate: string | Date | null
    awardedAt: string | Date
  }>(
    `
      SELECT
        j.winner_user_id AS "userId",
        e.event_tier AS "eventTier",
        e.event_date AS "eventDate",
        j.awarded_at AS "awardedAt"
      FROM event_judged_awards j
      JOIN events e ON e.id = j.event_id
    `
  )

  for (const row of judged.rows) {
    if (!eventInSeason(row.eventDate, row.awardedAt, start, end)) continue
    const xp = getJudgedAwardBonusXp(row.eventTier)
    if (xp > 0) addXp(map, row.userId, xp, row.eventTier)
  }

  return map
}

export async function buildSeasonLeaderboard(
  scope: 'combined' | HomeStore,
  year?: number
): Promise<SeasonLeaderboardPayload> {
  const seasonYear = year ?? currentSeasonYear()
  const xpByUser = await loadSeasonXpByUser(seasonYear)

  const usersRes = await db.query<{
    id: number
    name: string
    xp: number
    rank: string
    home_store: string | null
    active_deck_id: string | null
  }>(
    `
      SELECT id, name, COALESCE(xp, 0)::int AS xp, rank, home_store, active_deck_id
      FROM users
      ORDER BY name ASC
    `
  )

  let rows: SeasonLeaderboardRow[] = usersRes.rows
    .filter((u) => scope === 'combined' || normalizeHomeStore(u.home_store) === scope)
    .map((u) => {
      const breakdown = xpByUser.get(u.id) ?? { seasonXp: 0, challengeXp: 0, cupXp: 0 }
      const lifetimeXp = Math.max(0, Number(u.xp) || 0)
      return {
        id: u.id,
        name: u.name,
        rank: (u.rank as RankTier) || getRankForXp(lifetimeXp),
        lifetimeXp,
        seasonXp: breakdown.seasonXp,
        challengeXp: breakdown.challengeXp,
        cupXp: breakdown.cupXp,
        homeStore: normalizeHomeStore(u.home_store),
        activeDeckId: u.active_deck_id,
        activeDeckLabel: deckLabel(u.active_deck_id),
      }
    })
    .sort((a, b) => b.seasonXp - a.seasonXp || b.lifetimeXp - a.lifetimeXp || a.name.localeCompare(b.name))

  if (scope === 'combined') {
    rows = rows.filter((r) => r.seasonXp > 0)
  }

  const pickLeader = (pick: (r: SeasonLeaderboardRow) => number) => {
    let best: SeasonLeaderboardRow | null = null
    let bestVal = -1
    for (const r of rows) {
      const v = pick(r)
      if (v > bestVal) {
        bestVal = v
        best = r
      }
    }
    return bestVal > 0 ? best : null
  }

  const challengeLeader =
    scope === 'combined' ? null : pickLeader((r) => r.challengeXp)
  const cupChampion = scope === 'combined' ? null : pickLeader((r) => r.cupXp)

  return {
    seasonYear,
    scope,
    rows,
    challengeLeader,
    cupChampion,
  }
}
