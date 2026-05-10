const express = require("express")
const { body, validationResult } = require("express-validator")
const Stats = require("../models/Stats")
const User = require("../models/User")
const Game = require("../models/Game")
const auth = require("../middleware/auth")

const router = express.Router()

const SUPPORTED_TYPES = new Set(["bullet", "blitz", "rapid", "all"])
const PERIOD_TO_MS = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
  all: null,
}

function normalizeReason(reason) {
  if (!reason) return "other"
  const raw = String(reason).toLowerCase().trim()
  const aliases = {
    "draw-by-agreement": "draw-agreement",
  }
  return aliases[raw] || raw
}

function reasonLabel(reason) {
  const labels = {
    checkmate: "Checkmate",
    timeout: "Timeout",
    resignation: "Resignation",
    disconnect: "Disconnect",
    stalemate: "Stalemate",
    "draw-agreement": "Draw Agreement",
    "threefold-repetition": "Threefold Repetition",
    "insufficient-material": "Insufficient Material",
    other: "Other",
  }
  return labels[reason] || "Other"
}

function getOutcomeForUser(game, userId) {
  const whiteId = game?.players?.white ? String(game.players.white) : null
  const blackId = game?.players?.black ? String(game.players.black) : null
  const uid = String(userId)
  const side = whiteId === uid ? "white" : blackId === uid ? "black" : null
  if (!side) return null

  const winner = game?.result?.winner
  if (!winner || winner === "draw") return { side, outcome: "draw" }
  return { side, outcome: winner === side ? "win" : "loss" }
}

function currentRatingForType(user, type) {
  const bullet = Math.round(Number(user?.ratings?.bullet?.rating ?? 1500))
  const blitz = Math.round(Number(user?.ratings?.blitz?.rating ?? 1500))
  const rapid = Math.round(Number(user?.ratings?.rapid?.rating ?? 1500))
  if (type === "bullet") return bullet
  if (type === "blitz") return blitz
  if (type === "rapid") return rapid
  return Math.round((bullet + blitz + rapid) / 3)
}

function buildRatingHistory(gamesAsc, currentRating) {
  const deltaFor = (outcome) => (outcome === "win" ? 8 : outcome === "loss" ? -8 : 0)
  const totalDelta = gamesAsc.reduce((sum, g) => sum + deltaFor(g.outcome), 0)
  let rating = currentRating - totalDelta
  const rows = [{ date: null, rating }]
  for (const g of gamesAsc) {
    rating += deltaFor(g.outcome)
    rows.push({
      date: g.date.toISOString(),
      rating,
      outcome: g.outcome,
      reason: g.reason,
    })
  }

  if (rows.length <= 140) return rows
  const step = Math.ceil(rows.length / 140)
  const sampled = []
  for (let i = 0; i < rows.length; i += step) sampled.push(rows[i])
  const last = rows[rows.length - 1]
  if (sampled[sampled.length - 1] !== last) sampled.push(last)
  return sampled
}

