const express = require("express");
const { body, validationResult } = require("express-validator");
const crypto = require("crypto");

const auth = require("../middleware/auth");
const requirePoliciesAccepted = require("../middleware/requirePoliciesAccepted");
const User = require("../models/User");
const GameInvitation = require("../models/GameInvitation");
const Game = require("../models/Game");
const RematchRequest = require("../models/RematchRequest");
const {
  dismissAllArenaNotificationsForUser,
} = require("../services/arenaNotificationService");

const { getPublicFrontendUrl } = require("../utils/frontendUrl");

const router = express.Router();

const DEFAULT_TIME_CONTROLS = {
  bullet: { initial: 60000, increment: 1000 },
  blitz: { initial: 180000, increment: 2000 },
  rapid: { initial: 600000, increment: 0 },
  classical: { initial: 900000, increment: 10000 },
};

const INVITE_EXPIRATION_MS = 15 * 60 * 1000;

function normalizeGameType(requestedType) {
  const fallback = "blitz";
  if (!requestedType) return fallback;
  const normalized = requestedType.toLowerCase();
  return DEFAULT_TIME_CONTROLS[normalized] ? normalized : fallback;
}

function resolveTimeControl(gameType, maybeControl = {}) {
  const base = DEFAULT_TIME_CONTROLS[gameType] || DEFAULT_TIME_CONTROLS.blitz;
  const initial = Number(maybeControl.initial);
  const increment = Number(maybeControl.increment);
  return {
    initial: Number.isFinite(initial) && initial > 0 ? initial : base.initial,
    increment:
      Number.isFinite(increment) && increment >= 0 ? increment : base.increment,
  };
}

function resolveSides(preferredColor = "random") {
  if (preferredColor === "white") {
    return { inviterSide: "white", inviteeSide: "black" };
  }
  if (preferredColor === "black") {
    return { inviterSide: "black", inviteeSide: "white" };
  }
  // random — fixed at create time for open links via stored preferredColor;
  // if still random, default inviter white for display.
  return { inviterSide: "white", inviteeSide: "black" };
}

function formatInvitation(invitation) {
  const matchType = invitation.matchType || "rated";
  const preferredColor = invitation.preferredColor || "random";
  const { inviterSide, inviteeSide } = resolveSides(
    preferredColor === "random" ? "white" : preferredColor
  );
  return {
    id: invitation._id,
    token: invitation.token,
    status: invitation.status,
    gameType: invitation.gameType,
    matchType,
    gameFormat: invitation.isOpenLink ? "open_link" : "friend",
    isOpenLink: Boolean(invitation.isOpenLink),
    preferredColor,
    inviterSide,
    inviteeSide,
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
          avatar: invitation.toUser.avatar,
          country: invitation.toUser.country || "",
        }
      : null,
  };
}

function isGameCompletedLike(status) {
  return ["completed", "abandoned", "draw"].includes(String(status || "").toLowerCase());
}

async function resolveInvitationEffectiveStatus(invitation, now = new Date()) {
  if (invitation.status !== "pending") return invitation.status;
  if (invitation.expiresAt && invitation.expiresAt < now) {
    invitation.status = "expired";
    await invitation.save();
    return "expired";
  }
  if (invitation.gameId) {
    const game = await Game.findOne({ gameId: invitation.gameId }).select("status");
    if (game && isGameCompletedLike(game.status)) {
      return "completed";
    }
  }
  return "pending";
}

async function resolveRematchEffectiveStatus(rematchRequest, now = new Date()) {
  if (rematchRequest.status !== "pending") return rematchRequest.status;
  const expiresAt = new Date(rematchRequest.createdAt.getTime() + 24 * 60 * 60 * 1000);
  if (expiresAt < now) {
    rematchRequest.status = "expired";
    await rematchRequest.save();
    return "expired";
  }
  if (rematchRequest.gameId) {
    const game = await Game.findOne({ gameId: rematchRequest.gameId }).select("status");
    if (game && isGameCompletedLike(game.status)) {
      return "completed";
    }
  }
  return "pending";
}

