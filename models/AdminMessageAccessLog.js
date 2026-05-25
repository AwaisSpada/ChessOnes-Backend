const mongoose = require("mongoose");

/**
 * Audit trail required by Privacy Policy §11 ("Message encryption & security"):
 * "All administrative access to message content is logged, including the
 *  identity of the staff member, the messages accessed, and the reason."
 *
 * One row is created per messages-fetch call from the admin Messenger
 * Investigation tool, even when the same admin re-opens the same thread.
 */
const adminMessageAccessLogSchema = new mongoose.Schema(
  {
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MessengerConversation",
      required: true,
      index: true,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    reason: { type: String, default: "", maxlength: 500 },
    messagesReturned: { type: Number, default: 0 },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

adminMessageAccessLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model(
  "AdminMessageAccessLog",
  adminMessageAccessLogSchema
);
