/** Event tier — set at creation; multiplies placement XP. */
export const EVENT_TIER_ORDER = ['casual', 'challenge', 'cup'] as const

export type EventTier = (typeof EVENT_TIER_ORDER)[number]

export const EVENT_TIER_MULTIPLIER: Record<EventTier, number> = {
  casual: 1.0,
  challenge: 2.0,
  cup: 3.5,
}

export const EVENT_TIER_LABEL: Record<EventTier, string> = {
  casual: 'Casual',
  challenge: 'Challenge',
  cup: 'Cup',
}

const TIER_SET = new Set<string>(EVENT_TIER_ORDER)

export function isEventTier(value: string): value is EventTier {
  return TIER_SET.has(value)
}

export function normalizeEventTier(value: string | null | undefined): EventTier {
  if (value && isEventTier(value)) return value
  return 'casual'
}

export function applyEventTierMultiplier(
  baseXp: number,
  tier: string | null | undefined
): number {
  const t = normalizeEventTier(tier)
  return Math.round(baseXp * EVENT_TIER_MULTIPLIER[t])
}

export function formatEventTierMultiplier(tier: EventTier): string {
  const m = EVENT_TIER_MULTIPLIER[tier]
  return m === Math.floor(m) ? `×${m.toFixed(1)}` : `×${m}`
}
