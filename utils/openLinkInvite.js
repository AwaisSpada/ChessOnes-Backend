const Game = require("../models/Game");
const GameInvitation = require("../models/GameInvitation");

function formatOpenLinkSocketPayload(invitation, extra = {}) {
  return {
    id: invitation._id,
    token: invitation.token,
    status: invitation.status,
    gameType: invitation.gameType,
    matchType: invitation.matchType || "rated",
    gameFormat: "open_link",
    isOpenLink: true,
    needsHostConfirm: invitation.status === "claimed",
    preferredColor: invitation.preferredColor || "random",
    inviterSide:
      invitation.preferredColor === "black" ? "black" : "white",
    inviteeSide:
      invitation.preferredColor === "black" ? "white" : "black",
    timeControl: invitation.timeControl,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    gameId: invitation.gameId || null,
    from: invitation.fromUser
      ? {
          id: invitation.fromUser._id,
          username: invitation.fromUser.username,
          fullName: invitation.fromUser.fullName,
          rating: invitation.fromUser.rating,
          ratings: invitation.fromUser.ratings,
          avatar: invitation.fromUser.avatar,
          country: invitation.fromUser.country || "",
        }
      : null,
    to: invitation.toUser
      ? {
          id: invitation.toUser._id,
          username: invitation.toUser.username,
          fullName: invitation.toUser.fullName,
          rating: invitation.toUser.rating,
          ratings: invitation.toUser.ratings,
          avatar: invitation.toUser.avatar,
          country: invitation.toUser.country || "",
        }
      : null,
    ...extra,
  };
}

/**
 * B claims an open challenge link.
 * Creates the game but does NOT fully accept — host (A) must confirm.
 * Emits `open-link:needs-confirm` to A (on-screen tick/cross).
 * Does NOT emit challenge:update accepted / opponent-joined (no A auto-nav).
 *
 * @returns {Promise<{ invitation: object, game: object, awaitingHostConfirm: boolean }>}
 */
async function claimOpenLinkInvitation(invitation, acceptor, io) {
  if (!invitation?.isOpenLink) {
    throw Object.assign(new Error("Not an open challenge link"), {
      status: 400,
      code: "NOT_OPEN_LINK",
    });
  }

  const fromUserId = invitation.fromUser?._id || invitation.fromUser;
  const acceptorId = acceptor._id || acceptor.id;
  const toUserId = invitation.toUser?._id || invitation.toUser || null;

  if (String(fromUserId) === String(acceptorId)) {
    throw Object.assign(new Error("You cannot accept your own challenge link"), {
      status: 400,
      code: "OWN_LINK",
    });
  }

  if (toUserId && String(toUserId) !== String(acceptorId)) {
    throw Object.assign(
      new Error("This challenge link was already claimed by someone else"),
      { status: 403, code: "ALREADY_CLAIMED" }
    );
  }

  if (invitation.status === "accepted" && invitation.gameId) {
    const existing = await Game.findOne({ gameId: invitation.gameId });
    if (existing) {
      return { invitation, game: existing, awaitingHostConfirm: false };
    }
  }

  if (invitation.status === "claimed" && invitation.gameId) {
    if (toUserId && String(toUserId) === String(acceptorId)) {
      const existing = await Game.findOne({ gameId: invitation.gameId });
      if (existing) {
        return { invitation, game: existing, awaitingHostConfirm: true };
      }
    }
  }

  if (!["pending", "claimed"].includes(invitation.status)) {
    throw Object.assign(new Error(`Invitation already ${invitation.status}`), {
      status: 400,
      code: "NOT_PENDING",
    });
  }

  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    invitation.status = "expired";
    await invitation.save();
    throw Object.assign(new Error("Invitation has expired"), {
      status: 410,
      code: "EXPIRED",
    });
  }

  if (invitation.status === "pending" && invitation.gameId) {
    const currentGame = await Game.findOne({ gameId: invitation.gameId }).select(
      "status"
    );
    if (
      currentGame &&
      ["completed", "abandoned", "draw"].includes(
        String(currentGame.status || "").toLowerCase()
      )
    ) {
      throw Object.assign(new Error("Invitation is no longer actionable"), {
        status: 409,
        code: "INVITATION_COMPLETED",
      });
    }
  }

  // Already claimed with game — return as-is.
  if (invitation.status === "claimed" && invitation.gameId) {
    const existing = await Game.findOne({ gameId: invitation.gameId });
    if (existing) {
      return { invitation, game: existing, awaitingHostConfirm: true };
    }
  }

  const { setGameCategory } = require("../services/ratingEngine");
  const isRated = (invitation.matchType || "rated") === "rated";
  const inviterColor =
    invitation.preferredColor === "black" ? "black" : "white";
  const gameId = Math.random().toString(36).substr(2, 9);
  const players =
    inviterColor === "white"
      ? { white: fromUserId, black: acceptorId }
      : { white: acceptorId, black: fromUserId };

  const game = new Game({
    gameId,
    type: "friend",
    isRated,
    players,
    timeControl: invitation.timeControl,
    timeRemaining: {
      white: invitation.timeControl.initial,
      black: invitation.timeControl.initial,
    },
    status: "active",
  });
  setGameCategory(game);
  await game.save();

  invitation.toUser = acceptorId;
  invitation.toEmail = acceptor.email || null;
  invitation.gameId = gameId;
  // Claimed = waiting for host (A) tick/cross — NOT fully accepted yet.
  invitation.status = "claimed";
  await invitation.save();
  await invitation.populate([
    {
      path: "fromUser",
      select: "username fullName avatar rating ratings country",
    },
    {
      path: "toUser",
      select: "username fullName avatar rating ratings country",
    },
  ]);

  if (io) {
    const fromId = String(invitation.fromUser._id);
    const claimer = invitation.toUser;
    // On-screen permission for A — show claimer (B) as the person joining.
    const confirmPayload = formatOpenLinkSocketPayload(invitation, {
      needsHostConfirm: true,
      // Reuse IncomingChallengeModal `from` field for who is challenging A.
      from: {
        id: claimer._id,
        username: claimer.username,
        fullName: claimer.fullName,
        rating: claimer.rating,
        ratings: claimer.ratings,
        avatar: claimer.avatar,
        country: claimer.country || "",
      },
      hostId: fromId,
      claimerId: String(claimer._id),
    });
    io.to(`user:${fromId}`).emit("open-link:needs-confirm", confirmPayload);
    // Soft notify lists without auto-navigating (status is claimed, not accepted).
    io.to(`user:${fromId}`).emit("challenge:update", confirmPayload);
    io.to(`user:${String(claimer._id)}`).emit(
      "challenge:update",
      formatOpenLinkSocketPayload(invitation)
    );
  }

  return { invitation, game, awaitingHostConfirm: true };
}

