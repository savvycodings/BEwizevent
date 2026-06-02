import express from 'express'
import multer from 'multer'
import { db } from '../db'
import { uploadToCloudinary } from '../helpers/uploadToCloudinary'
import { getPlacementBadgeId, RANK_ORDER, recalculatePlayerRankAndXp } from '../ranking'
import { setEventPlacementWithShift } from '../placementShift'
import {
  ensureAttendanceDeckFromActive,
  ensureAttendanceDecksFromActive,
  getAttendanceDeckSnapshot,
  setAttendanceDeck,
} from '../deckStats'
import { deckLabel, isValidDeckId } from '../deckCatalog'
import {
  logAttendanceDeckSaved,
  logAttendanceMarked,
  logMatchRecorded,
  logPlacementSaved,
} from '../deckLog'
import { requireAdminPass } from '../middleware/requireAdminPass'
import { isEventTier, normalizeEventTier } from '../eventTiers'
import {
  getJudgedAwardBonusXp,
  isJudgedAwardType,
  JUDGED_AWARD_CRITERIA,
  JUDGED_AWARD_LABEL,
  JUDGED_AWARD_TYPES,
  type JudgedAwardType,
} from '../judgedAwards'
import { importTdfForEvent } from '../tdfImport'
import { hintFromFileName } from '../tdfParser'
import {
  entitlementTierForXp,
  getRankEntitlementsForUser,
  isEntitlementTier,
  redeemRankEntitlement,
} from '../rankEntitlements'

const router = express.Router()
router.use(requireAdminPass)
const upload = multer({ storage: multer.memoryStorage() })
const MANUAL_BADGE_IDS = [
  'champion',
  'magician',
  'sweat',
  'scholar',
  'quick',
  'scientist',
  'flawless',
] as const

router.get('/users', async (_req, res) => {
  const users = await db.query(
    `
      SELECT
        id,
        name,
        email,
        profile_image_url AS "profileImageUrl",
        xp,
        rank,
        is_admin AS "isAdmin",
        created_at AS "createdAt"
      FROM users
      ORDER BY created_at DESC
    `
  )
  res.json({ users: users.rows })
})

router.get('/rankings', async (_req, res) => {
  const users = await db.query(
    `
      SELECT
        id,
        name,
        xp,
        rank,
        created_at AS "createdAt"
      FROM users
      ORDER BY
        CASE rank
          WHEN $1 THEN 1
          WHEN $2 THEN 2
          WHEN $3 THEN 3
          WHEN $4 THEN 4
          WHEN $5 THEN 5
          WHEN $6 THEN 6
          ELSE 0
        END DESC,
        xp DESC,
        created_at ASC
    `,
    [...RANK_ORDER]
  )
  return res.json({ rankings: users.rows })
})

router.get('/users/:userId/details', async (req, res) => {
  const userId = Number(req.params.userId)
  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: 'userId must be a positive integer' })
  }

  // Keep rank/XP in sync even for users with placements recorded before ranked mode existed.
  await recalculatePlayerRankAndXp(userId)

  const userResult = await db.query(
    `
      SELECT
        id,
        name,
        email,
        profile_image_url AS "profileImageUrl",
        xp,
        rank,
        is_admin AS "isAdmin",
        created_at AS "createdAt"
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  )

  const user = userResult.rows[0]
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const attendance = await db.query(
    `
      SELECT
        e.id AS "eventId",
        e.title AS "eventTitle",
        e.event_date AS "eventDate",
        e.location,
        a.attended,
        a.placement,
        a.updated_at AS "updatedAt"
      FROM event_attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.user_id = $1
      ORDER BY a.updated_at DESC, e.event_date DESC NULLS LAST
    `,
    [userId]
  )

  const earnedBadges = attendance.rows
    .map((row: { eventId: number; eventTitle: string; placement: number | null; updatedAt: string }) => {
      const badgeId = getPlacementBadgeId(row.placement)
      if (!badgeId) return null
      return {
        badgeId,
        placement: row.placement,
        eventId: row.eventId,
        eventTitle: row.eventTitle,
        awardedAt: row.updatedAt,
      }
    })
    .filter(Boolean)

  const manualBadgesRes = await db.query(
    `
      SELECT
        badge_id AS "badgeId",
        awarded_at AS "awardedAt"
      FROM user_badges
      WHERE user_id = $1
      ORDER BY awarded_at DESC
    `,
    [userId]
  )

  const manualBadges = manualBadgesRes.rows.map((row: { badgeId: string; awardedAt: string }) => ({
    badgeId: row.badgeId,
    placement: null,
    eventId: null,
    eventTitle: null,
    awardedAt: row.awardedAt,
  }))

  const stats = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE attended = TRUE)::INTEGER AS "eventsAttended",
        COUNT(*)::INTEGER AS "eventRecords"
      FROM event_attendance
      WHERE user_id = $1
    `,
    [userId]
  )

  return res.json({
    user,
    attendance: attendance.rows,
    badges: [...earnedBadges, ...manualBadges],
    stats: stats.rows[0] ?? { eventsAttended: 0, eventRecords: 0 },
  })
})

