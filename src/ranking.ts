import { db } from './db'
import { applyEventTierMultiplier, normalizeEventTier } from './eventTiers'
import { getJudgedAwardBonusXp } from './judgedAwards'

export const RANK_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion'] as const
export type RankTier = (typeof RANK_ORDER)[number]
export type PlacementBadgeId = 'placed1st' | 'placed2nd' | 'placed3rd'

export const PLACEMENT_BADGE_BY_PLACE: Record<1 | 2 | 3, PlacementBadgeId> = {
  1: 'placed1st',
  2: 'placed2nd',
  3: 'placed3rd',
}

// Easy-to-tune placement XP rewards.
export const PLACEMENT_XP: Record<number, number> = {
  1: 100,
  2: 70,
  3: 50,
  4: 30,
  5: 30,
  6: 25,
  7: 25,
  8: 20,
}

export const DEFAULT_PLACEMENT_XP = 20

// Cumulative XP minimum required for each rank.
export const RANK_MIN_XP: Record<RankTier, number> = {
  Bronze: 0,
  Silver: 100,
  Gold: 300,
  Platinum: 650,
  Diamond: 1200,
  Champion: 2000,
}

export function getXpForPlacement(
  placement: number | null | undefined,
  eventTier?: string | null
): number {
  if (!placement || placement < 1) return 0
  const base = PLACEMENT_XP[placement] ?? DEFAULT_PLACEMENT_XP
  return applyEventTierMultiplier(base, normalizeEventTier(eventTier ?? 'casual'))
}

export function getRankForXp(xp: number): RankTier {
  let next: RankTier = 'Bronze'
  for (const rank of RANK_ORDER) {
    if (xp >= RANK_MIN_XP[rank]) {
      next = rank
    }
  }
  return next
}

export function getPlacementBadgeId(
  placement: number | null | undefined
): PlacementBadgeId | null {
  if (placement !== 1 && placement !== 2 && placement !== 3) {
    return null
  }
  return PLACEMENT_BADGE_BY_PLACE[placement]
}

export async function recalculatePlayerRankAndXp(userId: number): Promise<{ xp: number; rank: RankTier }> {
  const [placementsRes, judgedRes] = await Promise.all([
    db.query(
      `
        SELECT a.placement, e.event_tier AS "eventTier"
        FROM event_attendance a
        JOIN events e ON e.id = a.event_id
        WHERE a.user_id = $1 AND a.placement IS NOT NULL
      `,
      [userId]
    ),
    db.query(
      `
        SELECT e.event_tier AS "eventTier"
        FROM event_judged_awards j
        JOIN events e ON e.id = j.event_id
        WHERE j.winner_user_id = $1
      `,
      [userId]
    ),
  ])

  const placementXp = placementsRes.rows.reduce(
    (sum: number, row: { placement: number | null; eventTier?: string | null }) => {
      return sum + getXpForPlacement(row.placement, row.eventTier)
    },
    0
  )
  const judgedXp = judgedRes.rows.reduce(
    (sum: number, row: { eventTier?: string | null }) => sum + getJudgedAwardBonusXp(row.eventTier),
    0
  )
  const xp = placementXp + judgedXp

  const rank = getRankForXp(xp)

  await db.query(
    `
      UPDATE users
      SET xp = $2, rank = $3
      WHERE id = $1
    `,
    [userId, xp, rank]
  )

  return { xp, rank }
}
