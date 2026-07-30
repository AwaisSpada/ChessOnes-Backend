const Game = require("../models/Game");
const GameInvitation = require("../models/GameInvitation");

/**
 * Claim an open challenge link and create the live game.
 * Shared by HTTP respond + socket accept-invite.
 *
 * @param {object} invitation - populated GameInvitation (fromUser)
 * @param {object} acceptor - authenticated user doc (req.user / socket user)
 * @param {import('socket.io').Server | null} io
 * @returns {Promise<{ invitation: object, game: object }>}
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

  if (invitation.status !== "pending") {
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

  // Already claimed by this user with a game — idempotent return.
  if (invitation.gameId && toUserId && String(toUserId) === String(acceptorId)) {
    const existing = await Game.findOne({ gameId: invitation.gameId });
    if (existing) {
      return { invitation, game: existing };
    }
  }

  if (invitation.gameId) {
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
  invitation.status = "accepted";
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
    const fromId = invitation.fromUser._id.toString();
    io.to(`user:${fromId}`).emit("opponent-joined", {
      gameId: game.gameId,
      opponent: {
        id: acceptorId,
        username: acceptor.username,
        fullName: acceptor.fullName,
        avatar: acceptor.avatar,
        rating: acceptor.rating,
        ratings: acceptor.ratings,
        country: acceptor.country || "",
      },
    });
    io.to(game.gameId).emit("player-joined", {
      gameId: game.gameId,
      userId: String(acceptorId),
      player: {
        id: acceptorId,
        username: acceptor.username,
        fullName: acceptor.fullName,
        avatar: acceptor.avatar,
        rating: acceptor.rating,
        ratings: acceptor.ratings,
        country: acceptor.country || "",
      },
    });
  }

  return { invitation, game };
}

module.exports = { claimOpenLinkInvitation };
