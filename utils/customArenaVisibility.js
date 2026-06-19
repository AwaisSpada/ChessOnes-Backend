function getInvitedUserIds(arena) {
  const ids = new Set();

  if (Array.isArray(arena.invitedUserIds)) {
    for (const id of arena.invitedUserIds) {
      if (id) ids.add(String(id));
    }
  }

  if (Array.isArray(arena.invitedPlayers)) {
    for (const player of arena.invitedPlayers) {
      if (!player) continue;
      if (typeof player === "string") continue;
      if (player.userId) ids.add(String(player.userId));
    }
  }

  return ids;
}

function getInvitedUsernames(arena) {
  const names = new Set();

  if (Array.isArray(arena.invitedPlayers)) {
    for (const player of arena.invitedPlayers) {
      if (!player) continue;
      if (typeof player === "string") {
        names.add(player.toLowerCase());
        continue;
      }
      if (player.username) names.add(String(player.username).toLowerCase());
    }
  }

  return names;
}

function isUserInvited(arena, viewer) {
  if (!viewer) return false;
  const viewerId = viewer._id ? String(viewer._id) : null;
  const viewerUsername = viewer.username
    ? String(viewer.username).toLowerCase()
    : null;

  const invitedIds = getInvitedUserIds(arena);
  if (viewerId && invitedIds.has(viewerId)) return true;

  const invitedNames = getInvitedUsernames(arena);
  if (viewerUsername && invitedNames.has(viewerUsername)) return true;

  return false;
}

function isArenaVisibleToUser(arena, viewer) {
  const creatorId = String(arena.createdBy?._id || arena.createdBy || "");
  const viewerId = viewer?._id ? String(viewer._id) : null;

  if (arena.status === "draft") {
    return viewerId !== null && viewerId === creatorId;
  }

  if (viewerId && viewerId === creatorId) return true;

  if (arena.visibility === "public") return true;

  if (isUserInvited(arena, viewer)) return true;

  return false;
}

function viewerIsInvited(arena, viewer) {
  return isUserInvited(arena, viewer);
}

module.exports = {
  getInvitedUserIds,
  isArenaVisibleToUser,
  viewerIsInvited,
};
