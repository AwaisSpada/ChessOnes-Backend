const express = require("express");
const { body, validationResult } = require("express-validator");
const crypto = require("crypto");
const User = require("../models/User");
const UserInvite = require("../models/UserInvite");
const Game = require("../models/Game");
const {
  sendMail,
  buildPlatformInviteEmail,
  CHESSONES_FROM_NOREPLY,
} = require("../utils/sendMail");
const { getPublicFrontendUrl } = require("../utils/frontendUrl");
const auth = require("../middleware/auth");

const router = express.Router();

// @route   GET /api/friends/nemesis
// @desc    Get the logged-in user's nemesis: the opponent they have lost to the most (from DB).
//          Returns head-to-head W/L/D from the current user's perspective.
// @access  Private
router.get("/nemesis", auth, async (req, res) => {
  try {
    const myId = req.user._id.toString();
    const games = await Game.find({
      $or: [{ "players.white": myId }, { "players.black": myId }],
      status: "completed",
    })
      .populate("players.white players.black", "username fullName avatar rating ratings")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const byOpponent = new Map();
    for (const g of games) {
      if (!g.result || !g.result.winner) continue;
      const whiteId = g.players?.white?._id?.toString?.() || g.players?.white?.toString?.();
      const blackId = g.players?.black?._id?.toString?.() || g.players?.black?.toString?.();
      if (!whiteId || !blackId) continue;
      const iAmWhite = whiteId === myId;
      const opponentId = iAmWhite ? blackId : whiteId;
      const opponent = iAmWhite ? g.players.black : g.players.white;
      const name = opponent?.fullName || opponent?.username || "Opponent";
      const avatar = opponent?.avatar;
      const rating = opponent?.rating ?? opponent?.ratings?.blitz?.rating;

      let row = byOpponent.get(opponentId);
      if (!row) row = { opponentId, losses: 0, wins: 0, draws: 0, name, avatar, rating };
      if (g.result.winner === "draw") row.draws += 1;
      else if ((g.result.winner === "white" && iAmWhite) || (g.result.winner === "black" && !iAmWhite)) row.wins += 1;
      else row.losses += 1;
      byOpponent.set(opponentId, row);
    }

    let nemesisRow = null;
    for (const row of byOpponent.values()) {
      if (row.losses === 0) continue;
      if (!nemesisRow || row.losses > nemesisRow.losses) nemesisRow = row;
    }

    if (!nemesisRow) {
      return res.json({
        success: true,
        data: {
          nemesis: null,
          message: "No nemesis (no completed games with losses to any opponent).",
        },
      });
    }

    const friendIds = (req.user.friends || []).map((id) => id.toString());
    const isFriend = friendIds.includes(nemesisRow.opponentId);
    const nemesisUser = await User.findById(nemesisRow.opponentId)
      .select("username fullName avatar rating ratings")
      .lean();
    const displayName = nemesisUser?.fullName || nemesisUser?.username || nemesisRow.name;
    const displayAvatar = nemesisUser?.avatar ?? nemesisRow.avatar;
    const displayRating = nemesisUser?.ratings?.blitz?.rating ?? nemesisUser?.rating ?? nemesisRow.rating ?? 1500;

    res.json({
      success: true,
      data: {
        nemesis: {
          opponentId: nemesisRow.opponentId,
          name: displayName,
          avatar: displayAvatar,
          rating: typeof displayRating === "number" ? displayRating : 1500,
          wins: nemesisRow.wins,
          losses: nemesisRow.losses,
          draws: nemesisRow.draws,
        },
        isFriend,
      },
    });
  } catch (error) {
    console.error("Get nemesis error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   GET /api/friends
// @desc    Get user's friends list
// @access  Private
router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate("friends", "username fullName avatar status rating lastActive ratings puzzleRating country")
      .select("friends");

    res.json({
      success: true,
      data: { friends: user.friends },
    });
  } catch (error) {
    console.error("Get friends error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/friends/invite-by-email
// @desc    Invite someone who is not on ChessOnes yet: sends a themed email with signup link.
//          If the email already belongs to a registered user, returns an error (no friend request).
// @access  Private
router.post(
  "/invite-by-email",
  [auth, body("email").isEmail().normalizeEmail()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Invalid email",
          errors: errors.array(),
        });
      }

      const inviter = req.user;
      const email = req.body.email.toLowerCase();

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        if (existingUser._id.equals(inviter._id)) {
          return res.status(400).json({
            success: false,
            message: "You cannot invite yourself",
          });
        }
        return res.status(400).json({
          success: false,
          message:
            "This email is already registered on ChessOnes. That player is already on the platform — use Friends search to find and add them.",
        });
      }

      // Email does NOT exist on platform => send platform invite email
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      await UserInvite.create({
        email,
        inviter: inviter._id,
        token,
        status: "pending",
        expiresAt,
      });

      const baseUrl = getPublicFrontendUrl();
      const signupUrl = `${baseUrl}/signup?invite=${encodeURIComponent(
        token
      )}&email=${encodeURIComponent(email)}`;

      const html = buildPlatformInviteEmail({
        inviterName: inviter.fullName || inviter.username || "A friend",
        inviteeEmail: email,
        signupUrl,
      });

      await sendMail({
        to: email,
        from: CHESSONES_FROM_NOREPLY,
        subject: `${
          inviter.fullName || inviter.username || "A friend"
        } invited you to join ChessOnes`,
        html,
      });

      return res.json({
        success: true,
        message: "Invitation email sent",
      });
    } catch (error) {
      console.error("Invite by email error:", error);
      return res.status(500).json({
        success: false,
        message: "Server error while sending invite",
      });
    }
  }
);

