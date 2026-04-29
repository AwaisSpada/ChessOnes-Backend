const express = require("express");
const { body, validationResult } = require("express-validator");
const multer = require("multer");
const User = require("../models/User");
const News = require("../models/News");
const Badge = require("../models/Badge");
const Stats = require("../models/Stats");
const auth = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");
const {
  uploadImage,
  deleteImage,
  extractPublicId,
} = require("../utils/cloudinary");

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

    const users = await User.find(query)
      .select("-password")
      .select("username email fullName avatar status role ratings badges createdAt isSuspended")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await User.countDocuments(query);

    // Get stats for each user
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const stats = await Stats.findOne({ user: user._id }).lean();
        return {
          ...user,
          stats: stats || {
            wins: { total: 0 },
            gamesPlayed: { total: 0 },
          },
        };
      })
    );

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
      .populate("badges.badgeId", "name description imageUrl")
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

// ========== BADGE MANAGEMENT ==========

// @route   GET /api/admin/badges
// @desc    Get all badges
// @access  Private (Admin only)
router.get("/badges", async (req, res) => {
  try {
    const badges = await Badge.find().sort({ createdAt: -1 }).lean();

    // Get count of users who have each badge
    const badgesWithCounts = await Promise.all(
      badges.map(async (badge) => {
        const count = await User.countDocuments({
          "badges.badgeId": badge._id,
        });
        return {
          ...badge,
          usersCount: count,
        };
      })
    );

    res.json({
      success: true,
      data: { badges: badgesWithCounts },
    });
  } catch (error) {
    console.error("[Admin] Error fetching badges:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch badges",
    });
  }
});

// @route   POST /api/admin/badges
// @desc    Create badge
// @access  Private (Admin only)
router.post(
  "/badges",
  [
    body("name").trim().isLength({ min: 1, max: 100 }),
    body("description").trim().isLength({ min: 1, max: 500 }),
    body("imageUrl").optional().custom((value) => {
      if (!value || value === "") return true; // Allow empty string
      // If provided, must be a valid URL
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }).withMessage("imageUrl must be a valid URL or empty"),
    body("key").optional().trim(),
    body("badgeCategory").optional().isIn(["STATISTIC", "GAME_EVENT", "OPENING"]),
    body("logicConfig").optional().isObject(),
    body("criteria").optional().notEmpty(),
    body("targetValue").optional().isNumeric().withMessage("Target value must be a number"),
    body("condition").optional().isIn(["gte", "exact"]),
    body("autoAward").optional().isBoolean(),
    body("category").optional().isIn(["wins", "streak", "rating", "games", "botWins", "highestRating", "winStreak", "totalGames", "bulletWins", "blitzWins", "rapidWins", "bulletRating", "blitzRating", "rapidRating", "bulletGames", "blitzGames", "rapidGames", "custom"]),
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

      const { name, description, imageUrl, key, badgeCategory, logicConfig, criteria, targetValue, condition, autoAward, category } = req.body;

      const badge = new Badge({
        name,
        description,
        imageUrl: imageUrl && imageUrl.trim() !== "" ? imageUrl : null,
        key: key || null,
        badgeCategory: badgeCategory || "STATISTIC",
        logicConfig: logicConfig || {},
        criteria: criteria || {},
        targetValue: targetValue || 0,
        condition: condition || "gte",
        autoAward: autoAward !== undefined ? autoAward : false,
        category: category || "custom",
      });

      await badge.save();

      res.status(201).json({
        success: true,
        message: "Badge created successfully",
        data: { badge },
      });
    } catch (error) {
      console.error("[Admin] Error creating badge:", error);
      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: "Badge with this name already exists",
        });
      }
      res.status(500).json({
        success: false,
        message: "Failed to create badge",
      });
    }
  }
);