router.get('/users/:userId/snapshot', async (req, res) => {
  const userId = Number(req.params.userId)
  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: 'userId must be a positive integer' })
  }

  await recalculatePlayerRankAndXp(userId)

  const userResult = await db.query(
    `
      SELECT
        id,
        name,
        email,
        profile_image_url AS "profileImageUrl",
        xp,
        rank
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  )
  const user = userResult.rows[0]
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  const matchStats = await db.query(
    `
      SELECT
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE m.player_a_id = $1 OR m.player_b_id = $1
        ), 0) AS "gamesPlayed",
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE (m.player_a_id = $1 AND m.outcome = 'a_wins')
             OR (m.player_b_id = $1 AND m.outcome = 'b_wins')
        ), 0) AS wins,
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE (m.player_a_id = $1 AND m.outcome = 'b_wins')
             OR (m.player_b_id = $1 AND m.outcome = 'a_wins')
        ), 0) AS losses,
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE (m.player_a_id = $1 OR m.player_b_id = $1) AND m.outcome = 'draw'
        ), 0) AS draws
    `,
    [userId]
  )

  const placementStats = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE attended = TRUE AND placement = 1)::INTEGER AS "firstPlace",
        COUNT(*) FILTER (WHERE attended = TRUE AND placement = 2)::INTEGER AS "secondPlace",
        COUNT(*) FILTER (WHERE attended = TRUE AND placement = 3)::INTEGER AS "thirdPlace",
        COUNT(*) FILTER (WHERE attended = TRUE AND placement >= 1 AND placement <= 5)::INTEGER AS "topFiveFinishes",
        COUNT(*) FILTER (WHERE attended = TRUE)::INTEGER AS "eventsAttended"
      FROM event_attendance
      WHERE user_id = $1
    `,
    [userId]
  )

  const m = matchStats.rows[0] ?? { gamesPlayed: 0, wins: 0, losses: 0, draws: 0 }
  const p = placementStats.rows[0] ?? {
    firstPlace: 0,
    secondPlace: 0,
    thirdPlace: 0,
    topFiveFinishes: 0,
    eventsAttended: 0,
  }

  const gamesPlayed = Number(m.gamesPlayed) || 0
  const wins = Number(m.wins) || 0
  const losses = Number(m.losses) || 0
  const draws = Number(m.draws) || 0
  const winRatioPercent =
    gamesPlayed > 0 ? Math.round(((wins + 0.5 * draws) / gamesPlayed) * 100) : 0

  return res.json({
    user,
    snapshot: {
      gamesPlayed,
      wins,
      losses,
      draws,
      winRatioPercent,
      firstPlace: Number(p.firstPlace) || 0,
      secondPlace: Number(p.secondPlace) || 0,
      thirdPlace: Number(p.thirdPlace) || 0,
      topFiveFinishes: Number(p.topFiveFinishes) || 0,
      eventsAttended: Number(p.eventsAttended) || 0,
    },
  })
})

router.post('/users/:userId/badges', async (req, res) => {
  const userId = Number(req.params.userId)
  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: 'userId must be a positive integer' })
  }

  const badgeId = String(req.body?.badgeId || '').trim().toLowerCase()
  if (!MANUAL_BADGE_IDS.includes(badgeId as (typeof MANUAL_BADGE_IDS)[number])) {
    return res.status(400).json({ error: 'invalid badgeId' })
  }

  await db.query(
    `
      INSERT INTO user_badges (user_id, badge_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, badge_id) DO NOTHING
    `,
    [userId, badgeId]
  )

  return res.json({ ok: true })
})

router.post('/users/:userId/badges/remove', async (req, res) => {
  const userId = Number(req.params.userId)
  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: 'userId must be a positive integer' })
  }

  const badgeId = String(req.body?.badgeId || '').trim().toLowerCase()
  if (!MANUAL_BADGE_IDS.includes(badgeId as (typeof MANUAL_BADGE_IDS)[number])) {
    return res.status(400).json({ error: 'invalid badgeId' })
  }

  await db.query(
    `
      DELETE FROM user_badges
      WHERE user_id = $1 AND badge_id = $2
    `,
    [userId, badgeId]
  )

  return res.json({ ok: true })
})

