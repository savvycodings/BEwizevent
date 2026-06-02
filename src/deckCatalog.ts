export type DeckDefinition = { id: string; label: string }

export const DECK_CATALOG: DeckDefinition[] = [
  { id: 'dragapult', label: 'Dragapult ex' },
  { id: 'raging-bolt', label: 'Raging Bolt ex' },
  { id: 'alakazam', label: 'Alakazam' },
  { id: 'dipplinthwackey', label: 'Festival Lead' },
  { id: 'mewtwospidops', label: "Rocket's Mewtwo ex" },
  { id: 'lopunny-mega', label: 'Mega Lopunny ex' },
  { id: 'ogerponogerpon-wellspring', label: 'Ogerpon Box' },
  { id: 'crustle', label: 'Crustle' },
  { id: 'hydrapple', label: 'Hydrapple ex' },
  { id: 'garchomp', label: "Cynthia's Garchomp ex" },
  { id: 'zoroark', label: "N's Zoroark ex" },
  { id: 'lucario-mega', label: 'Mega Lucario ex' },
  { id: 'ogerponmeganium', label: 'Ogerpon Meganium' },
  { id: 'honchkrowporygon2', label: "Rocket's Honchkrow" },
  { id: 'starmie-mega', label: 'Mega Starmie ex' },
  { id: 'slowking', label: 'Slowking' },
  { id: 'clefairy', label: "Lillie's Clefairy ex" },
  { id: 'grimmsnarl', label: "Marnie's Grimmsnarl ex" },
  { id: 'okidogi', label: 'Okidogi' },
  { id: 'greninja', label: 'Greninja ex' },
  { id: 'noctowlogerpon-wellspring', label: 'Tera Box' },
  { id: 'kangaskhan-mega', label: 'Mega Kangaskhan ex' },
  { id: 'diancie-mega', label: 'Mega Diancie ex' },
  { id: 'trevenant', label: "Hop's Trevenant" },
  { id: 'typhlosion', label: "Ethan's Typhlosion" },
]

const deckById = new Map(DECK_CATALOG.map((d) => [d.id, d]))

export function isValidDeckId(id: string): boolean {
  return deckById.has(id)
}

export function deckLabel(id: string | null | undefined): string {
  if (!id) return 'Unknown deck'
  return deckById.get(id)?.label ?? id
}
