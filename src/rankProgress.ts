import { db } from './db'
import { getJudgedAwardBonusXp, JUDGED_AWARD_LABEL, type JudgedAwardType } from './judgedAwards'
import { getRankForXp, getXpForPlacement, type RankTier } from './ranking'

export type RankProgressPoint = {
  at: string
  label: string
  cumulativeXp: number
  rank: RankTier
  placement: number
  xpGained: number
}

export type RankProgressSeries = {
  userId: number
  name: string
  points: RankProgressPoint[]
  xpGainedInRange: number
  eventsInRange: number
}

type AttendanceRow = {
  eventDate: string | Date | null
  eventTitle: string
  placement: number
  eventTier: string | null
  updatedAt: string | Date
}

type JudgedRow = {
  eventDate: string | Date | null
  eventTitle: string
  eventTier: string | null
  awardType: JudgedAwardType
  updatedAt: string | Date
}

type ProgressRow =
  | { kind: 'placement'; row: AttendanceRow }
  | { kind: 'judged'; row: JudgedRow }

/** pg returns DATE/TIMESTAMP as Date objects; some rows may be ISO strings. */
function toEventMillis(value: string | Date | null | undefined): number {
  if (value == null) return 0
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isNaN(t) ? 0 : t
  }
  const raw = String(value).trim()
  if (!raw) return 0
  const d = new Date(raw.includes('T') ? raw : `${raw}T12:00:00`)
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

export function isValidMonthKey(month: string): boolean {
  return monthBounds(month) !== null
}

function monthBounds(month: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const [year, mon] = month.split('-').map(Number)
  const start = new Date(year, mon - 1, 1, 0, 0, 0, 0)
  const end = new Date(year, mon, 0, 23, 59, 59, 999)
  return { start, end }
}

function eventTimestamp(row: AttendanceRow): number {
  return toEventMillis(row.eventDate) || toEventMillis(row.updatedAt)
}

function inMonth(ts: number, bounds: { start: Date; end: Date }): boolean {
  return ts >= bounds.start.getTime() && ts <= bounds.end.getTime()
}

async function fetchPlacementRows(userId: number): Promise<AttendanceRow[]> {
  const res = await db.query(
    `
      SELECT
        e.event_date AS "eventDate",
        e.title AS "eventTitle",
        e.event_tier AS "eventTier",
        a.placement,
        a.updated_at AS "updatedAt"
      FROM event_attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.user_id = $1
        AND a.attended = TRUE
        AND a.placement IS NOT NULL
      ORDER BY COALESCE(e.event_date, a.updated_at) ASC, a.updated_at ASC
    `,
    [userId]
  )
  return res.rows as AttendanceRow[]
}

async function fetchJudgedRows(userId: number): Promise<JudgedRow[]> {
  const res = await db.query(
    `
      SELECT
        e.event_date AS "eventDate",
        e.title AS "eventTitle",
        e.event_tier AS "eventTier",
        j.award_type AS "awardType",
        j.awarded_at AS "updatedAt"
      FROM event_judged_awards j
      JOIN events e ON e.id = j.event_id
      WHERE j.winner_user_id = $1
      ORDER BY COALESCE(e.event_date, j.awarded_at) ASC, j.awarded_at ASC
    `,
    [userId]
  )
  return res.rows as JudgedRow[]
}

function progressTimestamp(row: ProgressRow): number {
  if (row.kind === 'placement') return eventTimestamp(row.row)
  return eventTimestamp({
    eventDate: row.row.eventDate,
    eventTitle: row.row.eventTitle,
    placement: 0,
    eventTier: row.row.eventTier,
    updatedAt: row.row.updatedAt,
  })
}

function mergeProgressRows(placements: AttendanceRow[], judged: JudgedRow[]): ProgressRow[] {
  const merged: ProgressRow[] = [
    ...placements.map((row) => ({ kind: 'placement' as const, row })),
    ...judged.map((row) => ({ kind: 'judged' as const, row })),
  ]
  merged.sort((a, b) => progressTimestamp(a) - progressTimestamp(b))
  return merged
}

function buildSeriesFromRows(
  rows: ProgressRow[],
  options: { month?: string; startingXp?: number }
): Omit<RankProgressSeries, 'userId' | 'name'> {
  const bounds = options.month ? monthBounds(options.month) : null
  let cumulative = Math.max(0, options.startingXp ?? 0)
  const points: RankProgressPoint[] = []
  let xpGainedInRange = 0
  let eventsInRange = 0

  if (bounds) {
    points.push({
      at: bounds.start.toISOString(),
      label: 'Start',
      cumulativeXp: cumulative,
      rank: getRankForXp(cumulative),
      placement: 0,
      xpGained: 0,
    })
  } else if (rows.length > 0) {
    const firstTs = progressTimestamp(rows[0])
    const startTs = Math.max(0, firstTs - 24 * 60 * 60 * 1000)
    points.push({
      at: new Date(startTs).toISOString(),
      label: 'Start',
      cumulativeXp: 0,
      rank: 'Bronze',
      placement: 0,
      xpGained: 0,
    })
  }

  for (const entry of rows) {
    const ts = progressTimestamp(entry)
    if (bounds && !inMonth(ts, bounds)) continue

    let xpGained = 0
    let placement = 0
    let label = ''

    if (entry.kind === 'placement') {
      const row = entry.row
      xpGained = getXpForPlacement(row.placement, row.eventTier)
      placement = row.placement
      label = row.eventTitle.length > 14 ? `${row.eventTitle.slice(0, 12)}…` : row.eventTitle
      eventsInRange += 1
    } else {
      const row = entry.row
      xpGained = getJudgedAwardBonusXp(row.eventTier)
      placement = 0
      const shortAward = JUDGED_AWARD_LABEL[row.awardType].replace('Best ', '')
      label = shortAward.length > 14 ? `${shortAward.slice(0, 12)}…` : shortAward
    }

    cumulative += xpGained
    xpGainedInRange += xpGained

    points.push({
      at: new Date(ts).toISOString(),
      label,
      cumulativeXp: cumulative,
      rank: getRankForXp(cumulative),
      placement,
      xpGained,
    })
  }

  return { points, xpGainedInRange, eventsInRange }
}

