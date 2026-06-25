const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const CustomArena = require("../models/CustomArena");
const auth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");
const { getPlatformGamesTodayCount } = require("../utils/game-list-enrichment");
const { syncCustomArenaStatuses, MATCH_COUNT_MAX_AGE_MS } = require("../utils/customArenaLifecycle");
const {
  isArenaVisibleToUser,
  viewerIsInvited,
} = require("../utils/customArenaVisibility");
const { enrichLeaderboardRow, buildRuntimeLeaderboard } = require("../utils/customArenaPairing");
const {
  initializeArenaRuntime,
  getArenaRuntimeState,
  recordArenaGameResult,
  attachGameToPairing,
  startArenaPairingGame,
  setArenaMatchmakingReady,
  acceptArenaPairing,
  enterArenaLobby,
  addInvitesToLiveArena,
  leaveArenaTournament,
} = require("../services/customArenaEngine");
const { getArenaChatMessages } = require("../utils/arenaChat");
const {
  notifyArenaParticipants,
  notifyArenaInvitees,
  markArenaJoined,
  listArenaNotificationsForUser,
  notifyArenaEndedIfNeeded,
} = require("../services/arenaNotificationService");

// Lowered for flow testing (host + 1 other is enough)
const MIN_ARENA_PLAYERS = 2;

const router = express.Router();

const ACTIVE_USER_STATUSES = ["online", "in-game"];
const GAME_TYPES = ["bullet", "blitz", "rapid"];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDurationMinutes(minutes) {
  if (minutes >= 1440) return "24h";
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${minutes}m`;
}

function formatRelativeAgo(date) {
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatCountdown(targetDate) {
  const diffMs = new Date(targetDate).getTime() - Date.now();
  if (diffMs <= 0) return "0:00";
  const totalMins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs >= 24) return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  const secs = Math.floor((diffMs % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatDetailedCountdown(targetDate) {
  const diffMs = new Date(targetDate).getTime() - Date.now();
  if (diffMs <= 0) return "0d 0h 0m 00s";

  const totalSecs = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const seconds = totalSecs % 60;

  return `${days}d ${hours}h ${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function getMatchCountExpiryDate(arena) {
  if (!arena?.createdAt) return null;
  return new Date(new Date(arena.createdAt).getTime() + MATCH_COUNT_MAX_AGE_MS);
}

function computeProgress(arena) {
  if (arena.status === "ended") return 100;
  if (arena.status !== "live") return 0;

  if (arena.format === "match_count" && arena.createdAt) {
    const elapsedMs = Date.now() - new Date(arena.createdAt).getTime();
    return Math.min(
      100,
      Math.max(0, Math.round((elapsedMs / MATCH_COUNT_MAX_AGE_MS) * 100))
    );
  }

  if (arena.format !== "time_duration" || !arena.startedAt) return 0;

  const elapsedMs = Date.now() - new Date(arena.startedAt).getTime();
  const totalMs = arena.durationMinutes * 60 * 1000;
  if (totalMs <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100)));
}

function countInvitedPlayers(arena) {
  if (Array.isArray(arena.invitedPlayers) && arena.invitedPlayers.length > 0) {
    return arena.invitedPlayers.length;
  }
  if (Array.isArray(arena.invitedUserIds)) {
    return arena.invitedUserIds.length;
  }
  return 0;
}

function buildParticipantsList(arena) {
  const hostId = String(arena.createdBy?._id || arena.createdBy || "");

  if (Array.isArray(arena.leaderboard) && arena.leaderboard.length > 0) {
    return arena.leaderboard.map((row) => ({
      userId: String(row.userId),
      username: row.username || "player",
      displayName: row.displayName || row.username || "Player",
      avatar: row.avatar || "",
      country: row.country || "",
      isHost: hostId && String(row.userId) === hostId,
    }));
  }

  const participants = [];
  const seen = new Set();

  const push = (entry, isHost = false) => {
    const userId = String(entry.userId || entry._id);
    if (!userId || seen.has(userId)) return;
    seen.add(userId);
    participants.push({
      userId,
      username: entry.username || "player",
      displayName: entry.displayName || entry.fullName || entry.username || "Player",
      avatar: entry.avatar || "",
      country: entry.country || "",
      isHost,
    });
  };

  if (arena.hostPlays !== false && arena.createdBy) {
    push(
      {
        userId: hostId,
        username: arena.createdBy.username,
        displayName: arena.createdBy.fullName || arena.createdBy.username,
        avatar: arena.createdBy.avatar,
        country: arena.createdBy.country || "",
      },
      true
    );
  }

  for (const invite of arena.invitedPlayers || []) {
    if (invite?.userId) push(invite, String(invite.userId) === hostId);
  }

  return participants;
}

