const mongoose = require("mongoose");
const CustomArena = require("../models/CustomArena");
const ArenaNotification = require("../models/ArenaNotification");
const { getPublicFrontendUrl } = require("../utils/frontendUrl");

const REMINDER_WINDOW_MS = 15 * 60 * 1000;

function formatDurationMinutes(minutes) {
  const value = Number(minutes) || 0;
  if (value >= 1440) return "24h";
  if (value >= 60 && value % 60 === 0) return `${value / 60}h`;
  if (value >= 60) {
    const h = Math.floor(value / 60);
    const m = value % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${value}m`;
}

function formatArenaFormatLabel(arena) {
  if (arena.format === "match_count") {
    return `${arena.matchCount || 6} games per pairing`;
  }
  return `${formatDurationMinutes(arena.durationMinutes)} duration`;
}

function formatGameTypeLabel(gameType) {
  if (!gameType) return "Blitz";
  return gameType.charAt(0).toUpperCase() + gameType.slice(1).toLowerCase();
}

function formatRatingModeLabel(ratingMode) {
  return ratingMode === "unrated" ? "Unrated" : "Rated";
}

function formatScheduledAtLabel(scheduledAt) {
  if (!scheduledAt) return null;
  try {
    return new Date(scheduledAt).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return null;
  }
}

function getArenaRecipientUserIds(arena) {
  const ids = new Set();
  const hostId = arena.createdBy?._id || arena.createdBy;
  if (arena.hostPlays !== false && hostId) {
    ids.add(String(hostId));
  }
  for (const invite of arena.invitedPlayers || []) {
    if (invite?.userId) ids.add(String(invite.userId));
  }
  for (const id of arena.invitedUserIds || []) {
    if (id) ids.add(String(id));
  }
  for (const id of arena.participantUserIds || []) {
    if (id) ids.add(String(id));
  }
  return [...ids];
}

function getHostDisplay(arena) {
  const host = arena.createdBy;
  if (!host || typeof host !== "object") {
    return { hostName: "Host", hostAvatar: "" };
  }
  return {
    hostName: host.fullName || host.username || host.name || "Host",
    hostAvatar: host.avatar || "",
  };
}

function serializeArenaNotification(arena, notification, userId) {
  const uid = String(userId);
  const joined = (arena.joinedUserIds || []).map(String).includes(uid);
  const { hostName, hostAvatar } = getHostDisplay(arena);
  const baseUrl = getPublicFrontendUrl();
  const arenaId = String(arena._id);

  return {
    id: String(notification._id),
    lastEventType: notification.lastEventType,
    arenaId,
    arenaName: arena.name,
    gameType: arena.gameType,
    gameTypeLabel: formatGameTypeLabel(arena.gameType),
    timeControl: arena.timeControl?.label || "",
    ratingMode: arena.ratingMode === "unrated" ? "unrated" : "rated",
    ratingModeLabel: formatRatingModeLabel(arena.ratingMode),
    format: arena.format,
    formatLabel: formatArenaFormatLabel(arena),
    startMode: arena.startMode === "schedule" ? "schedule" : "now",
    scheduledAt: arena.scheduledAt || null,
    scheduledAtLabel: formatScheduledAtLabel(arena.scheduledAt),
    startedAt: arena.startedAt || null,
    status: arena.status,
    hostName,
    hostAvatar,
    playerCount: getArenaRecipientUserIds(arena).length,
    joinUrl: `${baseUrl}/tournament-play?arenaId=${arenaId}`,
    hasJoined: joined,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
  };
}

async function upsertArenaNotificationForUser(arena, userId, eventType) {
  const notification = await ArenaNotification.findOneAndUpdate(
    { userId, arenaId: arena._id },
    {
      $set: {
        lastEventType: eventType,
        dismissed: false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return serializeArenaNotification(arena, notification, userId);
}

function emitArenaNotification(io, userId, payload) {
  if (!io || !userId || !payload) return;
  io.to(`user:${String(userId)}`).emit("arena:notification", payload);
}

function emitArenaNotificationUpdate(io, userId, payload) {
  if (!io || !userId || !payload) return;
  io.to(`user:${String(userId)}`).emit("arena:notification:update", payload);
}

async function notifyArenaParticipants(io, arenaDoc, eventType) {
  const arena = await CustomArena.findById(arenaDoc._id || arenaDoc)
    .populate("createdBy", "username fullName name avatar")
    .lean();
  if (!arena) return [];

  const recipients = getArenaRecipientUserIds(arena);
  const payloads = [];

  for (const userId of recipients) {
    const payload = await upsertArenaNotificationForUser(arena, userId, eventType);
    payloads.push(payload);
    emitArenaNotification(io, userId, payload);
  }

  return payloads;
}

async function notifyArenaEndedIfNeeded(io, arenaId) {
  const arena = await CustomArena.findById(arenaId)
    .populate("createdBy", "username fullName name avatar")
    .lean();
  if (!arena || arena.status !== "ended" || arena.endedNotificationSent) {
    return;
  }

  await notifyArenaParticipants(io, arena, "ended");
  await CustomArena.updateOne(
    { _id: arena._id },
    { $set: { endedNotificationSent: true } }
  );
}

async function markArenaJoined(io, arenaId, userId) {
  const uid = String(userId);
  const arena = await CustomArena.findById(arenaId);
  if (!arena) return null;

  const joined = (arena.joinedUserIds || []).map(String);
  if (!joined.includes(uid)) {
    arena.joinedUserIds = [
      ...(arena.joinedUserIds || []),
      new mongoose.Types.ObjectId(uid),
    ];
    await arena.save();
  }

  const populated = await CustomArena.findById(arenaId)
    .populate("createdBy", "username fullName name avatar")
    .lean();
  if (!populated) return null;

  const notification = await ArenaNotification.findOne({
    userId: uid,
    arenaId,
    dismissed: false,
  });
  if (!notification) return null;

  const payload = serializeArenaNotification(populated, notification, uid);
  emitArenaNotificationUpdate(io, uid, payload);
  return payload;
}

async function listArenaNotificationsForUser(userId) {
  const notifications = await ArenaNotification.find({
    userId,
    dismissed: false,
  })
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  if (notifications.length === 0) return [];

  const arenaIds = [...new Set(notifications.map((n) => String(n.arenaId)))];
  const arenas = await CustomArena.find({ _id: { $in: arenaIds } })
    .populate("createdBy", "username fullName name avatar")
    .lean();
  const arenaMap = new Map(arenas.map((a) => [String(a._id), a]));

  return notifications
    .map((notification) => {
      const arena = arenaMap.get(String(notification.arenaId));
      if (!arena) return null;
      return serializeArenaNotification(arena, notification, userId);
    })
    .filter(Boolean);
}

async function dismissAllArenaNotificationsForUser(userId) {
  const result = await ArenaNotification.updateMany(
    { userId, dismissed: false },
    { $set: { dismissed: true } }
  );
  return result.modifiedCount || 0;
}

async function processScheduledArenaReminders(io, now = new Date()) {
  const upcoming = await CustomArena.find({
    status: "scheduled",
    startMode: "schedule",
    scheduledAt: { $ne: null },
    reminder15MinSent: { $ne: true },
  }).select("_id scheduledAt");

  for (const arena of upcoming) {
    const msUntil = new Date(arena.scheduledAt).getTime() - now.getTime();
    if (msUntil > 0 && msUntil <= REMINDER_WINDOW_MS) {
      await notifyArenaParticipants(io, arena._id, "reminder_15min");
      await CustomArena.updateOne(
        { _id: arena._id },
        { $set: { reminder15MinSent: true } }
      );
    }
  }
}

async function processPendingEndedNotifications(io) {
  const pending = await CustomArena.find({
    status: "ended",
    endedNotificationSent: { $ne: true },
  }).select("_id");

  for (const arena of pending) {
    await notifyArenaEndedIfNeeded(io, arena._id);
  }
}

module.exports = {
  REMINDER_WINDOW_MS,
  getArenaRecipientUserIds,
  serializeArenaNotification,
  notifyArenaParticipants,
  notifyArenaEndedIfNeeded,
  markArenaJoined,
  listArenaNotificationsForUser,
  dismissAllArenaNotificationsForUser,
  processScheduledArenaReminders,
  processPendingEndedNotifications,
};
