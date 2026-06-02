export const HOME_STORE_ORDER = ['glendower', 'rosebank'] as const

export type HomeStore = (typeof HOME_STORE_ORDER)[number]

export const HOME_STORE_LABEL: Record<HomeStore, string> = {
  glendower: 'Glendower',
  rosebank: 'Rosebank',
}

const STORE_SET = new Set<string>(HOME_STORE_ORDER)

export function isHomeStore(value: string): value is HomeStore {
  return STORE_SET.has(value)
}

export function normalizeHomeStore(value: string | null | undefined): HomeStore | null {
  if (value && isHomeStore(value)) return value
  return null
}
