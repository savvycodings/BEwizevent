/**
 * Structured logs for Profile rank chart API routes.
 * Grep server output for `[charts]` when debugging empty charts or 4xx/5xx.
 */
const PREFIX = '[charts]'

export type RankProgressLogContext = {
  userId: number
  compareUserId?: number
  month: string
}

export function logRankProgressRequest(ctx: RankProgressLogContext) {
  console.log(`${PREFIX} rank-progress request`, ctx)
}

export function logRankProgressOk(
  ctx: RankProgressLogContext,
  stats: {
    primaryPoints: number
    comparePoints: number | null
    xpGained: number
    events: number
    rankStart: string
    rankEnd: string
  }
) {
  console.log(`${PREFIX} rank-progress OK`, { ...ctx, ...stats })
}

export function logRankProgressError(
  ctx: RankProgressLogContext,
  err: unknown,
  httpStatus: number
) {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : undefined
  console.error(`${PREFIX} rank-progress FAILED`, {
    ...ctx,
    httpStatus,
    message,
    stack,
  })
}

export function logComparePlayersError(q: string, err: unknown, httpStatus: number) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`${PREFIX} compare-players FAILED`, {
    route: 'GET /auth/players',
    q: q || '(empty)',
    httpStatus,
    message,
  })
}
