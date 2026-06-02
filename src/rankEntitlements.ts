import crypto from 'crypto'
import { db } from './db'

/** Prize tiers — keep in sync with app/src/data/rankCatalog.ts */
export const ENTITLEMENT_TIER_ORDER = [
  'Bronze',
  'Silver',
  'Gold',
  'Platinum',
  'Diamond',
  'Master',
  'Champion',
] as const

export type EntitlementTier = (typeof ENTITLEMENT_TIER_ORDER)[number]

export const ENTITLEMENT_MIN_XP: Record<EntitlementTier, number> = {
  Bronze: 0,
  Silver: 100,
  Gold: 300,
  Platinum: 650,
  Diamond: 1200,
  Master: 1600,
  Champion: 2000,
}

export const RANK_ENTITLEMENT_REWARD: Record<EntitlementTier, string> = {
  Bronze: 'Standard prize pack',
  Silver: 'Standard prize pack',
  Gold: 'Standard prize pack',
  Platinum: 'Standard + upgraded prize pack',
  Diamond: 'Standard + upgraded prize pack',
  Master: 'Upgraded pack + 1 extra booster',
  Champion: 'Upgraded pack + 2 extra boosters (or pack + promo)',
}

export type EntitlementStatus = 'locked' | 'claimable' | 'claimed' | 'redeemed'

export type RankEntitlementRow = {
  tier: EntitlementTier
  minXp: number
  reward: string
  status: EntitlementStatus
  claimCode: string | null
  redeemedAt: string | null
}

const TIER_SET = new Set<string>(ENTITLEMENT_TIER_ORDER)

export function isEntitlementTier(tier: string): tier is EntitlementTier {
  return TIER_SET.has(tier)
}

export function entitlementTierForXp(xp: number): EntitlementTier {
  let tier: EntitlementTier = 'Bronze'
  for (const name of ENTITLEMENT_TIER_ORDER) {
    if (xp >= ENTITLEMENT_MIN_XP[name]) tier = name
  }
  return tier
}

function generateClaimCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }
  return code
}

async function insertClaim(userId: number, tier: EntitlementTier): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateClaimCode()
    try {
      const res = await db.query<{ claim_code: string }>(
        `
          INSERT INTO rank_entitlement_claims (user_id, tier, claim_code)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, tier) DO NOTHING
          RETURNING claim_code
        `,
        [userId, tier, code]
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

export async function getRankEntitlementsForUser(
  userId: number,
  xp: number
): Promise<RankEntitlementRow[]> {
  const claimsRes = await db.query<{
    tier: string
    claim_code: string
    redeemed_at: string | Date | null
  }>(
    `
      SELECT tier, claim_code, redeemed_at
      FROM rank_entitlement_claims
      WHERE user_id = $1
    `,
    [userId]
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
    const minXp = ENTITLEMENT_MIN_XP[tier]
    const claim = claimByTier.get(tier)
    let status: EntitlementStatus
    if (xp < minXp) status = 'locked'
    else if (!claim) status = 'claimable'
    else if (claim.redeemedAt) status = 'redeemed'
    else status = 'claimed'

    return {
      tier,
      minXp,
      reward: RANK_ENTITLEMENT_REWARD[tier],
      status,
      claimCode: claim?.claimCode ?? null,
      redeemedAt: claim?.redeemedAt ?? null,
    }
  })
}

export async function claimRankEntitlement(
  userId: number,
  tier: EntitlementTier,
  xp: number
): Promise<{ claimCode: string; status: EntitlementStatus }> {
  if (xp < ENTITLEMENT_MIN_XP[tier]) {
    throw new Error('Rank tier not unlocked yet')
  }
  const claimCode = await insertClaim(userId, tier)
  const rows = await getRankEntitlementsForUser(userId, xp)
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
