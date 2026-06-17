import { db } from './db'
import {
  DEFAULT_REWARD_MAP,
  thresholdsForSeasonType,
  type RankTier,
  type SeasonType,
} from './leagueDefaults'
import { getDefaultRewardMap } from './leagueConfig'
import { dateKey } from './xpEngine'

export type SeasonRow = {
  id: number
  name: string
  seasonType: SeasonType
  startDate: string
  endDate: string
  status: 'draft' | 'active' | 'archived'
  rankThresholds: Record<RankTier, number>
  rewardMap: Record<RankTier, string>
}

function mapSeasonRow(row: {
  id: number
  name: string
  season_type: string
  start_date: string | Date
  end_date: string | Date
  status: string
  rank_thresholds: Record<RankTier, number>
  reward_map: Record<RankTier, string>
}): SeasonRow {
  return {
    id: row.id,
    name: row.name,
    seasonType: row.season_type as SeasonType,
    startDate: dateKey(row.start_date),
    endDate: dateKey(row.end_date),
    status: row.status as SeasonRow['status'],
    rankThresholds: row.rank_thresholds,
    rewardMap: row.reward_map,
  }
}

export type { SeasonType }

export async function getActiveSeason(): Promise<SeasonRow | null> {
  const res = await db.query(
    `
      SELECT id, name, season_type, start_date, end_date, status, rank_thresholds, reward_map
      FROM seasons
      WHERE status = 'active'
      ORDER BY start_date DESC
      LIMIT 1
    `
  )
  return res.rows[0] ? mapSeasonRow(res.rows[0]) : null
}

export async function getSeasonById(id: number): Promise<SeasonRow | null> {
  const res = await db.query(
    `
      SELECT id, name, season_type, start_date, end_date, status, rank_thresholds, reward_map
      FROM seasons WHERE id = $1
    `,
    [id]
  )
  return res.rows[0] ? mapSeasonRow(res.rows[0]) : null
}

export async function listSeasons(): Promise<SeasonRow[]> {
  const res = await db.query(
    `
      SELECT id, name, season_type, start_date, end_date, status, rank_thresholds, reward_map
      FROM seasons
      ORDER BY start_date DESC
    `
  )
  return res.rows.map(mapSeasonRow)
}

export async function ensureDefaultActiveSeason(): Promise<SeasonRow> {
  const existing = await getActiveSeason()
  if (existing) return existing

  const year = new Date().getFullYear()
  const defaults = await getDefaultRewardMap()
  const res = await db.query(
    `
      INSERT INTO seasons (name, season_type, start_date, end_date, status, rank_thresholds, reward_map)
      VALUES ($1, 'main', $2, $3, 'active', $4::jsonb, $5::jsonb)
      RETURNING id, name, season_type, start_date, end_date, status, rank_thresholds, reward_map
    `,
    [
      `${year} Main Season`,
      `${year}-09-01`,
      `${year + 1}-06-15`,
      JSON.stringify(thresholdsForSeasonType('main')),
      JSON.stringify(defaults),
    ]
  )
  return mapSeasonRow(res.rows[0])
}

export function getRankForSeasonXp(
  xp: number,
  thresholds: Record<RankTier, number>
): RankTier {
  let tier: RankTier = 'Bronze'
  for (const name of Object.keys(thresholds) as RankTier[]) {
    if (xp >= thresholds[name]) tier = name
  }
  return tier
}

export async function createSeason(input: {
  name: string
  seasonType: SeasonType
  startDate: string
  endDate: string
  rankThresholds?: Record<RankTier, number>
  rewardMap?: Record<RankTier, string>
}): Promise<SeasonRow> {
  const defaults = await getDefaultRewardMap()
  const res = await db.query(
    `
      INSERT INTO seasons (name, season_type, start_date, end_date, status, rank_thresholds, reward_map)
      VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, $6::jsonb)
      RETURNING id, name, season_type, start_date, end_date, status, rank_thresholds, reward_map
    `,
    [
      input.name,
      input.seasonType,
      input.startDate,
      input.endDate,
      JSON.stringify(input.rankThresholds ?? thresholdsForSeasonType(input.seasonType)),
      JSON.stringify(input.rewardMap ?? defaults),
    ]
  )
  return mapSeasonRow(res.rows[0])
}

