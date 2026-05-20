import 'dotenv/config'
import { Pool } from 'pg'
import fs from 'fs'
import path from 'path'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in server environment')
}

/** Neon/other URLs sometimes include channel_binding=require, which can break node-pg in some runtimes. */
function sanitizeDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.searchParams.delete('channel_binding')
    // Quiets node-pg warning: require/verify-ca as verify-full until pg v9; see deploy logs.
    if (u.hostname.includes('neon.tech') && !u.searchParams.has('uselibpqcompat')) {
      u.searchParams.set('uselibpqcompat', 'true')
    }
    return u.toString()
  } catch {
    return raw
  }
}

export const db = new Pool({
  connectionString: sanitizeDatabaseUrl(process.env.DATABASE_URL),
})

export async function initDb() {
  // Use path next to compiled dist/ — process.cwd() on Railway may not be the repo root.
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql')
  const schemaSql = fs.readFileSync(schemaPath, 'utf8')
  await db.query(schemaSql)
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
  `)
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0;
  `)
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS rank TEXT NOT NULL DEFAULT 'Bronze';
  `)
  await db.query(`
    ALTER TABLE events
    ADD COLUMN IF NOT EXISTS banner_image_url TEXT;
  `)
  await db.query(`
    ALTER TABLE event_attendance
    ADD COLUMN IF NOT EXISTS placement INTEGER;
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_badges (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id TEXT NOT NULL,
      awarded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, badge_id)
    );
  `)
  await db.query(`
    ALTER TABLE events
    ADD COLUMN IF NOT EXISTS scheduled_rounds INTEGER;
  `)
  await db.query(`
    ALTER TABLE events
    ADD COLUMN IF NOT EXISTS use_match_tracking BOOLEAN NOT NULL DEFAULT FALSE;
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS event_matches (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL CHECK (round_number >= 1),
      player_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      player_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL CHECK (outcome IN ('a_wins', 'b_wins', 'draw')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (player_a_id < player_b_id),
      UNIQUE (event_id, round_number, player_a_id, player_b_id)
    );
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_event_matches_event_id ON event_matches(event_id);
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_event_matches_event_round ON event_matches(event_id, round_number);
  `)
}
