import express from 'express'
import { db } from '../db'
import {
  getAllLeagueConfig,
  getAntiFarmingConfig,
  getDefaultRewardMap,
  getVeteranGraceConfig,
  setLeagueConfigKey,
} from '../leagueConfig'
import {
  activateSeason,
  archiveAndEndSeason,
  createSeason,
  ensureDefaultActiveSeason,
  getActiveSeason,
  getSeasonById,
  listSeasons,
  updateSeason,
  type SeasonType,
} from '../seasons'
import { thresholdsForSeasonType, type RankTier } from '../leagueDefaults'
import {
  listBadgeDefinitions,
  seedBadgeDefinitions,
  updateBadgeDefinition,
  onSeasonArchived,
} from '../badgesService'
import { recalculatePlayerProgression } from '../playerProgression'
import { requireAdminPass } from '../middleware/requireAdminPass'

const router = express.Router()
router.use(requireAdminPass)

router.get('/league/config', async (_req, res) => {
  try {
    const [config, antiFarm, veteranGrace, rewards, badges, activeSeason, seasons] = await Promise.all([
      getAllLeagueConfig(),
      getAntiFarmingConfig(),
      getVeteranGraceConfig(),
      getDefaultRewardMap(),
      listBadgeDefinitions(),
      getActiveSeason(),
      listSeasons(),
    ])
    return res.json({ config, antiFarm, veteranGrace, defaultRewards: rewards, badges, activeSeason, seasons })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load league config'
    console.error('[admin] GET /league/config failed', err)
    return res.status(500).json({ error: message })
  }
})

router.patch('/league/config', async (req, res) => {
  const { antiFarm, veteranGrace, defaultRewards } = req.body ?? {}
  if (antiFarm) {
    const current = await getAntiFarmingConfig()
    await setLeagueConfigKey('anti_farming', { ...current, ...antiFarm })
  }
  if (veteranGrace) {
    const current = await getVeteranGraceConfig()
    await setLeagueConfigKey('veteran_grace', { ...current, ...veteranGrace })
  }
  if (defaultRewards) await setLeagueConfigKey('default_rewards', defaultRewards)
  return res.json({ ok: true })
})

router.get('/league/badges', async (_req, res) => {
  const badges = await listBadgeDefinitions()
  return res.json({ badges })
})

router.patch('/league/badges/:badgeId', async (req, res) => {
  const badgeId = String(req.params.badgeId)
  const { title, description, xpReward } = req.body ?? {}
  await updateBadgeDefinition(badgeId, { title, description, xpReward: xpReward != null ? Number(xpReward) : undefined })
  return res.json({ ok: true })
})

router.get('/league/seasons', async (_req, res) => {
  const seasons = await listSeasons()
  return res.json({ seasons })
})

router.post('/league/seasons', async (req, res) => {
  const { name, seasonType, startDate, endDate, rankThresholds, rewardMap } = req.body ?? {}
  if (!name || !seasonType || !startDate || !endDate) {
    return res.status(400).json({ error: 'name, seasonType, startDate, endDate required' })
  }
  if (seasonType !== 'main' && seasonType !== 'off_season') {
    return res.status(400).json({ error: 'seasonType must be main or off_season' })
  }
  const season = await createSeason({
    name: String(name),
    seasonType: seasonType as SeasonType,
    startDate: String(startDate),
    endDate: String(endDate),
    rankThresholds: rankThresholds as Record<RankTier, number> | undefined,
    rewardMap: rewardMap as Record<RankTier, string> | undefined,
  })
  return res.status(201).json({ season })
})

router.patch('/league/seasons/:seasonId', async (req, res) => {
  const seasonId = Number(req.params.seasonId)
  const { name, seasonType, startDate, endDate, rankThresholds, rewardMap } = req.body ?? {}
  const season = await updateSeason(seasonId, {
    name: name != null ? String(name) : undefined,
    seasonType: seasonType as SeasonType | undefined,
    startDate: startDate != null ? String(startDate) : undefined,
    endDate: endDate != null ? String(endDate) : undefined,
    rankThresholds: rankThresholds as Record<RankTier, number> | undefined,
    rewardMap: rewardMap as Record<RankTier, string> | undefined,
  })
  if (!season) return res.status(404).json({ error: 'Season not found' })
  return res.json({ season })
})

router.post('/league/seasons/:seasonId/activate', async (req, res) => {
  const seasonId = Number(req.params.seasonId)
  try {
    const season = await activateSeason(seasonId)
    return res.json({ season })
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' })
  }
})

router.post('/league/seasons/:seasonId/end', async (req, res) => {
  const seasonId = Number(req.params.seasonId)
  try {
    await onSeasonArchived(seasonId)
    await archiveAndEndSeason(seasonId)
    await ensureDefaultActiveSeason()
    return res.json({ ok: true })
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' })
  }
})

router.post('/league/seasons/seed-defaults', async (_req, res) => {
  await seedBadgeDefinitions()
  const season = await ensureDefaultActiveSeason()
  return res.json({ season })
})

router.post('/league/players/:userId/recalculate', async (req, res) => {
  const userId = Number(req.params.userId)
  const snapshot = await recalculatePlayerProgression(userId)
  return res.json({ snapshot })
})

router.post('/league/players/:userId/adjust-xp', async (req, res) => {
  const userId = Number(req.params.userId)
  const delta = Number(req.body?.delta ?? 0)
  const season = await getActiveSeason()
  if (!season) return res.status(400).json({ error: 'No active season' })
  await db.query(
    `
      UPDATE player_season_stats SET season_xp = GREATEST(0, season_xp + $3), updated_at = NOW()
      WHERE user_id = $1 AND season_id = $2
    `,
    [userId, season.id, delta]
  )
  const snapshot = await recalculatePlayerProgression(userId)
  return res.json({ snapshot })
})

router.get('/league/seasons/:seasonId/thresholds-template', async (req, res) => {
  const type = String(req.query.type ?? 'main') as SeasonType
  return res.json({
    thresholds: thresholdsForSeasonType(type === 'off_season' ? 'off_season' : 'main'),
  })
})

export default router
