const CustomArena = require("../models/CustomArena");
const User = require("../models/User");
const {
  isMatchCountArenaComplete,
  hasActivePairings,
  getActiveArenaRoster,
} = require("../utils/customArenaPairing");
const { initializeArenaRuntime, tickArenaPairings } = require("../services/customArenaEngine");
const {
  processScheduledArenaReminders,
  processPendingEndedNotifications,
  notifyArenaEndedIfNeeded,
} = require("../services/arenaNotificationService");

const MATCH_COUNT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function isMatchCountArenaExpired(arena, now = Date.now()) {
  if (!arena?.createdAt) return false;
  return now - new Date(arena.createdAt).getTime() >= MATCH_COUNT_MAX_AGE_MS;
}

async function syncCustomArenaStatuses(io = null) {
  const now = new Date();

  await processScheduledArenaReminders(io, now);

  const dueScheduled = await CustomArena.find({
    status: "scheduled",
    scheduledAt: { $lte: now },
  }).select("_id scheduledAt createdBy");

  for (const arena of dueScheduled) {
    await CustomArena.updateOne(
      { _id: arena._id },
      {
        $set: {
          status: "live",
          startedAt: arena.scheduledAt || now,
        },
      }
    );

    const host = await User.findById(arena.createdBy).select(
      "username fullName avatar"
    );
    if (host) {
      await initializeArenaRuntime(arena._id, host);
      await tickArenaPairings(arena._id);
    }
  }

  const liveTimed = await CustomArena.find({
    status: "live",
    format: "time_duration",
    startedAt: { $ne: null },
  }).select("_id startedAt durationMinutes");

  for (const arena of liveTimed) {
    const endMs =
      new Date(arena.startedAt).getTime() + arena.durationMinutes * 60 * 1000;
    if (Date.now() >= endMs) {
      await CustomArena.updateOne(
        { _id: arena._id },
        { $set: { status: "ended", endedAt: new Date(endMs) } }
      );
      if (io) await notifyArenaEndedIfNeeded(io, arena._id);
    }
  }

  const liveMatchCount = await CustomArena.find({
    status: "live",
    format: "match_count",
  }).select(
    "_id participantUserIds pairStats matchCount activePairings createdAt playerStates"
  );

  for (const arena of liveMatchCount) {
    if (isMatchCountArenaExpired(arena, now.getTime())) {
      await CustomArena.updateOne(
        { _id: arena._id },
        { $set: { status: "ended", endedAt: now } }
      );
      if (io) await notifyArenaEndedIfNeeded(io, arena._id);
      continue;
    }

    const roster = (arena.participantUserIds || []).map(String);
    const activeRoster = getActiveArenaRoster(arena.playerStates, roster);
    const complete = isMatchCountArenaComplete(
      activeRoster,
      arena.pairStats,
      arena.matchCount
    );
    const stillActive = hasActivePairings(arena.activePairings);
    if (complete && !stillActive) {
      await CustomArena.updateOne(
        { _id: arena._id },
        { $set: { status: "ended", endedAt: now } }
      );
      if (io) await notifyArenaEndedIfNeeded(io, arena._id);
    }
  }

  await processPendingEndedNotifications(io);
}

module.exports = {
  syncCustomArenaStatuses,
  isMatchCountArenaExpired,
  MATCH_COUNT_MAX_AGE_MS,
};