function serializeCustomArena(arena, viewer) {
  const viewerId = viewer?._id ? String(viewer._id) : null;
  const host =
    arena.createdBy?.username ||
    arena.createdBy?.fullName ||
    arena.createdBy?.name ||
    arena.createdBy?.email?.split("@")[0] ||
    "Host";
  const isOwner =
    viewerId && String(arena.createdBy?._id || arena.createdBy) === viewerId;
  const isInvited = viewer ? viewerIsInvited(arena, viewer) : false;

  const formatLabel =
    arena.format === "match_count"
      ? `${arena.matchCount} games / pairing`
      : formatDurationMinutes(arena.durationMinutes);

  let timeLeft = null;
  let startedAgo = null;
  let startsIn = null;
  let endedAgo = null;
  let progress = computeProgress(arena);

  if (arena.status === "live") {
    startedAgo = arena.startedAt ? formatRelativeAgo(arena.startedAt) : "Just now";
    if (arena.format === "time_duration" && arena.startedAt) {
      const endMs =
        new Date(arena.startedAt).getTime() + arena.durationMinutes * 60 * 1000;
      timeLeft = formatCountdown(new Date(endMs));
    } else if (arena.format === "match_count") {
      const expiry = getMatchCountExpiryDate(arena);
      timeLeft = expiry ? formatDetailedCountdown(expiry) : "—";
    } else {
      timeLeft = "Live";
    }
  } else if (arena.status === "scheduled" && arena.scheduledAt) {
    startsIn = formatCountdown(arena.scheduledAt);
  } else if (arena.status === "ended") {
    endedAgo = arena.endedAt
      ? formatRelativeAgo(arena.endedAt)
      : arena.updatedAt
        ? formatRelativeAgo(arena.updatedAt)
        : "Recently";
    progress = 100;
  }

  const invitedList = Array.isArray(arena.invitedPlayers)
    ? arena.invitedPlayers
        .filter((p) => p && typeof p === "object")
        .map((p) => ({
          userId: String(p.userId),
          username: p.username,
          displayName: p.displayName || p.username,
          avatar: p.avatar || "",
          country: p.country || "",
        }))
    : [];

  const participants = buildParticipantsList(arena);

  const leaderboard = buildRuntimeLeaderboard(arena);

  return {
    id: String(arena._id),
    name: arena.name,
    category: arena.gameType,
    tc: arena.timeControl?.label || "—",
    status: arena.status,
    ratingMode: arena.ratingMode,
    players: countInvitedPlayers(arena),
    invitedPlayers: invitedList,
    participants,
    leaderboard,
    host,
    visibility: arena.visibility,
    format: arena.format,
    formatLabel,
    joinCode: arena.joinCode,
    scheduledAt: arena.scheduledAt || null,
    startedAt: arena.startedAt || null,
    endedAt: arena.endedAt || null,
    startedAgo,
    startsIn,
    endedAgo,
    timeLeft,
    progress,
    isOwner: Boolean(isOwner),
    isInvited: Boolean(isInvited),
    hostPlays: arena.hostPlays !== false,
    participantCount:
      Array.isArray(arena.participantUserIds) && arena.participantUserIds.length > 0
        ? arena.participantUserIds.length
        : countInvitedPlayers(arena) + (arena.hostPlays !== false ? 1 : 0),
    createdAt: arena.createdAt,
    durationMinutes: arena.durationMinutes ?? null,
    matchCount: arena.matchCount ?? null,
    startMode: arena.startMode || "now",
    timeControl: arena.timeControl
      ? {
          label: arena.timeControl.label,
          time: arena.timeControl.time,
          increment: Number(arena.timeControl.increment) || 0,
        }
      : null,
  };
}

