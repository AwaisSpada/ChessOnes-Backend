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

module.exports = {
  onlineUsers,
  isUserOnline,
  onlineUserIds,
  presenceStatus,
};