function broadcastInvite(io, invitation) {
  if (!io) return;
  const payload = formatInvitation(invitation);
  if (invitation.fromUser?._id) {
    io.to(`user:${invitation.fromUser._id.toString()}`).emit(
      "challenge:update",
      payload
    );
  }
  if (invitation.toUser?._id) {
    io.to(`user:${invitation.toUser._id.toString()}`).emit(
      "challenge:update",
      payload
    );
  }
  io.to(`invite:${invitation.token}`).emit("challenge:update", payload);
}

function pickOpenLinkColor(preferredColor) {
  if (preferredColor === "white" || preferredColor === "black") {
    return preferredColor;
  }
  return Math.random() < 0.5 ? "white" : "black";
}

router.post(
  "/email",
  [
    auth,
    requirePoliciesAccepted,
    body("email")
      .isEmail()
      .withMessage("Valid email is required")
      .normalizeEmail(),
    body("gameType").optional().isString(),
    body("timeControl").optional().isObject(),
    body("matchType").optional().isIn(["rated", "unrated", "casual"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { email, gameType, timeControl, matchType } = req.body;
      const normalizedMatchType =
        matchType === "unrated" || matchType === "casual" ? "unrated" : "rated";
      const isRated = normalizedMatchType === "rated";
      const normalizedEmail = email.toLowerCase();
      const opponent = await User.findOne({ email: normalizedEmail });

      if (!opponent) {
        return res.status(404).json({
          success: false,
          message: "No user found with that email",
        });
      }

      if (opponent._id.equals(req.user._id)) {
        return res.status(400).json({
          success: false,
          message: "You cannot challenge yourself",
        });
      }

      // Option A: prevent multiple simultaneous pending challenges from the same sender
      const existingPending = await GameInvitation.findOne({
        fromUser: req.user._id,
        toUser: opponent._id,
        status: "pending",
        expiresAt: { $gt: new Date() },
      });
      if (existingPending) {
        return res.status(400).json({
          success: false,
          message: "You already have a pending challenge to this user",
          data: { invitation: formatInvitation(existingPending) },
        });
      }

      const normalizedGameType = normalizeGameType(gameType);
      const resolvedTimeControl = resolveTimeControl(
        normalizedGameType,
        timeControl
      );
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRATION_MS);

      // Create the game immediately when sending invitation
      const { setGameCategory } = require("../services/ratingEngine");
      const gameId = Math.random().toString(36).substr(2, 9);
      const game = new Game({
        gameId: gameId,
        type: "friend",
        isRated,
        players: {
          white: req.user._id,
          black: opponent._id,
        },
        timeControl: resolvedTimeControl,
        timeRemaining: {
          white: resolvedTimeControl.initial,
          black: resolvedTimeControl.initial,
        },
        status: "active", // Game is active, just waiting for opponent
      });
      setGameCategory(game);
      await game.save();
      console.log(`✅ Game created on invitation send: ${gameId}`);

      const invitation = await GameInvitation.create({
        token,
        fromUser: req.user._id,
        toUser: opponent._id,
        toEmail: normalizedEmail,
        gameType: normalizedGameType,
        matchType: normalizedMatchType,
        timeControl: resolvedTimeControl,
        expiresAt,
        gameId: gameId, // Store gameId in invitation
      });

      await invitation.populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
        { path: "toUser", select: "username fullName avatar rating country" },
      ]);

      const baseUrl = getPublicFrontendUrl();
      const joinUrl = `${baseUrl}/dashboard?invite=${token}`;

      const formatted = {
        ...formatInvitation(invitation),
        joinUrl,
      };

      const io = req.app.get("io");
      if (io) {
        io.to(`user:${opponent._id.toString()}`).emit(
          "challenge:incoming",
          formatted
        );
      }

      res.status(201).json({
        success: true,
        message: "Challenge invitation sent",
        data: { invitation: formatted },
      });
    } catch (error) {
      console.error("Email challenge error:", error);
      res.status(500).json({
        success: false,
        message: "Unable to send challenge invitation",
      });
    }
  }
);

