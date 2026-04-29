const mongoose = require("mongoose");

const rematchRequestSchema = new mongoose.Schema(
  {
    gameId: {
      type: String,
      required: true,
      index: true,
    },
    fromUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    toUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired"],
      default: "pending",
    },
    originalGameId: {
      type: String,
      required: true,
    },
    timeControl: {
      initial: {
        type: Number,
        required: true,
      },
      increment: {
        type: Number,
        required: true,
      },
    },
    gameType: {
      type: String,
      enum: ["bullet", "blitz", "rapid", "classical"],
      default: "blitz",
    },
    isClearedByRecipient: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for quick lookups
rematchRequestSchema.index({ toUser: 1, status: 1 });
rematchRequestSchema.index({ gameId: 1 });

module.exports = mongoose.model("RematchRequest", rematchRequestSchema);

