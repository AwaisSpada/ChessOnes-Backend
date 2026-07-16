const mongoose = require("mongoose");

const invitationSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
    },
    fromUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    toUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      default: null,
    },
    toEmail: {
      type: String,
      required: false,
      lowercase: true,
      trim: true,
      default: null,
    },
    /** Anyone with the join link can accept (not tied to a friend). */
    isOpenLink: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** Challenger's preferred color: white | black | random */
    preferredColor: {
      type: String,
      enum: ["white", "black", "random"],
      default: "random",
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired"],
      default: "pending",
    },
    gameType: {
      type: String,
      enum: ["bullet", "blitz", "rapid", "classical"],
      default: "blitz",
    },
    matchType: {
      type: String,
      enum: ["rated", "unrated"],
      default: "rated",
    },
    timeControl: {
      initial: {
        type: Number,
        default: 300000,
      },
      increment: {
        type: Number,
        default: 3,
      },
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    gameId: {
      type: String,
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

invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("GameInvitation", invitationSchema);