async function xpBeforeMonth(userId: number, month: string): Promise<number> {
  const bounds = monthBounds(month)
  if (!bounds) return 0
  const [placements, judged] = await Promise.all([
    fetchPlacementRows(userId),
    fetchJudgedRows(userId),
  ])
  const rows = mergeProgressRows(placements, judged)
  let total = 0
  for (const entry of rows) {
    const ts = progressTimestamp(entry)
    if (ts >= bounds.start.getTime()) continue
    if (entry.kind === 'placement') {
      total += getXpForPlacement(entry.row.placement, entry.row.eventTier)
    } else {
      total += getJudgedAwardBonusXp(entry.row.eventTier)
    }
  }
  return total
}

export async function buildRankProgressSeries(
  userId: number,
  options?: { month?: string }
): Promise<RankProgressSeries> {
  const userRes = await db.query('SELECT id, name FROM users WHERE id = $1', [userId])
  const user = userRes.rows[0]
  if (!user) {
    throw new Error('User not found')
  }

  const [placements, judged] = await Promise.all([
    fetchPlacementRows(userId),
    fetchJudgedRows(userId),
  ])
  const rows = mergeProgressRows(placements, judged)
  const startingXp = options?.month ? await xpBeforeMonth(userId, options.month) : 0
  const built = buildSeriesFromRows(rows, { month: options?.month, startingXp })

  return {
    userId,
    name: user.name,
    ...built,
  }
}

export function currentMonthKey(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}`
}

export type UserXpSnapshot = {
  userId: number
  name: string
  xp: number
  rank: RankTier
}

/** Lifetime XP from users table — used for player-vs-player bar compare. */
export async function getUserXpSnapshot(userId: number): Promise<UserXpSnapshot> {
  const res = await db.query(
    `SELECT id, name, COALESCE(xp, 0)::int AS xp, rank FROM users WHERE id = $1`,
    [userId]
  )
  const row = res.rows[0]
  if (!row) {
    throw new Error('User not found')
  }
  const xp = Math.max(0, Number(row.xp) || 0)
  const rank = (row.rank as RankTier) || getRankForXp(xp)
  return {
    userId: row.id,
    name: row.name,
    xp,
    rank,
  }
}

function seriesHasScoredEvents(points: RankProgressPoint[]): boolean {
  return points.some((p) => p.placement > 0 && p.xpGained > 0)
}

/** Prefer month timeline when it has scored events; otherwise show full history with event dates. */
export async function resolveChartPoints(
  userId: number,
  month: string,
  monthSeries: RankProgressSeries
): Promise<{ points: RankProgressPoint[]; scope: 'month' | 'all-time' }> {
  if (seriesHasScoredEvents(monthSeries.points) && monthSeries.points.length >= 2) {
    return { points: monthSeries.points, scope: 'month' }
  }
  const allTime = await buildRankProgressSeries(userId)
  if (seriesHasScoredEvents(allTime.points)) {
    return { points: allTime.points, scope: 'all-time' }
  }
  if (monthSeries.points.length >= 2) {
    return { points: monthSeries.points, scope: 'month' }
  }
  if (allTime.points.length >= 2) {
    return { points: allTime.points, scope: 'all-time' }
  }
  return { points: monthSeries.points.length ? monthSeries.points : allTime.points, scope: 'month' }
}

/** Map compare cumulative XP onto the primary timeline so both lines share the same x-axis. */
export function alignCompareToPrimaryTimeline(
  primaryTimeline: RankProgressPoint[],
  comparePoints: RankProgressPoint[]
): RankProgressPoint[] {
  if (primaryTimeline.length === 0) return []
  if (comparePoints.length === 0) {
    return primaryTimeline.map((p) => ({
      at: p.at,
      label: '',
      cumulativeXp: 0,
      rank: 'Bronze' as RankTier,
      placement: 0,
      xpGained: 0,
    }))
  }

  const sorted = [...comparePoints].sort(
    (a, b) => toEventMillis(a.at) - toEventMillis(b.at)
  )

  return primaryTimeline.map((p) => {
    const t = toEventMillis(p.at)
    let cumulative = sorted[0].cumulativeXp
    let rank = sorted[0].rank
    for (const c of sorted) {
      const ct = toEventMillis(c.at)
      if (ct <= t) {
        cumulative = c.cumulativeXp
        rank = c.rank
      } else {
        break
      }
    }
    return {
      at: p.at,
      label: p.label,
      cumulativeXp: cumulative,
      rank,
      placement: 0,
      xpGained: 0,
    }
  })
}
