const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Puzzle = require("../models/Puzzle");
const PuzzleAttempt = require("../models/PuzzleAttempt");
const User = require("../models/User");
const auth = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");

// Get puzzles with filters (optional auth - can view without login)
router.get("/", optionalAuth, async (req, res) => {
  try {
    const {
      difficulty,
      theme,
      minRating,
      maxRating,
      limit = 20,
      page = 1,
      sortBy = "rating", // rating, popularity, nbPlays
      sortOrder = "asc", // asc, desc
    } = req.query;

    // Build query
    const query = {};

    if (difficulty) {
      query.difficulty = difficulty.toUpperCase();
    }

    if (theme) {
      query.themes = { $in: [theme] };
    }

    if (minRating || maxRating) {
      query.rating = {};
      if (minRating) query.rating.$gte = parseInt(minRating);
      if (maxRating) query.rating.$lte = parseInt(maxRating);
    }

    // Build sort
    const sort = {};
    sort[sortBy] = sortOrder === "desc" ? -1 : 1;

    // Calculate skip
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get puzzles
    console.log("🔍 Puzzle query:", JSON.stringify(query));
    console.log("🔍 Sort:", JSON.stringify(sort));
    console.log("🔍 Limit:", parseInt(limit), "Skip:", skip);
    
    const puzzles = await Puzzle.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip)
      .select("-__v")
      .lean();

    console.log(`📦 Found ${puzzles.length} puzzles`);

    // Get total count for pagination
    const total = await Puzzle.countDocuments(query);
    console.log(`📊 Total puzzles matching query: ${total}`);

    // Get user's attempted puzzles to mark them (if user is authenticated)
    let attemptedPuzzleIds = [];
    if (req.user) {
      const userId = req.user._id || req.user.id;
      try {
        attemptedPuzzleIds = await PuzzleAttempt.find({
          user: userId,
          solved: true,
        }).distinct("puzzle");
      } catch (error) {
        console.error("Error fetching attempted puzzles:", error);
        // Continue without attempted puzzle info
      }
    }

    // Mark puzzles as attempted
    const puzzlesWithStatus = puzzles.map((puzzle) => ({
      ...puzzle,
      attempted: attemptedPuzzleIds.includes(puzzle._id),
    }));

    res.json({
      success: true,
      data: {
        puzzles: puzzlesWithStatus,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching puzzles:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching puzzles",
      error: error.message,
    });
  }
});

// Get random puzzle (MUST be before /:id route) - optional auth
// Implements rating-based selection with exclusion of already played puzzles
router.get("/random/get", optionalAuth, async (req, res) => {
  try {
    const { difficulty, minRating, maxRating } = req.query;

    // Get user's puzzle rating if authenticated
    let userPuzzleRating = 100; // Default for non-authenticated users
    let playedPuzzleIds = [];
    
    if (req.user) {
      const user = await User.findById(req.user._id || req.user.id).select("puzzleRating");
      if (user) {
        userPuzzleRating = user.puzzleRating || 100;
      }
      
      // REQUIREMENT: Get all puzzles this user has attempted (solved OR failed)
      // Once a puzzle is attempted, it should never be shown to the same user again
      const attempts = await PuzzleAttempt.find({
        user: req.user._id || req.user.id,
      }).select("puzzle");
      playedPuzzleIds = attempts.map(a => a.puzzle.toString());
      console.log(`[Random Puzzle] User has attempted ${playedPuzzleIds.length} puzzles, excluding them from selection`);
    }

    // Build query - exclude ALL attempted puzzles (solved or failed)
    // REQUIREMENT: A puzzle is eligible only if user has NOT attempted it before
    const query = {
      _id: { $nin: playedPuzzleIds.map(id => new mongoose.Types.ObjectId(id)) },
    };

    if (difficulty) {
      query.difficulty = difficulty.toUpperCase();
    }

    // Rating-based selection: puzzles within ±200 of user rating (widens if needed)
    let ratingRange = 200;
    let ratingQuery = {
      $gte: Math.max(0, userPuzzleRating - ratingRange),
      $lte: userPuzzleRating + ratingRange,
    };

    // Allow manual override
    if (minRating || maxRating) {
      ratingQuery = {};
      if (minRating) ratingQuery.$gte = parseInt(minRating);
      if (maxRating) ratingQuery.$lte = parseInt(maxRating);
    } else {
      query.rating = ratingQuery;
    }

    // Get count of available puzzles
    let count = await Puzzle.countDocuments(query);

    // If no puzzles in range, widen the range progressively
    if (count === 0 && !minRating && !maxRating) {
      for (let range of [300, 400, 500, 1000, 2000]) {
        query.rating = {
          $gte: Math.max(0, userPuzzleRating - range),
          $lte: userPuzzleRating + range,
        };
        count = await Puzzle.countDocuments(query);
        if (count > 0) break;
      }
    }

    if (count === 0) {
      return res.status(404).json({
        success: false,
        message: "No puzzles found with the specified criteria",
      });
    }

    // Get random puzzle from available ones
    // Use a more random approach: shuffle the results or use aggregation
    // For better randomization, we'll use aggregation with $sample if available
    // Otherwise, use a random skip value
    const randomSkip = Math.floor(Math.random() * count);
    const puzzle = await Puzzle.findOne(query)
      .skip(randomSkip)
      .select("-__v")
      .lean();

    if (!puzzle) {
      return res.status(404).json({
        success: false,
        message: "No puzzle found",
      });
    }

    res.json({
      success: true,
      data: { puzzle },
    });
  } catch (error) {
    console.error("Error fetching random puzzle:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching random puzzle",
      error: error.message,
    });
  }
});

