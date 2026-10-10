const mongoose = require("mongoose");

/**
 * Dedicated Puzzle Rush pool (imported from puzzle_rush_pool.csv).
 * Isolated from rated Puzzle and DailyPuzzle collections.
 */
const puzzleRushPuzzleSchema = new mongoose.Schema(
  {
    puzzleId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    fen: { type: String, required: true },
    moves: { type: String, required: true },
    rating: { type: Number, required: true, index: true },
    ratingDeviation: { type: Number, default: 0 },
    popularity: { type: Number, default: 0 },
    nbPlays: { type: Number, default: 0 },
    themes: { type: [String], default: [], index: true },
    category: { type: String, default: "", index: true },
    gameUrl: { type: String, default: "" },
    openingTags: { type: [String], default: [] },
  },
  { timestamps: true }
);

puzzleRushPuzzleSchema.index({ rating: 1, _id: 1 });

module.exports = mongoose.model("PuzzleRushPuzzle", puzzleRushPuzzleSchema);
