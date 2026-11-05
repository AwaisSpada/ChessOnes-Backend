/**
 * Phase 0 ReconnectManager — extract of disconnect/reconnect helpers from server.js.
 * Behavior must match the previous inline implementations exactly
 * (grace 45s / arena 60s, heartbeat 2500ms stale / 500ms poll, forfeit only with moves).
 */

const Game = require("../../models/Game");
const Stats = require("../../models/Stats");
const { isUserOnline } = require("../../utils/presence");

/** Brief disconnect (refresh / tab switch) must not instantly forfeit active games. */
const DISCONNECT_GAME_END_GRACE_MS = 15_000;
const DISCONNECT_ARENA_GAME_END_GRACE_MS = 15_000;

/** Live-game heartbeats (opt-in): clients that emit game:heartbeat get ~2s drop detection. */
const GAME_HEARTBEAT_STALE_MS = 2500;

/** @type {import("socket.io").Server | null} */
let ioRef = null;

/** `${userId}:${gameId}` -> { handle, deadlineMs } */
const pendingDisconnectGameEnds = new Map();

/** `${gameId}:${userId}` -> { lastMs, staleNotified } */
const gameHeartbeats = new Map();

let heartbeatIntervalStarted = false;

function getIo() {
  if (!ioRef) {
    throw new Error("ReconnectManager.init(io) must be called before use");
  }
  return ioRef;
}

/**
 * Bind Socket.IO server and start the heartbeat stale scanner (once).
 * @param {import("socket.io").Server} io
 */
function init(io) {
  ioRef = io;
  if (heartbeatIntervalStarted) return;
  heartbeatIntervalStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of gameHeartbeats.entries()) {
      if (!entry || entry.staleNotified) continue;
      if (now - entry.lastMs < GAME_HEARTBEAT_STALE_MS) continue;
      const sep = key.lastIndexOf(":");
      if (sep <= 0) continue;
      const gameId = key.slice(0, sep);
      const userId = key.slice(sep + 1);
      entry.staleNotified = true;
      gameHeartbeats.set(key, entry);
      emitPlayerDisconnected(getIo(), gameId, userId);
      console.log(
        `📡 Game heartbeat stale → player-disconnected game=${gameId} user=${userId}`
      );
    }
  }, 500);
}

function pendingKey(userId, gameId) {
  return `${String(userId)}:${String(gameId)}`;
}

function clearPendingEntry(key) {
  const entry = pendingDisconnectGameEnds.get(key);
  if (!entry) return false;
  clearTimeout(entry.handle);
  pendingDisconnectGameEnds.delete(key);
  return true;
}

/** @returns {boolean} true if a pending auto-forfeit was cancelled (player is reconnecting). */
function cancelPendingDisconnectGameEnd(userId, gameId) {
  if (!userId || !gameId) return false;
  return clearPendingEntry(pendingKey(userId, gameId));
}

function getPendingDisconnectDeadline(userId, gameId) {
  if (!userId || !gameId) return null;
  const entry = pendingDisconnectGameEnds.get(pendingKey(userId, gameId));
  return entry?.deadlineMs ?? null;
}

/** @returns {string[]} gameIds that had a pending disconnect end cancelled. */
function cancelPendingDisconnectEndsForUser(userId) {
  if (!userId) return [];
  const prefix = `${String(userId)}:`;
  const resumedGameIds = [];
  for (const [key, entry] of pendingDisconnectGameEnds.entries()) {
    if (key.startsWith(prefix)) {
      if (entry?.handle) clearTimeout(entry.handle);
      pendingDisconnectGameEnds.delete(key);
      resumedGameIds.push(key.slice(prefix.length));
    }
  }
  return resumedGameIds;
}

/** Notify opponents that a player is back in the game room (mobile + web presence UI). */
function emitPlayerReconnected(io, gameId, userId) {
  if (!gameId || !userId) return;
  const liveSideEffects = require("./liveSideEffects");
  const { ORIGIN } = require("./events/DomainEvent");
  void liveSideEffects.afterPlayerConnection({
    gameId: String(gameId),
    userId: String(userId),
    connected: true,
    origin: ORIGIN.Reconnect,
  });
  // Fallback if transport not booted yet (tests / early call)
  const { tryGetGameTransport } = require("./transport");
  if (!tryGetGameTransport() && io) {
    const payload = { gameId: String(gameId), userId: String(userId), connected: true };
    io.to(String(gameId)).emit("player-reconnected", payload);
    io.to(String(gameId)).emit("connection-status", {
      ...payload,
      status: "online",
    });
  }
}

