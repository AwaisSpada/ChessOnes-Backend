const mongoose = require("mongoose");

const wrongEntrySchema = new mongoose.Schema(
  {
    puzzleId: { type: String, required: true },
    fen: { type: String, default: "" },
    moves: { type: String, default: "" },
    rating: { type: Number, default: 0 },
    themes: { type: [String], default: [] },
    category: { type: String, default: "" },
    reason: {
      type: String,
      enum: ["wrong", "skip"],
      required: true,
    },
  },
  { _id: false }
);

/**
 * One completed Puzzle Rush attempt (3:00 or 5:00).
 * Leaderboards use best score per user per mode (and optionally per day).
 */
const puzzleRushRunSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    modeSeconds: {
      type: Number,
      enum: [180, 300],
      required: true,
      index: true,
    },
    solved: { type: Number, required: true, min: 0 },
    wrongCount: { type: Number, required: true, min: 0, default: 0 },
    wrongs: { type: [wrongEntrySchema], default: [] },
    bestStreak: { type: Number, default: 0, min: 0 },
    avgSecondsPerPuzzle: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0, min: 0, max: 100 },
    durationMs: { type: Number, default: 0 },
    /** UTC calendar day of the run (YYYY-MM-DD) for daily boards */
    dayKey: { type: String, required: true, index: true },
    isPersonalBest: { type: Boolean, default: false },
  },
  { timestamps: true }
);

puzzleRushRunSchema.index({ modeSeconds: 1, dayKey: 1, solved: -1, createdAt: 1 });
puzzleRushRunSchema.index({ modeSeconds: 1, solved: -1, createdAt: 1 });
puzzleRushRunSchema.index({ user: 1, modeSeconds: 1, solved: -1 });

module.exports = mongoose.model("PuzzleRushRun", puzzleRushRunSchema);
