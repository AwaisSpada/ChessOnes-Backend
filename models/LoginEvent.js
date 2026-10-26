const mongoose = require("mongoose");

/**
 * Append-only login markers for admin CMS daily-login charts.
 * Does not affect gameplay, sockets, or auth responses.
 */
const loginEventSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

loginEventSchema.index({ createdAt: 1 });

module.exports = mongoose.model("LoginEvent", loginEventSchema);
