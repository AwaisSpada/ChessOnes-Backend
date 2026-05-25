const mongoose = require("mongoose");
const { encrypt, decrypt, isEncrypted } = require("../utils/messageCrypto");

// Plaintext is capped to 2000 chars by the route layer; the column itself
// stores the AES-GCM envelope which is ~33% larger than the plaintext plus a
// fixed-size header, so we leave the field unbounded here.
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
      trim: true,
    },
    // Soft-delete: when a user deletes their own message we hide it from both
    // participants (user-facing behavior unchanged) but keep the row + body so
    // moderators can still investigate reports. `deletedAt = null` means the
    // message is live.
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

messengerMessageSchema.index({ conversation: 1, createdAt: -1 });
// Fast path for "latest non-deleted message" (snippet refresh + message list).
messengerMessageSchema.index({ conversation: 1, deletedAt: 1, createdAt: -1 });

// Encrypt the body just before it is persisted. `validate` runs after setters
// but before `save`, and we hook there so the encrypted form is what gets
// validated/stored. Idempotent — encrypt() is a no-op for already-enveloped
// strings, so re-saving an existing message doesn't double-encrypt.
messengerMessageSchema.pre("validate", function (next) {
  if (this.isModified("body") && typeof this.body === "string") {
    if (!isEncrypted(this.body)) {
      this.body = encrypt(this.body);
    }
  }
  next();
});

/** Return the plaintext body for a single message (document or lean object). */
messengerMessageSchema.statics.decryptBody = function (doc) {
  if (!doc) return "";
  return decrypt(doc.body || "");
};

module.exports = mongoose.model("MessengerMessage", messengerMessageSchema);
