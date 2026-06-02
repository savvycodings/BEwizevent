import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import multer from 'multer'
import { db } from '../db'
import { uploadToCloudinary } from '../helpers/uploadToCloudinary'
import { weekStreakFromAttendance } from '../helpers/weekStreak'
import {
  logComparePlayersError,
  logRankProgressError,
  logRankProgressOk,
  logRankProgressRequest,
} from '../chartLog'
import {
  alignCompareToPrimaryTimeline,
  buildRankProgressSeries,
  currentMonthKey,
  isValidMonthKey,
  resolveChartPoints,
  getUserXpSnapshot,
} from '../rankProgress'
import {
  claimRankEntitlement,
  entitlementTierForXp,
  getRankEntitlementsForUser,
  isEntitlementTier,
} from '../rankEntitlements'
import {
  countUserMatchWins,
  getCommunityDeckMeta,
  getDeckProfile,
  setUserActiveDeck,
} from '../deckStats'
import { deckLabel, isValidDeckId } from '../deckCatalog'
import {
  logActiveDeckUpdated,
  logDeckError,
  logDeckProfileOk,
  logDeckProfileRequest,
} from '../deckLog'
import { buildSeasonLeaderboard } from '../seasonXp'
import { isHomeStore, normalizeHomeStore, type HomeStore } from '../stores'

const USER_PROFILE_RETURNING = `
  id,
  name,
  email,
  profile_image_url AS "profileImageUrl",
  is_admin AS "isAdmin",
  home_store AS "homeStore"
`

function toPublicUser(row: Record<string, unknown>) {
  return {
    ...row,
    homeStore: normalizeHomeStore(row.homeStore as string | null | undefined),
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })

router.post('/upload-profile', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' })
  }
  const uploadRes = await uploadToCloudinary(req.file.buffer, 'wizardsevents/profiles')
  return res.json({ imageUrl: uploadRes.secure_url })
})

router.post('/profile-image', async (req, res) => {
  const { userId, imageUrl } = req.body ?? {}
  if (!userId || !imageUrl) {
    return res.status(400).json({ error: 'userId and imageUrl are required' })
  }

  const result = await db.query(
    `
      UPDATE users
      SET profile_image_url = $1
      WHERE id = $2
      RETURNING ${USER_PROFILE_RETURNING}
    `,
    [imageUrl, userId]
  )

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User not found' })
  }

  return res.json({ user: toPublicUser(result.rows[0]) })
})

router.post('/profile', async (req, res) => {
  const { userId, name, email, homeStore } = req.body ?? {}
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' })
  }
  if (name === undefined && email === undefined && homeStore === undefined) {
    return res.status(400).json({ error: 'name, email, or homeStore is required' })
  }

  const existing = await db.query('SELECT id, email FROM users WHERE id = $1', [userId])
  if (!existing.rows[0]) {
    return res.status(404).json({ error: 'User not found' })
  }

  const nextName = name !== undefined ? String(name).trim() : undefined
  const nextEmail = email !== undefined ? String(email).trim().toLowerCase() : undefined

  if (nextName !== undefined && !nextName) {
    return res.status(400).json({ error: 'name cannot be empty' })
  }
  if (nextEmail !== undefined && !nextEmail) {
    return res.status(400).json({ error: 'email cannot be empty' })
  }

  if (nextEmail) {
    const clash = await db.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [
      nextEmail,
      userId,
    ])
    if (clash.rows.length) {
      return res.status(409).json({ error: 'Email is already in use' })
    }
  }

  let nextHomeStore: HomeStore | undefined
  if (homeStore !== undefined) {
    const storeRaw = String(homeStore).trim().toLowerCase()
    if (!isHomeStore(storeRaw)) {
      return res.status(400).json({ error: 'homeStore must be glendower or rosebank' })
    }
    nextHomeStore = storeRaw
  }

  const result = await db.query(
    `
      UPDATE users
      SET
        name = CASE WHEN $1::boolean THEN $2::text ELSE name END,
        email = CASE WHEN $3::boolean THEN $4::text ELSE email END,
        home_store = CASE WHEN $5::boolean THEN $6::text ELSE home_store END
      WHERE id = $7
      RETURNING ${USER_PROFILE_RETURNING}
    `,
    [
      nextName !== undefined,
      nextName ?? '',
      nextEmail !== undefined,
      nextEmail ?? '',
      nextHomeStore !== undefined,
      nextHomeStore ?? '',
      userId,
    ]
  )

  return res.json({ user: toPublicUser(result.rows[0]) })
})

