const mongoose = require("mongoose");
const crypto = require("crypto");

const customArenaSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    gameType: {
      type: String,
      enum: ["bullet", "blitz", "rapid"],
      required: true,
      index: true,
    },
    timeControl: {
      label: { type: String, required: true },
      time: { type: Number, required: true },
      increment: { type: Number, default: 0 },
    },
    ratingMode: {
      type: String,
      enum: ["rated", "unrated"],
      default: "rated",
    },
    format: {
      type: String,
      enum: ["match_count", "time_duration"],
      default: "time_duration",
    },
    matchCount: {
      type: Number,
      default: 6,
      min: 1,
      max: 20,
    },
    durationMinutes: {
      type: Number,
      default: 1440,
      min: 30,
      max: 1440,
    },
    invitedUserIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
      index: true,
    },
    invitedPlayers: {
      type: [
        {
          userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          username: { type: String, required: true, trim: true },
          displayName: { type: String, default: "", trim: true },
          avatar: { type: String, default: "" },
          country: { type: String, default: "" },
        },
      ],
      default: [],
    },
    visibility: {
      type: String,
      enum: ["invite_only", "link_access", "public"],
      default: "invite_only",
    },
    startMode: {
      type: String,
      enum: ["now", "schedule"],
      default: "now",
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    joinCode: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomBytes(4).toString("hex"),
    },
    status: {
      type: String,
      enum: ["draft", "scheduled", "live", "ended"],
      default: "draft",
      index: true,
    },
    hostPlays: {
      type: Boolean,
      default: true,
    },
    participantUserIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    leaderboard: {
      type: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          username: { type: String, default: "" },
          displayName: { type: String, default: "" },
          avatar: { type: String, default: "" },
          country: { type: String, default: "" },
          points: { type: Number, default: 0 },
          wins: { type: Number, default: 0 },
          draws: { type: Number, default: 0 },
          losses: { type: Number, default: 0 },
          gamesPlayed: { type: Number, default: 0 },
          discarded: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    pairStats: {
      type: [
        {
          playerA: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          playerB: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          gamesPlayed: { type: Number, default: 0 },
          lastWhiteUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        },
      ],
      default: [],
    },
    playerStates: {
      type: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          status: {
            type: String,
            enum: ["idle", "matched", "in_game", "offline", "left_tournament"],
            default: "idle",
          },
          matchmakingReady: { type: Boolean, default: false },
          currentGameId: { type: String, default: null },
          lastOpponentUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
          },
        },
      ],
      default: [],
    },
    activePairings: {
      type: [
        {
          pairingId: { type: String, required: true },
          whiteUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          blackUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          gameId: { type: String, default: null },
          status: {
            type: String,
            enum: ["pending", "active", "completed"],
            default: "pending",
          },
          acceptedUserIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
            default: [],
          },
          result: {
            type: String,
            enum: ["white", "black", "draw", null],
            default: null,
          },
          createdAt: { type: Date, default: Date.now },
          completedAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
    chatMessages: {
      type: [
        {
          messageId: { type: String, required: true },
          senderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          username: { type: String, default: "Player", trim: true },
          avatar: { type: String, default: "", trim: true },
          message: { type: String, required: true, maxlength: 500 },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    joinedUserIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    reminder15MinSent: {
      type: Boolean,
      default: false,
    },
    endedNotificationSent: {
      type: Boolean,
      default: false,
    },
    recordedGameIds: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CustomArena", customArenaSchema);
