import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import multer from 'multer'
import { db } from '../db'
import { uploadToCloudinary } from '../helpers/uploadToCloudinary'
import { weekStreakFromAttendance } from '../helpers/weekStreak'

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
      RETURNING id, name, email, profile_image_url AS "profileImageUrl", is_admin AS "isAdmin"
    `,
    [imageUrl, userId]
  )

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User not found' })
  }

  return res.json({ user: result.rows[0] })
})

router.post('/profile', async (req, res) => {
  const { userId, name, email } = req.body ?? {}
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' })
  }
  if (name === undefined && email === undefined) {
    return res.status(400).json({ error: 'name or email is required' })
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

  const result = await db.query(
    `
      UPDATE users
      SET
        name = CASE WHEN $1::boolean THEN $2::text ELSE name END,
        email = CASE WHEN $3::boolean THEN $4::text ELSE email END
      WHERE id = $5
      RETURNING id, name, email, profile_image_url AS "profileImageUrl", is_admin AS "isAdmin"
    `,
    [
      nextName !== undefined,
      nextName ?? '',
      nextEmail !== undefined,
      nextEmail ?? '',
      userId,
    ]
  )

  return res.json({ user: result.rows[0] })
})

router.post('/signup', async (req, res) => {
  const { name, email, password, profileImageUrl } = req.body ?? {}
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' })
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
      INSERT INTO users (name, email, password_hash, profile_image_url, is_admin)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email, profile_image_url AS "profileImageUrl", is_admin AS "isAdmin"
    `,
    [name, email.toLowerCase(), passwordHash, profileImageUrl || null, isFirstUser]
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
      SELECT id, name, email, password_hash AS "passwordHash", is_admin AS "isAdmin"
      , profile_image_url AS "profileImageUrl"
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
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      isAdmin: user.isAdmin,
    },
  })
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

  const feedRows = await db.query(
    `
      SELECT
        a.id,
        e.title AS "eventTitle",
        a.placement AS "placement",
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
    feed: feedRows.rows,
  })
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