router.post('/upload-event-banner', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' })
  }
  const uploadRes = await uploadToCloudinary(req.file.buffer, 'wizardsevents/event-banners')
  return res.json({ imageUrl: uploadRes.secure_url })
})

router.get('/events', async (_req, res) => {
  const events = await db.query(
    `
      SELECT
        id,
        title,
        event_date AS "eventDate",
        location,
        banner_image_url AS "bannerImageUrl",
        scheduled_rounds AS "scheduledRounds",
        use_match_tracking AS "useMatchTracking",
        event_tier AS "eventTier",
        created_at AS "createdAt"
      FROM events
      ORDER BY created_at DESC
    `
  )
  res.json({ events: events.rows })
})

/**
 * One event — includes judge settings for match tracking.
 */
router.get('/events/:eventId/settings', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  const eventResult = await db.query(
    `
      SELECT
        id,
        title,
        event_date AS "eventDate",
        location,
        banner_image_url AS "bannerImageUrl",
        scheduled_rounds AS "scheduledRounds",
        use_match_tracking AS "useMatchTracking",
        event_tier AS "eventTier",
        created_at AS "createdAt"
      FROM events
      WHERE id = $1
      LIMIT 1
    `,
    [eventId]
  )
  const event = eventResult.rows[0]
  if (!event) {
    return res.status(404).json({ error: 'Event not found' })
  }
  return res.json({ event })
})

router.patch('/events/:eventId', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  const body = req.body ?? {}
  const exists = await db.query(`SELECT id FROM events WHERE id = $1 LIMIT 1`, [eventId])
  if (!exists.rows[0]) {
    return res.status(404).json({ error: 'Event not found' })
  }
  const pieces: string[] = []
  const vals: unknown[] = []
  let pi = 0
  if (Object.prototype.hasOwnProperty.call(body, 'scheduledRounds')) {
    const v = body.scheduledRounds
    if (v === null || v === '') {
      pieces.push('scheduled_rounds = NULL')
    } else {
      const n = Math.floor(Number(v))
      if (!Number.isInteger(n) || n < 0 || n > 99) {
        return res.status(400).json({ error: 'scheduledRounds must be null or 0–99' })
      }
      pi++
      pieces.push(`scheduled_rounds = $${pi}`)
      vals.push(n)
    }
  }
  if (typeof body.useMatchTracking === 'boolean') {
    pi++
    pieces.push(`use_match_tracking = $${pi}`)
    vals.push(body.useMatchTracking)
  }
  if (pieces.length === 0) {
    return res.status(400).json({ error: 'Provide scheduledRounds and/or useMatchTracking' })
  }
  pi++
  vals.push(eventId)
  const result = await db.query(
    `
      UPDATE events
      SET ${pieces.join(', ')}
      WHERE id = $${pi}
      RETURNING
        id,
        title,
        event_date AS "eventDate",
        location,
        banner_image_url AS "bannerImageUrl",
        scheduled_rounds AS "scheduledRounds",
        use_match_tracking AS "useMatchTracking",
        event_tier AS "eventTier",
        created_at AS "createdAt"
    `,
    vals
  )
  return res.json({ event: result.rows[0] })
})

router.get('/events/:eventId/matches', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  const eventResult = await db.query(`SELECT id FROM events WHERE id = $1 LIMIT 1`, [eventId])
  if (!eventResult.rows[0]) {
    return res.status(404).json({ error: 'Event not found' })
  }
  const rows = await db.query(
    `
      SELECT
        m.id,
        m.event_id AS "eventId",
        m.round_number AS "roundNumber",
        m.player_a_id AS "playerAId",
        m.player_b_id AS "playerBId",
        m.outcome,
        m.updated_at AS "updatedAt",
        ua.name AS "playerAName",
        ub.name AS "playerBName"
      FROM event_matches m
      JOIN users ua ON ua.id = m.player_a_id
      JOIN users ub ON ub.id = m.player_b_id
      WHERE m.event_id = $1
      ORDER BY m.round_number ASC, m.player_a_id ASC
    `,
    [eventId]
  )
  return res.json({ matches: rows.rows })
})

/** Normalize focal + opponent + W/L/D into stored row (player_a_id < player_b_id). */
function matchRowFromFocalResult(
  focalUserId: number,
  opponentUserId: number,
  result: 'win' | 'loss' | 'draw'
): { playerAId: number; playerBId: number; outcome: 'a_wins' | 'b_wins' | 'draw' } {
  if (focalUserId === opponentUserId) {
    throw new Error('Opponent must differ from player')
  }
  const low = Math.min(focalUserId, opponentUserId)
  const high = Math.max(focalUserId, opponentUserId)
  if (result === 'draw') {
    return { playerAId: low, playerBId: high, outcome: 'draw' }
  }
  const focalWon = result === 'win'
  if (focalUserId === low) {
    return { playerAId: low, playerBId: high, outcome: focalWon ? 'a_wins' : 'b_wins' }
  }
  return { playerAId: low, playerBId: high, outcome: focalWon ? 'b_wins' : 'a_wins' }
}

