const mongoose = require("mongoose");

const puzzleSchema = new mongoose.Schema(
  {
    puzzleId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    fen: {
      type: String,
      required: true,
    },
    moves: {
      type: String,
      required: true, // Space-separated moves like "e2e4 e7e5" - KEPT FOR BACKWARD COMPATIBILITY
    },
    // NEW: Multi-move solution tree (optional, preferred over moves if present)
    // Structure: [{ move: "e2e4", reply: "e7e5" }, { move: "d2d4", reply: "d7d5" }]
    solutionTree: {
      type: [
        {
          move: { type: String, required: true },
          reply: { type: String, required: false },
        },
      ],
      required: false,
      default: undefined, // Use undefined instead of null for optional fields
    },
    rating: {
      type: Number,
      required: true,
      index: true,
    },
    ratingDeviation: {
      type: Number,
      default: 0,
    },
    popularity: {
      type: Number,
      default: 0,
    },
    nbPlays: {
      type: Number,
      default: 0,
    },
    // NEW: Derived popularity score for better ranking
    popularityScore: {
      type: Number,
      default: 0,
      index: true,
    },
    // NEW: Average time to solve (in seconds)
    averageSolveTime: {
      type: Number,
      default: 0,
    },
    themes: {
      type: [String],
      default: [],
    },
    gameUrl: {
      type: String,
      default: "",
    },
    openingTags: {
      type: [String],
      default: [],
    },
    difficulty: {
      type: String,
      enum: ["VERY EASY", "EASY", "MEDIUM", "HARD", "MASTER"],
      default: "MEDIUM",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Calculate difficulty based on rating
puzzleSchema.pre("save", function (next) {
  if (this.rating) {
    if (this.rating < 1000) {
      this.difficulty = "VERY EASY";
    } else if (this.rating < 1500) {
      this.difficulty = "EASY";
    } else if (this.rating < 2000) {
      this.difficulty = "MEDIUM";
    } else if (this.rating < 2500) {
      this.difficulty = "HARD";
    } else {
      this.difficulty = "MASTER";
    }
  }
  next();
});

// Index for efficient queries
puzzleSchema.index({ rating: 1, difficulty: 1 });
puzzleSchema.index({ themes: 1 });
// NEW: Index for popularity-based queries (safe to add)
puzzleSchema.index({ popularityScore: -1 });

module.exports = mongoose.model("Puzzle", puzzleSchema);