router.post('/signup', async (req, res) => {
  const { name, email, password, profileImageUrl, homeStore, deckId } = req.body ?? {}
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' })
  }
  const storeRaw = String(homeStore ?? '').trim().toLowerCase()
  if (!isHomeStore(storeRaw)) {
    return res.status(400).json({ error: 'homeStore must be glendower or rosebank' })
  }
  const deckRaw = String(deckId ?? '').trim()
  if (!deckRaw || !isValidDeckId(deckRaw)) {
    return res.status(400).json({ error: 'A valid deckId is required' })
  }

  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.rows.length) {
    return res.status(409).json({ error: 'Email already exists' })
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const firstUserResult = await db.query('SELECT COUNT(*)::int AS count FROM users')
  const isFirstUser = Number(firstUserResult.rows[0]?.count || 0) === 0

  const result = await db.query(
    `
      INSERT INTO users (name, email, password_hash, profile_image_url, is_admin, home_store, active_deck_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        id,
        name,
        email,
        profile_image_url AS "profileImageUrl",
        is_admin AS "isAdmin",
        home_store AS "homeStore",
        active_deck_id AS "activeDeckId"
    `,
    [name, email.toLowerCase(), passwordHash, profileImageUrl || null, isFirstUser, storeRaw, deckRaw]
  )

  return res.status(201).json({ user: result.rows[0] })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' })
  }

  const result = await db.query(
    `
      SELECT
        id,
        name,
        email,
        password_hash AS "passwordHash",
        is_admin AS "isAdmin",
        profile_image_url AS "profileImageUrl",
        home_store AS "homeStore"
      FROM users
      WHERE email = $1
    `,
    [email.toLowerCase()]
  )

  const user = result.rows[0]
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash)
  if (!passwordOk) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  return res.json({
    user: toPublicUser({
      id: user.id,
      name: user.name,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      isAdmin: user.isAdmin,
      homeStore: user.homeStore,
    }),
  })
})

router.get('/leaderboards/combined', async (_req, res) => {
  try {
    const payload = await buildSeasonLeaderboard('combined')
    return res.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load leaderboard'
    return res.status(500).json({ error: message })
  }
})

router.get('/leaderboards/store/:storeId', async (req, res) => {
  const storeId = String(req.params.storeId ?? '').toLowerCase()
  if (!isHomeStore(storeId)) {
    return res.status(400).json({ error: 'storeId must be glendower or rosebank' })
  }
  try {
    const payload = await buildSeasonLeaderboard(storeId as HomeStore)
    return res.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load leaderboard'
    return res.status(500).json({ error: message })
  }
})

router.get('/home-summary', async (req, res) => {
  const userId = Number(req.query.userId)
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId query parameter is required' })
  }

  const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [userId])
  if (!userCheck.rows[0]) {
    return res.status(404).json({ error: 'User not found' })
  }

  const attended = await db.query(
    `
      SELECT
        e.event_date AS "eventDate",
        a.updated_at AS "updatedAt"
      FROM event_attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.user_id = $1 AND a.attended = TRUE
    `,
    [userId]
  )

  const weekStreak = weekStreakFromAttendance(attended.rows)
  const gamesPlayed = attended.rows.length

  const feedRows = await db.query(
    `
      SELECT
        a.id,
        e.id AS "eventId",
        e.title AS "eventTitle",
        a.placement AS "placement",
        a.deck_id AS "deckId",
        a.updated_at AS "markedAt"
      FROM event_attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.user_id = $1 AND a.attended = TRUE
      ORDER BY a.updated_at DESC
      LIMIT 50
    `,
    [userId]
  )

  return res.json({
    weekStreak,
    gamesPlayed,
    feed: feedRows.rows,
  })
})

