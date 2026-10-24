const express = require("express");
const mongoose = require("mongoose");
const { body, validationResult } = require("express-validator");
const multer = require("multer");
const User = require("../models/User");
const News = require("../models/News");
const Stats = require("../models/Stats");
const Game = require("../models/Game");
const DailyPuzzleUserProgress = require("../models/DailyPuzzleUserProgress");
const PuzzleAttempt = require("../models/PuzzleAttempt");
const PuzzleRushRun = require("../models/PuzzleRushRun");
const PuzzleWarsMatch = require("../models/PuzzleWarsMatch");
const { todayDateKey } = require("../utils/daily-puzzle-dates");
const MessengerConversation = require("../models/MessengerConversation");
const MessengerMessage = require("../models/MessengerMessage");
const AdminMessageAccessLog = require("../models/AdminMessageAccessLog");
const auth = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");
const {
  uploadImage,
  deleteImage,
  extractPublicId,
} = require("../utils/cloudinary");
const { decrypt } = require("../utils/messageCrypto");
const { formatMemberSince } = require("../utils/userProjections");

/** Matches socket presence: users marked online or in an active game. */
const ACTIVE_USER_STATUSES = ["online", "in-game"];

const PLATFORM_KEYS = ["web", "ios", "android", "unknown"];

/** Prefer signupPlatform; else last FCM device platform; else unknown. */
function resolveUserPlatform(user) {
  const signed = String(user?.signupPlatform || "")
    .toLowerCase()
    .trim();
  if (signed === "web" || signed === "ios" || signed === "android") {
    return { platform: signed, platformSource: "signup" };
  }
  const tokens = Array.isArray(user?.fcmTokens) ? user.fcmTokens : [];
  if (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    const p = String(last?.platform || "")
      .toLowerCase()
      .trim();
    if (p === "web" || p === "ios" || p === "android") {
      return { platform: p, platformSource: "device" };
    }
  }
  return { platform: "unknown", platformSource: null };
}

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = allowedTypes.test(file.mimetype);
    const extname = allowedTypes.test(file.originalname.toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files (jpeg, jpg, png, gif, webp) are allowed"));
  },
});

const router = express.Router();

// All admin routes require authentication and admin role
router.use(auth);
router.use(isAdmin);

// ========== USER MANAGEMENT ==========

// @route   GET /api/admin/users
// @desc    Get all users with pagination
// @access  Private (Admin only)
router.get("/users", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search || "";
    const onlineOnly =
      req.query.onlineOnly === "true" || req.query.onlineOnly === "1";

    // Build query
    const query = {};
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { fullName: { $regex: search, $options: "i" } },
      ];
    }

    // Exclude deleted accounts by default
    if (!req.query.includeDeleted) {
      query.isDeleted = false;
    }

    if (onlineOnly) {
      query.status = { $in: ACTIVE_USER_STATUSES };
    }

    const baseCountQuery = { ...query };
    delete baseCountQuery.status;

    const users = await User.find(query)
      .select(
        "username email fullName avatar status role ratings createdAt isSuspended signupPlatform fcmTokens"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const [total, totalUsers, onlineCount, platformDocs] = await Promise.all([
      User.countDocuments(query),
      User.countDocuments(baseCountQuery),
      User.countDocuments({
        ...baseCountQuery,
        status: { $in: ACTIVE_USER_STATUSES },
      }),
      // Lightweight scan for engagement mix (signup → FCM fallback). Caps memory vs full user dump.
      User.find(baseCountQuery)
        .select("signupPlatform fcmTokens")
        .lean(),
    ]);

    const platformBreakdown = {
      web: 0,
      ios: 0,
      android: 0,
      unknown: 0,
    };
    for (const doc of platformDocs) {
      const { platform } = resolveUserPlatform(doc);
      if (PLATFORM_KEYS.includes(platform)) {
        platformBreakdown[platform] += 1;
      } else {
        platformBreakdown.unknown += 1;
      }
    }

    const userIds = users.map((user) => user._id);
    const today = todayDateKey();

    const [statsDocs, dailySolvedTodayDocs, normalSolvedCounts] =
      await Promise.all([
        Stats.find({ user: { $in: userIds } }).lean(),
        DailyPuzzleUserProgress.find({
          user: { $in: userIds },
          dateKey: today,
          solved: true,
        })
          .select("user")
          .lean(),
        PuzzleAttempt.aggregate([
          { $match: { user: { $in: userIds }, solved: true } },
          { $group: { _id: "$user", count: { $sum: 1 } } },
        ]),
      ]);

    const statsByUserId = new Map(
      statsDocs.map((doc) => [String(doc.user), doc])
    );
    const dailySolvedTodaySet = new Set(
      dailySolvedTodayDocs.map((doc) => String(doc.user))
    );
    const normalSolvedByUserId = new Map(
      normalSolvedCounts.map((row) => [String(row._id), row.count])
    );

    const usersWithStats = users.map((user) => {
      const userId = String(user._id);
      const stats = statsByUserId.get(userId);
      const memberSince = formatMemberSince(user.createdAt);
      const isOnline = ACTIVE_USER_STATUSES.includes(user.status);
      const { platform, platformSource } = resolveUserPlatform(user);
      const { fcmTokens: _omitTokens, ...safeUser } = user;
      return {
        ...safeUser,
        ...(memberSince ? { memberSince } : {}),
        isOnline,
        signupPlatform: user.signupPlatform || "unknown",
        platform,
        platformSource,
        stats: stats || {
          wins: { total: 0 },
          gamesPlayed: { total: 0 },
          losses: { total: 0 },
          draws: { total: 0 },
        },
        dailyPuzzleSolvedToday: dailySolvedTodaySet.has(userId),
        normalPuzzlesSolvedCount: normalSolvedByUserId.get(userId) ?? 0,
      };
    });

    res.json({
      success: true,
      data: {
        users: usersWithStats,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
        summary: {
          totalUsers,
          onlineCount,
          platformBreakdown,
        },
      },
    });
  } catch (error) {
    console.error("[Admin] Error fetching users:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
    });
  }
});

