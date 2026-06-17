import { db } from './db'
import { getAntiFarmingConfig, getVeteranGraceConfig } from './leagueConfig'
import { higherRank, RANK_ORDER, type RankTier } from './leagueDefaults'
import {
  ensureDefaultActiveSeason,
  getActiveSeason,
  getPreviousSeasonEntitlementTier,
  getRankForSeasonXp,
  graceEntitlementTier,
  isWithinGracePeriod,
} from './seasons'
import {
  computeJudgedXp,
  computeRawEventXp,
  dateKey,
  weekKey,
} from './xpEngine'

export type PlayerProgressSnapshot = {
  seasonXp: number
  currentRank: RankTier
  bestRank: RankTier
  entitlementTier: RankTier
  lifetimeXp: number
}

async function getEventFieldSize(eventId: number): Promise<number> {
  const res = await db.query<{ field_size: number | null; c: number }>(
    `
      SELECT e.field_size,
        (SELECT COUNT(*)::int FROM event_attendance a
         WHERE a.event_id = e.id AND a.attended = TRUE AND a.placement IS NOT NULL) AS c
      FROM events e WHERE e.id = $1
    `,
    [eventId]
  )
  const row = res.rows[0]
  if (!row) return 0
  return Math.max(row.field_size ?? 0, row.c ?? 0, 0)
}

async function loadWeeklyOpponents(userId: number, eventId: number): Promise<number[]> {
  const res = await db.query<{ opponent_id: number }>(
    `
      SELECT CASE WHEN m.player_a_id = $1 THEN m.player_b_id ELSE m.player_a_id END AS opponent_id
      FROM event_matches m
      JOIN events e ON e.id = m.event_id
      WHERE (m.player_a_id = $1 OR m.player_b_id = $1)
        AND m.event_id <> $2
        AND m.outcome IN ('a_wins', 'b_wins')
        AND e.event_date >= (CURRENT_DATE - INTERVAL '7 days')
    `,
    [userId, eventId]
  )
  return res.rows.map((r) => r.opponent_id)
}

async function badgeXpForUserInSeason(userId: number, seasonStart: string, seasonEnd: string): Promise<number> {
  const res = await db.query<{ xp_reward: number }>(
    `
      SELECT COALESCE(bd.xp_reward, 0)::int AS xp_reward
      FROM user_badges ub
      JOIN badge_definitions bd ON bd.id = ub.badge_id
      WHERE ub.user_id = $1
        AND ub.awarded_at::date >= $2::date
        AND ub.awarded_at::date <= $3::date
    `,
    [userId, seasonStart, seasonEnd]
  )
  return res.rows.reduce((s, r) => s + (r.xp_reward ?? 0), 0)
}

