const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");
const DailyPuzzleAssignment = require("../models/DailyPuzzleAssignment");
const DailyPuzzle = require("../models/DailyPuzzle");
const User = require("../models/User");
const {
  todayDateKey,
  addDaysToDateKey,
  isFutureDateKey,
  isValidDateKey,
  getLaunchDateKey,
  isBeforeLaunchDateKey,
} = require("../utils/daily-puzzle-dates");
const {
  ensureAssignmentForDate,
  getUserProgress,
  markSolved,
  getCalendarForUser,
  computeDisplayStreak,
} = require("../utils/daily-puzzle-service");

function serializePuzzle(puzzle) {
  if (!puzzle) return null;
  return {
    _id: puzzle._id,
    sourceId: puzzle.sourceId,
    fen: puzzle.fen,
    moves: puzzle.moves,
    rating: puzzle.rating,
    themes: puzzle.themes || [],
  };
}

/**
 * GET /api/daily-puzzle?date=YYYY-MM-DD
 * Returns global puzzle for that date + user progress.
 */
router.get("/", optionalAuth, async (req, res) => {
  try {
    const dateKey = String(req.query.date || todayDateKey());
    if (!isValidDateKey(dateKey)) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }
    if (isFutureDateKey(dateKey)) {
      return res.status(400).json({
        success: false,
        message: "Future daily puzzles are not available yet",
        launchDateKey: getLaunchDateKey(),
      });
    }
    if (isBeforeLaunchDateKey(dateKey)) {
      return res.status(404).json({
        success: false,
        message: `Daily puzzles start on ${getLaunchDateKey()} (UTC)`,
        launchDateKey: getLaunchDateKey(),
      });
    }

    const assignment = await ensureAssignmentForDate(dateKey);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "No daily puzzle available for this date (pool empty)",
      });
    }

    const populated =
      assignment.puzzle?.fen != null
        ? assignment
        : await assignment.populate("puzzle");

    const userId = req.user?._id || req.user?.id;
    const progress = await getUserProgress(userId, dateKey);

    let streak = 0;
    if (userId) {
      const user = await User.findById(userId).select(
        "dailyPuzzleStreak dailyPuzzleLastStreakDate"
      );
      streak = computeDisplayStreak(user);
    }

    res.json({
      success: true,
      data: {
        dateKey,
        todayDateKey: todayDateKey(),
        puzzle: serializePuzzle(populated.puzzle),
        solved: Boolean(progress?.solved),
        solvedAt: progress?.solvedAt || null,
        streak,
      },
    });
  } catch (error) {
    console.error("[Daily Puzzle] GET error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load daily puzzle",
      error: error.message,
    });
  }
});

/**
 * POST /api/daily-puzzle/:dateKey/solve
 */
router.post("/:dateKey/solve", auth, async (req, res) => {
  try {
    const dateKey = req.params.dateKey;
    if (!isValidDateKey(dateKey)) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }
    if (isFutureDateKey(dateKey)) {
      return res.status(400).json({
        success: false,
        message: "Cannot solve a future daily puzzle",
      });
    }
    if (isBeforeLaunchDateKey(dateKey)) {
      return res.status(404).json({
        success: false,
        message: `Daily puzzles start on ${getLaunchDateKey()} (UTC)`,
        launchDateKey: getLaunchDateKey(),
      });
    }

    const assignment = await ensureAssignmentForDate(dateKey);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "No daily puzzle for this date",
      });
    }

    const userId = req.user._id || req.user.id;
    const timeSpent = Number(req.body?.timeSpent) || 0;
    const { progress, alreadySolved } = await markSolved({
      userId,
      dateKey,
      timeSpent,
    });

    const user = await User.findById(userId).select(
      "dailyPuzzleStreak dailyPuzzleLastStreakDate"
    );

    res.json({
      success: true,
      data: {
        dateKey,
        solved: true,
        alreadySolved,
        solvedAt: progress.solvedAt,
        streak: computeDisplayStreak(user),
        todayDateKey: todayDateKey(),
      },
    });
  } catch (error) {
    console.error("[Daily Puzzle] solve error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to record solve",
      error: error.message,
    });
  }
});

/**
 * GET /api/daily-puzzle/stats/user
 */
router.get("/stats/user", auth, async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).select(
      "dailyPuzzleStreak dailyPuzzleLastStreakDate"
    );
    const today = todayDateKey();
    const progressToday = await getUserProgress(userId, today);

    res.json({
      success: true,
      data: {
        streak: computeDisplayStreak(user),
        todayDateKey: today,
        todaySolved: Boolean(progressToday?.solved),
        lastStreakDate: user?.dailyPuzzleLastStreakDate || null,
      },
    });
  } catch (error) {
    console.error("[Daily Puzzle] stats error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load daily puzzle stats",
      error: error.message,
    });
  }
});

/**
 * GET /api/daily-puzzle/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
router.get("/calendar", optionalAuth, async (req, res) => {
  try {
    const today = todayDateKey();
    const fromKey = String(req.query.from || addDaysToDateKey(today, -90));
    const toKey = String(req.query.to || today);

    if (!isValidDateKey(fromKey) || !isValidDateKey(toKey)) {
      return res.status(400).json({ success: false, message: "Invalid date range" });
    }

    const userId = req.user?._id || req.user?.id;
    const days = await getCalendarForUser(userId, { fromKey, toKey });

    res.json({
      success: true,
      data: {
        fromKey,
        toKey,
        todayDateKey: today,
        launchDateKey: getLaunchDateKey(),
        days,
      },
    });
  } catch (error) {
    console.error("[Daily Puzzle] calendar error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load calendar",
      error: error.message,
    });
  }
});

/** GET /api/daily-puzzle/pool/stats — admin/debug */
router.get("/pool/stats", async (_req, res) => {
  try {
    const [total, used, unused] = await Promise.all([
      DailyPuzzle.countDocuments(),
      DailyPuzzle.countDocuments({ usedOnDateKey: { $ne: null } }),
      DailyPuzzle.countDocuments({ usedOnDateKey: null }),
    ]);
    const assignments = await DailyPuzzleAssignment.countDocuments();
    res.json({
      success: true,
      data: { total, used, unused, assignments },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
