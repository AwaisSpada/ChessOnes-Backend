const express = require("express");
const auth = require("../middleware/auth");
const { buildAchievementsPayload } = require("../services/achievementUnlockService");

const router = express.Router();

/**
 * GET /api/achievements/me
 * Full catalog + unlock/progress for the authenticated user.
 *
 * GET /api/achievements/me?userId=...
 * Same for another user (public unlock state only — no private fields).
 */
router.get("/me", auth, async (req, res) => {
  try {
    const targetId = req.query.userId
      ? String(req.query.userId)
      : req.user._id.toString();

    const payload = await buildAchievementsPayload(targetId);
    if (!payload) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      data: payload,
    });
  } catch (error) {
    console.error("[Achievements] GET /me failed:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load achievements",
    });
  }
});

module.exports = router;