// Get a single puzzle by ID - optional auth
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const puzzle = await Puzzle.findById(req.params.id).select("-__v").lean();

    if (!puzzle) {
      return res.status(404).json({
        success: false,
        message: "Puzzle not found",
      });
    }

    // Check if user has attempted this puzzle (if authenticated)
    let attempt = null;
    if (req.user) {
      const userId = req.user._id || req.user.id;
      attempt = await PuzzleAttempt.findOne({
        user: userId,
        puzzle: puzzle._id,
      }).lean();
    }

    res.json({
      success: true,
      data: {
        puzzle: {
          ...puzzle,
          attempted: !!attempt,
          solved: attempt?.solved || false,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching puzzle:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching puzzle",
      error: error.message,
    });
  }
});

// Submit puzzle attempt
router.post("/:id/attempt", auth, async (req, res) => {
  try {
    const { solved, timeSpent } = req.body;
    const puzzleId = req.params.id;
    const userId = req.user._id || req.user.id;

    // Get puzzle
    const puzzle = await Puzzle.findById(puzzleId);
    if (!puzzle) {
      return res.status(404).json({
        success: false,
        message: "Puzzle not found",
      });
    }

    // REQUIREMENT: Track ALL puzzle attempts (solved OR failed)
    // Once a puzzle is attempted, it should never be shown to the same user again
    // Get or create attempt
    let attempt = await PuzzleAttempt.findOne({
      user: userId,
      puzzle: puzzleId,
    });

    if (!attempt) {
      // First attempt - create new record
      // REQUIREMENT: Create attempt record for ANY attempt (solved or failed)
      attempt = new PuzzleAttempt({
        user: userId,
        puzzle: puzzleId,
        solved: solved || false,
        attempts: 1,
        timeSpent: timeSpent || 0,
      });
      console.log(`[Puzzle Attempt] Created new attempt record for puzzle ${puzzleId}, solved: ${solved}`);
    } else {
      // Subsequent attempt - update existing record
      attempt.attempts += 1;
      if (solved && !attempt.solved) {
        attempt.solved = true; // Upgrade to solved if previously failed
      }
      if (timeSpent) {
        attempt.timeSpent += timeSpent;
      }
      console.log(`[Puzzle Attempt] Updated attempt record for puzzle ${puzzleId}, attempts: ${attempt.attempts}, solved: ${attempt.solved}`);
    }

    await attempt.save();

    // Calculate rating change using ELO-like system
    const user = await User.findById(userId);
    const userRating = user.puzzleRating || 100;
    const puzzleRating = puzzle.rating;

    // Calculate expected score (probability of winning)
    const expectedScore =
      1 / (1 + Math.pow(10, (puzzleRating - userRating) / 400));

    // K-factor (how much rating changes)
    const K = 32;

    // Calculate rating change
    let ratingChange = 0;
    if (solved) {
      // Win: gain points
      ratingChange = Math.round(K * (1 - expectedScore));
    } else {
      // Loss: lose points (but less than if we won)
      ratingChange = Math.round(K * (0 - expectedScore) * 0.5); // Lose half of what we would have gained
    }

    // Update user's puzzle rating
    const newRating = Math.max(0, userRating + ratingChange); // Don't go below 0
    user.puzzleRating = newRating;

    // ========================================================================
    // STREAK TRACKING: Update streak in database
    // ========================================================================
    if (solved) {
      // Puzzle solved - increment streak
      user.puzzleStreak = (user.puzzleStreak || 0) + 1;
      console.log(`[Puzzle Streak] Incremented streak to ${user.puzzleStreak} for user ${userId}`);
    } else {
      // Puzzle failed - reset streak to 0
      user.puzzleStreak = 0;
      console.log(`[Puzzle Streak] Reset streak to 0 for user ${userId}`);
    }
    // ========================================================================
    
    await user.save();

    // Update attempt with rating change
    attempt.ratingChange = ratingChange;
    await attempt.save();

    res.json({
      success: true,
      data: {
        solved,
        ratingChange,
        newRating,
        newStreak: user.puzzleStreak || 0,
        attempts: attempt.attempts,
      },
    });
  } catch (error) {
    console.error("Error submitting puzzle attempt:", error);
    res.status(500).json({
      success: false,
      message: "Error submitting puzzle attempt",
      error: error.message,
    });
  }
});

