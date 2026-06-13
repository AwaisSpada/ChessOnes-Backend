const mongoose = require("mongoose");

const learnStudyProgressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    studyId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    phase: {
      type: String,
      enum: ["new", "learning", "review"],
      default: "new",
    },
    ease: { type: Number, default: 2.5 },
    intervalDays: { type: Number, default: 0 },
    learningStep: { type: Number, default: 0 },
    dueAt: { type: Date, required: true },
    reps: { type: Number, default: 0 },
    lapses: { type: Number, default: 0 },
    lastStudiedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

learnStudyProgressSchema.index({ user: 1, studyId: 1 }, { unique: true });

module.exports = mongoose.model("LearnStudyProgress", learnStudyProgressSchema);
