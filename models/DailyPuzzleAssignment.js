const mongoose = require("mongoose");

/** One global puzzle per calendar day (platform-wide). */
const dailyPuzzleAssignmentSchema = new mongoose.Schema(
  {
    dateKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    puzzle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DailyPuzzle",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "DailyPuzzleAssignment",
  dailyPuzzleAssignmentSchema
);
