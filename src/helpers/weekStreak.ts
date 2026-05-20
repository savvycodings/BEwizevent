/** Monday 00:00 UTC for the calendar week containing `d` (ISO-style week start). */
export function mondayWeekStartUtc(d: Date): number {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  const wd = new Date(Date.UTC(y, m, day)).getUTCDay()
  const offset = wd === 0 ? -6 : 1 - wd
  const monday = new Date(Date.UTC(y, m, day + offset, 0, 0, 0, 0))
  return monday.getTime()
}

export function attendanceReferenceDate(
  eventDate: string | null | undefined,
  updatedAt: string | Date
): Date {
  if (eventDate) {
    return new Date(`${String(eventDate).slice(0, 10)}T12:00:00.000Z`)
  }
  return new Date(updatedAt)
}

/**
 * Counts consecutive calendar weeks (UTC Monday boundaries) with at least one
 * attended event, anchored at the most recent such week.
 */
export function weekStreakFromAttendance(
  rows: { eventDate: string | null | undefined; updatedAt: string | Date }[]
): number {
  const weekStarts = new Set<number>()
  for (const r of rows) {
    weekStarts.add(mondayWeekStartUtc(attendanceReferenceDate(r.eventDate, r.updatedAt)))
  }
  const sorted = [...weekStarts].sort((a, b) => b - a)
  if (sorted.length === 0) return 0
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  let streak = 1
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1]! - sorted[i]! === WEEK_MS) {
      streak++
    } else {
      break
    }
  }
  return streak
}
