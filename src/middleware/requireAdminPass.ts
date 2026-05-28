import crypto from 'crypto'
import { Request, Response, NextFunction } from 'express'

/** GET routes any signed-in user may call without the organizer password. */
const PUBLIC_GET = [
  /^\/events\/?$/,
  /^\/events\/[^/]+\/leaderboard\/?$/,
  /^\/users\/[^/]+\/details\/?$/,
  /^\/users\/[^/]+\/snapshot\/?$/,
  /^\/rankings\/?$/,
]

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function requireAdminPass(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' && PUBLIC_GET.some((re) => re.test(req.path))) {
    return next()
  }

  const expected = process.env.ADMIN_PASS
  if (!expected) {
    return res.status(500).json({ error: 'ADMIN_PASS is not configured on the server' })
  }

  const provided = String(req.header('x-admin-pass') ?? '')
  if (!provided || !timingSafeEqual(provided, expected)) {
    return res.status(403).json({ error: 'Admin password required' })
  }

  return next()
}
