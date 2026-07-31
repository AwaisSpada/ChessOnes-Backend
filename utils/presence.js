/**
 * Live socket presence registry.
 *
 * `User.status` in Mongo can go stale (process restart, killed connections), so
 * anything user-facing should read presence from this in-memory registry which
 * only holds users with at least one live socket.
 */

/** userId (string) -> Set<socketId> */
const onlineUsers = new Map();

function isUserOnline(userId) {
  if (!userId) return false;
  const sockets = onlineUsers.get(String(userId));
  return Boolean(sockets && sockets.size > 0);
}

function onlineUserIds() {
  const ids = [];
  for (const [userId, sockets] of onlineUsers.entries()) {
    if (sockets && sockets.size > 0) ids.push(String(userId));
  }
  return ids;
}

/** @returns {"online"|"offline"} */
function presenceStatus(userId) {
  return isUserOnline(userId) ? "online" : "offline";
}

/**
 * Drop every live socket of a user (logout). Web clients keep the socket open on
 * client-side navigation, so without this they stay "online" until a refresh.
 * The socket `disconnect` handler then clears the registry and tells friends.
 *
 * @returns {number} sockets closed
 */
function disconnectUserSockets(io, userId) {
  const sockets = onlineUsers.get(String(userId));
  if (!io || !sockets || sockets.size === 0) return 0;

  let closed = 0;
  for (const socketId of [...sockets]) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    // Leave socket.data.userId intact — the disconnect handler needs it to
    // clear the registry and broadcast "offline" to friends.
    socket.disconnect(true);
    closed += 1;
  }
  return closed;
}

module.exports = {
  onlineUsers,
  isUserOnline,
  onlineUserIds,
  presenceStatus,
  disconnectUserSockets,
};