router.get('/attended-events', async (req, res) => {
  const userId = Number(req.query.userId)
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId query parameter is required' })
  }

  const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [userId])
  if (!userCheck.rows[0]) {
    return res.status(404).json({ error: 'User not found' })
  }

  const rows = await db.query(
    `
      SELECT
        a.id,
        e.id AS "eventId",
        e.title AS "eventTitle",
        e.event_date AS "eventDate",
        a.placement AS "placement",
        a.deck_id AS "deckId",
        a.updated_at AS "markedAt"
      FROM event_attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.user_id = $1 AND a.attended = TRUE
      ORDER BY a.updated_at DESC
    `,
    [userId]
  )

  return res.json({ events: rows.rows })
})

router.get('/rank-progress', async (req, res) => {
  const userId = Number(req.query.userId)
  const compareUserId = req.query.compareUserId
    ? Number(req.query.compareUserId)
    : undefined
  const month = String(req.query.month ?? currentMonthKey())
  const logCtx = { userId, compareUserId, month }

  if (!userId || Number.isNaN(userId)) {
    console.error('[charts] rank-progress FAILED', {
      ...logCtx,
      httpStatus: 400,
      message: 'userId query parameter is required',
    })
    return res.status(400).json({ error: 'userId query parameter is required' })
  }

  if (!isValidMonthKey(month)) {
    console.error('[charts] rank-progress FAILED', {
      ...logCtx,
      httpStatus: 400,
      message: `Invalid month (expected YYYY-MM): ${month}`,
    })
    return res.status(400).json({ error: `Invalid month: use YYYY-MM (got "${month}")` })
  }

  logRankProgressRequest(logCtx)

  try {
    const primaryMonth = await buildRankProgressSeries(userId, { month })
    const primaryChart = await resolveChartPoints(userId, month, primaryMonth)
    const primary = { ...primaryMonth, points: primaryChart.points }

    let compare = null
    let compareTotals: {
      primary: Awaited<ReturnType<typeof getUserXpSnapshot>>
      compare: Awaited<ReturnType<typeof getUserXpSnapshot>>
    } | null = null
    let chartScope: 'month' | 'all-time' = primaryChart.scope
    if (compareUserId && !Number.isNaN(compareUserId) && compareUserId !== userId) {
      const [primarySnap, compareSnap] = await Promise.all([
        getUserXpSnapshot(userId),
        getUserXpSnapshot(compareUserId),
      ])
      compareTotals = { primary: primarySnap, compare: compareSnap }
      const compareMonth = await buildRankProgressSeries(compareUserId, { month })
      const compareChart = await resolveChartPoints(compareUserId, month, compareMonth)
      if (compareChart.scope === 'all-time') chartScope = 'all-time'
      const aligned = alignCompareToPrimaryTimeline(primaryChart.points, compareChart.points)
      compare = { ...compareMonth, points: aligned }
    }

    const lifetime = await getUserXpSnapshot(userId)

    const last = primaryMonth.points[primaryMonth.points.length - 1]
    const first = primaryMonth.points[0]
    const payload = {
      month,
      chartScope,
      primary,
      compare,
      compareTotals,
      lifetime: {
        xp: lifetime.xp,
        rank: lifetime.rank,
        name: lifetime.name,
      },
      summary: {
        rankStart: first?.rank ?? 'Bronze',
        rankEnd: last?.rank ?? first?.rank ?? 'Bronze',
        xpGained: primaryMonth.xpGainedInRange,
        events: primaryMonth.eventsInRange,
      },
    }

    logRankProgressOk(logCtx, {
      primaryPoints: primary.points.length,
      comparePoints: compare?.points.length ?? null,
      xpGained: primary.xpGainedInRange,
      events: primary.eventsInRange,
      rankStart: payload.summary.rankStart,
      rankEnd: payload.summary.rankEnd,
    })

    return res.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load rank progress'
    const status = message === 'User not found' ? 404 : 500
    logRankProgressError(logCtx, err, status)
    return res.status(status).json({ error: message })
  }
})

