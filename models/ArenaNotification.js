const mongoose = require("mongoose");

const arenaNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    arenaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomArena",
      required: true,
      index: true,
    },
    lastEventType: {
      type: String,
      enum: ["created", "reminder_15min", "ended"],
      required: true,
    },
    dismissed: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

arenaNotificationSchema.index({ userId: 1, arenaId: 1 }, { unique: true });

module.exports = mongoose.model("ArenaNotification", arenaNotificationSchema);