// @route   PATCH /api/admin/badges/:badgeId
// @desc    Update badge
// @access  Private (Admin only)
router.patch(
  "/badges/:badgeId",
  [
    body("name").optional().trim().isLength({ min: 1, max: 100 }),
    body("description").optional().trim().isLength({ min: 1, max: 500 }),
    body("imageUrl").optional().custom((value) => {
      if (!value || value === "") return true; // Allow empty string
      // If provided, must be a valid URL
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }).withMessage("imageUrl must be a valid URL or empty"),
    body("key").optional().trim(),
    body("badgeCategory").optional().isIn(["STATISTIC", "GAME_EVENT", "OPENING"]),
    body("logicConfig").optional().isObject(),
    body("criteria").optional().notEmpty(),
    body("targetValue").optional().isNumeric().withMessage("Target value must be a number"),
    body("condition").optional().isIn(["gte", "exact"]),
    body("autoAward").optional().isBoolean(),
    body("category").optional().isIn(["wins", "streak", "rating", "games", "botWins", "highestRating", "winStreak", "totalGames", "bulletWins", "blitzWins", "rapidWins", "bulletRating", "blitzRating", "rapidRating", "bulletGames", "blitzGames", "rapidGames", "custom"]),
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

      const updateData = {};
      const { name, description, imageUrl, key, badgeCategory, logicConfig, criteria, targetValue, condition, autoAward, category } = req.body;

      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (key !== undefined) updateData.key = key;
      if (badgeCategory !== undefined) updateData.badgeCategory = badgeCategory;
      if (logicConfig !== undefined) updateData.logicConfig = logicConfig;
      if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
      if (criteria !== undefined) updateData.criteria = criteria;
      if (targetValue !== undefined) updateData.targetValue = targetValue;
      if (condition !== undefined) updateData.condition = condition;
      if (autoAward !== undefined) updateData.autoAward = autoAward;
      if (category !== undefined) updateData.category = category;

      const badge = await Badge.findByIdAndUpdate(
        req.params.badgeId,
        updateData,
        { new: true, runValidators: true }
      );

      if (!badge) {
        return res.status(404).json({
          success: false,
          message: "Badge not found",
        });
      }

      res.json({
        success: true,
        message: "Badge updated successfully",
        data: { badge },
      });
    } catch (error) {
      console.error("[Admin] Error updating badge:", error);
      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: "Badge with this name already exists",
        });
      }
      res.status(500).json({
        success: false,
        message: "Failed to update badge",
      });
    }
  }
);

// @route   POST /api/admin/badges/:badgeId/image
// @desc    Upload badge image to Cloudinary
// @access  Private (Admin only)
router.post("/badges/:badgeId/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file provided",
      });
    }

    const badge = await Badge.findById(req.params.badgeId);
    if (!badge) {
      return res.status(404).json({
        success: false,
        message: "Badge not found",
      });
    }

    // Delete old image from Cloudinary if it exists
    if (badge.imageUrl) {
      try {
        const oldPublicId = extractPublicId(badge.imageUrl);
        if (oldPublicId) {
          await deleteImage(oldPublicId);
        }
      } catch (error) {
        console.error("[Admin] Error deleting old badge image:", error);
        // Continue even if deletion fails
      }
    }

    // Upload new image to Cloudinary
    const publicId = `badges/${badge._id}`;
    const uploadResult = await uploadImage(
      req.file.buffer,
      "badges",
      publicId
    );

    // Update badge image URL
    badge.imageUrl = uploadResult.secure_url;
    await badge.save();

    res.json({
      success: true,
      message: "Badge image uploaded successfully",
      data: {
        imageUrl: uploadResult.secure_url,
        badge: {
          _id: badge._id,
          imageUrl: badge.imageUrl,
        },
      },
    });
  } catch (error) {
    console.error("[Admin] Badge image upload error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to upload badge image",
    });
  }
});

// @route   DELETE /api/admin/badges/:badgeId
// @desc    Delete badge
// @access  Private (Admin only)
router.delete("/badges/:badgeId", async (req, res) => {
  try {
    const badge = await Badge.findByIdAndDelete(req.params.badgeId);

    if (!badge) {
      return res.status(404).json({
        success: false,
        message: "Badge not found",
      });
    }

    // Remove badge from all users
    await User.updateMany(
      { "badges.badgeId": badge._id },
      { $pull: { badges: { badgeId: badge._id } } }
    );

    res.json({
      success: true,
      message: "Badge deleted successfully",
    });
  } catch (error) {
    console.error("[Admin] Error deleting badge:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete badge",
    });
  }
});

module.exports = router;