// // @route   POST /api/friends/request
// // @desc    Send friend request
// // @access  Private
// router.post("/request", [auth, body("userId").isMongoId()], async (req, res) => {
//   try {
//     const errors = validationResult(req)
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid user ID",
//       })
//     }

//     const { userId } = req.body

//     if (userId === req.user._id.toString()) {
//       return res.status(400).json({
//         success: false,
//         message: "Cannot send friend request to yourself",
//       })
//     }

//     const targetUser = await User.findById(userId)
//     if (!targetUser) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found",
//       })
//     }

//     // Check if already friends
//     if (req.user.friends.includes(userId)) {
//       return res.status(400).json({
//         success: false,
//         message: "Already friends with this user",
//       })
//     }

//     // Check if request already exists
//     const existingRequest = targetUser.friendRequests.find(
//       (request) => request.from.toString() === req.user._id.toString() && request.status === "pending",
//     )

//     if (existingRequest) {
//       return res.status(400).json({
//         success: false,
//         message: "Friend request already sent",
//       })
//     }

//     // Add friend request
//     targetUser.friendRequests.push({
//       from: req.user._id,
//       status: "pending",
//     })

//     await targetUser.save()

//     // Emit real-time notification
//     req.app
//       .get("io")
//       .to(userId)
//       .emit("friend-request", {
//         from: {
//           id: req.user._id,
//           username: req.user.username,
//           fullName: req.user.fullName,
//           avatar: req.user.avatar,
//         },
//       })

//     res.json({
//       success: true,
//       message: "Friend request sent successfully",
//     })
//   } catch (error) {
//     console.error("Send friend request error:", error)
//     res.status(500).json({
//       success: false,
//       message: "Server error",
//     })
//   }
// })

// @route   POST /api/friends/request
// @desc    Send friend request
// @access  Private
// router.post(
//   "/request",
//   [
//     auth,
//     body("userId").isMongoId(),   // sender
//     body("friendId").isMongoId(), // receiver
//   ],
//   async (req, res) => {
//     try {
//       const errors = validationResult(req);
//       if (!errors.isEmpty()) {
//         return res.status(400).json({
//           success: false,
//           message: "Invalid user IDs",
//         });
//       }

//       const { userId, friendId } = req.body;

//       // prevent self-requests
//       if (userId === friendId) {
//         return res.status(400).json({
//           success: false,
//           message: "Cannot send friend request to yourself",
//         });
//       }

//       // find both users
//       const sender = await User.findById(userId);
//       const receiver = await User.findById(friendId);

//       if (!sender || !receiver) {
//         return res.status(404).json({
//           success: false,
//           message: "One or both users not found",
//         });
//       }