function emitPlayerDisconnected(io, gameId, userId, extra = {}) {
  if (!gameId || !userId) return;
  const reconnectUntil =
    typeof extra.reconnectUntil === "number" && Number.isFinite(extra.reconnectUntil)
      ? extra.reconnectUntil
      : undefined;
  const graceMs =
    typeof extra.graceMs === "number" && Number.isFinite(extra.graceMs)
      ? extra.graceMs
      : undefined;
  const liveSideEffects = require("./liveSideEffects");
  const { ORIGIN } = require("./events/DomainEvent");
  void liveSideEffects.afterPlayerConnection({
    gameId: String(gameId),
    userId: String(userId),
    connected: false,
    origin: ORIGIN.Reconnect,
    reconnectUntil,
    graceMs,
  });
  const { tryGetGameTransport } = require("./transport");
  if (!tryGetGameTransport() && io) {
    const payload = {
      gameId: String(gameId),
      userId: String(userId),
      connected: false,
      ...(reconnectUntil != null ? { reconnectUntil } : {}),
      ...(graceMs != null ? { graceMs } : {}),
    };
    io.to(String(gameId)).emit("player-disconnected", payload);
    io.to(String(gameId)).emit("connection-status", {
      ...payload,
      status: "reconnecting",
    });
  }
}

function heartbeatKey(gameId, userId) {
  return `${String(gameId)}:${String(userId)}`;
}

function clearGameHeartbeat(gameId, userId) {
  if (!gameId || !userId) return;
  gameHeartbeats.delete(heartbeatKey(gameId, userId));
}

function touchGameHeartbeat(gameId, userId) {
  if (!gameId || !userId) return;
  const key = heartbeatKey(gameId, userId);
  const prev = gameHeartbeats.get(key);
  gameHeartbeats.set(key, { lastMs: Date.now(), staleNotified: false });
  // First beat after a stale window → reconnect signal
  if (prev?.staleNotified) {
    emitPlayerReconnected(getIo(), gameId, userId);
  }
}

function isUserFullyOffline(userId) {
  return !isUserOnline(userId);
}

function snapshotClocksAtDisconnectEnd(game) {
  try {
    const ClockAuthority = require("./ClockAuthority");
    let live = null;
    try {
      live = require("./LiveGameManager").get(String(game.gameId));
    } catch {
      live = null;
    }
    const source = live && live.status === "active" ? live : game;
    const clockResult = ClockAuthority.drainSideToMove(source, Date.now());
    ClockAuthority.commitElapsedClock(source, clockResult);
    if (source !== game && source.timeRemaining) {
      game.timeRemaining = {
        white: source.timeRemaining.white,
        black: source.timeRemaining.black,
      };
    }
    try {
      require("./ClockScheduler").cancel(game.gameId);
    } catch {
      /* scheduler optional */
    }
    if (live && live.status === "active") {
      live.status = "completed";
      if (live.timeRemaining && game.timeRemaining) {
        live.timeRemaining = {
          white: game.timeRemaining.white,
          black: game.timeRemaining.black,
        };
      }
    }
  } catch (err) {
    console.warn("[Disconnect] clock snapshot skipped:", err?.message || err);
  }
}

