/**
 * Find Rival + Friends (post-accept): both players must join the game room
 * within JOIN_WAIT_MS. Does not change clocks, player-ready after both join,
 * first-move abandon (post clockStartedAt), invite expiry, or disconnect grace.
 */

const JOIN_WAIT_MS = 30_000;

/** @type {import("socket.io").Server | null} */
let ioRef = null;
/** @type {(gameId: string) => Set<string> | undefined} */
let getRoomUsers = () => undefined;

/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, whiteId: string, blackId: string }>} */
const pending = new Map();
/** @type {Map<string, string[]>} */
const waiterIdsByGame = new Map();

function seatId(player) {
  if (!player) return "";
  if (typeof player === "object") {
    return String(player._id || player.id || "");
  }
  return String(player);
}

function isBoardOpenWaitGame(game) {
  if (!game || game.arenaId) return false;
  return game.type === "multiplayer" || game.type === "friend";
}

function waitStartMs(game) {
  if (game?.boardOpenWaitStartedAt) {
    const stamped = new Date(game.boardOpenWaitStartedAt).getTime();
    if (Number.isFinite(stamped)) return stamped;
  }
  if (game?.type === "multiplayer" && game.createdAt) {
    const created = new Date(game.createdAt).getTime();
    if (Number.isFinite(created)) return created;
  }
  return NaN;
}

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

function seatedWaitersFromRoom(game) {
  const gameId = String(game?.gameId || "");
  const whiteId = seatId(game?.players?.white);
  const blackId = seatId(game?.players?.black);
  const users = getRoomUsers(gameId) || new Set();
  return [whiteId, blackId].filter((id) => id && users.has(String(id))).map(String);
}

function getWaiterUserIds(gameId) {
  return waiterIdsByGame.get(String(gameId || "")) || [];
}

function setWaiterUserIds(gameId, ids) {
  const unique = [...new Set((ids || []).map(String).filter(Boolean))];
  waiterIdsByGame.set(String(gameId), unique);
}

async function persistWaiterUserIds(gameId, ids) {
  try {
    const Game = require("../../models/Game");
    await Game.updateOne(
      { gameId: String(gameId) },
      { $set: { boardOpenWaitWaiterUserIds: ids } }
    );
  } catch (err) {
    console.error("[FindRival] persist waiter ids failed:", gameId, err);
  }
}

function emitOccupants(gameId) {
  const io = ioRef;
  if (!io) return;
  const id = String(gameId || "");
  const users = getRoomUsers(id);
  io.to(id).emit("game-room-occupants", {
    gameId: id,
    userIds: users ? Array.from(users) : [],
    waiterUserIds: getWaiterUserIds(id),
  });
}

function bothInRoom(gameId, whiteId, blackId) {
  const users = getRoomUsers(String(gameId));
  if (!users || users.size < 2) return false;
  return users.has(String(whiteId)) && users.has(String(blackId));
}

function inactiveSeatIds(gameId, whiteId, blackId) {
  const users = getRoomUsers(String(gameId)) || new Set();
  return [whiteId, blackId].filter((id) => id && !users.has(String(id)));
}

function broadcastEnded(gameId, whiteId, blackId, result) {
  const io = ioRef;
  if (!io) return;
  const payload = {
    gameId,
    result: result || { winner: "draw", reason: "first-move-abandon" },
    joinWaitExpired: true,
    inactiveUserIds: result?.inactiveUserIds || inactiveSeatIds(gameId, whiteId, blackId),
  };
  io.to(gameId).emit("game-ended", payload);
  if (whiteId) io.to(`user:${whiteId}`).emit("game-ended", payload);
  if (blackId) io.to(`user:${blackId}`).emit("game-ended", payload);
}

function schedule(game) {
  if (!isBoardOpenWaitGame(game) || !game?.gameId) return;
  const gameId = String(game.gameId);
  const whiteId = seatId(game.players?.white);
  const blackId = seatId(game.players?.black);
  if (!whiteId || !blackId) return;

  cancel(gameId);
  const startMs = waitStartMs(game);
  const remaining = Number.isFinite(startMs)
    ? startMs + JOIN_WAIT_MS - Date.now()
    : JOIN_WAIT_MS;
  if (remaining <= 0) {
    void expire(gameId, whiteId, blackId);
    return;
  }
  const timer = setTimeout(() => {
    pending.delete(gameId);
    void expire(gameId, whiteId, blackId);
  }, remaining);
  const fromDoc = Array.isArray(game.boardOpenWaitWaiterUserIds)
    ? game.boardOpenWaitWaiterUserIds.map(String).filter(Boolean)
    : [];
  if (fromDoc.length && getWaiterUserIds(gameId).length === 0) {
    setWaiterUserIds(gameId, fromDoc);
  } else if (getWaiterUserIds(gameId).length === 0) {
    const fromRoom = seatedWaitersFromRoom(game);
    if (fromRoom.length) setWaiterUserIds(gameId, fromRoom);
  }
  pending.set(gameId, { timer, whiteId, blackId });
}

