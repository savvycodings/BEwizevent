/**
 * Structured logs for deck profile and event deck attribution.
 * Grep server output for `[decks]` when debugging radar / deck wins.
 */
const PREFIX = '[decks]'

export type DeckLogContext = {
  userId: number
  eventId?: number
}

export function logDeckProfileRequest(ctx: DeckLogContext) {
  console.log(`${PREFIX} deck-profile request`, ctx)
}

export function logDeckProfileOk(
  ctx: DeckLogContext,
  stats: {
    activeDeckId: string | null
    statRows: number
    totalEvents: number
    totalWins: number
    matchWins: number
  }
) {
  console.log(`${PREFIX} deck-profile OK`, { ...ctx, ...stats })
}

export function logActiveDeckUpdated(ctx: DeckLogContext & { deckId: string | null; label: string | null }) {
  console.log(`${PREFIX} active-deck updated`, ctx)
}

export function logAttendanceDeckSaved(
  ctx: DeckLogContext & { deckId: string | null; label: string | null }
) {
  console.log(`${PREFIX} attendance-deck saved`, ctx)
}

export function logAttendanceMarked(
  ctx: DeckLogContext & { attended: boolean; deckId: string | null; label: string | null }
) {
  console.log(`${PREFIX} attendance marked`, ctx)
}

export function logPlacementSaved(
  ctx: DeckLogContext & {
    placement: number | null
    deckId: string | null
    deckLabel: string | null
    isEventWin: boolean
  }
) {
  console.log(`${PREFIX} placement saved`, { ...ctx, isEventWin: ctx.isEventWin })
}

export function logMatchRecorded(
  ctx: DeckLogContext & {
    roundNumber: number
    focalUserId: number
    opponentUserId: number
    result: string
    deckId: string | null
    deckLabel: string | null
    focalWon: boolean
  }
) {
  console.log(`${PREFIX} match recorded`, ctx)
}

export function logDeckBackfill(
  ctx: DeckLogContext & { deckId: string; source: 'active_deck' | 'admin_deck' }
) {
  console.log(`${PREFIX} deck_id backfilled on attendance`, ctx)
}

export function logDeckError(route: string, ctx: DeckLogContext, err: unknown, httpStatus: number) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`${PREFIX} ${route} FAILED`, { ...ctx, httpStatus, message })
}
