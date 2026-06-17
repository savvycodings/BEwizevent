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
    ALTER TABLE events
    ADD COLUMN IF NOT EXISTS event_tier TEXT NOT NULL DEFAULT 'casual';
  `)
  await db.query(`
    UPDATE events SET event_tier = 'casual' WHERE event_tier IS NULL OR event_tier = '';
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
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_deck_id TEXT;
  `)
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS home_store TEXT;
  `)
  await db.query(`
    ALTER TABLE event_attendance
    ADD COLUMN IF NOT EXISTS deck_id TEXT;
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS rank_entitlement_claims (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tier TEXT NOT NULL,
      claim_code TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      redeemed_at TIMESTAMPTZ,
      redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (user_id, tier),
      UNIQUE (claim_code)
    );
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_rank_entitlement_claims_user ON rank_entitlement_claims(user_id);
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_rank_entitlement_claims_code ON rank_entitlement_claims(claim_code);
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS event_judged_awards (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      award_type TEXT NOT NULL CHECK (award_type IN ('best_bling', 'best_rogue')),
      winner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, award_type)
    );
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_event_judged_awards_event ON event_judged_awards(event_id);
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_event_judged_awards_winner ON event_judged_awards(winner_user_id);
  `)
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pop_id TEXT;
  `)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pop_id ON users(pop_id) WHERE pop_id IS NOT NULL;
  `)
  await db.query(`
    ALTER TABLE event_matches DROP CONSTRAINT IF EXISTS event_matches_outcome_check;
  `)
  await db.query(`
    ALTER TABLE event_matches
    ADD CONSTRAINT event_matches_outcome_check
    CHECK (outcome IN ('a_wins', 'b_wins', 'draw', 'pending'));
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS seasons (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      season_type TEXT NOT NULL CHECK (season_type IN ('main', 'off_season')),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
      rank_thresholds JSONB NOT NULL DEFAULT '{}',
      reward_map JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS player_season_stats (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      season_xp INTEGER NOT NULL DEFAULT 0,
      current_rank TEXT NOT NULL DEFAULT 'Bronze',
      best_rank TEXT NOT NULL DEFAULT 'Bronze',
      entitlement_tier TEXT NOT NULL DEFAULT 'Bronze',
      grace_entitlement_tier TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, season_id)
    );
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS league_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS badge_definitions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      xp_reward INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_trophies (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
      trophy_type TEXT NOT NULL,
      awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, season_id, trophy_type)
    );
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS event_xp_awards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      xp_amount INTEGER NOT NULL,
      award_type TEXT NOT NULL,
      event_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, event_id, award_type)
    );
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS season_archives (
      id SERIAL PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      snapshot JSONB NOT NULL
    );
  `)

  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS best_rank TEXT;`)
  await db.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL;`)
  await db.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS store TEXT;`)
  await db.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS entry_fee INTEGER NOT NULL DEFAULT 0;`)
  await db.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS field_size INTEGER;`)
  await db.query(`ALTER TABLE rank_entitlement_claims ADD COLUMN IF NOT EXISTS season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL;`)

  const { seedBadgeDefinitions } = await import('./badgesService')
  const { ensureDefaultActiveSeason } = await import('./seasons')
  const { setLeagueConfigKey } = await import('./leagueConfig')
  const { DEFAULT_ANTI_FARMING, DEFAULT_VETERAN_GRACE, DEFAULT_REWARD_MAP } = await import('./leagueDefaults')

  await seedBadgeDefinitions()
  await setLeagueConfigKey('anti_farming', DEFAULT_ANTI_FARMING)
  await setLeagueConfigKey('veteran_grace', DEFAULT_VETERAN_GRACE)
  await setLeagueConfigKey('default_rewards', DEFAULT_REWARD_MAP)
  await ensureDefaultActiveSeason()
}