router.post(
  "/link",
  [
    auth,
    requirePoliciesAccepted,
    body("gameType").optional().isString(),
    body("timeControl").optional().isObject(),
    body("matchType").optional().isIn(["rated", "unrated", "casual"]),
    body("preferredColor").optional().isIn(["white", "black", "random"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { gameType, timeControl, matchType, preferredColor } = req.body;
      const normalizedMatchType =
        matchType === "unrated" || matchType === "casual" ? "unrated" : "rated";
      const normalizedGameType = normalizeGameType(gameType);
      const resolvedTimeControl = resolveTimeControl(
        normalizedGameType,
        timeControl
      );
      // Resolve random at create so the share link has a fixed color assignment.
      const resolvedColor = pickOpenLinkColor(preferredColor || "random");
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRATION_MS);

      // Expire older open links from this user so only one active share exists.
      await GameInvitation.updateMany(
        {
          fromUser: req.user._id,
          isOpenLink: true,
          status: "pending",
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: "expired" } }
      );

      const invitation = await GameInvitation.create({
        token,
        fromUser: req.user._id,
        toUser: null,
        toEmail: null,
        isOpenLink: true,
        preferredColor: resolvedColor,
        gameType: normalizedGameType,
        matchType: normalizedMatchType,
        timeControl: resolvedTimeControl,
        expiresAt,
        gameId: null,
      });

      await invitation.populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
      ]);

      const baseUrl = getPublicFrontendUrl();
      const joinUrl = `${baseUrl}/dashboard?invite=${token}`;

      const formatted = {
        ...formatInvitation(invitation),
        joinUrl,
      };

      res.status(201).json({
        success: true,
        message: "Challenge link created",
        data: { invitation: formatted },
      });
    } catch (error) {
      console.error("Open challenge link error:", error);
      res.status(500).json({
        success: false,
        message: "Unable to create challenge link",
      });
    }
  }
);

router.post(
  "/friend",
  [
    auth,
    requirePoliciesAccepted,
    body("friendId").isMongoId().withMessage("friendId is required"),
    body("gameType").optional().isString(),
    body("timeControl").optional().isObject(),
    body("matchType").optional().isIn(["rated", "unrated", "casual"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { friendId, gameType, timeControl, matchType } = req.body;
      const normalizedMatchType =
        matchType === "unrated" || matchType === "casual" ? "unrated" : "rated";
      const isRated = normalizedMatchType === "rated";

      if (friendId === req.user._id.toString()) {
        return res.status(400).json({
          success: false,
          message: "You cannot challenge yourself",
        });
      }

      const opponent = await User.findById(friendId);
      if (!opponent) {
        return res.status(404).json({
          success: false,
          message: "Friend not found",
        });
      }

      const isFriend =
        Array.isArray(req.user.friends) &&
        req.user.friends.some((id) => id.toString() === friendId.toString());

      if (!isFriend) {
        return res.status(403).json({
          success: false,
          message: "You can only challenge friends you have added",
        });
      }

      // Option A: prevent multiple simultaneous pending challenges between same sender/receiver
      const existingPending = await GameInvitation.findOne({
        fromUser: req.user._id,
        toUser: opponent._id,
        status: "pending",
        expiresAt: { $gt: new Date() },
      });
      if (existingPending) {
        return res.status(400).json({
          success: false,
          message: "You already have a pending challenge to this friend",
          data: { invitation: formatInvitation(existingPending) },
        });
      }

      const normalizedGameType = normalizeGameType(gameType);
      const resolvedTimeControl = resolveTimeControl(
        normalizedGameType,
        timeControl
      );
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRATION_MS);

      // Create the game immediately when sending invitation
      const gameId = Math.random().toString(36).substr(2, 9);
      const { setGameCategory } = require("../services/ratingEngine");
      
      const game = new Game({
        gameId: gameId,
        type: "friend",
        isRated,
        players: {
          white: req.user._id,
          black: opponent._id,
        },
        timeControl: resolvedTimeControl,
        timeRemaining: {
          white: resolvedTimeControl.initial,
          black: resolvedTimeControl.initial,
        },
        status: "active", // Game is active, just waiting for opponent
      });
      setGameCategory(game);
      await game.save();
      console.log(`✅ Game created on friend invitation send: ${gameId}`);

      const invitation = await GameInvitation.create({
        token,
        fromUser: req.user._id,
        toUser: opponent._id,
        toEmail: opponent.email,
        gameType: normalizedGameType,
        matchType: normalizedMatchType,
        timeControl: resolvedTimeControl,
        expiresAt,
        gameId: gameId, // Store gameId in invitation
      });

      await invitation.populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
        { path: "toUser", select: "username fullName avatar rating country" },
      ]);

      const baseUrl = getPublicFrontendUrl();
      const joinUrl = `${baseUrl}/dashboard?invite=${token}`;

      const formatted = {
        ...formatInvitation(invitation),
        joinUrl,
      };

      const io = req.app.get("io");
      if (io) {
        io.to(`user:${opponent._id.toString()}`).emit(
          "challenge:incoming",
          formatted
        );
      }

      res.status(201).json({
        success: true,
        message: "Challenge invitation sent",
        data: { invitation: formatted },
      });
    } catch (error) {
      console.error("Friend challenge error:", error);
      res.status(500).json({
        success: false,
        message: "Unable to send challenge invitation",
      });
    }
  }
);

