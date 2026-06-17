/** Default league values — seeded into DB; admins can override per season / config. */

export const RANK_ORDER = [
  'Bronze',
  'Silver',
  'Gold',
  'Platinum',
  'Diamond',
  'Master',
  'Champion',
] as const

export type RankTier = (typeof RANK_ORDER)[number]

export type SeasonType = 'main' | 'off_season'

export const MAIN_SEASON_THRESHOLDS: Record<RankTier, number> = {
  Bronze: 0,
  Silver: 150,
  Gold: 450,
  Platinum: 1000,
  Diamond: 2000,
  Master: 3800,
  Champion: 7000,
}

export const OFF_SEASON_THRESHOLDS: Record<RankTier, number> = {
  Bronze: 0,
  Silver: 100,
  Gold: 250,
  Platinum: 500,
  Diamond: 900,
  Master: 1400,
  Champion: 2200,
}

export const DEFAULT_REWARD_MAP: Record<RankTier, string> = {
  Bronze: 'Standard prize pack',
  Silver: 'Standard prize pack',
  Gold: 'Standard prize pack',
  Platinum: 'Standard + upgraded prize pack',
  Diamond: 'Standard + upgraded prize pack',
  Master: 'Upgraded pack + 1 extra booster',
  Champion: 'Upgraded pack + 2 extra boosters (or pack + promo)',
}

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

export const DEFAULT_ANTI_FARMING = {
  minEventSize: 4,
  minEventSizeXpMultiplier: 0.5,
  dailyFullXpEvents: 1,
  additionalEventXpMultiplier: 0.25,
  diminishingOpponentBonusEnabled: true,
}

export const DEFAULT_VETERAN_GRACE = {
  enabled: true,
  weeks: 4,
}

export const DEFAULT_BADGE_DEFINITIONS = [
  { id: 'placed1st', title: 'First Blood', description: 'Finish 1st at an event.', category: 'placement', xpReward: 0, sortOrder: 1 },
  { id: 'placed2nd', title: 'Top Cut', description: 'Finish 2nd at an event.', category: 'placement', xpReward: 0, sortOrder: 2 },
  { id: 'placed3rd', title: 'Top Cut', description: 'Finish 3rd at an event.', category: 'placement', xpReward: 0, sortOrder: 3 },
  { id: 'flawless', title: 'Flawless', description: 'Win the event without a loss.', category: 'placement', xpReward: 50, sortOrder: 4 },
  { id: 'giant_slayer', title: 'Giant Slayer', description: 'Beat a higher-ranked opponent.', category: 'placement', xpReward: 40, sortOrder: 5 },
  { id: 'three_peat', title: 'Three-Peat', description: 'Win three events in a row.', category: 'placement', xpReward: 75, sortOrder: 6 },
  { id: 'iron_trainer', title: 'Iron Trainer', description: 'Attend events consistently.', category: 'consistency', xpReward: 25, sortOrder: 10 },
  { id: 'grinder_25', title: 'Grinder 25', description: 'Play 25 league events.', category: 'consistency', xpReward: 50, sortOrder: 11 },
  { id: 'grinder_50', title: 'Grinder 50', description: 'Play 50 league events.', category: 'consistency', xpReward: 75, sortOrder: 12 },
  { id: 'grinder_100', title: 'Grinder 100', description: 'Play 100 league events.', category: 'consistency', xpReward: 100, sortOrder: 13 },
  { id: 'marathon', title: 'Marathon', description: 'Complete a full season of play.', category: 'consistency', xpReward: 100, sortOrder: 14 },
  { id: 'type_master', title: 'Type Master', description: 'Win with a mono-type deck.', category: 'collection', xpReward: 40, sortOrder: 20 },
  { id: 'rogue_builder', title: 'Rogue Builder', description: 'Win with an off-meta deck.', category: 'collection', xpReward: 40, sortOrder: 21 },
  { id: 'format_sweep', title: 'Format Sweep', description: 'Top finishes across formats.', category: 'collection', xpReward: 50, sortOrder: 22 },
  { id: 'season_finalist', title: 'Season Finalist', description: 'Finish top 3 in season standings.', category: 'seasonal', xpReward: 75, sortOrder: 30 },
  { id: 'champions_cape', title: "Champion's Cape", description: 'Win the overall season championship.', category: 'seasonal', xpReward: 100, sortOrder: 31 },
  { id: 'cup_champion', title: 'Cup Champion', description: 'Win the store Cup championship.', category: 'seasonal', xpReward: 75, sortOrder: 32 },
  { id: 'champion', title: 'Champion', description: 'Win an event.', category: 'legacy', xpReward: 45, sortOrder: 40 },
  { id: 'magician', title: 'Magician', description: 'Win a round in a surprising way.', category: 'legacy', xpReward: 25, sortOrder: 41 },
  { id: 'quick', title: 'Quick', description: 'Win a round very quickly.', category: 'legacy', xpReward: 25, sortOrder: 42 },
  { id: 'scholar', title: 'Scholar', description: 'Show clear improvement from past events.', category: 'legacy', xpReward: 25, sortOrder: 43 },
  { id: 'scientist', title: 'Scientist', description: 'Win with strong strategy.', category: 'legacy', xpReward: 25, sortOrder: 44 },
  { id: 'sweat', title: 'Sweat', description: 'Give full effort in a match.', category: 'legacy', xpReward: 25, sortOrder: 45 },
] as const

export function thresholdsForSeasonType(type: SeasonType): Record<RankTier, number> {
  return type === 'off_season' ? { ...OFF_SEASON_THRESHOLDS } : { ...MAIN_SEASON_THRESHOLDS }
}

export function rankIndex(tier: RankTier): number {
  return RANK_ORDER.indexOf(tier)
}

export function higherRank(a: RankTier, b: RankTier): RankTier {
  return rankIndex(a) >= rankIndex(b) ? a : b
}
