-- Core users table for app authentication and roles
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  profile_image_url TEXT,
  xp INTEGER NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT 'Bronze',
  active_deck_id TEXT,
  home_store TEXT CHECK (home_store IS NULL OR home_store IN ('glendower', 'rosebank')),
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Events created by admins
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  event_date DATE,
  location TEXT,
  banner_image_url TEXT,
  scheduled_rounds INTEGER,
  use_match_tracking BOOLEAN NOT NULL DEFAULT FALSE,
  event_tier TEXT NOT NULL DEFAULT 'casual' CHECK (event_tier IN ('casual', 'challenge', 'cup')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- pairwise match; player_a_id is always < player_b_id; outcome is from that perspective
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

CREATE INDEX IF NOT EXISTS idx_event_matches_event_id ON event_matches(event_id);

-- Attendance state per user per event
CREATE TABLE IF NOT EXISTS event_attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attended BOOLEAN NOT NULL DEFAULT FALSE,
  placement INTEGER,
  deck_id TEXT, -- deck used at this event; frozen once set (not tied to users.active_deck_id)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, event_id)
);

-- Manually granted user badges (non-placement badges awarded by admins)
CREATE TABLE IF NOT EXISTS user_badges (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL,
  awarded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_event_id ON event_attendance(event_id);
CREATE INDEX IF NOT EXISTS idx_attendance_user_id ON event_attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id);

-- In-person prize claims: user reveals a code; staff redeems at the booth
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

CREATE INDEX IF NOT EXISTS idx_rank_entitlement_claims_user ON rank_entitlement_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_rank_entitlement_claims_code ON rank_entitlement_claims(claim_code);

CREATE INDEX IF NOT EXISTS idx_event_matches_event_round ON event_matches(event_id, round_number);

CREATE TABLE IF NOT EXISTS event_judged_awards (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  award_type TEXT NOT NULL CHECK (award_type IN ('best_bling', 'best_rogue')),
  winner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, award_type)
);

CREATE INDEX IF NOT EXISTS idx_event_judged_awards_event ON event_judged_awards(event_id);
CREATE INDEX IF NOT EXISTS idx_event_judged_awards_winner ON event_judged_awards(winner_user_id);