export async function recalculatePlayerProgression(userId: number): Promise<PlayerProgressSnapshot> {
  const season = (await getActiveSeason()) ?? (await ensureDefaultActiveSeason())
  const antiFarm = await getAntiFarmingConfig()
  const veteranGrace = await getVeteranGraceConfig()

  await db.query(
    `
      INSERT INTO player_season_stats (user_id, season_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, season_id) DO NOTHING
    `,
    [userId, season.id]
  )

  await db.query(`DELETE FROM event_xp_awards WHERE user_id = $1 AND season_id = $2`, [userId, season.id])

  const events = await db.query<{
    eventId: number
    placement: number
    eventTier: string | null
    eventDate: string | Date | null
    attended: boolean
  }>(
    `
      SELECT
        e.id AS "eventId",
        a.placement,
        e.event_tier AS "eventTier",
        e.event_date AS "eventDate",
        a.attended
      FROM event_attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.user_id = $1
        AND a.attended = TRUE
        AND a.placement IS NOT NULL
        AND a.placement >= 1
        AND (e.season_id = $2 OR (e.season_id IS NULL AND e.event_date >= $3::date AND e.event_date <= $4::date))
      ORDER BY COALESCE(e.event_date, a.updated_at::date), a.updated_at
    `,
    [userId, season.id, season.startDate, season.endDate]
  )

  const judged = await db.query<{
    eventId: number
    eventTier: string | null
    eventDate: string | Date | null
    awardType: string
  }>(
    `
      SELECT e.id AS "eventId", e.event_tier AS "eventTier", e.event_date AS "eventDate",
        j.award_type AS "awardType"
      FROM event_judged_awards j
      JOIN events e ON e.id = j.event_id
      WHERE j.winner_user_id = $1
        AND (e.season_id = $2 OR (e.season_id IS NULL AND e.event_date >= $3::date AND e.event_date <= $4::date))
    `,
    [userId, season.id, season.startDate, season.endDate]
  )

  const eventsByDay = new Map<string, typeof events.rows>()
  for (const row of events.rows) {
    const dk = dateKey(row.eventDate)
    const list = eventsByDay.get(dk) ?? []
    list.push(row)
    eventsByDay.set(dk, list)
  }
  for (const row of judged.rows) {
    const dk = dateKey(row.eventDate)
    if (!eventsByDay.has(dk)) eventsByDay.set(dk, [])
  }

  let seasonXp = 0
  const weeklyOpponents = new Map<string, Set<number>>()

  for (const [day, dayEvents] of eventsByDay) {
    let dayIndex = 0
    for (const row of dayEvents) {
      const fieldSize = await getEventFieldSize(row.eventId)
      const participantCount = fieldSize
      const wk = weekKey(day)
      const beatenSet = weeklyOpponents.get(wk) ?? new Set<number>()
      const opponents = await loadWeeklyOpponents(userId, row.eventId)
      for (const o of opponents) beatenSet.add(o)
      weeklyOpponents.set(wk, beatenSet)

      const xp = computeRawEventXp({
        placement: row.placement,
        fieldSize: Math.max(fieldSize, 1),
        eventTier: row.eventTier,
        eventDate: day,
        participantCount,
        opponentsBeatenThisWeek: beatenSet,
        eventIndexOnDay: dayIndex,
        antiFarm,
      })

      if (xp > 0) {
        await db.query(
          `
            INSERT INTO event_xp_awards (user_id, event_id, season_id, xp_amount, award_type, event_date)
            VALUES ($1, $2, $3, $4, 'placement', $5::date)
            ON CONFLICT (user_id, event_id, award_type) DO UPDATE SET xp_amount = EXCLUDED.xp_amount
          `,
          [userId, row.eventId, season.id, xp, day]
        )
        seasonXp += xp
      }
      dayIndex++
    }
  }

  const judgedByDay = new Map<string, typeof judged.rows>()
  for (const row of judged.rows) {
    const dk = dateKey(row.eventDate)
    const list = judgedByDay.get(dk) ?? []
    list.push(row)
    judgedByDay.set(dk, list)
  }

  for (const [day, dayJudged] of judgedByDay) {
    const dayEventCount = eventsByDay.get(day)?.length ?? 0
    let jIndex = 0
    for (const row of dayJudged) {
      const eventIndexOnDay = dayEventCount + jIndex
      const xp = computeJudgedXp(row.eventTier, eventIndexOnDay, antiFarm)
      if (xp > 0) {
        await db.query(
          `
            INSERT INTO event_xp_awards (user_id, event_id, season_id, xp_amount, award_type, event_date)
            VALUES ($1, $2, $3, $4, $5, $6::date)
            ON CONFLICT (user_id, event_id, award_type) DO UPDATE SET xp_amount = EXCLUDED.xp_amount
          `,
          [userId, row.eventId, season.id, xp, row.awardType, day]
        )
        seasonXp += xp
      }
      jIndex++
    }
  }

  seasonXp += await badgeXpForUserInSeason(userId, season.startDate, season.endDate)

  const currentRank = getRankForSeasonXp(seasonXp, season.rankThresholds)
  const prevStats = await db.query<{ best_rank: string }>(
    `SELECT best_rank FROM player_season_stats WHERE user_id = $1 AND season_id = $2`,
    [userId, season.id]
  )
  const prevBest = (prevStats.rows[0]?.best_rank as RankTier) ?? 'Bronze'
  const bestSeasonRank = higherRank(prevBest, currentRank)

  const userBest = await db.query<{ best_rank: string | null }>(
    `SELECT best_rank FROM users WHERE id = $1`,
    [userId]
  )
  const lifetimeBest = higherRank(
    (userBest.rows[0]?.best_rank as RankTier) ?? 'Bronze',
    currentRank
  )

  const previousEntitlement = await getPreviousSeasonEntitlementTier(userId, season.id)
  const inGrace = isWithinGracePeriod(season.startDate, veteranGrace.weeks)
  const seasonRankTier = currentRank
  const entitlementTier = graceEntitlementTier(
    seasonRankTier,
    previousEntitlement,
    veteranGrace.enabled,
    inGrace
  )

  await db.query(
    `
      UPDATE player_season_stats SET
        season_xp = $3,
        current_rank = $4,
        best_rank = $5,
        entitlement_tier = $6,
        grace_entitlement_tier = $7,
        updated_at = NOW()
      WHERE user_id = $1 AND season_id = $2
    `,
    [
      userId,
      season.id,
      seasonXp,
      currentRank,
      bestSeasonRank,
      entitlementTier,
      previousEntitlement,
    ]
  )

  const lifetimeRes = await db.query<{ total: number }>(
    `
      SELECT COALESCE(SUM(xp_amount), 0)::int AS total
      FROM event_xp_awards WHERE user_id = $1
    `,
    [userId]
  )
  const lifetimeXp = lifetimeRes.rows[0]?.total ?? seasonXp

  await db.query(
    `
      UPDATE users SET xp = $2, rank = $3, best_rank = $4 WHERE id = $1
    `,
    [userId, lifetimeXp, currentRank, lifetimeBest]
  )

  return {
    seasonXp,
    currentRank,
    bestRank: bestSeasonRank,
    entitlementTier,
    lifetimeXp,
  }
}

