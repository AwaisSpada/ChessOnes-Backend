const express = require("express")
const { body, validationResult } = require("express-validator")
const Stats = require("../models/Stats")
const User = require("../models/User")
const Game = require("../models/Game")
const auth = require("../middleware/auth")

const router = express.Router()

// @route   GET /api/stats/player/:userId
// @desc    Get player statistics
// @access  Private
router.get("/player/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params

    // Check if user can access these stats
    if (userId !== req.user._id.toString() && !req.user.friends.includes(userId)) {
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

module.exports = router
