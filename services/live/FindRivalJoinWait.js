/**
 * Find Rival only: after a match is created, both players must join the
 * game room within JOIN_WAIT_MS. Does not change clocks, player-ready,
 * first-move abandon (post clockStartedAt), or disconnect-with-moves grace.
 */

const JOIN_WAIT_MS = 30_000;

/** @type {import("socket.io").Server | null} */
let ioRef = null;
/** @type {(gameId: string) => Set<string> | undefined} */
let getRoomUsers = () => undefined;

/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, whiteId: string, blackId: string }>} */
const pending = new Map();

function init({ io, getGameRoomUsers }) {
  ioRef = io;
  if (typeof getGameRoomUsers === "function") getRoomUsers = getGameRoomUsers;
}

function cancel(gameId) {
  const id = String(gameId || "");
  if (!id) return;
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
}

function bothInRoom(gameId, whiteId, blackId) {
  const users = getRoomUsers(String(gameId));
  if (!users || users.size < 2) return false;
  return users.has(String(whiteId)) && users.has(String(blackId));
}

function schedule(game) {
  if (!game?.gameId || game.type !== "multiplayer" || game.arenaId) return;
  const gameId = String(game.gameId);
  const whiteId = game.players?.white ? String(game.players.white) : "";
  const blackId = game.players?.black ? String(game.players.black) : "";
  if (!whiteId || !blackId) return;

  cancel(gameId);
  const timer = setTimeout(() => {
    pending.delete(gameId);
    void expire(gameId, whiteId, blackId);
  }, JOIN_WAIT_MS);
  pending.set(gameId, { timer, whiteId, blackId });
}

function onJoined(gameId) {
  const id = String(gameId || "");
  const entry = pending.get(id);
  if (!entry) return;
  if (bothInRoom(id, entry.whiteId, entry.blackId)) {
    cancel(id);
  }
}

async function expire(gameId, whiteId, blackId) {
  try {
    const Game = require("../../models/Game");
    const game = await Game.findOne({ gameId, status: "active" });
    if (!game || game.type !== "multiplayer" || game.arenaId) return;
    if (Array.isArray(game.moves) && game.moves.length > 0) return;
    if (game.clockStartedAt) return;
    if (bothInRoom(gameId, whiteId, blackId)) return;

    game.status = "abandoned";
    game.result = { winner: "draw", reason: "first-move-abandon" };
    await game.save();

    try {
      const LiveGameManager = require("./LiveGameManager");
      const ClockScheduler = require("./ClockScheduler");
      const live = LiveGameManager.get(gameId);
      if (live && live.status === "active") {
        live.status = "abandoned";
        live.result = game.result;
        ClockScheduler.cancel(gameId);
      }
    } catch {
      // memory snapshot optional
    }

    const io = ioRef;
    if (!io) return;
    const payload = {
      gameId,
      result: game.result,
      joinWaitExpired: true,
    };
    io.to(gameId).emit("game-ended", payload);
    io.to(`user:${whiteId}`).emit("game-ended", payload);
    io.to(`user:${blackId}`).emit("game-ended", payload);
    console.log(`[FindRival] Join wait expired — abandoned ${gameId} (unrated)`);

    try {
      const { syncStoredPresenceStatus } = require("../../utils/presence");
      await syncStoredPresenceStatus(whiteId);
      await syncStoredPresenceStatus(blackId);
    } catch (err) {
      console.error("[FindRival] presence sync after join-wait expire:", err);
    }
  } catch (err) {
    console.error("[FindRival] join-wait expire failed:", gameId, err);
  }
}

module.exports = {
  JOIN_WAIT_MS,
  init,
  schedule,
  cancel,
  onJoined,
};