router.get("/", auth, async (req, res) => {
  try {
    const now = new Date();
    const direction =
      req.query.direction === "outgoing" ? "fromUser" : "toUser";
    const match = {
      [direction]: req.user._id,
      isClearedByRecipient: false,
    };

    const invitations = await GameInvitation.find(match)
      .sort({ createdAt: -1 })
      .limit(20)
      .populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
        { path: "toUser", select: "username fullName avatar rating country" },
      ]);

    const formattedInvitations = await Promise.all(
      invitations.map(async (invitation) => {
        const effectiveStatus = await resolveInvitationEffectiveStatus(invitation, now);
        const base = formatInvitation(invitation);
        return {
          ...base,
          status: effectiveStatus,
          effectiveStatus,
          isActionable: effectiveStatus === "pending",
        };
      })
    );

    // Also fetch rematch requests for incoming direction
    let rematchRequests = [];
    if (direction === "toUser") {
      const rematches = await RematchRequest.find({
        toUser: req.user._id,
        isClearedByRecipient: false,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate([
          { path: "fromUser", select: "username fullName avatar rating country" },
        ]);

      const originalIds = [
        ...new Set(rematches.map((r) => r.originalGameId).filter(Boolean)),
      ];
      const origGames =
        originalIds.length > 0
          ? await Game.find({ gameId: { $in: originalIds } })
              .select("gameId isRated")
              .lean()
          : [];
      const ratedByOrig = new Map(
        origGames.map((g) => [g.gameId, g.isRated !== false])
      );

      rematchRequests = await Promise.all(
        rematches.map(async (req) => {
          const effectiveStatus = await resolveRematchEffectiveStatus(req, now);
          const origRated = ratedByOrig.get(req.originalGameId);
          const matchType = origRated === false ? "unrated" : "rated";
          return {
            id: req._id,
            token: `rematch_${req._id}`, // Use a token-like identifier
            type: "rematch",
            status: effectiveStatus,
            effectiveStatus,
            isActionable: effectiveStatus === "pending",
            gameType: req.gameType || "blitz",
            matchType,
            gameFormat: "rematch",
            timeControl: req.timeControl || { initial: 300000, increment: 3 },
            expiresAt: new Date(req.createdAt.getTime() + 24 * 60 * 60 * 1000),
            createdAt: req.createdAt,
            gameId: req.originalGameId,
            from: req.fromUser
              ? {
                  id: req.fromUser._id,
                  username: req.fromUser.username,
                  fullName: req.fromUser.fullName,
                  rating: req.fromUser.rating,
                  avatar: req.fromUser.avatar,
                }
              : null,
            to: null,
          };
        })
      );
    }

    res.json({
      success: true,
      data: {
        invitations: [...formattedInvitations, ...rematchRequests],
      },
    });
  } catch (error) {
    console.error("Fetch invitations error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load invitations",
    });
  }
});