router.post('/events/:eventId/matches', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  const { roundNumber, focalUserId, opponentUserId, result } = req.body ?? {}
  const r = String(result || '').toLowerCase()
  if (!['win', 'loss', 'draw'].includes(r)) {
    return res.status(400).json({ error: 'result must be win, loss, or draw' })
  }
  const round = Math.floor(Number(roundNumber))
  const focal = Math.floor(Number(focalUserId))
  const opponent = Math.floor(Number(opponentUserId))
  if (!Number.isInteger(round) || round < 1 || round > 99) {
    return res.status(400).json({ error: 'roundNumber must be 1–99' })
  }
  if (!Number.isInteger(focal) || focal < 1 || !Number.isInteger(opponent) || opponent < 1) {
    return res.status(400).json({ error: 'focalUserId and opponentUserId are required' })
  }
  const eventResult = await db.query(`SELECT id FROM events WHERE id = $1 LIMIT 1`, [eventId])
  if (!eventResult.rows[0]) {
    return res.status(404).json({ error: 'Event not found' })
  }
  const attended = await db.query(
    `
      SELECT COUNT(*)::INTEGER AS c FROM event_attendance
      WHERE event_id = $1
        AND user_id IN ($2, $3)
        AND attended = TRUE
    `,
    [eventId, focal, opponent]
  )
  if (Number(attended.rows[0]?.c) < 2) {
    return res.status(400).json({ error: 'Both players must be marked attended for this event' })
  }
  await db.query(
    `
      DELETE FROM event_matches
      WHERE event_id = $1 AND round_number = $2
        AND (player_a_id = $3 OR player_b_id = $3)
    `,
    [eventId, round, focal]
  )
  let row
  try {
    row = matchRowFromFocalResult(focal, opponent, r as 'win' | 'loss' | 'draw')
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || 'Invalid match' })
  }
  await db.query(
    `
      INSERT INTO event_matches (event_id, round_number, player_a_id, player_b_id, outcome)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (event_id, round_number, player_a_id, player_b_id)
      DO UPDATE SET outcome = EXCLUDED.outcome, updated_at = NOW()
    `,
    [eventId, round, row.playerAId, row.playerBId, row.outcome]
  )
  await ensureAttendanceDecksFromActive(eventId, [focal, opponent])
  const snap = await getAttendanceDeckSnapshot(focal, eventId)
  const focalWon = r === 'win'
  logMatchRecorded({
    userId: focal,
    eventId,
    roundNumber: round,
    focalUserId: focal,
    opponentUserId: opponent,
    result: r,
    deckId: snap.deckId,
    deckLabel: snap.deckId ? deckLabel(snap.deckId) : null,
    focalWon,
  })
  return res.json({ ok: true })
})

router.delete('/events/:eventId/matches', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  const { focalUserId, roundNumber } = req.body ?? {}
  const round = Math.floor(Number(roundNumber))
  const focal = Math.floor(Number(focalUserId))
  if (!Number.isInteger(round) || round < 1 || round > 99) {
    return res.status(400).json({ error: 'roundNumber must be 1–99' })
  }
  if (!Number.isInteger(focal) || focal < 1) {
    return res.status(400).json({ error: 'focalUserId is required' })
  }
  const eventResult = await db.query(`SELECT id FROM events WHERE id = $1 LIMIT 1`, [eventId])
  if (!eventResult.rows[0]) {
    return res.status(404).json({ error: 'Event not found' })
  }
  await db.query(
    `
      DELETE FROM event_matches
      WHERE event_id = $1 AND round_number = $2
        AND (player_a_id = $3 OR player_b_id = $3)
    `,
    [eventId, round, focal]
  )
  return res.json({ ok: true })
})

