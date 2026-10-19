const mongoose = require("mongoose");

const MATCH_DURATION_MS = 3 * 60 * 1000;
const SEQUENCE_SIZE = 48;

const puzzleSnapshotSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    puzzleId: { type: String, required: true },
    fen: { type: String, required: true },
    moves: { type: String, required: true },
    rating: { type: Number, required: true },
    themes: { type: [String], default: [] },
    category: { type: String, default: "" },
  },
  { _id: false }
);

const playerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    username: { type: String, default: "" },
    fullName: { type: String, default: "" },
    avatar: { type: String, default: null },
    puzzleRating: { type: Number, default: 1200 },
    score: { type: Number, default: 0 },
    puzzleIndex: { type: Number, default: 0 },
    ready: { type: Boolean, default: false },
  },
  { _id: false }
);

const puzzleWarsMatchSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["pending", "ready", "live", "finished"],
      default: "pending",
      index: true,
    },
    mode: {
      type: String,
      enum: ["friend", "random", "open"],
      required: true,
      index: true,
    },
    durationMs: { type: Number, default: MATCH_DURATION_MS },
    puzzles: { type: [puzzleSnapshotSchema], default: [] },
    players: { type: [playerSchema], validate: [(v) => v.length === 2, "Need 2 players"] },
    challengerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    challengeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    startedAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    winnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /** 'p1' | 'p2' | 'draw' by player array index, or null while live */
    result: {
      type: String,
      enum: ["win", "draw", null],
      default: null,
    },
  },
  { timestamps: true }
);

puzzleWarsMatchSchema.index({ status: 1, updatedAt: -1 });
puzzleWarsMatchSchema.index({ "players.userId": 1, status: 1 });

puzzleWarsMatchSchema.statics.MATCH_DURATION_MS = MATCH_DURATION_MS;
puzzleWarsMatchSchema.statics.SEQUENCE_SIZE = SEQUENCE_SIZE;

module.exports = mongoose.model("PuzzleWarsMatch", puzzleWarsMatchSchema);
