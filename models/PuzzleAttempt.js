const mongoose = require("mongoose");

const puzzleAttemptSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    puzzle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Puzzle",
      required: true,
      index: true,
    },
    solved: {
      type: Boolean,
      default: false,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    timeSpent: {
      type: Number, // in seconds
      default: 0,
    },
    ratingChange: {
      type: Number,
      default: 0,
    },
    // NEW: Detailed history of each attempt (optional, appends new entries)
    // This allows tracking progression across multiple attempts
    attemptHistory: {
      type: [
        {
          attemptIndex: {
            type: Number,
            required: true,
          },
          movesPlayed: {
            type: [String],
            default: [],
          },
          solved: {
            type: Boolean,
            required: true,
          },
          timeSpent: {
            type: Number,
            default: 0,
          },
          usedHints: {
            type: Number,
            default: 0,
          },
          createdAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      required: false,
      default: undefined, // Use undefined for optional fields
    },
  },
  {
    timestamps: true,
  }
);

// Ensure one attempt record per user per puzzle
puzzleAttemptSchema.index({ user: 1, puzzle: 1 }, { unique: true });

module.exports = mongoose.model("PuzzleAttempt", puzzleAttemptSchema);