function parseScheduledAt(startMode, startDate, startTime) {
  if (startMode !== "schedule" || !startDate || !startTime) return null;
  const scheduled = new Date(`${startDate}T${startTime}`);
  return Number.isNaN(scheduled.getTime()) ? null : scheduled;
}

async function resolveInvitedPlayers(rawList, currentUserId) {
  const resolved = [];
  const seen = new Set();

  if (!Array.isArray(rawList)) return resolved;

  for (const item of rawList) {
    let user = null;

    if (item && typeof item === "object" && item.userId) {
      if (!mongoose.Types.ObjectId.isValid(item.userId)) continue;
      user = await User.findById(item.userId).select("username fullName avatar country");
    } else if (typeof item === "string") {
      const username = item.trim().replace(/^@/, "");
      if (!username) continue;
      user = await User.findOne({
        username: { $regex: new RegExp(`^${escapeRegex(username)}$`, "i") },
      }).select("username fullName avatar country");
    }

    if (!user) continue;
    const id = String(user._id);
    if (id === String(currentUserId) || seen.has(id)) continue;

    seen.add(id);
    resolved.push({
      userId: user._id,
      username: user.username,
      displayName: user.fullName || user.username,
      avatar: user.avatar || "",
      country: user.country || "",
    });
  }

  return resolved;
}

// @route   GET /api/tournaments/arena-notifications
router.get("/arena-notifications", auth, async (req, res) => {
  try {
    const notifications = await listArenaNotificationsForUser(req.user._id);
    res.json({ success: true, data: { notifications } });
  } catch (error) {
    console.error("[Tournaments] arena-notifications list error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load arena notifications",
    });
  }
});

// @route   GET /api/tournaments/header-stats
router.get("/header-stats", async (req, res) => {
  try {
    const io = req.app.get("io");
    await syncCustomArenaStatuses(io);

    const [onlineCount, gamesToday, liveCount] = await Promise.all([
      User.countDocuments({
        isDeleted: false,
        status: { $in: ACTIVE_USER_STATUSES },
      }),
      getPlatformGamesTodayCount(),
      CustomArena.countDocuments({ status: "live" }),
    ]);

    res.json({
      success: true,
      data: {
        onlineCount,
        gamesToday,
        liveCount,
      },
    });
  } catch (error) {
    console.error("[Tournaments] header-stats error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load tournament header stats",
    });
  }
});

// @route   GET /api/tournaments/custom-arenas
router.get("/custom-arenas", optionalAuth, async (req, res) => {
  try {
    const io = req.app.get("io");
    await syncCustomArenaStatuses(io);

    const arenas = await CustomArena.find()
      .sort({ createdAt: -1 })
      .populate("createdBy", "username fullName name email")
      .lean();

    const visible = arenas.filter((arena) => isArenaVisibleToUser(arena, req.user));

    res.json({
      success: true,
      data: {
        arenas: visible.map((arena) => serializeCustomArena(arena, req.user)),
      },
    });
  } catch (error) {
    console.error("[Tournaments] custom-arenas list error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load custom arenas",
    });
  }
});

// @route   GET /api/tournaments/custom-arenas/:id
router.get("/custom-arenas/:id", optionalAuth, async (req, res) => {
  try {
    const io = req.app.get("io");
    await syncCustomArenaStatuses(io);

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid arena id",
      });
    }

    const arena = await CustomArena.findById(req.params.id)
      .populate("createdBy", "username fullName name email avatar country")
      .lean();

    if (!arena) {
      return res.status(404).json({
        success: false,
        message: "Arena not found",
      });
    }

    if (!isArenaVisibleToUser(arena, req.user)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this arena",
      });
    }

    res.json({
      success: true,
      data: {
        arena: serializeCustomArena(arena, req.user),
      },
    });
  } catch (error) {
    console.error("[Tournaments] custom-arenas detail error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load custom arena",
    });
  }
});

