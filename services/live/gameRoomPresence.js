/**
 * Game-room socket presence — used to gate opening moves until both players
 * are actually in the Socket.IO game room (can receive move-made).
 * Bound from server.js (owns gameRoomUsers). Fail-open when unbound / empty
 * so unit tests and HTTP-only paths are not blocked.
 */

/** @type {null | ((gameId: string) => Set<string> | undefined)} */
let getUserSet = null;

function bindGameRoomUserSetAccessor(accessor) {
  getUserSet = typeof accessor === "function" ? accessor : null;
}

function roomUserSet(gameId) {
  if (!getUserSet || !gameId) return null;
  try {
    return getUserSet(String(gameId)) || null;
  } catch {
    return null;
  }
}

/**
 * True when both seats have a socket tracked in the game room.
 * If room tracking is empty/unbound → true (do not block).
 */
function bothPlayersInGameRoom(gameId, whiteId, blackId) {
  if (!gameId || whiteId == null || blackId == null) return true;
  const set = roomUserSet(gameId);
  if (!set || set.size === 0) return true;
  return set.has(String(whiteId)) && set.has(String(blackId));
}

/**
 * Opening plies only (White ply0, Black ply1) — UI load race window.
 */
function shouldGateOpeningMove(ply) {
  return typeof ply === "number" && ply < 2;
}

module.exports = {
  bindGameRoomUserSetAccessor,
  bothPlayersInGameRoom,
  shouldGateOpeningMove,
  roomUserSet,
};