async function stampAndSchedule(game) {
  if (!isBoardOpenWaitGame(game)) return;
  const waiters = seatedWaitersFromRoom(game);
  if (waiters.length) setWaiterUserIds(game.gameId, waiters);
  let dirty = false;
  if (!game.boardOpenWaitStartedAt) {
    game.boardOpenWaitStartedAt = new Date();
    dirty = true;
  }
  if (
    waiters.length &&
    (!Array.isArray(game.boardOpenWaitWaiterUserIds) ||
      game.boardOpenWaitWaiterUserIds.length === 0)
  ) {
    game.boardOpenWaitWaiterUserIds = waiters;
    dirty = true;
  }
  if (dirty && typeof game.save === "function") {
    try {
      await game.save();
    } catch (err) {
      console.error("[FindRival] stamp boardOpenWaitStartedAt failed:", err);
    }
  }
  schedule(game);
  emitOccupants(game.gameId);
}

function onJoined(gameId, userId) {
  const id = String(gameId || "");
  const uid = userId ? String(userId) : "";
  const entry = pending.get(id);
  if (uid && getWaiterUserIds(id).length === 0) {
    if (!entry || uid === entry.whiteId || uid === entry.blackId) {
      setWaiterUserIds(id, [uid]);
      void persistWaiterUserIds(id, [uid]);
    }
  }
  if (!entry) return;
  if (bothInRoom(id, entry.whiteId, entry.blackId)) {
    cancel(id);
  }
}

/** If someone leaves the board before clocks start, resume the original 30s wait. */
async function onLeft(gameId) {
  const id = String(gameId || "");
  if (!id) return;
  try {
    const Game = require("../../models/Game");
    const game = await Game.findOne({ gameId: id });
    if (!isBoardOpenWaitGame(game) || game.status !== "active") return;
    if (game.clockStartedAt) return;
    if (Array.isArray(game.moves) && game.moves.length > 0) return;
    if (game.type === "friend" && !game.boardOpenWaitStartedAt) return;
    const whiteId = seatId(game.players?.white);
    const blackId = seatId(game.players?.black);
    if (bothInRoom(id, whiteId, blackId)) return;
    schedule(game);
  } catch (err) {
    console.error("[FindRival] onLeft failed:", gameId, err);
  }
}

async function expire(gameId, whiteId, blackId) {
  try {
    const Game = require("../../models/Game");
    const game = await Game.findOne({ gameId });
    if (!isBoardOpenWaitGame(game)) return;

    const wId = whiteId || seatId(game.players?.white);
    const bId = blackId || seatId(game.players?.black);

    if (game.status === "abandoned" || game.status === "completed") {
      if (
        game.result?.reason === "first-move-abandon" ||
        !Array.isArray(game.moves) ||
        game.moves.length === 0
      ) {
        broadcastEnded(gameId, wId, bId, game.result);
      }
      return;
    }
    if (game.status !== "active") return;
    if (Array.isArray(game.moves) && game.moves.length > 0) return;
    if (game.clockStartedAt) return;

    const inactiveUserIds = inactiveSeatIds(gameId, wId, bId);
    game.status = "abandoned";
    game.result = {
      winner: "draw",
      reason: "first-move-abandon",
      joinWaitExpired: true,
      inactiveUserIds,
    };
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

    broadcastEnded(gameId, wId, bId, game.result);
    console.log(`[FindRival] Board-open wait expired — abandoned ${gameId} (unrated)`);

    try {
      const { syncStoredPresenceStatus } = require("../../utils/presence");
      await syncStoredPresenceStatus(wId);
      await syncStoredPresenceStatus(bId);
    } catch (err) {
      console.error("[FindRival] presence sync after join-wait expire:", err);
    }
  } catch (err) {
    console.error("[FindRival] join-wait expire failed:", gameId, err);
  }
}

async function claim(gameId, userId) {
  const id = String(gameId || "");
  const uid = String(userId || "");
  if (!id || !uid) return;
  try {
    const Game = require("../../models/Game");
    const game = await Game.findOne({ gameId: id });
    if (!isBoardOpenWaitGame(game)) return;
    const whiteId = seatId(game.players?.white);
    const blackId = seatId(game.players?.black);
    if (uid !== whiteId && uid !== blackId) return;
    const startMs = waitStartMs(game);
    const due = Number.isFinite(startMs) ? startMs + JOIN_WAIT_MS : 0;
    if (game.status === "active" && Date.now() + 750 < due) return;
    await expire(id, whiteId, blackId);
  } catch (err) {
    console.error("[FindRival] join-wait claim failed:", gameId, err);
  }
}

module.exports = {
  JOIN_WAIT_MS,
  init,
  schedule,
  stampAndSchedule,
  cancel,
  onJoined,
  onLeft,
  getWaiterUserIds,
  claim,
};
