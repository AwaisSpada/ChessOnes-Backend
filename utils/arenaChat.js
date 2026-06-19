const CustomArena = require("../models/CustomArena");

const MAX_ARENA_CHAT_MESSAGES = 200;

function serializeArenaChatMessage(arenaId, doc) {
  const createdAt = doc.createdAt ? new Date(doc.createdAt) : new Date();
  return {
    arenaId: String(arenaId),
    messageId: doc.messageId,
    senderId: String(doc.senderId),
    username: doc.username || "Player",
    avatar: doc.avatar || "",
    message: doc.message,
    timestamp: createdAt.toISOString(),
  };
}

async function appendArenaChatMessage(arenaId, payload) {
  const trimmed = String(payload.message || "").trim();
  if (!trimmed || !arenaId || !payload.senderId) return null;

  const createdAt = payload.timestamp ? new Date(payload.timestamp) : new Date();
  const messageId =
    payload.messageId ||
    `${payload.senderId}-${createdAt.getTime()}-${trimmed.slice(0, 32)}`;

  const entry = {
    messageId,
    senderId: payload.senderId,
    username: payload.username || "Player",
    avatar: payload.avatar || "",
    message: trimmed,
    createdAt,
  };

  const updated = await CustomArena.findByIdAndUpdate(
    arenaId,
    {
      $push: {
        chatMessages: {
          $each: [entry],
          $slice: -MAX_ARENA_CHAT_MESSAGES,
        },
      },
    },
    { new: true, select: "chatMessages" }
  ).lean();

  if (!updated) return null;
  return serializeArenaChatMessage(arenaId, entry);
}

async function getArenaChatMessages(arenaId) {
  const arena = await CustomArena.findById(arenaId).select("chatMessages").lean();
  if (!arena) return null;
  return (arena.chatMessages || []).map((m) =>
    serializeArenaChatMessage(arenaId, m)
  );
}

module.exports = {
  MAX_ARENA_CHAT_MESSAGES,
  serializeArenaChatMessage,
  appendArenaChatMessage,
  getArenaChatMessages,
};
