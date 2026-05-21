const User = require("../models/User");

function userHasBlocked(blocker, targetId) {
  if (!blocker?.blockedUsers?.length) return false;
  const tid = targetId.toString();
  return blocker.blockedUsers.some((id) => id.toString() === tid);
}

async function usersAreBlocked(userIdA, userIdB) {
  const [a, b] = await Promise.all([
    User.findById(userIdA).select("blockedUsers").lean(),
    User.findById(userIdB).select("blockedUsers").lean(),
  ]);
  if (!a || !b) return false;
  const aStr = userIdA.toString();
  const bStr = userIdB.toString();
  const aBlockedB = (a.blockedUsers || []).some((id) => id.toString() === bStr);
  const bBlockedA = (b.blockedUsers || []).some((id) => id.toString() === aStr);
  return aBlockedB || bBlockedA;
}

async function applyBlock(blockerId, targetId) {
  const [blocker, target] = await Promise.all([
    User.findById(blockerId),
    User.findById(targetId),
  ]);
  if (!blocker || !target) {
    return { ok: false, status: 404, message: "User not found" };
  }
  if (blockerId.toString() === targetId.toString()) {
    return { ok: false, status: 400, message: "Cannot block yourself" };
  }

  const tid = targetId.toString();
  const bid = blockerId.toString();
  if (!userHasBlocked(blocker, tid)) {
    blocker.blockedUsers.push(target._id);
  }

  blocker.friends = (blocker.friends || []).filter((id) => id.toString() !== tid);
  target.friends = (target.friends || []).filter((id) => id.toString() !== bid);

  blocker.friendRequests = (blocker.friendRequests || []).filter(
    (req) => req.from?.toString() !== tid
  );
  target.friendRequests = (target.friendRequests || []).filter(
    (req) => req.from?.toString() !== bid
  );

  await blocker.save();
  await target.save();

  return { ok: true, blocker, target };
}

module.exports = {
  userHasBlocked,
  usersAreBlocked,
  applyBlock,
};