//       // check if already friends
//       if (sender.friends.includes(friendId)) {
//         return res.status(400).json({
//           success: false,
//           message: "Already friends with this user",
//         });
//       }

//       // check if request already exists
//       const existingRequest = receiver.friendRequests.find(
//         (request) =>
//           request.from.toString() === userId && request.status === "pending"
//       );

//       if (existingRequest) {
//         return res.status(400).json({
//           success: false,
//           message: "Friend request already sent",
//         });
//       }

//       // push friend request into receiver's list
//       receiver.friendRequests.push({
//         from: userId,
//         status: "pending",
//       });

//       await receiver.save();

//       // emit real-time notification (if using socket.io)
//       req.app.get("io").to(friendId).emit("friend-request", {
//         from: {
//           id: sender._id,
//           username: sender.username,
//           fullName: sender.fullName,
//           avatar: sender.avatar,
//         },
//       });

//       res.json({
//         success: true,
//         message: "Friend request sent successfully",
//       });
//     } catch (error) {
//       console.error("Send friend request error:", error);
//       res.status(500).json({
//         success: false,
//         message: "Server error",
//       });
//     }
//   }
// );

// @route   POST /api/friends/request
// @desc    Send, accept, or decline friend request
// @access  Private
router.post(
  "/request",
  [
    auth,
    body("userId").isMongoId(), // sender (the logged-in user id from frontend)
    body("friendId").isMongoId(), // receiver or sender depending on action
    body("action").isIn(["send", "accept", "decline"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Invalid input",
        });
      }

      const { userId, friendId, action } = req.body;

      // prevent self-requests
      if (userId === friendId) {
        return res.status(400).json({
          success: false,
          message: "Cannot perform action on yourself",
        });
      }

      const sender = await User.findById(userId);
      const receiver = await User.findById(friendId);

      if (!sender || !receiver) {
        return res.status(404).json({
          success: false,
          message: "One or both users not found",
        });
      }

      // ====== ACTION HANDLING ======
      if (action === "send") {
        // check if already friends
        if (sender.friends.includes(friendId)) {
          return res.status(400).json({
            success: false,
            message: "Already friends with this user",
          });
        }

        // check if request already exists
        const existingRequest = receiver.friendRequests.find(
          (req) => req.from.toString() === userId && req.status === "pending"
        );

        if (existingRequest) {
          return res.status(400).json({
            success: false,
            message: "Friend request already sent",
          });
        }

        receiver.friendRequests.push({
          from: userId,
          status: "pending",
        });

        await receiver.save();

        // notify receiver
        req.app
          .get("io")
          ?.to(`user:${friendId}`)
          .emit("friend-request", {
            from: {
              id: sender._id,
              username: sender.username,
              fullName: sender.fullName,
              avatar: sender.avatar,
            },
          });

        return res.json({
          success: true,
          message: "Friend request sent successfully",
        });
      }

      if (action === "accept") {
        // find pending request from friendId → userId
        const requestIndex = sender.friendRequests.findIndex(
          (req) => req.from.toString() === friendId && req.status === "pending"
        );

        if (requestIndex === -1) {
          return res.status(400).json({
            success: false,
            message: "No pending friend request found",
          });
        }

        // update status
        sender.friendRequests[requestIndex].status = "accepted";
        sender.friends.push(friendId);
        receiver.friends.push(userId);

        await sender.save();
        await receiver.save();

        // notify sender of acceptance
        req.app
          .get("io")
          ?.to(`user:${friendId}`)
          .emit("friend-request-accepted", {
            by: {
              id: sender._id,
              username: sender.username,
              fullName: sender.fullName,
              avatar: sender.avatar,
            },
          });

        return res.json({
          success: true,
          message: "Friend request accepted",
        });
      }

      if (action === "decline") {
        // find pending request from friendId → userId
        const requestIndex = sender.friendRequests.findIndex(
          (req) => req.from.toString() === friendId && req.status === "pending"
        );

        if (requestIndex === -1) {
          return res.status(400).json({
            success: false,
            message: "No pending friend request found",
          });
        }

        // mark as rejected
        sender.friendRequests[requestIndex].status = "rejected";
        await sender.save();

        // notify sender of decline
        req.app
          .get("io")
          ?.to(`user:${friendId}`)
          .emit("friend-request-declined", {
            by: {
              id: sender._id,
              username: sender.username,
              fullName: sender.fullName,
              avatar: sender.avatar,
            },
          });

        return res.json({
          success: true,
          message: "Friend request declined",
        });
      }
    } catch (error) {
      console.error("Friend request error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   GET /api/friends/requests
// @desc    Get pending friend requests
// @access  Private
router.get("/requests", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate("friendRequests.from", "username fullName avatar rating")
      .select("friendRequests");

    const pendingRequests = user.friendRequests.filter(
      (request) => request.status === "pending"
    );

    res.json({
      success: true,
      data: { requests: pendingRequests },
    });
  } catch (error) {
    console.error("Get friend requests error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/friends/respond
// @desc    Respond to friend request
// @access  Private
router.post(
  "/respond",
  [
    auth,
    body("requestId").isMongoId(),
    body("action").isIn(["accept", "decline"]),
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

      const { requestId, action } = req.body;

      const user = await User.findById(req.user._id);
      const request = user.friendRequests.id(requestId);

      if (!request || request.status !== "pending") {
        return res.status(404).json({
          success: false,
          message: "Friend request not found",
        });
      }

      const fromUser = await User.findById(request.from);
      if (!fromUser) {
        return res.status(404).json({
          success: false,
          message: "Requesting user not found",
        });
      }

      if (action === "accept") {
        // Add each other as friends
        user.friends.push(request.from);
        fromUser.friends.push(req.user._id);

        request.status = "accepted";

        await user.save();
        await fromUser.save();

        // Emit real-time notification to requester
        req.app
          .get("io")
          ?.to(`user:${request.from.toString()}`)
          .emit("friend-request-accepted", {
            user: {
              id: req.user._id,
              username: req.user.username,
              fullName: req.user.fullName,
              avatar: req.user.avatar,
            },
            requestId: request._id.toString(),
          });

        // Emit update to receiver to remove from their notification list
        req.app
          .get("io")
          ?.to(`user:${req.user._id.toString()}`)
          .emit("friend-request-update", {
            requestId: request._id.toString(),
            status: "accepted",
            from: {
              id: request.from.toString(),
            },
          });

        res.json({
          success: true,
          message: "Friend request accepted",
        });
      } else {
        request.status = "declined";
        await user.save();

        // Emit real-time notification to requester
        req.app
          .get("io")
          ?.to(`user:${request.from.toString()}`)
          .emit("friend-request-declined", {
            by: {
              id: req.user._id,
              username: req.user.username,
              fullName: req.user.fullName,
              avatar: req.user.avatar,
            },
            requestId: request._id.toString(),
          });

        // Emit update to receiver to remove from their notification list
        req.app
          .get("io")
          ?.to(`user:${req.user._id.toString()}`)
          .emit("friend-request-update", {
            requestId: request._id.toString(),
            status: "declined",
            from: {
              id: request.from.toString(),
            },
          });

        res.json({
          success: true,
          message: "Friend request declined",
        });
      }
    } catch (error) {
      console.error("Respond to friend request error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   DELETE /api/friends/:friendId
// @desc    Remove friend
// @access  Private
router.delete("/:friendId", auth, async (req, res) => {
  try {
    const { friendId } = req.params;

    const friendIds = (req.user.friends || []).map((id) => id.toString());
    if (!friendIds.includes(friendId)) {
      return res.status(400).json({
        success: false,
        message: "User is not in your friends list",
      });
    }

    const friend = await User.findById(friendId);
    if (!friend) {
      return res.status(404).json({
        success: false,
        message: "Friend not found",
      });
    }

    // Remove from both users' friends lists
    req.user.friends.pull(friendId);
    friend.friends.pull(req.user._id);

    await req.user.save();
    await friend.save();

    req.app
      .get("io")
      ?.to(`user:${friendId}`)
      .emit("friend-removed", { removedBy: req.user._id.toString() });

    res.json({
      success: true,
      message: "Friend removed successfully",
    });
  } catch (error) {
    console.error("Remove friend error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/friends/invite-game
// @desc    Invite friend to play a game
// @access  Private
router.post(
  "/invite-game",
  [
    auth,
    body("friendId").isMongoId(),
    body("gameType").optional().isIn(["blitz", "rapid", "classical"]),
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

      const { friendId, gameType = "rapid", timeControl, matchType } = req.body;
      const normalizedMatchType =
        matchType === "unrated" || matchType === "casual" ? "unrated" : "rated";

      if (!req.user.friends.includes(friendId)) {
        return res.status(400).json({
          success: false,
          message: "User is not in your friends list",
        });
      }

      const friend = await User.findById(friendId);
      if (!friend) {
        return res.status(404).json({
          success: false,
          message: "Friend not found",
        });
      }

      if (friend.status === "in-game") {
        return res.status(400).json({
          success: false,
          message: "Friend is currently in a game",
        });
      }

      // Create game invitation
      const invitation = {
        id: Math.random().toString(36).substr(2, 9),
        from: req.user._id,
        to: friendId,
        gameType,
        matchType: normalizedMatchType,
        timeControl: timeControl || { initial: 600000, increment: 0 },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
      };

      // Emit real-time invitation (room name must match register-user: user:${userId})
      req.app
        .get("io")
        .to(`user:${friendId}`)
        .emit("game-invitation", {
          invitation: {
            ...invitation,
            from: {
              id: req.user._id,
              username: req.user.username,
              fullName: req.user.fullName,
              avatar: req.user.avatar,
              rating: req.user.rating,
            },
          },
        });

      res.json({
        success: true,
        message: "Game invitation sent",
        data: { invitation },
      });
    } catch (error) {
      console.error("Invite game error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   GET /api/friends/online
// @desc    Get online friends
// @access  Private
router.get("/online", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate({
        path: "friends",
        match: { status: { $in: ["online", "in-game"] } },
        select: "username fullName avatar status rating lastActive",
      })
      .select("friends");

    res.json({
      success: true,
      data: { onlineFriends: user.friends },
    });
  } catch (error) {
    console.error("Get online friends error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

router.get("/search", auth, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Search query is required",
      });
    }

    const currentUserId = req.user._id;
    const searchQuery = query.trim();

    // Build search conditions - search in username, email, and fullName
    const searchConditions = {
      $or: [
        { username: { $regex: searchQuery, $options: "i" } },
        { email: { $regex: searchQuery, $options: "i" } },
        { fullName: { $regex: searchQuery, $options: "i" } },
      ],
      _id: { $ne: currentUserId }, // Exclude current user
    };

    // Find users matching the search
    const users = await User.find(searchConditions)
      .select("username fullName email avatar rating status country friendRequests")
      .limit(20) // Limit results
      .lean(); // Use lean() for better performance

    // Get current user's friends list to mark which users are already friends
    const currentUser = await User.findById(currentUserId).select("friends");
    const friendIds = currentUser?.friends?.map((id) => id.toString()) || [];

    // Get current user's pending friend requests
    const currentUserWithRequests = await User.findById(currentUserId)
      .select("friendRequests")
      .lean();
    const pendingRequestFromIds =
      currentUserWithRequests?.friendRequests
        ?.filter((req) => req.status === "pending")
        .map((req) => req.from.toString()) || [];

    // Format users with friend status
    const formattedUsers = users.map((user) => {
      const userId = user._id.toString();
      const isFriend = friendIds.includes(userId);
      const hasPendingRequest = pendingRequestFromIds.includes(userId);
      // Outgoing request: current user already sent request to this searched user.
      const requestSent =
        Array.isArray(user.friendRequests) &&
        user.friendRequests.some(
          (req) =>
            req?.status === "pending" &&
            req?.from?.toString() === currentUserId.toString()
        );

      return {
        id: user._id,
        _id: user._id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        avatar: user.avatar,
        rating: user.rating,
        status: user.status,
        isFriend,
        requestSent,
        hasPendingRequest,
      };
    });

    return res.json({
      success: true,
      data: { users: formattedUsers },
    });
  } catch (err) {
    console.error("Search API Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

module.exports = router;
