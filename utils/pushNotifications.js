const User = require("../models/User");
const { getMessaging } = require("./firebaseAdmin");

const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

async function removeInvalidTokens(userId, badTokens) {
  if (!badTokens.length) return;
  await User.updateOne(
    { _id: userId },
    { $pull: { fcmTokens: { token: { $in: badTokens } } } }
  );
}

/**
 * Send an FCM data+notification message to all of a user's device tokens.
 * Never throws — push failures must not break game/friend flows.
 */
async function sendPushToUser(userId, { title, body, data = {} } = {}) {
  try {
    if (!userId || !title) return { sent: 0 };

    const messaging = getMessaging();
    if (!messaging) return { sent: 0, skipped: "firebase_not_configured" };

    const user = await User.findById(userId).select("fcmTokens preferences");
    if (!user) return { sent: 0, skipped: "user_missing" };

    // Honor notifications preference when explicitly disabled.
    // Support both keys: pushNotifications (settings UI) and push (legacy).
    const prefs = user.preferences?.notifications;
    if (prefs === false) return { sent: 0, skipped: "notifications_disabled" };
    if (prefs && typeof prefs === "object") {
      if (prefs.push === false || prefs.pushNotifications === false) {
        return { sent: 0, skipped: "notifications_disabled" };
      }
    }

    const tokens = (user.fcmTokens || [])
      .map((row) => (typeof row === "string" ? row : row?.token))
      .filter(Boolean);

    if (!tokens.length) return { sent: 0, skipped: "no_tokens" };

    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v == null ? "" : String(v)])
    );

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body: body || "" },
      data: stringData,
      android: {
        priority: "high",
        notification: {
          channelId: "chessones_default",
          sound: "default",
        },
      },
    });

    const bad = [];
    response.responses.forEach((res, i) => {
      if (res.success) return;
      const code = res.error?.code;
      if (code && INVALID_TOKEN_CODES.has(code)) {
        bad.push(tokens[i]);
      } else {
        console.warn("[push] send failed:", code || res.error?.message);
      }
    });

    if (bad.length) {
      await removeInvalidTokens(userId, bad);
    }

    return {
      sent: response.successCount,
      failed: response.failureCount,
    };
  } catch (err) {
    console.error("[push] sendPushToUser error:", err.message);
    return { sent: 0, error: err.message };
  }
}

async function sendChallengePush(toUserId, fromUser) {
  const name = fromUser?.fullName || fromUser?.username || "A player";
  return sendPushToUser(toUserId, {
    title: "Game challenge",
    body: `${name} challenged you to a game`,
    data: {
      type: "game_challenge",
      fromUserId: fromUser?._id?.toString?.() || fromUser?.id || "",
    },
  });
}

/** B claimed A's open challenge link — notify host to confirm (1 min window). */
async function sendOpenLinkHostConfirmPush(hostUserId, claimerUser, meta = {}) {
  const name = claimerUser?.fullName || claimerUser?.username || "A player";
  return sendPushToUser(hostUserId, {
    title: "Challenge ready",
    body: `${name} joined your challenge — accept to play`,
    data: {
      type: "game_challenge",
      needsHostConfirm: "true",
      token: meta.token || "",
      gameId: meta.gameId || "",
      fromUserId:
        claimerUser?._id?.toString?.() || claimerUser?.id || "",
    },
  });
}

async function sendFriendRequestPush(toUserId, fromUser) {
  const name = fromUser?.fullName || fromUser?.username || "Someone";
  return sendPushToUser(toUserId, {
    title: "Friend request",
    body: `${name} wants to be friends`,
    data: {
      type: "friend_request",
      fromUserId: fromUser?._id?.toString?.() || fromUser?.id || "",
    },
  });
}

module.exports = {
  sendPushToUser,
  sendChallengePush,
  sendOpenLinkHostConfirmPush,
  sendFriendRequestPush,
};
