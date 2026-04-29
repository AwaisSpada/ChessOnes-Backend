const mongoose = require("mongoose");

const badgeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    imageUrl: {
      type: String,
      required: false,
      trim: true,
      default: null,
    },
    // Unique identifier for the badge (e.g., "bullet_win_50", "checkmate_pawn", "rating_2000")
    key: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    // Badge category type: STATISTIC, GAME_EVENT, or OPENING
    badgeCategory: {
      type: String,
      enum: ["STATISTIC", "GAME_EVENT", "OPENING"],
      default: "STATISTIC",
    },
    // JSON configuration for badge logic
    // For STATISTIC: { "metric": "bulletWins", "value": 50, "condition": "gte" }
    // For GAME_EVENT: { "event": "heart_attack_finish", "timeRemaining": 500 } or { "event": "mate_with_pawn" }
    // For OPENING: { "opening": "Ruy Lopez" } or { "opening": "Sicilian Defense" }
    logicConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Legacy fields (kept for backward compatibility)
    // Criteria for earning the badge (stored as JSON)
    criteria: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Target value for the badge (numeric)
    targetValue: {
      type: Number,
      default: 0,
    },
    // Condition for comparison: "gte" (Greater Than or Equal to) or "exact" (Exact Match)
    condition: {
      type: String,
      enum: ["gte", "exact"],
      default: "gte",
    },
    // Metric/Category of badge (legacy - kept for backward compatibility)
    category: {
      type: String,
      enum: ["wins", "streak", "rating", "games", "botWins", "highestRating", "winStreak", "totalGames", "bulletWins", "blitzWins", "rapidWins", "bulletRating", "blitzRating", "rapidRating", "bulletGames", "blitzGames", "rapidGames", "custom"],
      default: "custom",
    },
    // Whether this badge is automatically awarded
    autoAward: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Index for badge lookup
badgeSchema.index({ name: 1 });
badgeSchema.index({ key: 1 });
badgeSchema.index({ badgeCategory: 1, autoAward: 1 });
badgeSchema.index({ category: 1, autoAward: 1 }); // Legacy index

module.exports = mongoose.model("Badge", badgeSchema);

