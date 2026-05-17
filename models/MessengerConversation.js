const mongoose = require("mongoose");

/**
 * One row per friend pair (canonical userA < userB by ObjectId hex).
 * Separate from in-game chat (game rooms / chat:send).
 */
const messengerConversationSchema = new mongoose.Schema(
  {
    userA: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userB: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastMessageAt: { type: Date, default: null },
    lastMessageSnippet: { type: String, default: "", maxlength: 200 },
    lastMessageSenderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    /** Last time userA opened this thread (GET messages). */
    lastReadAtUserA: { type: Date, default: null },
    /** Last time userB opened this thread (GET messages). */
    lastReadAtUserB: { type: Date, default: null },
  },
  { timestamps: true }
);

messengerConversationSchema.index({ userA: 1, userB: 1 }, { unique: true });

/** @param {import("mongoose").Types.ObjectId | string} id1 */
function orderParticipantIds(id1, id2) {
  const a = new mongoose.Types.ObjectId(id1.toString());
  const b = new mongoose.Types.ObjectId(id2.toString());
  return a.toString() < b.toString() ? [a, b] : [b, a];
}

messengerConversationSchema.statics.orderParticipantIds = orderParticipantIds;

messengerConversationSchema.statics.findOrCreateForUsers = async function (id1, id2) {
  const [ua, ub] = orderParticipantIds(id1, id2);
  let doc = await this.findOne({ userA: ua, userB: ub });
  if (doc) return doc;
  try {
    doc = await this.create({ userA: ua, userB: ub });
    return doc;
  } catch (err) {
    if (err && err.code === 11000) {
      return this.findOne({ userA: ua, userB: ub });
    }
    throw err;
  }
};

module.exports = mongoose.model("MessengerConversation", messengerConversationSchema);
