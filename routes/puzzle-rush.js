const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const PuzzleRushPuzzle = require("../models/PuzzleRushPuzzle");
const PuzzleRushRun = require("../models/PuzzleRushRun");
const User = require("../models/User");

const VALID_MODES = new Set([180, 300]);
const MAX_BATCH = 50;
const MAX_SOLVED = 250;
const MAX_WRONGS_STORED = 80;

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function serializePuzzle(doc) {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    puzzleId: doc.puzzleId,
    fen: doc.fen,
    moves: doc.moves,
    rating: doc.rating,
    themes: doc.themes || [],
    category: doc.category || "",
  };
}

function clampInt(n, min, max, fallback = 0) {
  const v = Number.isFinite(Number(n)) ? Math.floor(Number(n)) : fallback;
  return Math.min(max, Math.max(min, v));
}

/**
 * GET /api/puzzle-rush/pool/stats
 */
router.get("/pool/stats", auth, async (_req, res) => {
  try {
    const total = await PuzzleRushPuzzle.countDocuments();
    res.json({ success: true, data: { total } });
  } catch (error) {
    console.error("Puzzle rush pool stats error:", error);
    res.status(500).json({ success: false, message: "Failed to load pool stats" });
  }
});

/**
 * GET /api/puzzle-rush/batch?count=20&exclude=id1,id2&minRating=&maxRating=
 * Returns random rush-pool puzzles for the timed session.
 */
router.get("/batch", auth, async (req, res) => {
  try {
    const count = clampInt(req.query.count, 1, MAX_BATCH, 20);
    const excludeRaw = String(req.query.exclude || "");
    const exclude = excludeRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500);

    const minRating = req.query.minRating
      ? clampInt(req.query.minRating, 400, 3000, 400)
      : null;
    const maxRating = req.query.maxRating
      ? clampInt(req.query.maxRating, 400, 3000, 3000)
      : null;

    const match = {};
    if (exclude.length) {
      match.puzzleId = { $nin: exclude };
    }
    if (minRating != null || maxRating != null) {
      match.rating = {};
      if (minRating != null) match.rating.$gte = minRating;
      if (maxRating != null) match.rating.$lte = maxRating;
    }

    let puzzles = await PuzzleRushPuzzle.aggregate([
      { $match: match },
      { $sample: { size: count } },
      {
        $project: {
          puzzleId: 1,
          fen: 1,
          moves: 1,
          rating: 1,
          themes: 1,
          category: 1,
        },
      },
    ]);

    // Widen if rating filter returned too few
    if (puzzles.length < count && (minRating != null || maxRating != null)) {
      const need = count - puzzles.length;
      const haveIds = [
        ...exclude,
        ...puzzles.map((p) => p.puzzleId),
      ];
      const more = await PuzzleRushPuzzle.aggregate([
        { $match: { puzzleId: { $nin: haveIds } } },
        { $sample: { size: need } },
        {
          $project: {
            puzzleId: 1,
            fen: 1,
            moves: 1,
            rating: 1,
            themes: 1,
            category: 1,
          },
        },
      ]);
      puzzles = puzzles.concat(more);
    }

    if (!puzzles.length) {
      const total = await PuzzleRushPuzzle.countDocuments();
      return res.status(404).json({
        success: false,
        message:
          total === 0
            ? "Puzzle Rush pool is empty. Import puzzle_rush_pool.csv first."
            : "No puzzles available for this request",
        data: { total },
      });
    }

    res.json({
      success: true,
      data: {
        puzzles: puzzles.map(serializePuzzle),
        count: puzzles.length,
      },
    });
  } catch (error) {
    console.error("Puzzle rush batch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch rush puzzles" });
  }
});

/**
 * POST /api/puzzle-rush/submit
 * Body: { modeSeconds, solved, wrongs[], bestStreak, avgSecondsPerPuzzle, durationMs }
 */
