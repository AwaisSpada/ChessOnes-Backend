const mongoose = require("mongoose");

/**
 * Pool entry imported from Excel. Each puzzle is used at most once globally.
 * `usedOnDateKey` is set when assigned to a calendar day (YYYY-MM-DD).
 */
const dailyPuzzleSchema = new mongoose.Schema(
  {
    sourceId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    fen: { type: String, required: true },
    moves: { type: String, required: true },
    rating: { type: Number, default: 1500 },
    themes: { type: [String], default: [] },
    importOrder: { type: Number, default: 0, index: true },
    usedOnDateKey: {
      type: String,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

dailyPuzzleSchema.index({ usedOnDateKey: 1, importOrder: 1 });

module.exports = mongoose.model("DailyPuzzle", dailyPuzzleSchema);
