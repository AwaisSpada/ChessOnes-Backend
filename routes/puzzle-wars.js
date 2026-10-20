/**
 * Puzzle Wars REST — isolated from /api/puzzle-rush and /api/games.
 */
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const User = require("../models/User");
const PuzzleWarsMatch = require("../models/PuzzleWarsMatch");
const matchService = require("../services/puzzleWars/matchService");

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function clampInt(n, min, max, fallback = 0) {
  const v = Number.isFinite(Number(n)) ? Math.floor(Number(n)) : fallback;
  return Math.min(max, Math.max(min, v));
}

/**
 * GET /api/puzzle-wars/matches/:matchId
 * Authoritative match snapshot including shared puzzle sequence.
 */
router.get("/matches/:matchId", auth, async (req, res) => {
  try {
    const match = await PuzzleWarsMatch.findById(req.params.matchId);
    if (!match) {
      return res.status(404).json({ success: false, message: "Match not found" });
    }
    const uid = String(req.user._id);
    const isPlayer = match.players.some((p) => String(p.userId) === uid);
    if (!isPlayer) {
      return res.status(403).json({ success: false, message: "Not a player in this match" });
    }
    return res.json({
      success: true,
      data: matchService.serializeMatch(match, { includePuzzles: true }),
    });
  } catch (error) {
    console.error("Puzzle Wars get match error:", error);
    return res.status(500).json({ success: false, message: "Failed to load match" });
  }
});

/**
 * GET /api/puzzle-wars/lobby
 * Snapshot of open random seeks (also pushed via socket).
 */
router.get("/lobby", auth, async (_req, res) => {
  try {
    // Lobby is socket-primary; REST returns empty stub for cold start UIs.
    return res.json({ success: true, data: { seeks: [] } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load lobby" });
  }
});

/**
 * GET /api/puzzle-wars/leaderboard?scope=global|friends&period=today|all&limit=50
 * One row per user — ranked by best single-match score (not sum of games).
 * Example: scored 10 then 11 → shown as 11 only.
 */
router.get("/leaderboard", auth, async (req, res) => {
  try {
    const scope = String(req.query.scope || "global") === "friends" ? "friends" : "global";
    const period = String(req.query.period || "all") === "today" ? "today" : "all";
    const limit = clampInt(req.query.limit, 1, 100, 50);
    const dayKey = utcDayKey();

    const match = { status: "finished" };
    if (period === "today") {
      const start = new Date(`${dayKey}T00:00:00.000Z`);
      const end = new Date(`${dayKey}T23:59:59.999Z`);
      match.finishedAt = { $gte: start, $lte: end };
    }

    let friendIds = [];
    if (scope === "friends") {
      const me = await User.findById(req.user._id).select("friends").lean();
      friendIds = (me?.friends || []).map((id) => id);
      friendIds.push(req.user._id);
    }

    const pipeline = [
      { $match: match },
      { $unwind: "$players" },
    ];

    if (scope === "friends") {
      pipeline.push({ $match: { "players.userId": { $in: friendIds } } });
    }

    pipeline.push(
      {
        $group: {
          _id: "$players.userId",
          bestScore: { $max: "$players.score" },
          games: { $sum: 1 },
          wins: {
            $sum: {
              $cond: [{ $eq: ["$winnerId", "$players.userId"] }, 1, 0],
            },
          },
          lastAt: { $max: "$finishedAt" },
        },
      },
      // Highest best match points first; one entry per user.
      { $sort: { bestScore: -1, lastAt: 1 } },
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
          fullName: "$userDoc.fullName",
          avatar: "$userDoc.avatar",
          bestScore: 1,
          games: 1,
          wins: 1,
          lastAt: 1,
        },
      }
    );

    const rows = await PuzzleWarsMatch.aggregate(pipeline);
    const meId = String(req.user._id);
    const friendIdSet = new Set(friendIds.map((id) => String(id)));

    const entries = rows.map((r, i) => ({
      rank: i + 1,
      userId: String(r.userId),
      username: r.username,
      displayName: r.fullName || r.username,
      avatar: r.avatar || null,
      bestScore: r.bestScore || 0,
      games: r.games || 0,
      wins: r.wins || 0,
      draws: 0,
      isYou: String(r.userId) === meId,
      isFriend: scope === "friends" || friendIdSet.has(String(r.userId)),
    }));

    let yourEntry = entries.find((e) => e.isYou) || null;
    if (!yourEntry) {
      const myPipe = [
        { $match: match },
        { $unwind: "$players" },
        { $match: { "players.userId": req.user._id } },
        {
          $group: {
            _id: "$players.userId",
            bestScore: { $max: "$players.score" },
            games: { $sum: 1 },
            wins: {
              $sum: {
                $cond: [{ $eq: ["$winnerId", "$players.userId"] }, 1, 0],
              },
            },
          },
        },
      ];
      const mine = await PuzzleWarsMatch.aggregate(myPipe);
      const myRow = mine[0];
      if (myRow) {
        const betterPipe = [
          { $match: match },
          { $unwind: "$players" },
        ];
        if (scope === "friends") {
          betterPipe.push({ $match: { "players.userId": { $in: friendIds } } });
        }
        betterPipe.push(
          {
            $group: {
              _id: "$players.userId",
              bestScore: { $max: "$players.score" },
            },
          },
          { $match: { bestScore: { $gt: myRow.bestScore || 0 } } },
          { $count: "n" }
        );
        const better = await PuzzleWarsMatch.aggregate(betterPipe);
        yourEntry = {
          rank: (better[0]?.n || 0) + 1,
          userId: meId,
          username: req.user.username,
          displayName: req.user.fullName || req.user.username,
          avatar: req.user.avatar || null,
          bestScore: myRow.bestScore || 0,
          games: myRow.games || 0,
          wins: myRow.wins || 0,
          draws: 0,
          isYou: true,
          isFriend: true,
        };
      }
    }

    return res.json({
      success: true,
      data: {
        scope,
        period,
        dayKey,
        entries,
        you: yourEntry,
      },
    });
  } catch (error) {
    console.error("Puzzle Wars leaderboard error:", error);
    return res.status(500).json({ success: false, message: "Failed to load leaderboard" });
  }
});

module.exports = router;
