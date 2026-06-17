import { db } from './db'
import { deckLabel } from './deckCatalog'
import { type RankTier } from './leagueDefaults'
import { getActiveSeason } from './seasons'
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
  entitlementTier: RankTier
}

export type SeasonLeaderboardPayload = {
  seasonId: number | null
  seasonName: string | null
  seasonYear: number
  scope: 'combined' | HomeStore
  rows: SeasonLeaderboardRow[]
  challengeLeader: SeasonLeaderboardRow | null
  cupChampion: SeasonLeaderboardRow | null
  overallChampion: SeasonLeaderboardRow | null
}

export function currentSeasonYear(): number {
  return new Date().getFullYear()
}

async function loadChallengeCupXp(seasonId: number): Promise<Map<number, SeasonXpBreakdown>> {
  const map = new Map<number, SeasonXpBreakdown>()
  const res = await db.query<{
    userId: number
    xp: number
    eventTier: string | null
  }>(
    `
      SELECT ex.user_id AS "userId", ex.xp_amount AS xp, e.event_tier AS "eventTier"
      FROM event_xp_awards ex
      JOIN events e ON e.id = ex.event_id
      WHERE ex.season_id = $1
    `,
    [seasonId]
  )
  for (const row of res.rows) {
    const cur = map.get(row.userId) ?? { seasonXp: 0, challengeXp: 0, cupXp: 0 }
    cur.seasonXp += row.xp
    if (row.eventTier === 'challenge') cur.challengeXp += row.xp
    if (row.eventTier === 'cup') cur.cupXp += row.xp
    map.set(row.userId, cur)
  }
  return map
}

export async function buildSeasonLeaderboard(
  scope: 'combined' | HomeStore,
  seasonId?: number
): Promise<SeasonLeaderboardPayload> {
  const season = seasonId ? await (async () => {
    const { getSeasonById } = await import('./seasons')
    return getSeasonById(seasonId)
  })() : await getActiveSeason()

  if (!season) {
    return {
      seasonId: null,
      seasonName: null,
      seasonYear: currentSeasonYear(),
      scope,
      rows: [],
      challengeLeader: null,
      cupChampion: null,
      overallChampion: null,
    }
  }

  const xpByUser = await loadChallengeCupXp(season.id)

  const usersRes = await db.query<{
    id: number
    name: string
    xp: number
    rank: string
    home_store: string | null
    active_deck_id: string | null
    season_xp: number | null
    current_rank: string | null
    entitlement_tier: string | null
  }>(
    `
      SELECT
        u.id,
        u.name,
        COALESCE(u.xp, 0)::int AS xp,
        u.rank,
        u.home_store,
        u.active_deck_id,
        pss.season_xp,
        pss.current_rank,
        pss.entitlement_tier
      FROM users u
      LEFT JOIN player_season_stats pss ON pss.user_id = u.id AND pss.season_id = $1
      ORDER BY u.name ASC
    `,
    [season.id]
  )

  let rows: SeasonLeaderboardRow[] = usersRes.rows
    .filter((u) => {
      if (scope === 'combined') return true
      return normalizeHomeStore(u.home_store) === scope
    })
    .map((u) => {
      const breakdown = xpByUser.get(u.id) ?? { seasonXp: 0, challengeXp: 0, cupXp: 0 }
      const seasonXp = u.season_xp ?? breakdown.seasonXp
      const currentRank = (u.current_rank as RankTier) || 'Bronze'
      return {
        id: u.id,
        name: u.name,
        rank: currentRank,
        lifetimeXp: Math.max(0, Number(u.xp) || 0),
        seasonXp,
        challengeXp: breakdown.challengeXp,
        cupXp: breakdown.cupXp,
        homeStore: normalizeHomeStore(u.home_store),
        activeDeckId: u.active_deck_id,
        activeDeckLabel: deckLabel(u.active_deck_id),
        entitlementTier: (u.entitlement_tier as RankTier) || currentRank,
      }
    })
    .sort((a, b) => b.seasonXp - a.seasonXp || b.lifetimeXp - a.lifetimeXp || a.name.localeCompare(b.name))

  if (scope === 'combined') {
    rows = rows.filter((r) => r.seasonXp > 0)
  }

  const challengeLeader =
    scope === 'combined'
      ? null
      : [...rows].sort((a, b) => b.challengeXp - a.challengeXp)[0] ?? null
  const cupChampion =
    scope === 'combined'
      ? null
      : [...rows].sort((a, b) => b.cupXp - a.cupXp)[0] ?? null
  const overallChampion = rows[0] ?? null

  return {
    seasonId: season.id,
    seasonName: season.name,
    seasonYear: new Date(season.startDate).getFullYear(),
    scope,
    rows,
    challengeLeader: challengeLeader && challengeLeader.challengeXp > 0 ? challengeLeader : null,
    cupChampion: cupChampion && cupChampion.cupXp > 0 ? cupChampion : null,
    overallChampion: overallChampion && overallChampion.seasonXp > 0 ? overallChampion : null,
  }
}
