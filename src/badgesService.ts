import { db } from './db'
import { getActiveSeason } from './seasons'
import { recalculatePlayerProgression } from './playerProgression'
import { DEFAULT_BADGE_DEFINITIONS } from './leagueDefaults'

export async function seedBadgeDefinitions(): Promise<void> {
  for (const b of DEFAULT_BADGE_DEFINITIONS) {
    await db.query(
      `
        INSERT INTO badge_definitions (id, title, description, category, xp_reward, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          xp_reward = EXCLUDED.xp_reward,
          sort_order = EXCLUDED.sort_order
      `,
      [b.id, b.title, b.description, b.category, b.xpReward, b.sortOrder]
    )
  }
}

export async function listBadgeDefinitions() {
  const res = await db.query(
    `SELECT id, title, description, category, xp_reward AS "xpReward", sort_order AS "sortOrder"
     FROM badge_definitions ORDER BY sort_order ASC, id ASC`
  )
  return res.rows
}

export async function updateBadgeDefinition(
  id: string,
  patch: { title?: string; description?: string; xpReward?: number }
): Promise<void> {
  await db.query(
    `
      UPDATE badge_definitions SET
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        xp_reward = COALESCE($4, xp_reward)
      WHERE id = $1
    `,
    [id, patch.title ?? null, patch.description ?? null, patch.xpReward ?? null]
  )
}

export async function awardBadgeWithXp(
  userId: number,
  badgeId: string,
  awardedBy: number | null
): Promise<void> {
  await db.query(
    `
      INSERT INTO user_badges (user_id, badge_id, awarded_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, badge_id) DO NOTHING
    `,
    [userId, badgeId, awardedBy]
  )
  await recalculatePlayerProgression(userId)
}

export async function evaluateConsistencyBadges(userId: number): Promise<void> {
  const countRes = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM event_attendance WHERE user_id = $1 AND attended = TRUE`,
    [userId]
  )
  const count = countRes.rows[0]?.c ?? 0
  const thresholds: [number, string][] = [
    [5, 'iron_trainer'],
    [25, 'grinder_25'],
    [50, 'grinder_50'],
    [100, 'grinder_100'],
  ]
  for (const [min, badgeId] of thresholds) {
    if (count >= min) {
      await db.query(
        `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, badgeId]
      )
    }
  }
}

export async function awardSeasonEndTrophies(seasonId: number): Promise<void> {
  const season = await db.query(`SELECT id FROM seasons WHERE id = $1`, [seasonId])
  if (!season.rows[0]) return

  const combined = await db.query<{ user_id: number }>(
    `
      SELECT user_id FROM player_season_stats
      WHERE season_id = $1
      ORDER BY season_xp DESC
      LIMIT 1
    `,
    [seasonId]
  )
  if (combined.rows[0]) {
    await db.query(
      `
        INSERT INTO user_trophies (user_id, season_id, trophy_type)
        VALUES ($1, $2, 'overall_champion')
        ON CONFLICT DO NOTHING
      `,
      [combined.rows[0].user_id, seasonId]
    )
    await db.query(
      `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, 'champions_cape') ON CONFLICT DO NOTHING`,
      [combined.rows[0].user_id]
    )
  }

  for (const store of ['glendower', 'rosebank'] as const) {
    const storeChamp = await db.query<{ user_id: number }>(
      `
        SELECT pss.user_id
        FROM player_season_stats pss
        JOIN users u ON u.id = pss.user_id
        WHERE pss.season_id = $1 AND u.home_store = $2
        ORDER BY pss.season_xp DESC
        LIMIT 1
      `,
      [seasonId, store]
    )
    if (storeChamp.rows[0]) {
      await db.query(
        `
          INSERT INTO user_trophies (user_id, season_id, trophy_type)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `,
        [storeChamp.rows[0].user_id, seasonId, `${store}_champion`]
      )
      await db.query(
        `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, 'cup_champion') ON CONFLICT DO NOTHING`,
        [storeChamp.rows[0].user_id]
      )
    }
  }

  const top3 = await db.query<{ user_id: number }>(
    `
      SELECT user_id FROM player_season_stats
      WHERE season_id = $1
      ORDER BY season_xp DESC
      LIMIT 3
    `,
    [seasonId]
  )
  for (const row of top3.rows) {
    await db.query(
      `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, 'season_finalist') ON CONFLICT DO NOTHING`,
      [row.user_id]
    )
  }
}

export async function onSeasonArchived(seasonId: number): Promise<void> {
  await awardSeasonEndTrophies(seasonId)
  const players = await db.query<{ user_id: number }>(
    `SELECT user_id FROM player_season_stats WHERE season_id = $1`,
    [seasonId]
  )
  for (const p of players.rows) {
    await evaluateConsistencyBadges(p.user_id)
    await recalculatePlayerProgression(p.user_id)
  }
}