router.post("/submit", auth, async (req, res) => {
  try {
    const modeSeconds = Number(req.body.modeSeconds);
    if (!VALID_MODES.has(modeSeconds)) {
      return res.status(400).json({
        success: false,
        message: "modeSeconds must be 180 or 300",
      });
    }

    const solved = clampInt(req.body.solved, 0, MAX_SOLVED, 0);
    const rawWrongs = Array.isArray(req.body.wrongs) ? req.body.wrongs : [];
    const wrongs = rawWrongs.slice(0, MAX_WRONGS_STORED).map((w) => ({
      puzzleId: String(w.puzzleId || "").slice(0, 32),
      fen: String(w.fen || "").slice(0, 120),
      moves: String(w.moves || "").slice(0, 200),
      rating: clampInt(w.rating, 0, 4000, 0),
      themes: Array.isArray(w.themes)
        ? w.themes.map((t) => String(t).slice(0, 40)).slice(0, 12)
        : [],
      category: String(w.category || "").slice(0, 64),
      reason: w.reason === "skip" ? "skip" : "wrong",
    }));
    const wrongCount = clampInt(
      req.body.wrongCount != null ? req.body.wrongCount : wrongs.length,
      0,
      MAX_SOLVED,
      wrongs.length
    );
    const bestStreak = clampInt(req.body.bestStreak, 0, MAX_SOLVED, 0);
    const durationMs = clampInt(
      req.body.durationMs,
      0,
      modeSeconds * 1000 + 15000,
      modeSeconds * 1000
    );
    const attempts = solved + wrongCount;
    const accuracy =
      attempts > 0
        ? Math.round((solved / attempts) * 1000) / 10
        : 0;
    const avgSecondsPerPuzzle =
      attempts > 0
        ? Math.round((durationMs / 1000 / attempts) * 10) / 10
        : Number(req.body.avgSecondsPerPuzzle) || 0;

    const dayKey = utcDayKey();
    const userId = req.user._id;

    const priorBest = await PuzzleRushRun.findOne({
      user: userId,
      modeSeconds,
    })
      .sort({ solved: -1, createdAt: 1 })
      .select("solved")
      .lean();

    const isPersonalBest =
      !priorBest || solved > priorBest.solved;

    const run = await PuzzleRushRun.create({
      user: userId,
      modeSeconds,
      solved,
      wrongCount,
      wrongs,
      bestStreak,
      avgSecondsPerPuzzle,
      accuracy,
      durationMs,
      dayKey,
      isPersonalBest,
    });

    // Global rank today (among best-per-user for this mode+day)
    const todayAgg = await PuzzleRushRun.aggregate([
      { $match: { modeSeconds, dayKey } },
      {
        $group: {
          _id: "$user",
          best: { $max: "$solved" },
        },
      },
      { $sort: { best: -1 } },
    ]);
    const betterToday = todayAgg.filter((r) => r.best > solved).length;
    const globalRankToday = betterToday + 1;
    const globalPlayersToday = todayAgg.length;

    // All-time personal best rank (optional context)
    const allTimeAgg = await PuzzleRushRun.aggregate([
      { $match: { modeSeconds } },
      {
        $group: {
          _id: "$user",
          best: { $max: "$solved" },
        },
      },
      { $match: { best: { $gt: solved } } },
      { $count: "n" },
    ]);
    const globalRankAllTime = (allTimeAgg[0]?.n || 0) + 1;

    res.json({
      success: true,
      data: {
        runId: String(run._id),
        modeSeconds,
        solved,
        wrongCount,
        wrongs,
        bestStreak,
        avgSecondsPerPuzzle,
        accuracy,
        durationMs,
        dayKey,
        isPersonalBest,
        globalRankToday,
        globalPlayersToday,
        globalRankAllTime,
        previousBest: priorBest?.solved ?? null,
      },
    });
  } catch (error) {
    console.error("Puzzle rush submit error:", error);
    res.status(500).json({ success: false, message: "Failed to submit rush run" });
  }
});

/**
 * GET /api/puzzle-rush/leaderboard?mode=180|300&scope=global|friends&period=today|all&limit=50
 */