// @route   GET /api/admin/users/:userId
// @desc    Get single user details
// @access  Private (Admin only)
router.get("/users/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select("-password")
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const stats = await Stats.findOne({ user: user._id }).lean();

    res.json({
      success: true,
      data: {
        user: {
          ...user,
          stats: stats || null,
        },
      },
    });
  } catch (error) {
    console.error("[Admin] Error fetching user:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch user",
    });
  }
});

// @route   PATCH /api/admin/users/:userId
// @desc    Update user (suspend, change role, etc.)
// @access  Private (Admin only)
router.patch(
  "/users/:userId",
  [
    body("role").optional().isIn(["USER", "ADMIN"]),
    body("status").optional().isIn(["online", "offline", "in-game"]),
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

      const { role, status } = req.body;
      const updateData = {};

      if (role !== undefined) updateData.role = role;
      if (status !== undefined) updateData.status = status;

      const user = await User.findByIdAndUpdate(
        req.params.userId,
        updateData,
        { new: true, runValidators: true }
      ).select("-password");

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      res.json({
        success: true,
        message: "User updated successfully",
        data: { user },
      });
    } catch (error) {
      console.error("[Admin] Error updating user:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update user",
      });
    }
  }
);

// @route   POST /api/admin/users/:userId/reset-password
// @desc    Reset user password (Admin only)
// @access  Private (Admin only)
router.post(
  "/users/:userId/reset-password",
  [
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters long"),
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

      const { newPassword } = req.body;
      const user = await User.findById(req.params.userId);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Prevent resetting password for social auth users (they don't have passwords)
      if (user.provider) {
        return res.status(400).json({
          success: false,
          message: "Cannot reset password for social authentication users",
        });
      }

      // Update password (will be hashed by pre-save hook)
      user.password = newPassword;
      await user.save();

      console.log(`[Admin] Password reset for user ${user.username} (${user._id}) by admin ${req.user.username}`);

      res.json({
        success: true,
        message: "Password updated successfully",
      });
    } catch (error) {
      console.error("[Admin] Error resetting password:", error);
      res.status(500).json({
        success: false,
        message: "Failed to reset password",
      });
    }
  }
);