// @route   GET /api/stats/player/:userId
// @desc    Get player statistics
// @access  Private
router.get("/player/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params

    // Check if user can access these stats
    const isFriend = Array.isArray(req.user.friends)
      ? req.user.friends.some((fid) => String(fid) === String(userId))
      : false
    if (userId !== req.user._id.toString() && !isFriend) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      })
    }

    const stats = await Stats.findOne({ user: userId }).populate("user", "username fullName rating")

    if (!stats) {
      return res.status(404).json({
        success: false,
        message: "Statistics not found",
      })
    }

    res.json({
      success: true,
      data: { stats },
    })
  } catch (error) {
    console.error("Get player stats error:", error)
    res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

// @route   POST /api/stats/player
// @desc    Create initial player statistics
// @access  Private
router.post("/player", auth, async (req, res) => {
  try {
    // Check if stats already exist
    const existingStats = await Stats.findOne({ user: req.user._id })
    if (existingStats) {
      return res.status(400).json({
        success: false,
        message: "Statistics already exist for this user",
      })
    }

    const stats = new Stats({
      user: req.user._id,
    })

    await stats.save()

    res.status(201).json({
      success: true,
      message: "Player statistics created",
      data: { stats },
    })
  } catch (error) {
    console.error("Create player stats error:", error)
    res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

// @route   GET /api/stats/leaderboard
// @desc    Get leaderboard
// @access  Private
router.get("/leaderboard", auth, async (req, res) => {
  try {
    const { type = "rating", limit = 50 } = req.query

    let sortField = "rating"
    if (type === "wins") sortField = "wins.total"
    else if (type === "games") sortField = "gamesPlayed.total"
    else if (type === "winRate") sortField = "winRate"

    const users = await User.find({ rating: { $gt: 0 } })
      .select("username fullName avatar rating")
      .sort({ [sortField]: -1 })
      .limit(Number.parseInt(limit))

    // Get stats for each user
    const leaderboard = await Promise.all(
      users.map(async (user) => {
        const stats = await Stats.findOne({ user: user._id })
        return {
          user: {
            id: user._id,
            username: user.username,
            fullName: user.fullName,
            avatar: user.avatar,
            rating: user.rating,
          },
          stats: stats
            ? {
                gamesPlayed: stats.gamesPlayed.total,
                wins: stats.wins.total,
                winRate: stats.winRate,
                currentStreak: stats.currentStreak,
              }
            : null,
        }
      }),
    )

    res.json({
      success: true,
      data: { leaderboard },
    })
  } catch (error) {
    console.error("Get leaderboard error:", error)
    res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

// @route   GET /api/stats/achievements/:userId
// @desc    Get user achievements
// @access  Private
router.get("/achievements/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params

    const stats = await Stats.findOne({ user: userId })
    if (!stats) {
      return res.status(404).json({
        success: false,
        message: "Statistics not found",
      })
    }

    res.json({
      success: true,
      data: { achievements: stats.achievements },
    })
  } catch (error) {
    console.error("Get achievements error:", error)
    res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

// @route   POST /api/stats/update
// @desc    Update player statistics after game
// @access  Private
router.post(
  "/update",
  [
    auth,
    body("gameId").notEmpty(),
    body("result").isIn(["win", "loss", "draw"]),
    body("gameType").isIn(["bot", "multiplayer", "friend"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req)
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        })
      }

      const { gameId, result, gameType } = req.body

      // Verify game exists
      const game = await Game.findOne({ gameId })
      if (!game) {
        return res.status(404).json({
          success: false,
          message: "Game not found",
        })
      }

      // Check if user was part of this game
      const isPlayer =
        game.players.white.equals(req.user._id) || (game.players.black && game.players.black.equals(req.user._id))

      if (!isPlayer) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        })
      }

      const stats = await Stats.findOne({ user: req.user._id })
      if (!stats) {
        return res.status(404).json({
          success: false,
          message: "Statistics not found",
        })
      }

      // Calculate game time
      const gameTime = Date.now() - game.createdAt.getTime()

      // Update stats
      await stats.updateAfterGame(gameType, result, gameTime)

      // Check for new achievements
      const newAchievements = []

      // First win achievement
      if (stats.wins.total === 1 && result === "win") {
        newAchievements.push({
          name: "First Victory",
          description: "Win your first game",
        })
      }

      // Win streak achievements
      if (stats.currentStreak === 5) {
        newAchievements.push({
          name: "Hot Streak",
          description: "Win 5 games in a row",
        })
      }

      // Games played milestones
      if (stats.gamesPlayed.total === 10) {
        newAchievements.push({
          name: "Getting Started",
          description: "Play 10 games",
        })
      }

      // Add new achievements
      if (newAchievements.length > 0) {
        stats.achievements.push(...newAchievements)
        await stats.save()

        // Emit achievement notifications
        req.app.get("io").to(req.user._id.toString()).emit("achievements-unlocked", {
          achievements: newAchievements,
        })
      }

      res.json({
        success: true,
        message: "Statistics updated successfully",
        data: {
          stats,
          newAchievements,
        },
      })
    } catch (error) {
      console.error("Update stats error:", error)
      res.status(500).json({
        success: false,
        message: "Server error",
      })
    }
  },
)

// @route   GET /api/stats/:userId?type=rapid&period=7d
// @desc    Aggregated per-user stats for stats page
// @access  Private
router.get("/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params
    const typeRaw = String(req.query.type || "rapid").toLowerCase()
    const periodRaw = String(req.query.period || "7d").toLowerCase()
    const type = SUPPORTED_TYPES.has(typeRaw) ? typeRaw : "rapid"
    const period = Object.prototype.hasOwnProperty.call(PERIOD_TO_MS, periodRaw) ? periodRaw : "7d"

    // Keep same access policy as existing stats routes.
    const isFriend = Array.isArray(req.user.friends)
      ? req.user.friends.some((fid) => String(fid) === String(userId))
      : false
    if (userId !== req.user._id.toString() && !isFriend) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      })
    }

    const user = await User.findById(userId).select("ratings")
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      })
    }

    const sinceMs = PERIOD_TO_MS[period]
    const since = sinceMs == null ? null : new Date(Date.now() - sinceMs)
    const query = {
      status: "completed",
      $or: [{ "players.white": userId }, { "players.black": userId }],
      ...(type !== "all" ? { category: type } : {}),
      ...(since ? { updatedAt: { $gte: since } } : {}),
    }

    const games = await Game.find(query)
      .select("players result category updatedAt")
      .sort({ updatedAt: 1 })
      .lean()

    const normalized = []
    for (const g of games) {
      const mapped = getOutcomeForUser(g, userId)
      if (!mapped) continue
      normalized.push({
        outcome: mapped.outcome,
        reason: normalizeReason(g?.result?.reason),
        date: g.updatedAt ? new Date(g.updatedAt) : new Date(),
      })
    }

    const totals = {
      total: normalized.length,
      wins: normalized.filter((g) => g.outcome === "win").length,
      losses: normalized.filter((g) => g.outcome === "loss").length,
      draws: normalized.filter((g) => g.outcome === "draw").length,
    }
    const pct = (v) => (totals.total > 0 ? Number(((v / totals.total) * 100).toFixed(1)) : 0)

    const byOutcomeReason = {
      win: new Map(),
      loss: new Map(),
      draw: new Map(),
    }
    for (const g of normalized) {
      const key = g.reason || "other"
      const bucket = byOutcomeReason[g.outcome]
      bucket.set(key, (bucket.get(key) || 0) + 1)
    }
    const breakdownFor = (bucketName, totalForBucket) => {
      const map = byOutcomeReason[bucketName]
      return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({
          reason,
          label: reasonLabel(reason),
          count,
          percentage: totalForBucket > 0 ? Number(((count / totalForBucket) * 100).toFixed(1)) : 0,
        }))
    }

    const currentRating = currentRatingForType(user, type)
    const ratingHistory = buildRatingHistory(normalized, currentRating)

    return res.json({
      success: true,
      data: {
        userId,
        type,
        period,
        summary: {
          ...totals,
          winPercentage: pct(totals.wins),
          lossPercentage: pct(totals.losses),
          drawPercentage: pct(totals.draws),
        },
        ratingHistory,
        outcomeBreakdown: {
          wins: breakdownFor("win", totals.wins),
          losses: breakdownFor("loss", totals.losses),
          draws: breakdownFor("draw", totals.draws),
        },
      },
    })
  } catch (error) {
    console.error("Get detailed stats error:", error)
    return res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

module.exports = router
