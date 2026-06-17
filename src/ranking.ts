import { db } from './db'
import { applyEventTierMultiplier, normalizeEventTier } from './eventTiers'
import { getJudgedAwardBonusXp } from './judgedAwards'
import {
  DEFAULT_PLACEMENT_XP,
  PLACEMENT_XP,
  RANK_ORDER,
  type RankTier,
} from './leagueDefaults'
import { getRankForSeasonXp } from './seasons'
import { getActiveSeason } from './seasons'
import { recalculatePlayerProgression, recalculateEventParticipants } from './playerProgression'

export { RANK_ORDER, type RankTier }
export type PlacementBadgeId = 'placed1st' | 'placed2nd' | 'placed3rd'

export const PLACEMENT_BADGE_BY_PLACE: Record<1 | 2 | 3, PlacementBadgeId> = {
  1: 'placed1st',
  2: 'placed2nd',
  3: 'placed3rd',
}

export { PLACEMENT_XP, DEFAULT_PLACEMENT_XP }

/** @deprecated use season thresholds via getRankForSeasonXp */
export async function getRankForXp(xp: number): Promise<RankTier> {
  const season = await getActiveSeason()
  if (season) return getRankForSeasonXp(xp, season.rankThresholds)
  return getRankForSeasonXp(xp, {
    Bronze: 0,
    Silver: 150,
    Gold: 450,
    Platinum: 1000,
    Diamond: 2000,
    Master: 3800,
    Champion: 7000,
  })
}

export function getXpForPlacement(
  placement: number | null | undefined,
  eventTier?: string | null
): number {
  if (!placement || placement < 1) return 0
  const base = PLACEMENT_XP[placement] ?? DEFAULT_PLACEMENT_XP
  return applyEventTierMultiplier(base, normalizeEventTier(eventTier ?? 'casual'))
}

export function getPlacementBadgeId(
  placement: number | null | undefined
): PlacementBadgeId | null {
  if (placement !== 1 && placement !== 2 && placement !== 3) {
    return null
  }
  return PLACEMENT_BADGE_BY_PLACE[placement]
}

export async function recalculatePlayerRankAndXp(userId: number) {
  const snapshot = await recalculatePlayerProgression(userId)
  return { xp: snapshot.seasonXp, rank: snapshot.currentRank }
}

export { recalculateEventParticipants, recalculatePlayerProgression }