router.get('/events/:eventId/leaderboard', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }

  const eventResult = await db.query(
    `
      SELECT
        id,
        title,
        event_date AS "eventDate",
        location,
        banner_image_url AS "bannerImageUrl",
        scheduled_rounds AS "scheduledRounds",
        use_match_tracking AS "useMatchTracking",
        event_tier AS "eventTier",
        created_at AS "createdAt"
      FROM events
      WHERE id = $1
      LIMIT 1
    `,
    [eventId]
  )

  const event = eventResult.rows[0]
  if (!event) {
    return res.status(404).json({ error: 'Event not found' })
  }

  const leaderboard = await db.query(
    `
      SELECT
        a.user_id AS "userId",
        u.name AS "userName",
        u.email AS "userEmail",
        a.placement,
        a.attended,
        a.deck_id AS "deckId",
        a.updated_at AS "updatedAt",
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE m.event_id = a.event_id
            AND (m.player_a_id = a.user_id OR m.player_b_id = a.user_id)
        ), 0) AS "gamesPlayed",
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE m.event_id = a.event_id
            AND (
              (m.player_a_id = a.user_id AND m.outcome = 'a_wins')
              OR (m.player_b_id = a.user_id AND m.outcome = 'b_wins')
            )
        ), 0) AS "wins",
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE m.event_id = a.event_id
            AND (
              (m.player_a_id = a.user_id AND m.outcome = 'b_wins')
              OR (m.player_b_id = a.user_id AND m.outcome = 'a_wins')
            )
        ), 0) AS "losses",
        COALESCE((
          SELECT COUNT(*)::INTEGER FROM event_matches m
          WHERE m.event_id = a.event_id
            AND (m.player_a_id = a.user_id OR m.player_b_id = a.user_id)
            AND m.outcome = 'draw'
        ), 0) AS "draws",
        (
          SELECT u_opp.id FROM event_matches m
          JOIN users u_opp ON u_opp.id = (
            CASE
              WHEN m.player_a_id = a.user_id THEN m.player_b_id
              ELSE m.player_a_id
            END
          )
          WHERE m.event_id = a.event_id
            AND (m.player_a_id = a.user_id OR m.player_b_id = a.user_id)
            AND (
              (m.player_a_id = a.user_id AND m.outcome = 'b_wins')
              OR (m.player_b_id = a.user_id AND m.outcome = 'a_wins')
            )
          ORDER BY m.round_number DESC, m.updated_at DESC
          LIMIT 1
        ) AS "lostToUserId",
        (
          SELECT u_opp.name FROM event_matches m
          JOIN users u_opp ON u_opp.id = (
            CASE
              WHEN m.player_a_id = a.user_id THEN m.player_b_id
              ELSE m.player_a_id
            END
          )
          WHERE m.event_id = a.event_id
            AND (m.player_a_id = a.user_id OR m.player_b_id = a.user_id)
            AND (
              (m.player_a_id = a.user_id AND m.outcome = 'b_wins')
              OR (m.player_b_id = a.user_id AND m.outcome = 'a_wins')
            )
          ORDER BY m.round_number DESC, m.updated_at DESC
          LIMIT 1
        ) AS "lostToName",
        (
          SELECT opp_att.deck_id
          FROM event_matches m
          JOIN users u_opp ON u_opp.id = (
            CASE
              WHEN m.player_a_id = a.user_id THEN m.player_b_id
              ELSE m.player_a_id
            END
          )
          LEFT JOIN event_attendance opp_att
            ON opp_att.event_id = m.event_id AND opp_att.user_id = u_opp.id
          WHERE m.event_id = a.event_id
            AND (m.player_a_id = a.user_id OR m.player_b_id = a.user_id)
            AND (
              (m.player_a_id = a.user_id AND m.outcome = 'b_wins')
              OR (m.player_b_id = a.user_id AND m.outcome = 'a_wins')
            )
          ORDER BY m.round_number DESC, m.updated_at DESC
          LIMIT 1
        ) AS "lostToDeckId",
        (
          SELECT COALESCE(
            json_agg(
              json_build_object(
                'userId', u_opp.id,
                'name', u_opp.name,
                'deckId', opp_att.deck_id
              )
              ORDER BY m.round_number ASC, m.updated_at ASC
            ),
            '[]'::json
          )
          FROM event_matches m
          JOIN users u_opp ON u_opp.id = (
            CASE
              WHEN m.player_a_id = a.user_id THEN m.player_b_id
              ELSE m.player_a_id
            END
          )
          LEFT JOIN event_attendance opp_att
            ON opp_att.event_id = m.event_id AND opp_att.user_id = u_opp.id
          WHERE m.event_id = a.event_id
            AND (m.player_a_id = a.user_id OR m.player_b_id = a.user_id)
            AND (
              (m.player_a_id = a.user_id AND m.outcome = 'b_wins')
              OR (m.player_b_id = a.user_id AND m.outcome = 'a_wins')
            )
        ) AS "lossesTo"
      FROM event_attendance a
      JOIN users u ON u.id = a.user_id
      WHERE a.event_id = $1 AND a.attended = TRUE
      ORDER BY
        CASE WHEN a.placement IS NULL OR a.placement < 1 THEN 1 ELSE 0 END,
        a.placement ASC NULLS LAST,
        u.name ASC,
        a.updated_at DESC
    `,
    [eventId]
  )

  const attendanceStats = await db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE attended = TRUE)::INTEGER AS "attendeeCount",
        COUNT(*) FILTER (WHERE placement IS NOT NULL)::INTEGER AS "participantCount"
      FROM event_attendance
      WHERE event_id = $1
    `,
    [eventId]
  )

  return res.json({
    event,
    leaderboard: leaderboard.rows,
    stats: attendanceStats.rows[0] ?? { attendeeCount: 0, participantCount: 0 },
  })
})

/** Full roster for an event with placement per player (for judges; includes users without a row yet). */
router.get('/events/:eventId/placement-board', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }

  const eventResult = await db.query(`SELECT id FROM events WHERE id = $1 LIMIT 1`, [eventId])
  if (!eventResult.rows[0]) {
    return res.status(404).json({ error: 'Event not found' })
  }

  const rows = await db.query(
    `
      SELECT
        u.id AS "userId",
        u.name AS "userName",
        u.email AS "userEmail",
        COALESCE(a.attended, FALSE) AS "attended",
        a.placement AS "placement",
        a.deck_id AS "deckId",
        u.active_deck_id AS "suggestedDeckId"
      FROM users u
      LEFT JOIN event_attendance a ON a.user_id = u.id AND a.event_id = $1
      ORDER BY
        CASE WHEN a.placement IS NULL THEN 1 ELSE 0 END,
        a.placement ASC NULLS LAST,
        u.name ASC
    `,
    [eventId]
  )

  return res.json({ placements: rows.rows })
})

router.get('/events/:eventId/judged-awards', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  const eventRes = await db.query<{ event_tier: string }>(
    `SELECT event_tier FROM events WHERE id = $1`,
    [eventId]
  )
  if (!eventRes.rows[0]) return res.status(404).json({ error: 'Event not found' })

  const tier = eventRes.rows[0].event_tier
  const bonusXp = getJudgedAwardBonusXp(tier)

  const rows = await db.query(
    `
      SELECT
        j.award_type AS "awardType",
        j.winner_user_id AS "userId",
        u.name AS "userName",
        j.awarded_at AS "awardedAt"
      FROM event_judged_awards j
      JOIN users u ON u.id = j.winner_user_id
      WHERE j.event_id = $1
    `,
    [eventId]
  )

  const byType = new Map(rows.rows.map((r) => [r.awardType, r]))
  const awards = JUDGED_AWARD_TYPES.map((awardType) => {
    const row = byType.get(awardType)
    return {
      awardType,
      label: JUDGED_AWARD_LABEL[awardType],
      criteria: JUDGED_AWARD_CRITERIA[awardType],
      userId: row?.userId ?? null,
      userName: row?.userName ?? null,
      awardedAt: row?.awardedAt ?? null,
      bonusXp,
    }
  })

  return res.json({ eventTier: tier, bonusXp, awards })
})

router.post('/events/:eventId/judged-awards', async (req, res) => {
  const eventId = Number(req.params.eventId)
  const awardType = String(req.body?.awardType ?? '')
  const userIdRaw = req.body?.userId
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  if (!isJudgedAwardType(awardType)) {
    return res.status(400).json({ error: 'awardType must be best_bling or best_rogue' })
  }

  const eventRes = await db.query<{ event_tier: string }>(
    `SELECT event_tier FROM events WHERE id = $1`,
    [eventId]
  )
  if (!eventRes.rows[0]) return res.status(404).json({ error: 'Event not found' })

  const previous = await db.query<{ winner_user_id: number }>(
    `SELECT winner_user_id FROM event_judged_awards WHERE event_id = $1 AND award_type = $2`,
    [eventId, awardType]
  )
  const previousWinnerId = previous.rows[0]?.winner_user_id ?? null

  if (userIdRaw == null || userIdRaw === '') {
    await db.query(
      `DELETE FROM event_judged_awards WHERE event_id = $1 AND award_type = $2`,
      [eventId, awardType]
    )
  } else {
    const userId = Number(userIdRaw)
    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ error: 'userId must be a positive integer' })
    }
    const userCheck = await db.query(`SELECT id FROM users WHERE id = $1`, [userId])
    if (!userCheck.rows[0]) return res.status(404).json({ error: 'User not found' })

    await db.query(
      `
        INSERT INTO event_judged_awards (event_id, award_type, winner_user_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (event_id, award_type)
        DO UPDATE SET winner_user_id = EXCLUDED.winner_user_id, awarded_at = NOW()
      `,
      [eventId, awardType, userId]
    )
  }

  const toRecalc = new Set<number>()
  if (previousWinnerId) toRecalc.add(previousWinnerId)
  if (userIdRaw != null && userIdRaw !== '') toRecalc.add(Number(userIdRaw))
  for (const uid of toRecalc) {
    await recalculatePlayerRankAndXp(uid)
  }

  const rows = await db.query(
    `
      SELECT
        j.award_type AS "awardType",
        j.winner_user_id AS "userId",
        u.name AS "userName"
      FROM event_judged_awards j
      JOIN users u ON u.id = j.winner_user_id
      WHERE j.event_id = $1
    `,
    [eventId]
  )
  const byType = new Map(rows.rows.map((r) => [r.awardType, r]))
  const bonusXp = getJudgedAwardBonusXp(eventRes.rows[0].event_tier)
  const awards = JUDGED_AWARD_TYPES.map((t: JudgedAwardType) => {
    const row = byType.get(t)
    return {
      awardType: t,
      label: JUDGED_AWARD_LABEL[t],
      criteria: JUDGED_AWARD_CRITERIA[t],
      userId: row?.userId ?? null,
      userName: row?.userName ?? null,
      bonusXp,
    }
  })

  return res.json({ ok: true, bonusXp, awards })
})

router.post('/events', async (req, res) => {
  const { title, eventDate, location, createdBy, bannerImageUrl, eventTier } = req.body ?? {}
  if (!title) {
    return res.status(400).json({ error: 'title is required' })
  }
  const banner = String(bannerImageUrl ?? '').trim()
  if (!banner) {
    return res.status(400).json({ error: 'bannerImageUrl is required' })
  }
  const tierRaw = eventTier == null || eventTier === '' ? 'casual' : String(eventTier)
  if (!isEventTier(tierRaw)) {
    return res.status(400).json({ error: 'eventTier must be casual, challenge, or cup' })
  }
  const tier = normalizeEventTier(tierRaw)

  const result = await db.query(
    `
      INSERT INTO events (title, event_date, location, banner_image_url, created_by, event_tier)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        title,
        event_date AS "eventDate",
        location,
        banner_image_url AS "bannerImageUrl",
        event_tier AS "eventTier",
        created_at AS "createdAt"
    `,
    [title, eventDate || null, location || null, banner, createdBy || null, tier]
  )

  return res.status(201).json({ event: result.rows[0] })
})

router.get('/attendance', async (_req, res) => {
  const rows = await db.query(
    `
      SELECT
        a.id,
        a.attended,
        a.placement,
        a.deck_id AS "deckId",
        a.updated_at AS "updatedAt",
        u.id AS "userId",
        u.name AS "userName",
        u.email AS "userEmail",
        u.active_deck_id AS "suggestedDeckId",
        e.id AS "eventId",
        e.title AS "eventTitle"
      FROM event_attendance a
      JOIN users u ON u.id = a.user_id
      JOIN events e ON e.id = a.event_id
      ORDER BY a.updated_at DESC
    `
  )
  res.json({ attendance: rows.rows })
})

router.post('/attendance-placement', async (req, res) => {
  const { userId, eventId, placement } = req.body ?? {}
  if (!userId || !eventId) {
    return res.status(400).json({ error: 'userId and eventId are required' })
  }
  if (placement !== null && placement !== undefined) {
    const n = Number(placement)
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      return res.status(400).json({ error: 'placement must be null or an integer from 1 to 99' })
    }
  }

  const place =
    placement === null || placement === undefined ? null : Math.floor(Number(placement))

  try {
    const eventIdNum = Number(eventId)
    const userIdNum = Number(userId)
    const affectedUserIds = await setEventPlacementWithShift(eventIdNum, userIdNum, place)
    await ensureAttendanceDeckFromActive(userIdNum, eventIdNum)
    const snap = await getAttendanceDeckSnapshot(userIdNum, eventIdNum)
    logPlacementSaved({
      userId: userIdNum,
      eventId: eventIdNum,
      placement: snap.placement,
      deckId: snap.deckId,
      deckLabel: snap.deckId ? deckLabel(snap.deckId) : null,
      isEventWin: snap.placement === 1,
    })
    await Promise.all(affectedUserIds.map((id) => recalculatePlayerRankAndXp(id)))
    return res.json({ ok: true })
  } catch (err: any) {
    console.error('attendance-placement failed', err)
    return res.status(500).json({ error: err?.message || 'Placement update failed' })
  }
})

router.post('/attendance-deck', async (req, res) => {
  const { userId, eventId, deckId } = req.body ?? {}
  if (!userId || !eventId) {
    return res.status(400).json({ error: 'userId and eventId are required' })
  }
  const deck =
    deckId === null || deckId === undefined || deckId === ''
      ? null
      : String(deckId)
  if (deck != null && !isValidDeckId(deck)) {
    return res.status(400).json({ error: 'Invalid deck id' })
  }
  try {
    const userIdNum = Number(userId)
    const eventIdNum = Number(eventId)
    await setAttendanceDeck(userIdNum, eventIdNum, deck)
    logAttendanceDeckSaved({
      userId: userIdNum,
      eventId: eventIdNum,
      deckId: deck,
      label: deck ? deckLabel(deck) : null,
    })
    return res.json({ ok: true })
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Deck update failed' })
  }
})

router.post('/attendance', async (req, res) => {
  const { userId, eventId, attended } = req.body ?? {}
  if (!userId || !eventId || typeof attended !== 'boolean') {
    return res.status(400).json({ error: 'userId, eventId and attended(boolean) are required' })
  }

  let deckId: string | null = null
  if (attended) {
    const u = await db.query(`SELECT active_deck_id AS "activeDeckId" FROM users WHERE id = $1`, [
      userId,
    ])
    deckId = u.rows[0]?.activeDeckId ?? null
  }

  await db.query(
    `
      INSERT INTO event_attendance (user_id, event_id, attended, deck_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET
        attended = EXCLUDED.attended,
        deck_id = CASE
          WHEN EXCLUDED.attended AND event_attendance.deck_id IS NULL THEN EXCLUDED.deck_id
          ELSE event_attendance.deck_id
        END,
        updated_at = NOW()
    `,
    [userId, eventId, attended, deckId]
  )

  const userIdNum = Number(userId)
  const eventIdNum = Number(eventId)
  if (attended) {
    await ensureAttendanceDeckFromActive(userIdNum, eventIdNum)
  }
  const snap = attended ? await getAttendanceDeckSnapshot(userIdNum, eventIdNum) : null
  logAttendanceMarked({
    userId: userIdNum,
    eventId: eventIdNum,
    attended,
    deckId: snap?.deckId ?? deckId,
    label: snap?.deckId ? deckLabel(snap.deckId) : deckId ? deckLabel(deckId) : null,
  })

  return res.json({ ok: true })
})

router.get('/users/:userId/entitlements', async (req, res) => {
  const userId = Number(req.params.userId)
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user id' })
  }
  try {
    const userRes = await db.query<{ id: number; name: string; xp: number }>(
      `SELECT id, name, COALESCE(xp, 0)::int AS xp FROM users WHERE id = $1`,
      [userId]
    )
    const user = userRes.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })
    const entitlements = await getRankEntitlementsForUser(userId, user.xp)
    return res.json({
      user: { id: user.id, name: user.name, xp: user.xp, currentTier: entitlementTierForXp(user.xp) },
      entitlements,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load entitlements'
    return res.status(500).json({ error: message })
  }
})

router.post('/entitlements/redeem', async (req, res) => {
  const userId = Number(req.body?.userId)
  const tier = String(req.body?.tier ?? '')
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId is required' })
  }
  if (!isEntitlementTier(tier)) {
    return res.status(400).json({ error: 'Invalid tier' })
  }
  try {
    await redeemRankEntitlement(userId, tier, null)
    const userRes = await db.query<{ xp: number; name: string; id: number }>(
      `SELECT id, name, COALESCE(xp, 0)::int AS xp FROM users WHERE id = $1`,
      [userId]
    )
    const user = userRes.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })
    const entitlements = await getRankEntitlementsForUser(userId, user.xp)
    return res.json({
      ok: true,
      user: { id: user.id, name: user.name, xp: user.xp, currentTier: entitlementTierForXp(user.xp) },
      entitlements,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Redeem failed'
    const status = message === 'No active claim to redeem for this tier' ? 400 : 500
    return res.status(status).json({ error: message })
  }
})

router.post('/events/:eventId/import-tdf', async (req, res) => {
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId) || eventId < 1) {
    return res.status(400).json({ error: 'eventId must be a positive integer' })
  }
  const xml = String(req.body?.xml ?? '')
  const fileName = String(req.body?.fileName ?? 'import.tdf')
  if (!xml.trim()) {
    return res.status(400).json({ error: 'xml body is required' })
  }
  if (xml.length > 2_000_000) {
    return res.status(400).json({ error: 'File too large (max 2MB)' })
  }
  try {
    const hint = hintFromFileName(fileName)
    const result = await importTdfForEvent(eventId, xml, fileName)
    return res.json({ ok: true, hint, ...result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Import failed'
    return res.status(400).json({ error: message })
  }
})

export default router
