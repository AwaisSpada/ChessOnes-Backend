const mongoose = require("mongoose")

const statsSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    gamesPlayed: {
      total: { type: Number, default: 0 },
      bot: { type: Number, default: 0 },
      multiplayer: { type: Number, default: 0 },
      // Category-specific game counts (for badges)
      bullet: { type: Number, default: 0 },
      blitz: { type: Number, default: 0 },
      rapid: { type: Number, default: 0 },
    },
    wins: {
      total: { type: Number, default: 0 },
      bot: { type: Number, default: 0 },
      multiplayer: { type: Number, default: 0 },
      // Category-specific win counts (for badges)
      bullet: { type: Number, default: 0 },
      blitz: { type: Number, default: 0 },
      rapid: { type: Number, default: 0 },
    },
    losses: {
      total: { type: Number, default: 0 },
      bot: { type: Number, default: 0 },
      multiplayer: { type: Number, default: 0 },
    },
    draws: {
      total: { type: Number, default: 0 },
      bot: { type: Number, default: 0 },
      multiplayer: { type: Number, default: 0 },
    },
    winRate: {
      type: Number,
      default: 0,
    },
    averageGameTime: {
      type: Number,
      default: 0,
    },
    longestGame: {
      type: Number,
      default: 0,
    },
    shortestGame: {
      type: Number,
      default: 0,
    },
    currentStreak: {
      type: Number,
      default: 0,
    },
    bestStreak: {
      type: Number,
      default: 0,
    },
    achievements: [
      {
        name: String,
        description: String,
        unlockedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    ratingHistory: [
      {
        rating: Number,
        date: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  },
)

// Calculate win rate
statsSchema.methods.calculateWinRate = function () {
  if (this.gamesPlayed.total === 0) return 0
  return Math.round((this.wins.total / this.gamesPlayed.total) * 100)
}

// Update stats after game
// gameType: "bot", "multiplayer", or "friend"
// category: "bullet", "blitz", or "rapid" (optional, for category-specific tracking)
statsSchema.methods.updateAfterGame = function (gameType, result, gameTime, category = null) {
  this.gamesPlayed.total++
  this.gamesPlayed[gameType] = (this.gamesPlayed[gameType] || 0) + 1

  // Track category-specific stats if category is provided
  if (category && (category === "bullet" || category === "blitz" || category === "rapid")) {
    this.gamesPlayed[category] = (this.gamesPlayed[category] || 0) + 1
  }

  if (result === "win") {
    this.wins.total++
    this.wins[gameType] = (this.wins[gameType] || 0) + 1
    // Track category-specific wins
    if (category && (category === "bullet" || category === "blitz" || category === "rapid")) {
      this.wins[category] = (this.wins[category] || 0) + 1
    }
    this.currentStreak++
    if (this.currentStreak > this.bestStreak) {
      this.bestStreak = this.currentStreak
    }
  } else if (result === "loss") {
    this.losses.total++
    this.losses[gameType] = (this.losses[gameType] || 0) + 1
    this.currentStreak = 0
  } else if (result === "draw") {
    this.draws.total++
    this.draws[gameType] = (this.draws[gameType] || 0) + 1
  }

  this.winRate = this.calculateWinRate()

  // Update game time stats
  if (this.averageGameTime === 0) {
    this.averageGameTime = gameTime
  } else {
    this.averageGameTime = Math.round((this.averageGameTime + gameTime) / 2)
  }

  if (gameTime > this.longestGame) {
    this.longestGame = gameTime
  }

  if (this.shortestGame === 0 || gameTime < this.shortestGame) {
    this.shortestGame = gameTime
  }

  return this.save()
}

module.exports = mongoose.model("Stats", statsSchema)