// @route   POST /api/admin/users/:userId/toggle-status
// @desc    Toggle user suspension status
// @access  Private (Admin only)
router.post("/users/:userId/toggle-status", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Prevent suspending admins
    if (user.role === "ADMIN" && !user.isSuspended) {
      return res.status(400).json({
        success: false,
        message: "Cannot suspend an admin user",
      });
    }

    // Toggle suspension status
    user.isSuspended = !user.isSuspended;
    
    // If suspending, also set status to offline
    if (user.isSuspended) {
      user.status = "offline";
    }

    await user.save();

    // Emit Socket.io event to disconnect user if they're online
    const io = req.app.get("io");
    if (io && user.isSuspended) {
      // Emit to user's room
      io.to(`user:${user._id.toString()}`).emit("ACCOUNT_SUSPENDED", {
        message: "Your account has been suspended by an administrator",
      });
      
      // Disconnect all sockets for this user
      const sockets = await io.in(`user:${user._id.toString()}`).fetchSockets();
      sockets.forEach((socket) => {
        socket.emit("ACCOUNT_SUSPENDED", {
          message: "Your account has been suspended by an administrator",
        });
        socket.disconnect(true);
      });
    }

    res.json({
      success: true,
      message: user.isSuspended ? "User suspended successfully" : "User activated successfully",
      data: {
        user: {
          _id: user._id,
          username: user.username,
          email: user.email,
          isSuspended: user.isSuspended,
          status: user.status,
        },
      },
    });
  } catch (error) {
    console.error("[Admin] Error toggling user status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to toggle user status",
    });
  }
});

// ========== NEWS MANAGEMENT ==========

// @route   GET /api/admin/news
// @desc    Get all news articles
// @access  Private (Admin only)
router.get("/news", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const news = await News.find()
      .populate("createdBy", "username fullName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await News.countDocuments();

    res.json({
      success: true,
      data: {
        news,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error("[Admin] Error fetching news:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch news",
    });
  }
});

// @route   POST /api/admin/news
// @desc    Create news article
// @access  Private (Admin only)
router.post(
  "/news",
  [
    body("title").trim().isLength({ min: 1, max: 200 }),
    body("description").trim().isLength({ min: 1, max: 2000 }),
    body("imageUrl").optional().isURL(),
    body("published").optional().isBoolean(),
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

      const { title, description, imageUrl, published } = req.body;

      const news = new News({
        title,
        description,
        imageUrl: imageUrl || null,
        published: published || false,
        publishedAt: published ? new Date() : null,
        createdBy: req.user._id,
      });

      await news.save();
      await news.populate("createdBy", "username fullName");

      res.status(201).json({
        success: true,
        message: "News article created successfully",
        data: { news },
      });
    } catch (error) {
      console.error("[Admin] Error creating news:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create news article",
      });
    }
  }
);

// @route   PATCH /api/admin/news/:newsId
// @desc    Update news article
// @access  Private (Admin only)
router.patch(
  "/news/:newsId",
  [
    body("title").optional().trim().isLength({ min: 1, max: 200 }),
    body("description").optional().trim().isLength({ min: 1, max: 2000 }),
    body("imageUrl").optional().isURL(),
    body("published").optional().isBoolean(),
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

      const { title, description, imageUrl, published } = req.body;
      const updateData = {};

      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
      if (published !== undefined) {
        updateData.published = published;
        if (published && !updateData.publishedAt) {
          updateData.publishedAt = new Date();
        }
      }

      const news = await News.findByIdAndUpdate(
        req.params.newsId,
        updateData,
        { new: true, runValidators: true }
      ).populate("createdBy", "username fullName");

      if (!news) {
        return res.status(404).json({
          success: false,
          message: "News article not found",
        });
      }

      res.json({
        success: true,
        message: "News article updated successfully",
        data: { news },
      });
    } catch (error) {
      console.error("[Admin] Error updating news:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update news article",
      });
    }
  }
);

// @route   DELETE /api/admin/news/:newsId
// @desc    Delete news article
// @access  Private (Admin only)
router.delete("/news/:newsId", async (req, res) => {
  try {
    const news = await News.findByIdAndDelete(req.params.newsId);

    if (!news) {
      return res.status(404).json({
        success: false,
        message: "News article not found",
      });
    }

    res.json({
      success: true,
      message: "News article deleted successfully",
    });
  } catch (error) {
    console.error("[Admin] Error deleting news:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete news article",
    });
  }
});