/**
 * Host (A) confirms or declines a claimed open-link challenge.
 * @param {"accept"|"decline"} action
 */
async function confirmOpenLinkByHost(invitation, host, action, io) {
  if (!invitation?.isOpenLink) {
    throw Object.assign(new Error("Not an open challenge link"), {
      status: 400,
      code: "NOT_OPEN_LINK",
    });
  }

  const hostId = String(host._id || host.id);
  const fromUserId = String(invitation.fromUser?._id || invitation.fromUser);

  if (fromUserId !== hostId) {
    throw Object.assign(
      new Error("Only the challenge creator can confirm this link"),
      { status: 403, code: "NOT_HOST" }
    );
  }

  if (invitation.status !== "claimed") {
    if (invitation.status === "accepted" && action === "accept" && invitation.gameId) {
      const existing = await Game.findOne({ gameId: invitation.gameId });
      if (existing) {
        return { invitation, game: existing, action: "accept" };
      }
    }
    throw Object.assign(
      new Error(`Invitation is ${invitation.status}, not awaiting confirm`),
      { status: 400, code: "NOT_CLAIMED" }
    );
  }

  await invitation.populate([
    {
      path: "fromUser",
      select: "username fullName avatar rating ratings country",
    },
    {
      path: "toUser",
      select: "username fullName avatar rating ratings country",
    },
  ]);

  const claimerId = invitation.toUser
    ? String(invitation.toUser._id || invitation.toUser)
    : null;

  if (action === "decline") {
    invitation.status = "declined";
    await invitation.save();

    if (invitation.gameId) {
      await Game.updateOne(
        { gameId: invitation.gameId, status: "active" },
        {
          $set: {
            status: "abandoned",
            result: { winner: "draw", reason: "first-move-abandon" },
          },
        }
      );
    }

    const payload = formatOpenLinkSocketPayload(invitation);
    if (io) {
      io.to(`user:${fromUserId}`).emit("challenge:update", payload);
      if (claimerId) {
        io.to(`user:${claimerId}`).emit("challenge:update", payload);
        io.to(`user:${claimerId}`).emit("invite-declined", {
          gameId: invitation.gameId,
          token: invitation.token,
          message: "Challenge declined by the creator",
        });
      }
    }

    return { invitation, game: null, action: "decline" };
  }

  // accept
  invitation.status = "accepted";
  await invitation.save();

  const game = invitation.gameId
    ? await Game.findOne({ gameId: invitation.gameId })
    : null;
  if (!game) {
    throw Object.assign(new Error("Game not found for this challenge"), {
      status: 404,
      code: "GAME_NOT_FOUND",
    });
  }

  const payload = formatOpenLinkSocketPayload(invitation);
  if (io) {
    io.to(`user:${fromUserId}`).emit("challenge:update", payload);
    if (claimerId) {
      io.to(`user:${claimerId}`).emit("challenge:update", payload);
    }
    // A can navigate into the game.
    io.to(`user:${fromUserId}`).emit("invite-accepted", {
      gameId: game.gameId,
      invitation: payload,
    });
    // B unlocks waiting gate.
    if (claimerId) {
      io.to(`user:${claimerId}`).emit("opponent-joined", {
        gameId: game.gameId,
        opponent: payload.from,
      });
    }
  }

  return { invitation, game, action: "accept" };
}

module.exports = {
  claimOpenLinkInvitation,
  confirmOpenLinkByHost,
  formatOpenLinkSocketPayload,
};
