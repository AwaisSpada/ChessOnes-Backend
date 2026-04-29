const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema(
  {
    gameId: {
      type: String,
      required: true,
      unique: true,
    },
    type: {
      type: String,
      enum: ["bot", "multiplayer", "friend"],
      required: true,
    },
    players: {
      white: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: function() {
          // Only required for multiplayer games, not bot games
          return this.type !== "bot";
        },
      },
      black: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    },
    board: {
      type: Array,
      required: true,
      default: () => {
        // Standard chess starting position
        return [
          "r",
          "n",
          "b",
          "q",
          "k",
          "b",
          "n",
          "r",
          "p",
          "p",
          "p",
          "p",
          "p",
          "p",
          "p",
          "p",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "P",
          "P",
          "P",
          "P",
          "P",
          "P",
          "P",
          "P",
          "R",
          "N",
          "B",
          "Q",
          "K",
          "B",
          "N",
          "R",
        ];
      },
    },
    moves: [
      {
        from: Number,
        to: Number,
        piece: String,
        captured: String,
        notation: String,
        moveTimeMs: Number,
        moveTimeSeconds: Number,
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    positionHistory: {
      type: [String],
      default: [],
    },
    currentTurn: {
      type: String,
      enum: ["white", "black"],
      default: "white",
    },
    status: {
      type: String,
      enum: ["active", "completed", "abandoned"],
      default: "active",
    },
    result: {
      winner: {
        type: String,
        enum: ["white", "black", "draw"],
      },
      reason: {
        type: String,
        enum: [
          "checkmate",
          "stalemate",
          "resignation",
          "timeout",
          "draw-agreement",
          "draw-by-agreement",
          "disconnect",
          "threefold-repetition",
          "insufficient-material",
        ],
      },
    },
    timeControl: {
      initial: {
        type: Number,
        default: 600000, // 10 minutes in milliseconds
      },
      increment: {
        type: Number,
        default: 0,
      },
    },
    category: {
      type: String,
      enum: ["bullet", "blitz", "rapid", "un-timed"],
      default: null, // Will be set during game creation based on timeControl
    },
    timeRemaining: {
      white: {
        type: Number,
        default: 600000,
      },
      black: {
        type: Number,
        default: 600000,
      },
    },
    botDifficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      default: null,
    },
    // Optional reference to a named Bot (for Stockfish-backed bot battles)
    bot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bot",
      default: null,
    },
    // Which side the bot is playing ("white" or "black")
    botSide: {
      type: String,
      enum: ["white", "black", null],
      default: null,
    },
    // Optional custom bot profile (not backed by Bot collection)
    customBot: {
      name: { type: String, default: null },
      photoUrl: { type: String, default: null },
      subtitle: { type: String, default: null },
      description: { type: String, default: null },
      elo: { type: Number, default: null },
    },
    // Optional custom Stockfish tuning selected by user
    customBotConfig: {
      elo: { type: Number, default: null },
      skillLevel: { type: Number, default: null },
      depth: { type: Number, default: null },
      movetime: { type: Number, default: null },
    },
    chat: [
      {
        player: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        message: String,
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Draw request tracking
    drawRequest: {
      from: {
        type: String,
        enum: ["white", "black", null],
        default: null,
      },
      timestamp: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

// Generate unique game ID
gameSchema.pre("save", function (next) {
  if (!this.gameId) {
    this.gameId = Math.random().toString(36).substr(2, 9);
  }
  next();
});

module.exports = mongoose.model("Game", gameSchema);