router.get('/rank-entitlements', async (req, res) => {
  const userId = Number(req.query.userId)
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId query parameter is required' })
  }
  try {
    const snap = await getUserXpSnapshot(userId)
    const entitlements = await getRankEntitlementsForUser(userId, snap.xp)
    return res.json({
      currentXp: snap.xp,
      currentTier: entitlementTierForXp(snap.xp),
      entitlements,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load rank entitlements'
    const status = message === 'User not found' ? 404 : 500
    return res.status(status).json({ error: message })
  }
})

router.post('/rank-entitlements/claim', async (req, res) => {
  const userId = Number(req.body?.userId)
  const tier = String(req.body?.tier ?? '')
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId is required' })
  }
  if (!isEntitlementTier(tier)) {
    return res.status(400).json({ error: 'Invalid tier' })
  }
  try {
    const snap = await getUserXpSnapshot(userId)
    const result = await claimRankEntitlement(userId, tier, snap.xp)
    const entitlements = await getRankEntitlementsForUser(userId, snap.xp)
    return res.json({
      claimCode: result.claimCode,
      tier,
      entitlements,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Claim failed'
    const status =
      message === 'User not found' ? 404 : message === 'Rank tier not unlocked yet' ? 400 : 500
    return res.status(status).json({ error: message })
  }
})

router.get('/deck-meta', async (_req, res) => {
  try {
    const meta = await getCommunityDeckMeta()
    return res.json(meta)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load deck meta'
    return res.status(500).json({ error: message })
  }
})

router.get('/deck-profile', async (req, res) => {
  const userId = Number(req.query.userId)
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId query parameter is required' })
  }
  const logCtx = { userId }
  logDeckProfileRequest(logCtx)
  try {
    const [profile, matchWins] = await Promise.all([
      getDeckProfile(userId),
      countUserMatchWins(userId),
    ])
    const totalEvents = profile.stats.reduce((s, r) => s + r.events, 0)
    const totalWins = profile.stats.reduce((s, r) => s + r.wins, 0)
    logDeckProfileOk(logCtx, {
      activeDeckId: profile.activeDeckId,
      statRows: profile.stats.length,
      totalEvents,
      totalWins,
      matchWins,
    })
    return res.json(profile)
  } catch (err) {
    logDeckError('GET /auth/deck-profile', logCtx, err, 500)
    const message = err instanceof Error ? err.message : 'Failed to load deck profile'
    return res.status(500).json({ error: message })
  }
})

/** Updates profile deck only; event_attendance.deck_id rows are never changed here. */
router.patch('/active-deck', async (req, res) => {
  const userId = Number(req.body?.userId)
  const deckId = req.body?.deckId === null || req.body?.deckId === '' ? null : String(req.body?.deckId)
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'userId is required' })
  }
  const logCtx = { userId }
  try {
    await setUserActiveDeck(userId, deckId)
    logActiveDeckUpdated({
      ...logCtx,
      deckId,
      label: deckId ? deckLabel(deckId) : null,
    })
    const profile = await getDeckProfile(userId)
    return res.json(profile)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update deck'
    const status = message === 'Invalid deck' ? 400 : 500
    logDeckError('PATCH /auth/active-deck', logCtx, err, status)
    return res.status(status).json({ error: message })
  }
})

router.get('/players', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  try {
    const params: string[] = []
    let sql = `
      SELECT
        id,
        name,
        profile_image_url AS "profileImageUrl",
        xp,
        rank
      FROM users
    `
    if (q.length >= 2) {
      params.push(`%${q.toLowerCase()}%`)
      sql += ` WHERE LOWER(name) LIKE $1`
    }
    sql += `
      ORDER BY xp DESC, name ASC
      LIMIT ${q.length >= 2 ? 50 : 30}
    `
    const rows = await db.query(sql, params)
    return res.json({ players: rows.rows })
  } catch (err) {
    logComparePlayersError(q, err, 500)
    const message = err instanceof Error ? err.message : 'Failed to search players'
    return res.status(500).json({ error: message })
  }
})

router.post('/verify-admin', (req, res) => {
  const { password } = req.body ?? {}
  const expected = process.env.ADMIN_PASS
  if (!expected) {
    return res.status(500).json({ error: 'ADMIN_PASS is not configured on the server' })
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'password is required' })
  }
  if (!timingSafeEqual(password, expected)) {
    return res.status(403).json({ error: 'Incorrect admin password' })
  }
  return res.json({ ok: true })
})

export default router