router.post("/clear-all", auth, async (req, res) => {
  try {
    const [invitesResult, rematchesResult, clearedArenaNotifications] = await Promise.all([
      GameInvitation.updateMany(
        { toUser: req.user._id, isClearedByRecipient: false },
        { $set: { isClearedByRecipient: true } }
      ),
      RematchRequest.updateMany(
        { toUser: req.user._id, isClearedByRecipient: false },
        { $set: { isClearedByRecipient: true } }
      ),
      dismissAllArenaNotificationsForUser(req.user._id),
    ]);

    return res.json({
      success: true,
      message: "Notifications cleared",
      data: {
        clearedInvitations: invitesResult.modifiedCount || 0,
        clearedRematches: rematchesResult.modifiedCount || 0,
        clearedArenaNotifications,
      },
    });
  } catch (error) {
    console.error("Clear notifications error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to clear notifications",
    });
  }
});

router.post(
  "/:token/respond",
  [
    auth,
    requirePoliciesAccepted,
    body("action")
      .isIn(["accept", "decline"])
      .withMessage("Action must be accept or decline"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { action } = req.body;
      const token = req.params.token;
      
      // Check if this is a rematch request (token starts with "rematch_")
      let invitation = null;
      let isRematch = false;
      
      if (token.startsWith("rematch_")) {
        isRematch = true;
        const RematchRequest = require("../models/RematchRequest");
        const rematchId = token.replace("rematch_", "");
        const rematchRequest = await RematchRequest.findById(rematchId).populate([
          { path: "fromUser", select: "username fullName avatar rating country" },
        ]);
        
        if (rematchRequest) {
          // Convert rematch request to invitation-like format
          invitation = {
            _id: rematchRequest._id,
            token: token,
            status: rematchRequest.status,
            gameType: "rematch",
            gameId: rematchRequest.originalGameId,
            fromUser: rematchRequest.fromUser,
            toUser: { _id: rematchRequest.toUser },
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
          };
        }
      } else {
        invitation = await GameInvitation.findOne({
          token: req.params.token,
        }).populate([
          { path: "fromUser", select: "username fullName avatar rating ratings country" },
          { path: "toUser", select: "username fullName avatar rating ratings country" },
        ]);
      }

      if (!invitation) {
        return res.status(404).json({
          success: false,
          message: "Invitation not found",
        });
      }

      const isOpenLink = Boolean(invitation.isOpenLink);
      const toUserId = invitation.toUser?._id || invitation.toUser || null;
      const fromUserId = invitation.fromUser?._id || invitation.fromUser;

      if (isOpenLink) {
        if (String(fromUserId) === String(req.user._id)) {
          return res.status(400).json({
            success: false,
            message: "You cannot accept your own challenge link",
          });
        }
        if (toUserId && String(toUserId) !== String(req.user._id)) {
          return res.status(403).json({
            success: false,
            message: "This challenge link was already claimed by someone else",
          });
        }
      } else {
        if (!toUserId || String(toUserId) !== String(req.user._id)) {
          return res.status(403).json({
            success: false,
            message: "You are not allowed to respond to this invite",
          });
        }
      }

      if (invitation.status !== "pending") {
        return res.status(400).json({
          success: false,
          message: `Invitation already ${invitation.status}`,
        });
      }

      if (!isRematch && invitation.expiresAt < new Date()) {
        invitation.status = "expired";
        await invitation.save();
        return res.status(410).json({
          success: false,
          message: "Invitation has expired",
        });
      }

      if (!isRematch && invitation.gameId) {
        const currentGame = await Game.findOne({ gameId: invitation.gameId }).select("status");
        if (currentGame && isGameCompletedLike(currentGame.status)) {
          return res.status(409).json({
            success: false,
            message: "Invitation is no longer actionable",
            code: "INVITATION_COMPLETED",
            data: { status: "completed" },
          });
        }
      }
      if (isRematch) {
        const rematchId = token.replace("rematch_", "");
        const rematchRequest = await RematchRequest.findById(rematchId);
        if (!rematchRequest) {
          return res.status(404).json({
            success: false,
            message: "Rematch request not found",
          });
        }
        const effectiveStatus = await resolveRematchEffectiveStatus(rematchRequest);
        if (effectiveStatus !== "pending") {
          return res.status(409).json({
            success: false,
            message: `Rematch request already ${effectiveStatus}`,
            code: "REMATCH_NOT_ACTIONABLE",
            data: { status: effectiveStatus },
          });
        }
      }

      let game = null;

      if (action === "decline") {
        if (isRematch) {
          const RematchRequest = require("../models/RematchRequest");
          const rematchId = invitation._id;
          await RematchRequest.findByIdAndUpdate(rematchId, { status: "declined" });
          
          const io = req.app.get("io");
          if (io && invitation.fromUser) {
            io.to(`user:${invitation.fromUser._id.toString()}`).emit("rematch:declined", {
              gameId: invitation.gameId,
              fromUserId: invitation.fromUser._id.toString(),
            });
            io.to(`user:${invitation.fromUser._id.toString()}`).emit("challenge:update", {
              id: rematchId,
              token: `rematch_${rematchId}`,
              type: "rematch",
              status: "declined",
            });
          }
        } else {
          invitation.status = "declined";
          await invitation.save();
        }

        // If game was created, mark it as abandoned
        if (invitation.gameId) {
          const existingGame = await Game.findOne({
            gameId: invitation.gameId,
          });
          if (existingGame) {
            existingGame.status = "abandoned";
            await existingGame.save();
            console.log(
              `❌ Game ${invitation.gameId} marked as abandoned (invitation declined)`
            );
          }
        }
      } else if (action === "accept") {
        if (isRematch) {
          // Handle rematch acceptance - trigger socket event to create new game
          const RematchRequest = require("../models/RematchRequest");
          const rematchId = invitation._id;
          const rematchRequest = await RematchRequest.findById(rematchId);
          
          if (!rematchRequest || rematchRequest.status !== "pending") {
            return res.status(400).json({
              success: false,
              message: "Rematch request not found or already processed",
            });
          }
          
          // Trigger rematch:accept by emitting to user's socket room
          // The socket handler will process it and create the new game
          const io = req.app.get("io");
          if (io) {
            const userId = req.user._id.toString();
            // Emit to user's room - socket handler will pick it up
            io.to(`user:${userId}`).emit("rematch:accept", {
              gameId: rematchRequest.originalGameId,
              senderId: userId,
            });
          }
          
          // Return success - socket will handle the rest
          return res.status(200).json({
            success: true,
            message: "Rematch accepted. Please wait for game to start.",
            data: {
              rematchRequest: {
                id: rematchRequest._id,
                gameId: rematchRequest.originalGameId,
              },
            },
          });
        }

        // Open challenge link: claim + create game on accept
        if (isOpenLink && !invitation.gameId) {
          const { setGameCategory } = require("../services/ratingEngine");
          const isRated = (invitation.matchType || "rated") === "rated";
          const inviterColor =
            invitation.preferredColor === "black" ? "black" : "white";
          const gameId = Math.random().toString(36).substr(2, 9);
          const players =
            inviterColor === "white"
              ? { white: invitation.fromUser._id, black: req.user._id }
              : { white: req.user._id, black: invitation.fromUser._id };

          game = new Game({
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

          invitation.toUser = req.user._id;
          invitation.toEmail = req.user.email || null;
          invitation.gameId = gameId;
          invitation.status = "accepted";
          await invitation.save();
          await invitation.populate([
            { path: "fromUser", select: "username fullName avatar rating ratings country" },
            { path: "toUser", select: "username fullName avatar rating ratings country" },
          ]);

          const ioOpen = req.app.get("io");
          if (ioOpen) {
            ioOpen.to(`user:${invitation.fromUser._id.toString()}`).emit(
              "opponent-joined",
              {
                gameId: game.gameId,
                opponent: {
                  id: req.user._id,
                  username: req.user.username,
                  fullName: req.user.fullName,
                  avatar: req.user.avatar,
                  rating: req.user.rating,
                  ratings: req.user.ratings,
                  country: req.user.country || "",
                },
              }
            );
            ioOpen.to(game.gameId).emit("player-joined", {
              gameId: game.gameId,
              userId: req.user._id.toString(),
              player: {
                id: req.user._id,
                username: req.user.username,
                fullName: req.user.fullName,
                avatar: req.user.avatar,
                rating: req.user.rating,
                ratings: req.user.ratings,
                country: req.user.country || "",
              },
            });
          }

          broadcastInvite(ioOpen, invitation);
          return res.json({
            success: true,
            message: "Invitation accepted",
            data: {
              invitation: formatInvitation(invitation),
              game,
            },
          });
        }
        
        // Game was already created when invitation was sent
        if (!invitation.gameId) {
          return res.status(400).json({
            success: false,
            message: "Game ID not found in invitation",
          });
        }

        // Load existing game
        game = await Game.findOne({ gameId: invitation.gameId });

        if (!game) {
          return res.status(404).json({
            success: false,
            message: "Game not found",
          });
        }

        console.log(
          `✅ User accepted invitation, joining game: ${game.gameId}`
        );

        // Update invitation status
        invitation.status = "accepted";
        await invitation.save();

        const io = req.app.get("io");
        if (io) {
          console.log(`🎮 User B accepted - notifying both players`);
          console.log(
            `  - Sender (White): ${invitation.fromUser._id.toString()}`
          );
          console.log(
            `  - Acceptor (Black): ${invitation.toUser._id.toString()}`
          );
          console.log(`  - GameId: ${game.gameId}`);

          // Notify sender that opponent has joined
          io.to(`user:${invitation.fromUser._id.toString()}`).emit(
            "opponent-joined",
            {
              gameId: game.gameId,
              opponent: {
                id: invitation.toUser._id,
                username: invitation.toUser.username,
                fullName: invitation.toUser.fullName,
                avatar: invitation.toUser.avatar,
                rating: invitation.toUser.rating,
                ratings: invitation.toUser.ratings,
                country: invitation.toUser.country || "",
              },
            }
          );

          // Also emit to game room
          io.to(game.gameId).emit("player-joined", {
            gameId: game.gameId,
            userId: invitation.toUser._id.toString(),
            player: {
              id: invitation.toUser._id,
              username: invitation.toUser.username,
              fullName: invitation.toUser.fullName,
              avatar: invitation.toUser.avatar,
              rating: invitation.toUser.rating,
              ratings: invitation.toUser.ratings,
              country: invitation.toUser.country || "",
            },
          });

          console.log(`✅ opponent-joined event emitted to sender`);
        }
      }

      const io = req.app.get("io");
      broadcastInvite(io, invitation);

      res.json({
        success: true,
        message: `Invitation ${action === "accept" ? "accepted" : "declined"}`,
        data: {
          invitation: formatInvitation(invitation),
          game,
        },
      });
    } catch (error) {
      console.error("Invitation respond error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update invitation",
      });
    }
  }
);

module.exports = router;