// ========== BADGE MANAGEMENT (DEPRECATED) ==========
// Legacy admin Badge CRUD retired — achievements are code-catalog based.
// See constants/achievementsCatalog.js + /api/achievements/me
const badgesDeprecated = (_req, res) => {
  res.status(410).json({
    success: false,
    message:
      "Admin badge CRUD is deprecated. Achievements are defined in the code catalog.",
  });
};

router.get("/badges", badgesDeprecated);
router.post("/badges", badgesDeprecated);
router.patch("/badges/:badgeId", badgesDeprecated);
router.post("/badges/:badgeId/image", badgesDeprecated);
router.delete("/badges/:badgeId", badgesDeprecated);

// ========== MESSENGER INVESTIGATION ==========
// Privacy Policy §11: admins may access message content to investigate abuse,
// safety, or legal matters. Every fetch is logged in AdminMessageAccessLog
// (admin id, conversation id, reason, IP, UA, message count, timestamp).

/**
 * @route GET /api/admin/messenger/conversations
 *
 * List conversations newest-first. Optional `search` filters by either
 * participant's username/fullName/email. Pagination: ?page=&limit=.
 */
router.get("/messenger/conversations", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      100
    );
    const skip = (page - 1) * limit;
    const search = (req.query.search || "").toString().trim();

    let participantFilter = null;
    if (search) {
      const regex = new RegExp(
        search.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
        "i"
      );
      const matchedUsers = await User.find({
        $or: [{ username: regex }, { fullName: regex }, { email: regex }],
      })
        .select("_id")
        .lean();
      const ids = matchedUsers.map((u) => u._id);
      participantFilter = ids.length
        ? { $or: [{ userA: { $in: ids } }, { userB: { $in: ids } }] }
        : { _id: { $exists: false } }; // no matches → empty result
    }

    const baseFilter = {
      lastMessageAt: { $ne: null },
      ...(participantFilter || {}),
    };

    const [total, conversations] = await Promise.all([
      MessengerConversation.countDocuments(baseFilter),
      MessengerConversation.find(baseFilter)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userA", "username fullName avatar email")
        .populate("userB", "username fullName avatar email")
        .lean(),
    ]);

    const ids = conversations.map((c) => c._id);
    // Get total + deleted counts in a single aggregation so the admin row
    // can show, e.g. "42 messages · 3 deleted".
    const counts = ids.length
      ? await MessengerMessage.aggregate([
          { $match: { conversation: { $in: ids } } },
          {
            $group: {
              _id: "$conversation",
              total: { $sum: 1 },
              deleted: {
                $sum: {
                  $cond: [{ $ifNull: ["$deletedAt", false] }, 1, 0],
                },
              },
            },
          },
        ])
      : [];
    const countMap = new Map(
      counts.map((c) => [c._id.toString(), { total: c.total, deleted: c.deleted }])
    );

    const rows = conversations.map((c) => {
      const counts = countMap.get(c._id.toString()) || { total: 0, deleted: 0 };
      return {
        conversationId: c._id.toString(),
        participants: [c.userA, c.userB]
          .filter(Boolean)
          .map((u) => ({
            id: u._id.toString(),
            username: u.username,
            fullName: u.fullName || "",
            avatar: u.avatar || "",
            email: u.email || "",
          })),
        lastMessageAt: c.lastMessageAt
          ? new Date(c.lastMessageAt).toISOString()
          : null,
        lastMessagePreview: decrypt(c.lastMessageSnippet || "") || "",
        lastMessageSenderId: c.lastMessageSenderId
          ? c.lastMessageSenderId.toString()
          : null,
        messageCount: counts.total,
        deletedMessageCount: counts.deleted,
        createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
      };
    });

    return res.json({
      success: true,
      data: {
        conversations: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(Math.ceil(total / limit), 1),
        },
      },
    });
  } catch (error) {
    console.error("[Admin] messenger conversations error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load conversations" });
  }
});

/**
 * @route GET /api/admin/messenger/conversations/:conversationId/messages
 *
 * Returns the full plaintext thread for a conversation (decrypted on read).
 * Writes one audit row per call. Accepts an optional `reason` query string
 * (≤500 chars) which is recorded with the audit entry.
 */
