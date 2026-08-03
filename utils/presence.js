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
 * Users who opted out of "Show online status" — still connected, but appear offline.
 * @param {string[]} userIds
 * @returns {Promise<Set<string>>}
 */
async function loadHiddenOnlineUserIds(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length) return new Set();

  // Lazy require avoids circular imports with User consumers of this module.
  const User = require("../models/User");
  const docs = await User.find({ _id: { $in: ids } })
    .select("_id preferences.privacy.showOnlineStatus")
    .lean();

  const hidden = new Set();
  for (const doc of docs) {
    const flag = doc?.preferences?.privacy?.showOnlineStatus;
    // Strict false, plus defensive coerce if a bad client ever wrote a string.
    if (flag === false || flag === "false" || flag === 0) {
      hidden.add(String(doc._id));
    }
  }
  return hidden;
}

/** Live socket + privacy.onlineStatus — what friends should see. */
async function visiblePresenceStatus(userId) {
  if (!isUserOnline(userId)) return "offline";
  const hidden = await loadHiddenOnlineUserIds([userId]);
  return hidden.has(String(userId)) ? "offline" : "online";
}

/** Persist the *visible* status to Mongo (never force "online" past privacy). */
async function syncStoredPresenceStatus(userId) {
  if (!userId) return "offline";
  const status = await visiblePresenceStatus(userId);
  const User = require("../models/User");
  await User.findByIdAndUpdate(userId, { status }).exec();
  return status;
}

/**
 * @param {string[]} userIds
 * @returns {Promise<Record<string, "online"|"offline">>}
 */
async function visiblePresenceMap(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  const hidden = await loadHiddenOnlineUserIds(ids);
  /** @type {Record<string, "online"|"offline">} */
  const map = {};
  for (const id of ids) {
    map[id] = isUserOnline(id) && !hidden.has(id) ? "online" : "offline";
  }
  return map;
}

/**
 * Rewrite friend/user docs so API consumers (web + mobile) never see a green
 * dot for someone who turned off "Show online status".
 * Live sockets stay registered — only the *visible* status is masked.
 *
 * @param {Array<object>|null|undefined} users
 * @returns {Promise<object[]>}
 */
async function attachVisiblePresence(users) {
  const list = Array.isArray(users) ? users.filter(Boolean) : [];
  if (!list.length) return [];

  const ids = list.map((u) => String(u._id || u.id || "")).filter(Boolean);
  const map = await visiblePresenceMap(ids);

  return list.map((u) => {
    const id = String(u._id || u.id || "");
    const obj =
      typeof u.toObject === "function" ? u.toObject() : { ...u };
    obj.status = map[id] || "offline";
    return obj;
  });
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
  visiblePresenceStatus,
  visiblePresenceMap,
  attachVisiblePresence,
  syncStoredPresenceStatus,
  disconnectUserSockets,
};
