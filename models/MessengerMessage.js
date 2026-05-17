const mongoose = require("mongoose");

const messengerMessageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MessengerConversation",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    body: {
      type: String,
      required: true,
      maxlength: 2000,
      trim: true,
    },
  },
  { timestamps: true }
);

messengerMessageSchema.index({ conversation: 1, createdAt: -1 });

module.exports = mongoose.model("MessengerMessage", messengerMessageSchema);
