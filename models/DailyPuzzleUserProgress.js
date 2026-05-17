const mongoose = require("mongoose");

/** Per-user solve state for a specific daily puzzle date. */
const dailyPuzzleUserProgressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dateKey: {
      type: String,
      required: true,
      index: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    solved: { type: Boolean, default: false },
    solvedAt: { type: Date, default: null },
    timeSpent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

dailyPuzzleUserProgressSchema.index({ user: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model(
  "DailyPuzzleUserProgress",
  dailyPuzzleUserProgressSchema
);