async function completeGameOnUserDisconnect(game, userId, io) {
  const socketIo = io || getIo();
  snapshotClocksAtDisconnectEnd(game);
  let winnerColor = null;
  if (
    game.players.white &&
    game.players.white._id.toString() === userId.toString()
  ) {
    if (game.players.black) winnerColor = "black";
  } else if (
    game.players.black &&
    game.players.black._id.toString() === userId.toString()
  ) {
    if (game.players.white) winnerColor = "white";
  }

  if (!winnerColor) {
    game.status = "completed";
    game.result = {
      winner: null,
      reason: "disconnect",
    };
  } else {
    game.status = "completed";
    game.result = {
      winner: winnerColor,
      reason: "disconnect",
    };
  }

  await game.save();

  // Elo first, then notify — dialog shows ±delta immediately.
  let ratingChanges = null;
  try {
    if (game.result?.reason !== "first-move-abandon") {
      const gameForRating = await Game.findOne({ gameId: game.gameId }).populate(
        "players.white players.black"
      );
      if (gameForRating) {
        if (!gameForRating.category && gameForRating.timeControl) {
          const { setGameCategory } = require("../ratingEngine");
          setGameCategory(gameForRating);
          await gameForRating.save();
        }
        const { updateGameRatings } = require("../updateGameRatings");
        ratingChanges = (await updateGameRatings(gameForRating, socketIo)) || null;
      }
    }
  } catch (err) {
    console.error("[Disconnect] rating update failed:", game.gameId, err);
  }

  socketIo.to(game.gameId).emit("game-ended", {
    gameId: game.gameId,
    result: game.result,
    ...(ratingChanges ? { ratingChanges } : {}),
    ...(game.timeRemaining
      ? {
          timeRemaining: {
            white: game.timeRemaining.white,
            black: game.timeRemaining.black,
          },
        }
      : {}),
  });

  setImmediate(() => {
    void (async () => {
      try {
        const { triggerReviewGeneration } = require("../../utils/game-review/game-completion-hook");
        triggerReviewGeneration(game.gameId);
      } catch (error) {
        console.error(`[GameReview] Error triggering review generation hook:`, error);
      }

      try {
        const gameTime = Date.now() - game.createdAt.getTime();

        if (game.players.white) {
          const whiteStats = await Stats.findOne({
            user: game.players.white._id,
          });
          if (whiteStats) {
            const whiteResult =
              game.result.winner === "white"
                ? "win"
                : game.result.winner === "black"
                  ? "loss"
                  : "draw";
            await whiteStats.updateAfterGame(game.type, whiteResult, gameTime);
          }
        }

        if (game.players.black && game.type !== "bot") {
          const blackStats = await Stats.findOne({
            user: game.players.black._id,
          });
          if (blackStats) {
            const blackResult =
              game.result.winner === "black"
                ? "win"
                : game.result.winner === "white"
                  ? "loss"
                  : "draw";
            await blackStats.updateAfterGame(game.type, blackResult, gameTime);
          }
        }

        if (game.players.white) {
          const { syncStoredPresenceStatus } = require("../../utils/presence");
          await syncStoredPresenceStatus(game.players.white._id);
        }
        if (game.players.black && game.type !== "bot") {
          const { syncStoredPresenceStatus } = require("../../utils/presence");
          await syncStoredPresenceStatus(game.players.black._id);
        }

        try {
          const { syncArenaGameCompletion } = require("../../utils/arenaGameCompletionHook");
          await syncArenaGameCompletion(game.gameId, game.result, socketIo);
        } catch (err) {
          console.error("[Arena] disconnect completion sync failed:", game.gameId, err);
        }
      } catch (err) {
        console.error("[Disconnect] post game-ended side effects failed:", game.gameId, err);
      }
    })();
  });
}

function colorOfPlayer(game, userId) {
  const uid = String(userId);
  const idOf = (side) => {
    const p = game?.players?.[side];
    if (!p) return null;
    if (typeof p === "string") return p;
    if (p._id) return String(p._id);
    if (p.id) return String(p.id);
    return String(p);
  };
  if (idOf("white") === uid) return "white";
  if (idOf("black") === uid) return "black";
  return null;
}

/**
 * Default 15s. If the disconnected player is to-move, never wait longer
 * than their remaining flag time (game would end anyway).
 * Does not pause or mutate clocks.
 */
