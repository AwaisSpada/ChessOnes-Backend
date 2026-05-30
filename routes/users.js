const express = require("express");
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const Stats = require("../models/Stats");
const auth = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const multer = require("multer");
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

const UserReport = require("../models/UserReport");
const { OTHER_USER_FIELDS, formatMemberSince } = require("../utils/userProjections");
const {
  isValidReportReason,
  getCategoryLabel,
  getReasonLabel,
} = require("../utils/report-reasons");
const { userHasBlocked } = require("../utils/user-blocks");
const {
  sendMail,
  getContactInboxEmail,
  buildUserReportEmail,
  CHESSONES_FROM_SUPPORT,
} = require("../utils/sendMail");

const router = express.Router();

// Up to 5 evidence images, each ≤5MB (multer.fileFilter inherited from `upload`)
const MAX_REPORT_EVIDENCE_IMAGES = 5;
const reportEvidenceUpload = upload.array(
  "evidenceImages",
  MAX_REPORT_EVIDENCE_IMAGES
);

// @route   POST /api/users/report
router.post(
  "/report",
  auth,
  (req, res, next) => {
    reportEvidenceUpload(req, res, (err) => {
      if (err) {
        const message =
          err && err.code === "LIMIT_FILE_SIZE"
            ? "Each evidence image must be 5MB or smaller"
            : err && err.code === "LIMIT_UNEXPECTED_FILE"
            ? `You can attach at most ${MAX_REPORT_EVIDENCE_IMAGES} evidence images`
            : err?.message || "Failed to read uploaded images";
        return res.status(400).json({ success: false, message });
      }
      next();
    });
  },
  [
    body("reportedUserId").isMongoId(),
    body("category").isIn(["abuse", "fair_play", "account_profile", "other"]),
    body("reasonId").isString().trim().notEmpty(),
    body("details").optional().isString().trim().isLength({ max: 2000 }),
  ],
  async (req, res) => {
    const uploadedPublicIds = [];
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Invalid report",
          errors: errors.array(),
        });
      }

      const { reportedUserId, category, reasonId, details } = req.body;
      if (reportedUserId === req.user._id.toString()) {
        return res.status(400).json({
          success: false,
          message: "You cannot report yourself",
        });
      }

      if (!isValidReportReason(reasonId, category)) {
        return res.status(400).json({
          success: false,
          message: "Invalid report reason for category",
        });
      }

      if (reasonId === "other" && !(details || "").trim()) {
        return res.status(400).json({
          success: false,
          message: "Please describe the issue",
        });
      }

      const [reporter, reported] = await Promise.all([
        User.findById(req.user._id).select("username fullName email"),
        User.findById(reportedUserId).select("username fullName email _id"),
      ]);

      if (!reported) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const trimmedDetails = (details || "").trim();

      // Upload any attached evidence images to Cloudinary (no face crop;
      // keep original aspect ratio so screenshots are readable for moderators).
      const evidenceImages = [];
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length > MAX_REPORT_EVIDENCE_IMAGES) {
        return res.status(400).json({
          success: false,
          message: `You can attach at most ${MAX_REPORT_EVIDENCE_IMAGES} evidence images`,
        });
      }
      for (const file of files) {
        const uploadResult = await uploadImage(
          file.buffer,
          `chessones/user-reports/${req.user._id}`,
          null,
          {
            transformation: [
              {
                width: 1600,
                height: 1600,
                crop: "limit",
                quality: "auto",
                fetch_format: "auto",
              },
            ],
          }
        );
        if (uploadResult?.public_id) {
          uploadedPublicIds.push(uploadResult.public_id);
        }
        if (uploadResult?.secure_url) {
          evidenceImages.push({
            url: uploadResult.secure_url,
            publicId: uploadResult.public_id || "",
          });
        }
      }

      await UserReport.create({
        reporter: req.user._id,
        reportedUser: reportedUserId,
        category,
        reasonId,
        details: trimmedDetails,
        evidenceImages,
      });

      const reporterDisplay =
        reporter?.fullName || reporter?.username || "Unknown user";
      const reportedDisplay =
        reported.fullName || reported.username || "Unknown user";
      const categoryLabel = getCategoryLabel(category);
      const reasonLabel = getReasonLabel(reasonId);

      try {
        const inbox = getContactInboxEmail();
        const html = buildUserReportEmail({
          reporterName: reporterDisplay,
          reporterUsername: reporter?.username,
          reporterEmail: reporter?.email,
          reporterId: req.user._id.toString(),
          reportedName: reportedDisplay,
          reportedUsername: reported.username,
          reportedId: reportedUserId,
          categoryLabel,
          reasonLabel,
          details: trimmedDetails,
          evidenceImages,
        });
        const evidenceLines = evidenceImages.length
          ? [
              "",
              `Evidence images (${evidenceImages.length}):`,
              ...evidenceImages.map((img, idx) => `  ${idx + 1}. ${img.url}`),
            ]
          : [];
        const text = [
          `User report — ${reporterDisplay} reported ${reportedDisplay}`,
          "",
          `Reporter: ${reporterDisplay} (@${reporter?.username || "—"}) <${reporter?.email || "—"}>`,
          `Reporter ID: ${req.user._id}`,
          "",
          `Reported: ${reportedDisplay} (@${reported.username || "—"})`,
          `Reported ID: ${reportedUserId}`,
          "",
          `Category: ${categoryLabel}`,
          `Reason: ${reasonLabel}`,
          trimmedDetails ? `\nDetails:\n${trimmedDetails}` : "",
          ...evidenceLines,
        ]
          .filter(Boolean)
          .join("\n");

        await sendMail({
          to: inbox,
          from: CHESSONES_FROM_SUPPORT,
          subject: `[ChessOnes Report] ${reporterDisplay} → ${reportedDisplay}`,
          text,
          html,
        });
      } catch (mailErr) {
        console.error("Report notification email failed:", mailErr);
      }

      return res.json({
        success: true,
        message: "Report submitted. Our team will review it.",
      });
    } catch (error) {
      console.error("Report user error:", error);
      // Best-effort cleanup of any images we uploaded before the failure so we
      // don't leave orphaned files in Cloudinary.
      for (const publicId of uploadedPublicIds) {
        try {
          await deleteImage(publicId);
        } catch (cleanupErr) {
          console.error("Cleanup of report image failed:", cleanupErr);
        }
      }
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// @route   GET /api/users/profile
// @desc    Get user profile (own profile if no userId query param, other user if userId provided)
// @access  Private
router.get("/profile", auth, async (req, res) => {
  try {
    const { userId } = req.query;
    const targetUserId = userId || req.user._id;
    const targetStr = targetUserId && targetUserId.toString ? targetUserId.toString() : String(targetUserId);
    const myIdStr = req.user._id.toString();

    // If viewing another user's profile, only return public information (no email)
    const isOwnProfile = !userId || targetStr === myIdStr;

    let user;
    if (isOwnProfile) {
      // Full profile for own profile
      user = await User.findById(req.user._id)
        .select("-password")
        .populate("friends", "username fullName avatar status rating")
        .populate("badges.badgeId", "name description imageUrl");
    } else {
      // Public profile for other users — explicit allow-list (see
      // utils/userProjections). Sensitive fields like email, preferences,
      // friendRequests, blockedUsers, oauth provider, role, suspension and
      // policy-acceptance flags never reach the client this way.
      user = await User.findById(targetUserId)
        .select(OTHER_USER_FIELDS)
        .populate("badges.badgeId", "name description imageUrl");
      if (user && user.friends && user.friends.length > 0) {
        await user.populate("friends", "username fullName avatar status rating");
      }
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const stats = await Stats.findOne({ user: targetUserId });

    let isBlockedByMe = false;
    let hasBlockedMe = false;
    if (!isOwnProfile) {
      const meDoc = await User.findById(req.user._id).select("blockedUsers").lean();
      const themDoc = await User.findById(targetUserId).select("blockedUsers").lean();
      isBlockedByMe = userHasBlocked(meDoc, targetStr);
      hasBlockedMe = userHasBlocked(themDoc, myIdStr);
    }

    const userPayload = user.toObject();
    const memberSince = formatMemberSince(userPayload.createdAt);
    if (memberSince) userPayload.memberSince = memberSince;

    res.json({
      success: true,
      data: {
        user: userPayload,
        stats,
        isOwnProfile,
        isBlockedByMe,
        hasBlockedMe,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   GET /api/users/me/ratings
// @desc    Return current user's bullet/blitz/rapid ratings from DB (for verification)
// @access  Private
router.get("/me/ratings", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("ratings username").lean();
    if (!user || !user.ratings) {
      return res.status(404).json({ success: false, message: "User or ratings not found" });
    }
    const { bullet, blitz, rapid } = user.ratings;
    res.json({
      success: true,
      data: {
        userId: user._id,
        username: user.username,
        ratings: {
          bullet: bullet?.rating ?? 1500,
          blitz: blitz?.rating ?? 1500,
          rapid: rapid?.rating ?? 1500,
        },
      },
    });
  } catch (error) {
    console.error("Get me/ratings error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// // @route   PUT /api/users/profile
// // @desc    Update user profile
// // @access  Private
// router.put(
//   "/profile",
//   [
//     auth,
//     body("fullName").optional().isLength({ min: 2 }).trim(),
//     body("about").optional().isLength({ max: 500 }),
//     body("ageGroup").optional().isIn(["under-18", "18-25", "26-35", "36-50", "over-50"]),
//   ],
//   async (req, res) => {
//     try {
//       const errors = validationResult(req)
//       if (!errors.isEmpty()) {
//         return res.status(400).json({
//           success: false,
//           message: "Validation failed",
//           errors: errors.array(),
//         })
//       }

//       const { fullName, about, ageGroup } = req.body
//       const updateFields = {}

//       if (fullName) updateFields.fullName = fullName
//       if (about !== undefined) updateFields.about = about
//       if (ageGroup) updateFields.ageGroup = ageGroup

//       const user = await User.findByIdAndUpdate(req.user._id, updateFields, { new: true }).select("-password")

//       res.json({
//         success: true,
//         message: "Profile updated successfully",
//         data: { user },
//       })
//     } catch (error) {
//       console.error("Update profile error:", error)
//       res.status(500).json({
//         success: false,
//         message: "Server error",
//       })
//     }
//   },
// )

// @route   PUT /api/users/profile
// @desc    Update user profile (including password change)
// @access  Private
router.put(
  "/profile",
  [
    auth,
    body("username")
      .optional()
      .trim()
      .isLength({ min: 3, max: 50 })
      .withMessage("Username must be between 3 and 50 characters"),
    body("fullName").optional().isLength({ min: 2 }).trim(),
    body("about").optional().isLength({ max: 500 }),
    body("ageGroup")
      .optional()
      .isIn(["under-18", "18-25", "26-35", "36-50", "over-50"]),
    body("currentPassword").optional().isLength({ min: 6 }),
    body("newPassword").optional().isLength({ min: 6 }),
    body("confirmNewPassword").optional().isLength({ min: 6 }),
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

      const {
        username,
        fullName,
        about,
        ageGroup,
        country,
        avatar,
        currentPassword,
        newPassword,
        confirmNewPassword,
      } = req.body;

      const updateFields = {};

      if (username !== undefined) {
        const normalizedUsername = String(username).trim();
        if (!normalizedUsername) {
          return res.status(400).json({
            success: false,
            message: "Username cannot be empty",
          });
        }
        const existingWithUsername = await User.findOne({
          username: normalizedUsername,
          _id: { $ne: req.user._id },
        }).select("_id");
        if (existingWithUsername) {
          return res.status(400).json({
            success: false,
            message: "Username is already taken",
          });
        }
        updateFields.username = normalizedUsername;
      }
      if (fullName) updateFields.fullName = fullName;
      if (about !== undefined) updateFields.about = about;
      if (ageGroup) updateFields.ageGroup = ageGroup;
      if (country !== undefined) updateFields.country = country;
      if (avatar) updateFields.avatar = avatar;

      const user = await User.findById(req.user._id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // 🔑 Handle password change
      if (currentPassword || newPassword || confirmNewPassword) {
        if (!currentPassword || !newPassword || !confirmNewPassword) {
          return res.status(400).json({
            success: false,
            message: "All password fields are required",
          });
        }

        if (newPassword !== confirmNewPassword) {
          return res.status(400).json({
            success: false,
            message: "New password and confirm password do not match",
          });
        }
        console.log("pass:", user.password);

        // Compare current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        console.log(isMatch);
        if (!isMatch) {
          return res.status(400).json({
            success: false,
            message: "Current password is incorrect",
          });
        }

        // Hash new password
        user.password = newPassword;
        await user.save();

        return res.json({
          success: true,
          message: "Password updated successfully",
        });
      }

      // 🔄 Normal profile update
      const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        updateFields,
        { new: true }
      ).select("-password");

      res.json({
        success: true,
        message: "Profile updated successfully",
        data: { user: updatedUser },
      });
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   GET /api/users/preferences
// @desc    Get user preferences
// @access  Private
router.get("/preferences", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("preferences");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Return user preferences with defaults merged.
    // Display + gameplay defaults match chessones-frontend-v2:
    // lib/board-theme.ts (DEFAULT_BOARD_THEME_ID, DEFAULT_PIECE_SET),
    // lib/platform-background-theme.ts (obsidian),
    // app/settings/page.tsx initial state (coordinateMode, autoQueen, showCoordinates, premove).
    const userPrefs = user.preferences || {};
    const defaultDisplay = {
      theme: "dark",
      boardTheme: "blue_(default)",
      pieceSet: "cburnett",
      coordinateMode: "inside",
      showRating: true,
      showPlayerNames: true,
      animationSpeed: "normal",
      // Same id as frontend DEFAULT_PLATFORM_BACKGROUND_THEME_ID ("obsidian")
      platformBackgroundTheme: "obsidian",
    };
    const displayFromUser =
      userPrefs.display && typeof userPrefs.display === "object" && !Array.isArray(userPrefs.display)
        ? userPrefs.display
        : {};
    const defaultGameplay = {
      autoQueen: false,
      showCoordinates: true,
      highlightLastMove: true,
      showLegalMoves: true,
      confirmMoves: false,
      premove: true,
    };
    const gameplayFromUser =
      userPrefs.gameplay && typeof userPrefs.gameplay === "object" && !Array.isArray(userPrefs.gameplay)
        ? userPrefs.gameplay
        : {};
    const preferences = {
      theme: userPrefs.theme || "dark",
      boardStyle: userPrefs.boardStyle || "classic",
      gameplay: { ...defaultGameplay, ...gameplayFromUser },
      display: { ...defaultDisplay, ...displayFromUser },
      sound: userPrefs.sound || {
        soundEnabled: true,
        moveSound: true,
        captureSound: true,
        checkSound: true,
        gameEndSound: true,
        volume: 50,
      },
      notifications: userPrefs.notifications || {
        gameInvites: true,
        friendRequests: true,
        gameReminders: true,
        emailNotifications: false,
        pushNotifications: false,
        advertisementEmails: false,
      },
      privacy: userPrefs.privacy || {
        showOnlineStatus: true,
        allowFriendRequests: true,
        showGameHistory: true,
        allowSpectators: true,
      },
    };
    
    // Merge existing preferences with defaults
    if (userPrefs.sound) {
      preferences.sound = { ...preferences.sound, ...userPrefs.sound };
    }
    if (userPrefs.notifications) {
      preferences.notifications = { ...preferences.notifications, ...userPrefs.notifications };
    }
    if (userPrefs.privacy) {
      preferences.privacy = { ...preferences.privacy, ...userPrefs.privacy };
    }

    res.json({
      success: true,
      data: { preferences },
    });
  } catch (error) {
    console.error("Get preferences error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   PUT /api/users/preferences
// @desc    Update user preferences
// @access  Private
router.put(
  "/preferences",
  [
    auth,
    // Remove strict validation for preferences object - allow flexible structure
  ],
  async (req, res) => {
    try {
      const { preferences } = req.body;

      if (!preferences || typeof preferences !== "object") {
        return res.status(400).json({
          success: false,
          message: "Preferences object is required",
        });
      }

      // Get current user to merge preferences properly
      const user = await User.findById(req.user._id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Merge new preferences with existing ones (deep merge for nested objects)
      const currentPrefs = user.preferences || {};
      
      // Helper function to safely merge nested objects
      const mergeNested = (newVal, currentVal) => {
        if (!newVal) return currentVal;
        if (typeof newVal === "object" && !Array.isArray(newVal)) {
          const currentObj = typeof currentVal === "object" && !Array.isArray(currentVal) ? currentVal : {};
          return { ...currentObj, ...newVal };
        }
        return newVal;
      };

      const mergedPreferences = {
        ...currentPrefs,
        ...preferences,
        // Deep merge for nested objects
        gameplay: mergeNested(preferences.gameplay, currentPrefs.gameplay),
        display: mergeNested(preferences.display, currentPrefs.display),
        sound: mergeNested(preferences.sound, currentPrefs.sound),
        privacy: mergeNested(preferences.privacy, currentPrefs.privacy),
        // Special handling for notifications (can be Boolean or Object)
        notifications: preferences.notifications !== undefined
          ? typeof preferences.notifications === "object" && !Array.isArray(preferences.notifications)
            ? mergeNested(preferences.notifications, 
                typeof currentPrefs.notifications === "object" && !Array.isArray(currentPrefs.notifications)
                  ? currentPrefs.notifications
                  : {}) // Convert Boolean to empty object if needed
            : preferences.notifications // Handle Boolean for backward compatibility
          : currentPrefs.notifications,
      };

      // Update user with merged preferences
      user.preferences = mergedPreferences;
      await user.save();

      res.json({
        success: true,
        message: "Preferences updated successfully",
        data: { 
          user: {
            ...user.toObject(),
            preferences: mergedPreferences,
          }
        },
      });
    } catch (error) {
      console.error("Update preferences error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
        error: process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  }
);

// @route   GET /api/users/search
// @desc    Search users
// @access  Private
router.get("/search", auth, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 2 characters",
      });
    }

    const users = await User.find({
      $and: [
        { _id: { $ne: req.user._id } },
        {
          $or: [
            { username: { $regex: q, $options: "i" } },
            { fullName: { $regex: q, $options: "i" } },
          ],
        },
      ],
    })
      .select("username fullName avatar rating status")
      .limit(Number.parseInt(limit));

    res.json({
      success: true,
      data: { users },
    });
  } catch (error) {
    console.error("Search users error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/users/avatar
// @desc    Upload user avatar to Cloudinary
// @access  Private
router.post("/avatar", auth, upload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file provided",
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Delete old avatar from Cloudinary if it exists
    if (user.avatar) {
      try {
        const oldPublicId = extractPublicId(user.avatar);
        if (oldPublicId) {
          await deleteImage(oldPublicId);
        }
      } catch (error) {
        console.error("Error deleting old avatar:", error);
        // Continue even if deletion fails
      }
    }

    // Upload new avatar to Cloudinary
    const publicId = `avatars/${req.user._id}`;
    const uploadResult = await uploadImage(
      req.file.buffer,
      "avatars",
      publicId
    );

    // Update user avatar URL
    user.avatar = uploadResult.secure_url;
    await user.save();

    res.json({
      success: true,
      message: "Avatar uploaded successfully",
      data: {
        avatarUrl: uploadResult.secure_url,
        user: {
          _id: user._id,
          avatar: user.avatar,
        },
      },
    });
  } catch (error) {
    console.error("Avatar upload error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to upload avatar",
    });
  }
});

// @route   DELETE /api/users/avatar
// @desc    Delete user avatar
// @access  Private
router.delete("/avatar", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Delete avatar from Cloudinary if it exists
    if (user.avatar) {
      try {
        const oldPublicId = extractPublicId(user.avatar);
        if (oldPublicId) {
          await deleteImage(oldPublicId);
        }
      } catch (error) {
        console.error("Error deleting avatar from Cloudinary:", error);
        // Continue even if deletion fails
      }
    }

    // Remove avatar from user profile
    user.avatar = undefined;
    await user.save();

    res.json({
      success: true,
      message: "Avatar removed successfully",
      data: {
        user: {
          _id: user._id,
          avatar: user.avatar,
        },
      },
    });
  } catch (error) {
    console.error("Avatar delete error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to remove avatar",
    });
  }
});

module.exports = router;