export async function updateSeason(
  id: number,
  patch: Partial<{
    name: string
    seasonType: SeasonType
    startDate: string
    endDate: string
    rankThresholds: Record<RankTier, number>
    rewardMap: Record<RankTier, string>
  }>
): Promise<SeasonRow | null> {
  const current = await getSeasonById(id)
  if (!current) return null
  const res = await db.query(
    `
      UPDATE seasons SET
        name = COALESCE($2, name),
        season_type = COALESCE($3, season_type),
        start_date = COALESCE($4, start_date),
        end_date = COALESCE($5, end_date),
        rank_thresholds = COALESCE($6::jsonb, rank_thresholds),
        reward_map = COALESCE($7::jsonb, reward_map)
      WHERE id = $1
      RETURNING id, name, season_type, start_date, end_date, status, rank_thresholds, reward_map
    `,
    [
      id,
      patch.name ?? null,
      patch.seasonType ?? null,
      patch.startDate ?? null,
      patch.endDate ?? null,
      patch.rankThresholds ? JSON.stringify(patch.rankThresholds) : null,
      patch.rewardMap ? JSON.stringify(patch.rewardMap) : null,
    ]
  )
  return res.rows[0] ? mapSeasonRow(res.rows[0]) : null
}

export async function activateSeason(id: number): Promise<SeasonRow> {
  await db.query(`UPDATE seasons SET status = 'archived' WHERE status = 'active' AND id <> $1`, [id])
  const res = await db.query(
    `
      UPDATE seasons SET status = 'active' WHERE id = $1
      RETURNING id, name, season_type, start_date, end_date, status, rank_thresholds, reward_map
    `,
    [id]
  )
  if (!res.rows[0]) throw new Error('Season not found')
  await ensurePlayerSeasonStatsForSeason(id)
  return mapSeasonRow(res.rows[0])
}

async function ensurePlayerSeasonStatsForSeason(seasonId: number): Promise<void> {
  await db.query(
    `
      INSERT INTO player_season_stats (user_id, season_id)
      SELECT u.id, $1 FROM users u
      ON CONFLICT (user_id, season_id) DO NOTHING
    `,
    [seasonId]
  )
}

export async function archiveAndEndSeason(seasonId: number): Promise<void> {
  const season = await getSeasonById(seasonId)
  if (!season) throw new Error('Season not found')

  const stats = await db.query(
    `
      SELECT pss.*, u.name
      FROM player_season_stats pss
      JOIN users u ON u.id = pss.user_id
      WHERE pss.season_id = $1
    `,
    [seasonId]
  )

  await db.query(
    `
      INSERT INTO season_archives (season_id, snapshot)
      VALUES ($1, $2::jsonb)
    `,
    [seasonId, JSON.stringify({ season, players: stats.rows })]
  )

  await db.query(`UPDATE seasons SET status = 'archived' WHERE id = $1`, [seasonId])
  await db.query(`DELETE FROM rank_entitlement_claims WHERE season_id = $1`, [seasonId])
}

export async function getPreviousSeasonEntitlementTier(
  userId: number,
  beforeSeasonId: number
): Promise<RankTier | null> {
  const res = await db.query<{ entitlement_tier: string }>(
    `
      SELECT pss.entitlement_tier
      FROM player_season_stats pss
      JOIN seasons s ON s.id = pss.season_id
      WHERE pss.user_id = $1 AND pss.season_id <> $2 AND s.status = 'archived'
      ORDER BY s.end_date DESC
      LIMIT 1
    `,
    [userId, beforeSeasonId]
  )
  return (res.rows[0]?.entitlement_tier as RankTier) ?? null
}

export function isWithinGracePeriod(seasonStartDate: string, weeks: number): boolean {
  const start = new Date(`${seasonStartDate}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + weeks * 7)
  return Date.now() <= end.getTime()
}

export function graceEntitlementTier(
  seasonRankTier: RankTier,
  previousTier: RankTier | null,
  graceEnabled: boolean,
  inGraceWindow: boolean
): RankTier {
  if (!graceEnabled || !inGraceWindow || !previousTier) return seasonRankTier
  const order = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Champion'] as RankTier[]
  const ri = (t: RankTier) => order.indexOf(t)
  return ri(previousTier) > ri(seasonRankTier) ? previousTier : seasonRankTier
}