export async function recalculateEventParticipants(eventId: number): Promise<void> {
  const res = await db.query<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM event_attendance WHERE event_id = $1`,
    [eventId]
  )
  for (const row of res.rows) {
    await recalculatePlayerProgression(row.user_id)
  }
  const judged = await db.query<{ winner_user_id: number }>(
    `SELECT winner_user_id FROM event_judged_awards WHERE event_id = $1`,
    [eventId]
  )
  for (const row of judged.rows) {
    await recalculatePlayerProgression(row.winner_user_id)
  }
}

export async function getPlayerSeasonSnapshot(userId: number): Promise<PlayerProgressSnapshot | null> {
  const season = await getActiveSeason()
  if (!season) return null
  const res = await db.query<{
    season_xp: number
    current_rank: string
    best_rank: string
    entitlement_tier: string
  }>(
    `SELECT season_xp, current_rank, best_rank, entitlement_tier
     FROM player_season_stats WHERE user_id = $1 AND season_id = $2`,
    [userId, season.id]
  )
  const user = await db.query<{ xp: number }>(`SELECT xp FROM users WHERE id = $1`, [userId])
  if (!res.rows[0]) return null
  return {
    seasonXp: res.rows[0].season_xp,
    currentRank: res.rows[0].current_rank as RankTier,
    bestRank: res.rows[0].best_rank as RankTier,
    entitlementTier: res.rows[0].entitlement_tier as RankTier,
    lifetimeXp: user.rows[0]?.xp ?? 0,
  }
}

export type UserSeasonDisplay = {
  xp: number
  rank: RankTier
  seasonXp: number
  lifetimeXp: number
  entitlementTier: RankTier
}

/** Season XP/rank for all player-facing API responses. */
export async function getUserSeasonDisplay(userId: number): Promise<UserSeasonDisplay> {
  const snap = await getPlayerSeasonSnapshot(userId)
  const userRes = await db.query<{ xp: number }>(
    `SELECT COALESCE(xp, 0)::int AS xp FROM users WHERE id = $1`,
    [userId]
  )
  const lifetimeXp = Math.max(0, userRes.rows[0]?.xp ?? 0)
  const seasonXp = snap?.seasonXp ?? 0
  const rank = snap?.currentRank ?? 'Bronze'
  return {
    xp: seasonXp,
    rank,
    seasonXp,
    lifetimeXp,
    entitlementTier: snap?.entitlementTier ?? rank,
  }
}

const RANK_SORT_CASE = RANK_ORDER.map((tier, i) => `WHEN '${tier}' THEN ${RANK_ORDER.length - i}`).join(' ')

export async function listPlayersSeasonDisplay(options?: {
  query?: string
  limit?: number
}): Promise<Array<{ id: number; name: string; profileImageUrl: string | null; xp: number; rank: RankTier }>> {
  const season = await getActiveSeason()
  const seasonId = season?.id ?? null
  const params: unknown[] = [seasonId]
  let sql = `
    SELECT
      u.id,
      u.name,
      u.profile_image_url AS "profileImageUrl",
      COALESCE(pss.season_xp, 0)::int AS xp,
      COALESCE(pss.current_rank, 'Bronze') AS rank
    FROM users u
    LEFT JOIN player_season_stats pss ON pss.user_id = u.id AND pss.season_id = $1
  `
  const q = options?.query?.trim().toLowerCase()
  if (q && q.length >= 2) {
    params.push(`%${q}%`)
    sql += ` WHERE LOWER(u.name) LIKE $${params.length}`
  }
  sql += `
    ORDER BY
      CASE COALESCE(pss.current_rank, 'Bronze')
        ${RANK_SORT_CASE}
        ELSE 0
      END DESC,
      COALESCE(pss.season_xp, 0) DESC,
      u.name ASC
  `
  const limit = options?.limit ?? (q && q.length >= 2 ? 50 : 30)
  sql += ` LIMIT ${limit}`
  const res = await db.query(sql, params)
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    profileImageUrl: row.profileImageUrl ?? null,
    xp: Math.max(0, Number(row.xp) || 0),
    rank: (row.rank as RankTier) || 'Bronze',
  }))
}

export { RANK_ORDER, type RankTier }
