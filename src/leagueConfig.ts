import { db } from './db'
import {
  DEFAULT_ANTI_FARMING,
  DEFAULT_REWARD_MAP,
  DEFAULT_VETERAN_GRACE,
  type RankTier,
} from './leagueDefaults'

export type AntiFarmingConfig = typeof DEFAULT_ANTI_FARMING
export type VeteranGraceConfig = typeof DEFAULT_VETERAN_GRACE

let cachedAntiFarm: AntiFarmingConfig | null = null
let cachedVeteranGrace: VeteranGraceConfig | null = null
let cachedRewards: Record<RankTier, string> | null = null

export async function getAntiFarmingConfig(): Promise<AntiFarmingConfig> {
  if (cachedAntiFarm) return cachedAntiFarm
  const res = await db.query<{ value: AntiFarmingConfig }>(
    `SELECT value FROM league_config WHERE key = 'anti_farming'`
  )
  cachedAntiFarm = res.rows[0]?.value ?? DEFAULT_ANTI_FARMING
  return cachedAntiFarm
}

export async function getVeteranGraceConfig(): Promise<VeteranGraceConfig> {
  if (cachedVeteranGrace) return cachedVeteranGrace
  const res = await db.query<{ value: VeteranGraceConfig }>(
    `SELECT value FROM league_config WHERE key = 'veteran_grace'`
  )
  cachedVeteranGrace = res.rows[0]?.value ?? DEFAULT_VETERAN_GRACE
  return cachedVeteranGrace
}

export async function getDefaultRewardMap(): Promise<Record<RankTier, string>> {
  if (cachedRewards) return cachedRewards
  const res = await db.query<{ value: Record<RankTier, string> }>(
    `SELECT value FROM league_config WHERE key = 'default_rewards'`
  )
  cachedRewards = res.rows[0]?.value ?? DEFAULT_REWARD_MAP
  return cachedRewards
}

export async function setLeagueConfigKey(key: string, value: unknown): Promise<void> {
  await db.query(
    `
      INSERT INTO league_config (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [key, JSON.stringify(value)]
  )
  if (key === 'anti_farming') cachedAntiFarm = null
  if (key === 'veteran_grace') cachedVeteranGrace = null
  if (key === 'default_rewards') cachedRewards = null
}

export async function getAllLeagueConfig(): Promise<Record<string, unknown>> {
  const res = await db.query<{ key: string; value: unknown }>(`SELECT key, value FROM league_config`)
  const out: Record<string, unknown> = {}
  for (const row of res.rows) out[row.key] = row.value
  return out
}

export function invalidateLeagueConfigCache(): void {
  cachedAntiFarm = null
  cachedVeteranGrace = null
  cachedRewards = null
}