function resolveDisconnectGraceMs(game, disconnectedUserId) {
  const base = game?.arenaId
    ? DISCONNECT_ARENA_GAME_END_GRACE_MS
    : DISCONNECT_GAME_END_GRACE_MS;
  try {
    const ClockAuthority = require("./ClockAuthority");
    const discColor = colorOfPlayer(game, disconnectedUserId);
    if (!discColor) return base;
    const toMove = ClockAuthority.activeSide(game);
    if (discColor !== toMove) return base;
    const now = Date.now();
    const deadline = ClockAuthority.flagDeadlineMs(game, now);
    if (deadline == null) return base;
    const remaining = Math.max(0, deadline - now);
    return Math.min(base, remaining);
  } catch (err) {
    console.warn("[Disconnect] grace clock cap skipped:", err?.message || err);
    return base;
  }
}

function scheduleDisconnectGameEnd(userId, gameId, graceMs) {
  const key = pendingKey(userId, gameId);
  const now = Date.now();
  const requestedDeadline = now + Math.max(0, Number(graceMs) || 0);
  const existing = pendingDisconnectGameEnds.get(key);
  // Duplicate schedule (room leave + full offline) must not restart the 15s.
  if (existing && existing.deadlineMs <= requestedDeadline) {
    return existing.deadlineMs;
  }
  if (existing?.handle) clearTimeout(existing.handle);
  const deadlineMs = requestedDeadline;
  const delay = Math.max(0, deadlineMs - Date.now());
  const handle = setTimeout(async () => {
    pendingDisconnectGameEnds.delete(key);
    try {
      const game = await Game.findOne({
        gameId: String(gameId),
        status: "active",
      }).populate("players.white players.black");
      if (!game) return;
      if (game.type === "bot") return;
      const gameHasMoves =
        Array.isArray(game.moves) && game.moves.length > 0;
      if (!gameHasMoves) return;
      console.log(
        `⏱️ Ending game ${gameId} after disconnect grace (${delay}ms) for user ${userId}`
      );
      await completeGameOnUserDisconnect(game, userId, getIo());
    } catch (err) {
      console.error("disconnect grace game end failed:", gameId, err);
    }
  }, delay);
  pendingDisconnectGameEnds.set(key, { handle, deadlineMs });
  return deadlineMs;
}

/**
 * Start (or keep) reconnect grace for an active human game and tell the
 * opponent. Heartbeat-only disconnects should still call emitPlayerDisconnected
 * without this helper so we do not start a forfeit from a stale beat.
 */
async function beginDisconnectGrace(gameId, userId) {
  const io = getIo();
  if (!gameId || !userId) return;
  try {
    let game = null;
    try {
      const LiveGameManager = require("./LiveGameManager");
      game = LiveGameManager.get(String(gameId));
    } catch {
      game = null;
    }
    if (!game || game.status !== "active") {
      game = await Game.findOne({
        gameId: String(gameId),
        status: "active",
      }).populate("players.white players.black");
    }
    if (!game || game.status !== "active" || game.type === "bot") {
      emitPlayerDisconnected(io, gameId, userId);
      return;
    }
    const gameHasMoves = Array.isArray(game.moves) && game.moves.length > 0;
    if (!gameHasMoves) {
      emitPlayerDisconnected(io, gameId, userId);
      return;
    }
    const graceMs = resolveDisconnectGraceMs(game, userId);
    const deadlineMs = scheduleDisconnectGameEnd(userId, gameId, graceMs);
    emitPlayerDisconnected(io, gameId, userId, {
      reconnectUntil: deadlineMs,
      graceMs: Math.max(0, deadlineMs - Date.now()),
    });
  } catch (err) {
    console.error("beginDisconnectGrace failed:", gameId, err);
    emitPlayerDisconnected(io, gameId, userId);
  }
}

module.exports = {
  init,
  DISCONNECT_GAME_END_GRACE_MS,
  DISCONNECT_ARENA_GAME_END_GRACE_MS,
  GAME_HEARTBEAT_STALE_MS,
  cancelPendingDisconnectGameEnd,
  cancelPendingDisconnectEndsForUser,
  getPendingDisconnectDeadline,
  emitPlayerReconnected,
  emitPlayerDisconnected,
  clearGameHeartbeat,
  touchGameHeartbeat,
  scheduleDisconnectGameEnd,
  beginDisconnectGrace,
  resolveDisconnectGraceMs,
  completeGameOnUserDisconnect,
  isUserFullyOffline,
};