router.get(
  "/messenger/conversations/:conversationId/messages",
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid conversation id" });
      }

      const conv = await MessengerConversation.findById(conversationId)
        .populate("userA", "username fullName avatar email")
        .populate("userB", "username fullName avatar email")
        .lean();
      if (!conv) {
        return res
          .status(404)
          .json({ success: false, message: "Conversation not found" });
      }

      const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 500, 1),
        2000
      );

      // Investigation reads everything, including soft-deleted rows.
      const raw = await MessengerMessage.find({ conversation: conv._id })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();

      const messages = raw.map((m) => ({
        id: m._id.toString(),
        senderId: m.sender.toString(),
        body: decrypt(m.body || ""),
        createdAt: new Date(m.createdAt).toISOString(),
        deletedAt: m.deletedAt ? new Date(m.deletedAt).toISOString() : null,
        deletedBy: m.deletedBy ? m.deletedBy.toString() : null,
      }));

      // Audit log — privacy-policy mandated.
      try {
        const reason = (req.query.reason || "").toString().slice(0, 500);
        const ip =
          (req.headers["x-forwarded-for"] || "")
            .toString()
            .split(",")[0]
            .trim() ||
          req.ip ||
          "";
        const userAgent = (req.headers["user-agent"] || "")
          .toString()
          .slice(0, 500);
        await AdminMessageAccessLog.create({
          admin: req.user._id,
          conversation: conv._id,
          participants: [conv.userA?._id, conv.userB?._id].filter(Boolean),
          reason,
          messagesReturned: messages.length,
          ip,
          userAgent,
        });
      } catch (logErr) {
        console.error("[Admin] failed to write access log:", logErr);
      }

      const participantPayload = [conv.userA, conv.userB]
        .filter(Boolean)
        .map((u) => ({
          id: u._id.toString(),
          username: u.username,
          fullName: u.fullName || "",
          avatar: u.avatar || "",
          email: u.email || "",
        }));

      return res.json({
        success: true,
        data: {
          conversation: {
            conversationId: conv._id.toString(),
            participants: participantPayload,
            createdAt: conv.createdAt
              ? new Date(conv.createdAt).toISOString()
              : null,
            lastMessageAt: conv.lastMessageAt
              ? new Date(conv.lastMessageAt).toISOString()
              : null,
          },
          messages,
        },
      });
    } catch (error) {
      console.error("[Admin] messenger messages error:", error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to load messages" });
    }
  }
);

// ========== DASHBOARD METRICS (read-only; does not touch sockets / gameplay) ==========

function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfUtcMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthKey(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

function fillMonths(fromDate, toDate, countsByKey) {
  const out = [];
  const cur = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1)
  );
  const end = new Date(
    Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1)
  );
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth() + 1;
    const key = monthKey(y, m);
    out.push({
      key,
      label: cur.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
      count: countsByKey.get(key) || 0,
    });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

