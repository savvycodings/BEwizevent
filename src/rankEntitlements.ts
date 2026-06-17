import crypto from 'crypto'
import { db } from './db'
import { RANK_ORDER, type RankTier } from './leagueDefaults'
import { getActiveSeason, getRankForSeasonXp } from './seasons'
import { getPlayerSeasonSnapshot } from './playerProgression'

export type EntitlementTier = RankTier
export const ENTITLEMENT_TIER_ORDER = RANK_ORDER

export type EntitlementStatus = 'locked' | 'claimable' | 'claimed' | 'redeemed'

export type RankEntitlementRow = {
  tier: EntitlementTier
  minXp: number
  reward: string
  status: EntitlementStatus
  claimCode: string | null
  redeemedAt: string | null
}

const TIER_SET = new Set<string>(RANK_ORDER)

export function isEntitlementTier(tier: string): tier is EntitlementTier {
  return TIER_SET.has(tier)
}

export async function getEntitlementContext(userId: number): Promise<{
  seasonXp: number
  entitlementTier: EntitlementTier
  thresholds: Record<EntitlementTier, number>
  rewardMap: Record<EntitlementTier, string>
  seasonId: number
}> {
  const season = await getActiveSeason()
  if (!season) throw new Error('No active season')
  const snap = await getPlayerSeasonSnapshot(userId)
  await db.query(
    `INSERT INTO player_season_stats (user_id, season_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, season.id]
  )
  const row = await db.query<{
    season_xp: number
    entitlement_tier: string
  }>(
    `SELECT season_xp, entitlement_tier FROM player_season_stats WHERE user_id = $1 AND season_id = $2`,
    [userId, season.id]
  )
  const seasonXp = snap?.seasonXp ?? row.rows[0]?.season_xp ?? 0
  const entitlementTier = (snap?.entitlementTier ??
    row.rows[0]?.entitlement_tier ??
    'Bronze') as EntitlementTier
  return {
    seasonXp,
    entitlementTier,
    thresholds: season.rankThresholds,
    rewardMap: season.rewardMap,
    seasonId: season.id,
  }
}

function generateClaimCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }
  return code
}

async function insertClaim(userId: number, tier: EntitlementTier, seasonId: number): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateClaimCode()
    try {
      const res = await db.query<{ claim_code: string }>(
        `
          INSERT INTO rank_entitlement_claims (user_id, tier, claim_code, season_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, tier) DO NOTHING
          RETURNING claim_code
        `,
        [userId, tier, code, seasonId]
      )
      if (res.rows[0]?.claim_code) return res.rows[0].claim_code
      const existing = await db.query<{ claim_code: string }>(
        `SELECT claim_code FROM rank_entitlement_claims WHERE user_id = $1 AND tier = $2`,
        [userId, tier]
      )
      if (existing.rows[0]?.claim_code) return existing.rows[0].claim_code
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === '23505') continue
      throw err
    }
  }
  throw new Error('Could not generate a unique claim code')
}

function tierIndex(tier: EntitlementTier): number {
  return RANK_ORDER.indexOf(tier)
}

export async function getRankEntitlementsForUser(userId: number): Promise<RankEntitlementRow[]> {
  const ctx = await getEntitlementContext(userId)
  const claimsRes = await db.query<{
    tier: string
    claim_code: string
    redeemed_at: string | Date | null
  }>(
    `
      SELECT tier, claim_code, redeemed_at
      FROM rank_entitlement_claims
      WHERE user_id = $1 AND (season_id = $2 OR season_id IS NULL)
    `,
    [userId, ctx.seasonId]
  )

  const claimByTier = new Map(
    claimsRes.rows.map((r) => [
      r.tier,
      {
        claimCode: r.claim_code,
        redeemedAt: r.redeemed_at == null ? null : String(r.redeemed_at),
      },
    ])
  )

  return ENTITLEMENT_TIER_ORDER.map((tier) => {
    const minXp = ctx.thresholds[tier] ?? 0
    const claim = claimByTier.get(tier)
    const unlocked = tierIndex(ctx.entitlementTier) >= tierIndex(tier)
    let status: EntitlementStatus
    if (!unlocked) status = 'locked'
    else if (!claim) status = 'claimable'
    else if (claim.redeemedAt) status = 'redeemed'
    else status = 'claimed'

    return {
      tier,
      minXp,
      reward: ctx.rewardMap[tier] ?? '',
      status,
      claimCode: claim?.claimCode ?? null,
      redeemedAt: claim?.redeemedAt ?? null,
    }
  })
}

export async function claimRankEntitlement(
  userId: number,
  tier: EntitlementTier
): Promise<{ claimCode: string; status: EntitlementStatus }> {
  const ctx = await getEntitlementContext(userId)
  if (tierIndex(ctx.entitlementTier) < tierIndex(tier)) {
    throw new Error('Rank tier not unlocked yet')
  }
  const claimCode = await insertClaim(userId, tier, ctx.seasonId)
  const rows = await getRankEntitlementsForUser(userId)
  const row = rows.find((r) => r.tier === tier)
  return {
    claimCode,
    status: row?.status ?? 'claimed',
  }
}

export async function redeemRankEntitlement(
  userId: number,
  tier: EntitlementTier,
  adminUserId: number | null
): Promise<void> {
  const res = await db.query(
    `
      UPDATE rank_entitlement_claims
      SET redeemed_at = NOW(), redeemed_by = $3
      WHERE user_id = $1 AND tier = $2 AND redeemed_at IS NULL
    `,
    [userId, tier, adminUserId]
  )
  if (!res.rowCount) {
    throw new Error('No active claim to redeem for this tier')
  }
}

export function entitlementTierForXp(xp: number, thresholds: Record<RankTier, number>): EntitlementTier {
  return getRankForSeasonXp(xp, thresholds)
}