const PUZZLE_PERIOD_TO_MS = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
  all: null,
};

// Get user's puzzle statistics (optional ?period=7d|1m|3m|all for windowed counts)
router.get("/stats/user", auth, async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const periodRaw = String(req.query.period || "all").toLowerCase();
    const period = Object.prototype.hasOwnProperty.call(PUZZLE_PERIOD_TO_MS, periodRaw) ? periodRaw : "all";
    const sinceMs = PUZZLE_PERIOD_TO_MS[period];
    const since = sinceMs == null ? null : new Date(Date.now() - sinceMs);

    const uidObj = new mongoose.Types.ObjectId(userId);

    const lifetimeMatch = { user: uidObj };
    const periodMatch =
      since == null ? lifetimeMatch : { user: uidObj, updatedAt: { $gte: since } };

    const [lifetime, inWindow] = await Promise.all([
      PuzzleAttempt.aggregate([
        { $match: lifetimeMatch },
        {
          $group: {
            _id: null,
            totalPuzzles: { $sum: 1 },
            solved: { $sum: { $cond: ["$solved", 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ["$solved", false] }, 1, 0] } },
            totalTime: { $sum: "$timeSpent" },
            totalMoveAttempts: { $sum: "$attempts" },
          },
        },
      ]),
      PuzzleAttempt.aggregate([
        { $match: periodMatch },
        {
          $group: {
            _id: null,
            inPeriodPuzzles: { $sum: 1 },
            inPeriodSolved: { $sum: { $cond: ["$solved", 1, 0] } },
            inPeriodFailed: { $sum: { $cond: [{ $eq: ["$solved", false] }, 1, 0] } },
            inPeriodTime: { $sum: "$timeSpent" },
            inPeriodRatingDelta: { $sum: { $ifNull: ["$ratingChange", 0] } },
          },
        },
      ]),
    ]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const todaySolved = await PuzzleAttempt.countDocuments({
      user: uidObj,
      solved: true,
      updatedAt: {
        $gte: todayStart,
        $lte: todayEnd,
      },
    });

    const user = await User.findById(userId).select("puzzleRating puzzleStreak");

    const L = lifetime[0] || {};
    const P = inWindow[0] || {};

    const totalPuzzles = L.totalPuzzles || 0;
    const solved = L.solved || 0;
    const result = {
      period,
      puzzleRating: user?.puzzleRating ?? 100,
      totalPuzzles,
      solved,
      failed: L.failed || 0,
      totalTime: L.totalTime || 0,
      totalMoveAttempts: L.totalMoveAttempts || 0,
      accuracy: totalPuzzles > 0 ? Number(((solved / totalPuzzles) * 100).toFixed(1)) : 0,
      todayCompleted: todaySolved || 0,
      streak: user?.puzzleStreak ?? 0,
      inPeriod: {
        puzzlesTouched: P.inPeriodPuzzles || 0,
        solved: P.inPeriodSolved || 0,
        failed: P.inPeriodFailed || 0,
        timeSpent: P.inPeriodTime || 0,
        /** Sum of stored ratingChange on attempts updated in window (approximation). */
        ratingDeltaSum: Math.round(Number(P.inPeriodRatingDelta || 0)),
      },
      /** Skip is client-only navigation; not persisted. */
      skippedTracked: false,
    };

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error fetching puzzle stats:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching puzzle stats",
      error: error.message,
    });
  }
});

// Get available themes - optional auth
router.get("/themes/list", optionalAuth, async (req, res) => {
  try {
    const themes = await Puzzle.distinct("themes");
    res.json({
      success: true,
      data: { themes: themes.sort() },
    });
  } catch (error) {
    console.error("Error fetching themes:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching themes",
      error: error.message,
    });
  }
});

module.exports = router;