function fillDays(fromDate, toDate, countsByKey) {
  const out = [];
  const cur = new Date(fromDate.getTime());
  while (cur <= toDate) {
    const key = cur.toISOString().slice(0, 10);
    out.push({
      key,
      label: cur.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      count: countsByKey.get(key) || 0,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// @route   GET /api/admin/metrics
// @desc    CMS overview: registrations over time, platforms, activity counts
// @access  Private (Admin only)
router.get("/metrics", async (req, res) => {
  try {
    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

    const weekStart = new Date(todayStart);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);

    const thisMonthStart = startOfUtcMonth(now);
    const lastMonthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    );
    const nextMonthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    );

    const monthsBackStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
    );
    const daysBackStart = new Date(todayStart);
    daysBackStart.setUTCDate(daysBackStart.getUTCDate() - 29);

    const activeUsersQuery = { isDeleted: false };

    const [
      totalUsers,
      onlineCount,
      suspendedCount,
      adminCount,
      registeredToday,
      registeredThisWeek,
      registeredThisMonth,
      registeredLastMonth,
      monthAgg,
      dayAgg,
      platformDocs,
      gamesToday,
      gamesThisMonth,
      puzzlesToday,
      rushThisMonth,
      warsThisMonth,
      recentUsers,
    ] = await Promise.all([
      User.countDocuments(activeUsersQuery),
      User.countDocuments({
        ...activeUsersQuery,
        status: { $in: ACTIVE_USER_STATUSES },
      }),
      User.countDocuments({ ...activeUsersQuery, isSuspended: true }),
      User.countDocuments({ ...activeUsersQuery, role: "ADMIN" }),
      User.countDocuments({
        ...activeUsersQuery,
        createdAt: { $gte: todayStart, $lt: tomorrowStart },
      }),
      User.countDocuments({
        ...activeUsersQuery,
        createdAt: { $gte: weekStart },
      }),
      User.countDocuments({
        ...activeUsersQuery,
        createdAt: { $gte: thisMonthStart, $lt: nextMonthStart },
      }),
      User.countDocuments({
        ...activeUsersQuery,
        createdAt: { $gte: lastMonthStart, $lt: thisMonthStart },
      }),
      User.aggregate([
        {
          $match: {
            isDeleted: false,
            createdAt: { $gte: monthsBackStart },
          },
        },
        {
          $group: {
            _id: {
              y: { $year: "$createdAt" },
              m: { $month: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.y": 1, "_id.m": 1 } },
      ]),
      User.aggregate([
        {
          $match: {
            isDeleted: false,
            createdAt: { $gte: daysBackStart },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.find(activeUsersQuery).select("signupPlatform fcmTokens").lean(),
      Game.countDocuments({
        createdAt: { $gte: todayStart, $lt: tomorrowStart },
      }),
      Game.countDocuments({
        createdAt: { $gte: thisMonthStart, $lt: nextMonthStart },
      }),
      PuzzleAttempt.countDocuments({
        createdAt: { $gte: todayStart, $lt: tomorrowStart },
      }),
      PuzzleRushRun.countDocuments({
        createdAt: { $gte: thisMonthStart, $lt: nextMonthStart },
      }),
      PuzzleWarsMatch.countDocuments({
        createdAt: { $gte: thisMonthStart, $lt: nextMonthStart },
      }),
      User.find(activeUsersQuery)
        .select("username email avatar createdAt signupPlatform fcmTokens status")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
    ]);

    const monthMap = new Map();
    for (const row of monthAgg) {
      monthMap.set(monthKey(row._id.y, row._id.m), row.count);
    }
    const dayMap = new Map();
    for (const row of dayAgg) {
      dayMap.set(row._id, row.count);
    }

    const platformBreakdown = {
      web: 0,
      ios: 0,
      android: 0,
      unknown: 0,
    };
    for (const doc of platformDocs) {
      const { platform } = resolveUserPlatform(doc);
      if (PLATFORM_KEYS.includes(platform)) {
        platformBreakdown[platform] += 1;
      } else {
        platformBreakdown.unknown += 1;
      }
    }

    const monthDelta =
      registeredLastMonth > 0
        ? Math.round(
            ((registeredThisMonth - registeredLastMonth) / registeredLastMonth) *
              100
          )
        : registeredThisMonth > 0
          ? 100
          : 0;

    res.json({
      success: true,
      data: {
        totals: {
          users: totalUsers,
          online: onlineCount,
          suspended: suspendedCount,
          admins: adminCount,
        },
        registrations: {
          today: registeredToday,
          last7Days: registeredThisWeek,
          thisMonth: registeredThisMonth,
          lastMonth: registeredLastMonth,
          monthDeltaPct: monthDelta,
        },
        activity: {
          gamesToday,
          gamesThisMonth,
          puzzleAttemptsToday: puzzlesToday,
          rushRunsThisMonth: rushThisMonth,
          warsMatchesThisMonth: warsThisMonth,
        },
        platformBreakdown,
        charts: {
          registrationsByMonth: fillMonths(monthsBackStart, now, monthMap),
          registrationsByDay: fillDays(daysBackStart, todayStart, dayMap),
        },
        recentUsers: recentUsers.map((u) => {
          const { platform, platformSource } = resolveUserPlatform(u);
          return {
            _id: u._id,
            username: u.username,
            email: u.email,
            avatar: u.avatar,
            createdAt: u.createdAt,
            status: u.status,
            platform,
            platformSource,
          };
        }),
      },
    });
  } catch (error) {
    console.error("[Admin] metrics error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load admin metrics",
    });
  }
});

module.exports = router;