// @route   GET /api/tournaments/custom-arenas/:id/state
// @desc    Arena runtime: leaderboard, pairings, player availability
// @access  Private (visible participants)
router.get("/custom-arenas/:id/state", auth, async (req, res) => {
  try {
    const io = req.app.get("io");
    await syncCustomArenaStatuses(io);

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid arena id" });
    }

    const arena = await CustomArena.findById(req.params.id).lean();
    if (!arena) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arena, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const runtime = await getArenaRuntimeState(req.params.id, { autoTick: false });
    res.json({ success: true, data: { runtime } });
  } catch (error) {
    console.error("[Tournaments] custom-arenas state error:", error);
    res.status(500).json({ success: false, message: "Failed to load arena state" });
  }
});

// @route   GET /api/tournaments/custom-arenas/:id/chat
// @desc    Arena chat message history (last 200 messages)
// @access  Private (visible participants)
router.get("/custom-arenas/:id/chat", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid arena id" });
    }

    const arena = await CustomArena.findById(req.params.id).lean();
    if (!arena) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arena, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const messages = await getArenaChatMessages(req.params.id);
    res.json({ success: true, data: { messages: messages || [] } });
  } catch (error) {
    console.error("[Tournaments] custom-arenas chat history error:", error);
    res.status(500).json({ success: false, message: "Failed to load arena chat" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/matchmaking
// @desc    Opt in/out of arena matchmaking queue
// @access  Private
router.post("/custom-arenas/:id/matchmaking", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid arena id" });
    }

    const arenaLean = await CustomArena.findById(req.params.id).lean();
    if (!arenaLean) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arenaLean, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const ready = req.body?.ready === true;
    const { runtime, error } = await setArenaMatchmakingReady(
      req.params.id,
      req.user._id,
      ready
    );

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    res.json({ success: true, data: { runtime, ready } });
  } catch (error) {
    console.error("[Tournaments] custom-arenas matchmaking error:", error);
    res.status(500).json({ success: false, message: "Failed to update matchmaking" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/lobby-enter
// @desc    Reset queue state when opening tournament-play (opt-in matchmaking)
// @access  Private
router.post("/custom-arenas/:id/lobby-enter", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid arena id" });
    }

    const arenaLean = await CustomArena.findById(req.params.id).lean();
    if (!arenaLean) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arenaLean, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { runtime, error } = await enterArenaLobby(req.params.id, req.user._id);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const io = req.app.get("io");
    if (io) {
      try {
        await markArenaJoined(io, req.params.id, req.user._id);
      } catch (markErr) {
        console.warn("[Tournaments] markArenaJoined failed (non-fatal):", markErr?.message || markErr);
      }
    }

    res.json({ success: true, data: { runtime } });
  } catch (error) {
    console.error("[Tournaments] custom-arenas lobby-enter error:", error);
    res.status(500).json({ success: false, message: "Failed to enter arena lobby" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/leave
// @desc    Voluntarily leave a live arena (no further pairings)
// @access  Private
router.post("/custom-arenas/:id/leave", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid arena id" });
    }

    const arenaLean = await CustomArena.findById(req.params.id).lean();
    if (!arenaLean) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arenaLean, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { arena, runtime, error } = await leaveArenaTournament(
      req.params.id,
      req.user._id
    );

    if (error && !runtime) {
      return res.status(400).json({ success: false, message: error });
    }

    res.json({
      success: true,
      data: { runtime, arenaEnded: arena?.status === "ended" },
      message: error || undefined,
    });
  } catch (error) {
    console.error("[Tournaments] custom-arenas leave error:", error);
    res.status(500).json({ success: false, message: "Failed to leave arena" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/pairings/:pairingId/accept
// @desc    Confirm an arena pairing; starts the game when both players accept
// @access  Private
router.post("/custom-arenas/:id/pairings/:pairingId/accept", auth, async (req, res) => {
  try {
    const arenaLean = await CustomArena.findById(req.params.id).lean();
    if (!arenaLean) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arenaLean, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { game, runtime, error } = await acceptArenaPairing(
      req.params.id,
      req.params.pairingId,
      req.user._id
    );

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    res.json({
      success: true,
      data: {
        gameId: game?.gameId || null,
        runtime,
      },
    });
  } catch (error) {
    console.error("[Tournaments] custom-arenas accept pairing error:", error);
    res.status(500).json({ success: false, message: "Failed to accept pairing" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/pairings/:pairingId/result
// @desc    Record a completed arena game (used before tournament-play wiring)
// @access  Private
router.post("/custom-arenas/:id/pairings/:pairingId/result", auth, async (req, res) => {
  try {
    const { winner, gameId } = req.body;
    const arena = await CustomArena.findById(req.params.id).lean();
    if (!arena) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arena, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { arena: updated, error } = await recordArenaGameResult(req.params.id, {
      pairingId: req.params.pairingId,
      gameId,
      winner,
    });

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const io = req.app.get("io");
    if (updated?.status === "ended" && io) {
      await notifyArenaEndedIfNeeded(io, String(updated._id));
    }

    const runtime = await getArenaRuntimeState(updated._id, { autoTick: false });
    res.json({ success: true, data: { runtime } });
  } catch (error) {
    console.error("[Tournaments] custom-arenas result error:", error);
    res.status(500).json({ success: false, message: "Failed to record result" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/pairings/:pairingId/start
// @desc    Create chess game for a pending arena pairing
// @access  Private
router.post("/custom-arenas/:id/pairings/:pairingId/start", auth, async (req, res) => {
  try {
    const arenaLean = await CustomArena.findById(req.params.id).lean();
    if (!arenaLean) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arenaLean, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { arena, game, error } = await startArenaPairingGame(
      req.params.id,
      req.params.pairingId,
      req.user._id
    );

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const runtime = await getArenaRuntimeState(arena._id, { autoTick: false });
    res.json({
      success: true,
      data: {
        gameId: game.gameId,
        game,
        runtime,
      },
    });
  } catch (error) {
    console.error("[Tournaments] custom-arenas start pairing error:", error);
    res.status(500).json({ success: false, message: "Failed to start arena game" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/pairings/:pairingId/game
// @desc    Attach a real gameId to a pending pairing (tournament-play will call this)
// @access  Private
router.post("/custom-arenas/:id/pairings/:pairingId/game", auth, async (req, res) => {
  try {
    const { gameId } = req.body;
    if (!gameId) {
      return res.status(400).json({ success: false, message: "gameId is required" });
    }

    const arena = await CustomArena.findById(req.params.id).lean();
    if (!arena) {
      return res.status(404).json({ success: false, message: "Arena not found" });
    }
    if (!isArenaVisibleToUser(arena, req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const updated = await attachGameToPairing(
      req.params.id,
      req.params.pairingId,
      String(gameId)
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: "Pairing not found" });
    }

    const runtime = await getArenaRuntimeState(updated._id, { autoTick: false });
    res.json({ success: true, data: { runtime } });
  } catch (error) {
    console.error("[Tournaments] custom-arenas attach game error:", error);
    res.status(500).json({ success: false, message: "Failed to attach game" });
  }
});

// @route   POST /api/tournaments/custom-arenas/:id/invites
router.post("/custom-arenas/:id/invites", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid arena id",
      });
    }

    const arena = await CustomArena.findById(req.params.id);
    if (!arena) {
      return res.status(404).json({
        success: false,
        message: "Arena not found",
      });
    }

    if (String(arena.createdBy) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: "Only the host can invite players",
      });
    }

    const resolvedInvites = await resolveInvitedPlayers(
      req.body?.invitedPlayers,
      req.user._id
    );

    if (resolvedInvites.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Add at least one valid player to invite",
      });
    }

    const result = await addInvitesToLiveArena(req.params.id, resolvedInvites);
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: result.message || "Could not add players",
      });
    }

    const populated = await CustomArena.findById(req.params.id)
      .populate("createdBy", "username fullName name email")
      .lean();

    const io = req.app.get("io");
    if (io && result.newInvites?.length) {
      await notifyArenaInvitees(
        io,
        populated,
        result.newInvites.map((invite) => invite.userId),
        "created"
      );
    }

    const runtime = await getArenaRuntimeState(req.params.id, { autoTick: false });

    res.json({
      success: true,
      data: {
        added: result.added,
        arena: serializeCustomArena(populated, req.user),
        runtime,
      },
    });
  } catch (error) {
    console.error("[Tournaments] custom-arenas invites error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to invite players",
    });
  }
});

// @route   PATCH /api/tournaments/custom-arenas/:id
router.patch("/custom-arenas/:id", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid arena id",
      });
    }

    const arena = await CustomArena.findById(req.params.id);
    if (!arena) {
      return res.status(404).json({
        success: false,
        message: "Arena not found",
      });
    }

    if (String(arena.createdBy) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: "Only the host can edit this arena",
      });
    }

    if (arena.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft arenas can be edited",
      });
    }

    const {
      name,
      gameType,
      timeControl,
      ratingMode,
      format,
      matchCount,
      durationMinutes,
      invitedPlayers,
      startMode,
      startDate,
      startTime,
      intent,
    } = req.body;

    const trimmedName = String(name || "").trim();
    if (trimmedName.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Arena name must be at least 3 characters",
      });
    }

    if (!GAME_TYPES.includes(gameType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid game type",
      });
    }

    if (!timeControl?.label || typeof timeControl.time !== "number") {
      return res.status(400).json({
        success: false,
        message: "Time control is required",
      });
    }

    const resolvedInvites = await resolveInvitedPlayers(
      invitedPlayers,
      req.user._id
    );
    const hostWillPlay = true;
    const rosterSize = hostWillPlay
      ? resolvedInvites.length + 1
      : resolvedInvites.length;

    const isDraft = intent === "draft";
    const scheduledAt = parseScheduledAt(startMode, startDate, startTime);

    if (!isDraft && startMode === "schedule" && !scheduledAt) {
      return res.status(400).json({
        success: false,
        message: "Scheduled start requires a valid date and time",
      });
    }

    if (!isDraft && startMode === "schedule" && scheduledAt.getTime() <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: "Scheduled start must be in the future",
      });
    }

    if (!isDraft && rosterSize < MIN_ARENA_PLAYERS) {
      return res.status(400).json({
        success: false,
        message: `At least ${MIN_ARENA_PLAYERS} players required in the arena roster`,
      });
    }

    if (
      !isDraft &&
      hostWillPlay &&
      resolvedInvites.some((p) => String(p.userId) === String(req.user._id))
    ) {
      return res.status(400).json({
        success: false,
        message: "Host is already in the roster — remove duplicate self-invite",
      });
    }

    arena.name = trimmedName;
    arena.gameType = gameType;
    arena.timeControl = {
      label: timeControl.label,
      time: timeControl.time,
      increment: Number(timeControl.increment) || 0,
    };
    arena.ratingMode = ratingMode === "unrated" ? "unrated" : "rated";
    arena.format = format === "match_count" ? "match_count" : "time_duration";
    arena.matchCount = Math.min(20, Math.max(1, Number(matchCount) || 6));
    arena.durationMinutes = Math.min(
      1440,
      Math.max(30, Number(durationMinutes) || 1440)
    );
    arena.invitedUserIds = resolvedInvites.map((p) => p.userId);
    arena.invitedPlayers = resolvedInvites;
    arena.hostPlays = hostWillPlay;
    arena.startMode = startMode === "schedule" ? "schedule" : "now";

    if (!isDraft) {
      if (startMode === "now") {
        arena.status = "live";
        arena.startedAt = new Date();
        arena.scheduledAt = null;
      } else {
        arena.status = "scheduled";
        arena.scheduledAt = scheduledAt;
        arena.startedAt = null;
      }
    } else {
      arena.status = "draft";
      arena.scheduledAt = null;
      arena.startedAt = null;
    }

    await arena.save();

    if (!isDraft) {
      await initializeArenaRuntime(arena._id, req.user);
      if (arena.status === "live") {
        const { tickArenaPairings } = require("../services/customArenaEngine");
        await tickArenaPairings(arena._id);
      }
    }

    const populated = await CustomArena.findById(arena._id)
      .populate("createdBy", "username fullName name email")
      .lean();

    const io = req.app.get("io");
    if (!isDraft && io) {
      await notifyArenaParticipants(io, populated, "created");
    }

    res.json({
      success: true,
      data: {
        arena: serializeCustomArena(populated, req.user),
      },
    });
  } catch (error) {
    console.error("[Tournaments] custom-arenas update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update custom arena",
    });
  }
});

