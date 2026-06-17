import { applyEventTierMultiplier, normalizeEventTier } from './eventTiers'
import { getJudgedAwardBonusXp } from './judgedAwards'
import {
  DEFAULT_PLACEMENT_XP,
  PLACEMENT_XP,
  type RankTier,
} from './leagueDefaults'
import type { AntiFarmingConfig } from './leagueConfig'

export type EventXpInput = {
  placement: number
  fieldSize: number
  eventTier: string | null
  eventDate: string
  participantCount: number
  opponentsBeatenThisWeek: Set<number>
  eventIndexOnDay: number
  antiFarm: AntiFarmingConfig
}

export function basePlacementXp(placement: number): number {
  if (placement < 1) return 0
  return PLACEMENT_XP[placement] ?? DEFAULT_PLACEMENT_XP
}

export function sizeBonusXp(placement: number, fieldSize: number): number {
  if (placement < 1 || fieldSize < 2) return 0
  const opponentsBeaten = Math.max(0, fieldSize - placement)
  if (placement === 1) return opponentsBeaten * 2
  if (placement === 2) return opponentsBeaten * 1
  return 0
}

export function computeRawEventXp(input: EventXpInput): number {
  const base = basePlacementXp(input.placement)
  let sizeBonus = sizeBonusXp(input.placement, input.fieldSize)
  if (input.antiFarm.diminishingOpponentBonusEnabled && sizeBonus > 0) {
    const cappedOpponents = Math.max(0, input.fieldSize - input.placement - input.opponentsBeatenThisWeek.size)
    if (input.placement === 1) sizeBonus = cappedOpponents * 2
    else if (input.placement === 2) sizeBonus = cappedOpponents * 1
  }
  const subtotal = base + sizeBonus
  const tiered = applyEventTierMultiplier(subtotal, normalizeEventTier(input.eventTier))
  let xp = tiered
  if (input.participantCount < input.antiFarm.minEventSize) {
    xp = Math.round(xp * input.antiFarm.minEventSizeXpMultiplier)
  }
  if (input.eventIndexOnDay >= input.antiFarm.dailyFullXpEvents) {
    xp = Math.round(xp * input.antiFarm.additionalEventXpMultiplier)
  }
  return Math.max(0, xp)
}

export function computeJudgedXp(eventTier: string | null, eventIndexOnDay: number, antiFarm: AntiFarmingConfig): number {
  let xp = getJudgedAwardBonusXp(eventTier)
  if (eventIndexOnDay >= antiFarm.dailyFullXpEvents) {
    xp = Math.round(xp * antiFarm.additionalEventXpMultiplier)
  }
  return Math.max(0, xp)
}

export function weekKey(dateStr: string): string {
  const d = new Date(`${dateStr.slice(0, 10)}T12:00:00`)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  const monday = new Date(d)
  monday.setDate(diff)
  return monday.toISOString().slice(0, 10)
}

export function dateKey(value: string | Date | null | undefined): string {
  if (value == null) return new Date().toISOString().slice(0, 10)
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return new Date().toISOString().slice(0, 10)
    return value.toISOString().slice(0, 10)
  }
  const raw = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const parsed = new Date(raw.includes('T') ? raw : `${raw}T12:00:00`)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

export { type RankTier }
