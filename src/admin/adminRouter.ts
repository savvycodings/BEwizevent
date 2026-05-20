import express from 'express'
import multer from 'multer'
import { db } from '../db'
import { uploadToCloudinary } from '../helpers/uploadToCloudinary'
import { getPlacementBadgeId, RANK_ORDER, recalculatePlayerRankAndXp } from '../ranking'

const router = express.Router()
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
        ) AS "lostToName"
      FROM event_attendance a
      JOIN users u ON u.id = a.user_id
      WHERE a.event_id = $1 AND a.placement IS NOT NULL
      ORDER BY a.placement ASC, a.updated_at DESC
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
        a.placement AS "placement"
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

router.post('/events', async (req, res) => {
  const { title, eventDate, location, createdBy, bannerImageUrl } = req.body ?? {}
  if (!title) {
    return res.status(400).json({ error: 'title is required' })
  }

  const result = await db.query(
    `
      INSERT INTO events (title, event_date, location, banner_image_url, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        title,
        event_date AS "eventDate",
        location,
        banner_image_url AS "bannerImageUrl",
        created_at AS "createdAt"
    `,
    [title, eventDate || null, location || null, bannerImageUrl || null, createdBy || null]
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
        a.updated_at AS "updatedAt",
        u.id AS "userId",
        u.name AS "userName",
        u.email AS "userEmail",
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

  if (place !== null) {
    const clash = await db.query(
      `
        SELECT u.name AS "userName"
        FROM event_attendance a
        JOIN users u ON u.id = a.user_id
        WHERE a.event_id = $1 AND a.placement = $2 AND a.user_id <> $3
        LIMIT 1
      `,
      [eventId, place, userId]
    )
    if (clash.rows[0]) {
      return res.status(409).json({
        error: `Placement ${place} is already assigned to ${clash.rows[0].userName}`,
      })
    }
  }

  await db.query(
    `
      INSERT INTO event_attendance (user_id, event_id, attended, placement)
      VALUES ($1, $2, TRUE, $3)
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET placement = EXCLUDED.placement, attended = TRUE, updated_at = NOW()
    `,
    [userId, eventId, place]
  )

  await recalculatePlayerRankAndXp(Number(userId))

  return res.json({ ok: true })
})

router.post('/attendance', async (req, res) => {
  const { userId, eventId, attended } = req.body ?? {}
  if (!userId || !eventId || typeof attended !== 'boolean') {
    return res.status(400).json({ error: 'userId, eventId and attended(boolean) are required' })
  }

  await db.query(
    `
      INSERT INTO event_attendance (user_id, event_id, attended)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET attended = EXCLUDED.attended, updated_at = NOW()
    `,
    [userId, eventId, attended]
  )

  return res.json({ ok: true })
})

export default router