// @route   POST /api/tournaments/custom-arenas
router.post("/custom-arenas", auth, async (req, res) => {
  try {
    const {
      name,
      gameType,
      timeControl,
      ratingMode,
      format,
      matchCount,
      durationMinutes,
      invitedPlayers,
      visibility,
      startMode,
      startDate,
      startTime,
      joinCode,
      intent,
      hostPlays,
    } = req.body;

    const trimmedName = String(name || "").trim();
    if (trimmedName.length < 3) {
      return res.status(400).json({
        success: false,
        message: "Arena name must be at least 3 characters",
      });
    }

    if (!GAME_TYPES.includes(gameType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid game type",
      });
    }

    if (!timeControl?.label || typeof timeControl.time !== "number") {
      return res.status(400).json({
        success: false,
        message: "Time control is required",
      });
    }

    const resolvedInvites = await resolveInvitedPlayers(
      invitedPlayers,
      req.user._id
    );
    const hostWillPlay = true;
    const rosterSize = hostWillPlay
      ? resolvedInvites.length + 1
      : resolvedInvites.length;

    const isDraft = intent === "draft";
    const scheduledAt = parseScheduledAt(startMode, startDate, startTime);

    if (!isDraft && startMode === "schedule" && !scheduledAt) {
      return res.status(400).json({
        success: false,
        message: "Scheduled start requires a valid date and time",
      });
    }

    if (!isDraft && startMode === "schedule" && scheduledAt.getTime() <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: "Scheduled start must be in the future",
      });
    }

    if (!isDraft && rosterSize < MIN_ARENA_PLAYERS) {
      return res.status(400).json({
        success: false,
        message: `At least ${MIN_ARENA_PLAYERS} players required in the arena roster`,
      });
    }

    if (
      !isDraft &&
      hostWillPlay &&
      resolvedInvites.some((p) => String(p.userId) === String(req.user._id))
    ) {
      return res.status(400).json({
        success: false,
        message: "Host is already in the roster — remove duplicate self-invite",
      });
    }

    let status = "draft";
    let startedAt = null;

    if (!isDraft) {
      if (startMode === "now") {
        status = "live";
        startedAt = new Date();
      } else {
        status = "scheduled";
      }
    }

    const arena = await CustomArena.create({
      name: trimmedName,
      createdBy: req.user._id,
      gameType,
      timeControl: {
        label: timeControl.label,
        time: timeControl.time,
        increment: Number(timeControl.increment) || 0,
      },
      ratingMode: ratingMode === "unrated" ? "unrated" : "rated",
      format: format === "match_count" ? "match_count" : "time_duration",
      matchCount: Math.min(20, Math.max(1, Number(matchCount) || 6)),
      durationMinutes: Math.min(1440, Math.max(30, Number(durationMinutes) || 1440)),
      invitedUserIds: resolvedInvites.map((p) => p.userId),
      invitedPlayers: resolvedInvites,
      hostPlays: hostWillPlay,
      visibility: "invite_only",
      startMode: startMode === "schedule" ? "schedule" : "now",
      scheduledAt: !isDraft && startMode === "schedule" ? scheduledAt : null,
      startedAt: !isDraft && startMode === "now" ? startedAt : null,
      joinCode: joinCode || undefined,
      status,
    });

    if (!isDraft) {
      await initializeArenaRuntime(arena._id, req.user);
      if (status === "live") {
        const { tickArenaPairings } = require("../services/customArenaEngine");
        await tickArenaPairings(arena._id);
      }
    }

    const populated = await CustomArena.findById(arena._id)
      .populate("createdBy", "username fullName name email")
      .lean();

    const io = req.app.get("io");
    if (!isDraft && io) {
      await notifyArenaParticipants(io, populated, "created");
    }

    res.status(201).json({
      success: true,
      data: {
        arena: serializeCustomArena(populated, req.user),
      },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Join code already in use — try again",
      });
    }
    console.error("[Tournaments] custom-arenas create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create custom arena",
    });
  }
});

module.exports = router;