router.get("/leaderboard", auth, async (req, res) => {
  try {
    const modeSeconds = Number(req.query.mode || 180);
    if (!VALID_MODES.has(modeSeconds)) {
      return res.status(400).json({
        success: false,
        message: "mode must be 180 or 300",
      });
    }
    const scope = String(req.query.scope || "global") === "friends" ? "friends" : "global";
    const period = String(req.query.period || "all") === "today" ? "today" : "all";
    const limit = clampInt(req.query.limit, 1, 100, 50);
    const dayKey = utcDayKey();

    const match = { modeSeconds };
    if (period === "today") match.dayKey = dayKey;

    let friendIds = [];
    if (scope === "friends") {
      const me = await User.findById(req.user._id).select("friends").lean();
      friendIds = (me?.friends || []).map((id) => id);
      // Include self so you appear on friends board
      friendIds.push(req.user._id);
      match.user = { $in: friendIds };
    }

    const rows = await PuzzleRushRun.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$user",
          best: { $max: "$solved" },
          bestStreak: { $max: "$bestStreak" },
          accuracy: { $max: "$accuracy" },
          lastAt: { $max: "$createdAt" },
        },
      },
      { $sort: { best: -1, lastAt: 1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userDoc",
        },
      },
      { $unwind: "$userDoc" },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          username: "$userDoc.username",
          displayName: "$userDoc.displayName",
          avatar: "$userDoc.avatar",
          solved: "$best",
          bestStreak: 1,
          accuracy: 1,
          lastAt: 1,
        },
      },
    ]);

    const meId = String(req.user._id);
    const entries = rows.map((r, i) => ({
      rank: i + 1,
      userId: String(r.userId),
      username: r.username,
      displayName: r.displayName || r.username,
      avatar: r.avatar || null,
      solved: r.solved,
      bestStreak: r.bestStreak || 0,
      accuracy: r.accuracy || 0,
      isYou: String(r.userId) === meId,
      isFriend: scope === "friends" || friendIds.some((id) => String(id) === String(r.userId)),
    }));

    // Your rank if not in top list
    let yourEntry = entries.find((e) => e.isYou) || null;
    if (!yourEntry) {
      const myBest = await PuzzleRushRun.findOne({
        user: req.user._id,
        modeSeconds,
        ...(period === "today" ? { dayKey } : {}),
      })
        .sort({ solved: -1 })
        .select("solved bestStreak accuracy")
        .lean();

      if (myBest) {
        const better = await PuzzleRushRun.aggregate([
          {
            $match: {
              modeSeconds,
              ...(period === "today" ? { dayKey } : {}),
              ...(scope === "friends" ? { user: { $in: friendIds } } : {}),
            },
          },
          { $group: { _id: "$user", best: { $max: "$solved" } } },
          { $match: { best: { $gt: myBest.solved } } },
          { $count: "n" },
        ]);
        yourEntry = {
          rank: (better[0]?.n || 0) + 1,
          userId: meId,
          username: req.user.username,
          displayName: req.user.displayName || req.user.username,
          avatar: req.user.avatar || null,
          solved: myBest.solved,
          bestStreak: myBest.bestStreak || 0,
          accuracy: myBest.accuracy || 0,
          isYou: true,
          isFriend: true,
        };
      }
    }

    res.json({
      success: true,
      data: {
        modeSeconds,
        scope,
        period,
        dayKey,
        entries,
        you: yourEntry,
      },
    });
  } catch (error) {
    console.error("Puzzle rush leaderboard error:", error);
    res.status(500).json({ success: false, message: "Failed to load leaderboard" });
  }
});

/**
 * GET /api/puzzle-rush/me/best
 */
router.get("/me/best", auth, async (req, res) => {
  try {
    const modes = [180, 300];
    const out = {};
    for (const modeSeconds of modes) {
      const best = await PuzzleRushRun.findOne({
        user: req.user._id,
        modeSeconds,
      })
        .sort({ solved: -1, createdAt: 1 })
        .lean();
      out[String(modeSeconds)] = best
        ? {
            solved: best.solved,
            accuracy: best.accuracy,
            bestStreak: best.bestStreak,
            wrongCount: best.wrongCount,
            createdAt: best.createdAt,
          }
        : null;
    }
    res.json({ success: true, data: out });
  } catch (error) {
    console.error("Puzzle rush me/best error:", error);
    res.status(500).json({ success: false, message: "Failed to load best scores" });
  }
});

module.exports = router;
