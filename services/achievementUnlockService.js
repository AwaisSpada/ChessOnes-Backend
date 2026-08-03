const User = require("../models/User");
const Stats = require("../models/Stats");
const Game = require("../models/Game");
const PuzzleAttempt = require("../models/PuzzleAttempt");
const { ACHIEVEMENTS, CATEGORIES } = require("../constants/achievementsCatalog");

/** Matches updateGameRatings / client star: provisional until 5 rated games in that TC. */
const RATING_CONFIRM_GAMES = 5;

function accountYears(createdAt) {
  if (!createdAt) return 0;
  const start = new Date(createdAt).getTime();
  if (!Number.isFinite(start)) return 0;
  const ms = Date.now() - start;
  return Math.max(0, Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000)));
}

function isRatingConfirmed(user, timeControl) {
  const games = user?.ratings?.[timeControl]?.gamesPlayed;
  return typeof games === "number" && games >= RATING_CONFIRM_GAMES;
}

/**
 * Resolve a dotted path against stats + user + extras.
 * wins.* → rated online wins only (extras.ratedWins)
 * ratings.* → rating value (unlock gated separately via confirmation)
 */
function resolveStatValue(path, stats, user, extras = {}) {
  if (!path) return 0;

  if (path === "puzzles.solved") {
    return typeof extras.puzzlesSolved === "number" ? extras.puzzlesSolved : 0;
  }
  if (path === "account.years") {
    return accountYears(user?.createdAt);
  }

  if (path.startsWith("ratings.")) {
    const tc = path.split(".")[1];
    const rating = user?.ratings?.[tc]?.rating;
    return typeof rating === "number" ? rating : 0;
  }

  if (path.startsWith("wins.")) {
    const key = path.split(".")[1]; // bullet | blitz | rapid | total
    const rated = extras.ratedWins || {};
    if (key === "total") {
      return (
        (rated.bullet || 0) + (rated.blitz || 0) + (rated.rapid || 0)
      );
    }
    return rated[key] || 0;
  }

  if (path === "bestStreak") return stats?.bestStreak || 0;
  if (path === "currentStreak") return stats?.currentStreak || 0;

  const parts = path.split(".");
  let cur = stats;
  for (const part of parts) {
    if (cur == null) return 0;
    cur = cur[part];
  }
  return typeof cur === "number" ? cur : 0;
}

function ruleSatisfied(rule, stats, user, extras = {}) {
  if (!rule || rule.type !== "stat") return false;

  // Rating milestones: never while provisional (★); once confirmed, all
  // thresholds ≤ current rating unlock (and stay unlocked forever).
  if (rule.path && rule.path.startsWith("ratings.")) {
    const tc = rule.path.split(".")[1];
    if (!isRatingConfirmed(user, tc)) return false;
  }

  const current = resolveStatValue(rule.path, stats, user, extras);
  if (rule.op === "gte") return current >= rule.value;
  if (rule.op === "exact") return current === rule.value;
  return false;
}

function assetUrlFor(assetKey) {
  return `/badges/${assetKey}.png`;
}

/**
 * Count wins in rated human-vs-human games only (multiplayer + friend).
 * Bot / unrated / casual never count toward win achievements.
 */
async function loadRatedWinCounts(userId) {
  const mongoose = require("mongoose");
  const oid =
    userId instanceof mongoose.Types.ObjectId
      ? userId
      : new mongoose.Types.ObjectId(String(userId));
  const uid = String(oid);

  const rows = await Game.aggregate([
    {
      $match: {
        status: "completed",
        isRated: true,
        type: { $in: ["multiplayer", "friend"] },
        category: { $in: ["bullet", "blitz", "rapid"] },
        "result.winner": { $in: ["white", "black"] },
        $or: [{ "players.white": oid }, { "players.black": oid }],
      },
    },
    {
      $project: {
        category: 1,
        isWhiteWin: {
          $and: [
            { $eq: ["$result.winner", "white"] },
            { $eq: [{ $toString: "$players.white" }, uid] },
          ],
        },
        isBlackWin: {
          $and: [
            { $eq: ["$result.winner", "black"] },
            { $eq: [{ $toString: "$players.black" }, uid] },
          ],
        },
      },
    },
    {
      $match: {
        $or: [{ isWhiteWin: true }, { isBlackWin: true }],
      },
    },
    {
      $group: {
        _id: "$category",
        count: { $sum: 1 },
      },
    },
  ]);

  const ratedWins = { bullet: 0, blitz: 0, rapid: 0 };
  for (const row of rows) {
    if (row._id && Object.prototype.hasOwnProperty.call(ratedWins, row._id)) {
      ratedWins[row._id] = row.count;
    }
  }
  return ratedWins;
}

async function loadExtras(userId) {
  const [puzzlesSolved, ratedWins] = await Promise.all([
    PuzzleAttempt.countDocuments({ user: userId, solved: true }),
    loadRatedWinCounts(userId),
  ]);
  return { puzzlesSolved, ratedWins };
}

/**
 * Persist newly qualified catalog achievements and emit ACHIEVEMENT_UNLOCKED.
 * Never revokes existing unlocks (rating drop / loss streak cannot remove badges).
 */
async function checkAndUnlockAchievements(userId, io = null) {
  const user = await User.findById(userId);
  if (!user) return [];

  const stats = await Stats.findOne({ user: userId });
  const extras = await loadExtras(userId);

  if (!Array.isArray(user.unlockedAchievements)) {
    user.unlockedAchievements = [];
  }

  const already = new Set(
    user.unlockedAchievements.map((entry) => String(entry.id)),
  );
  const newlyUnlocked = [];

  for (const def of ACHIEVEMENTS) {
    if (already.has(def.id)) continue;
    if (!ruleSatisfied(def.rule, stats || {}, user, extras)) continue;

    const unlockedAt = new Date();
    user.unlockedAchievements.push({ id: def.id, unlockedAt });
    already.add(def.id);
    newlyUnlocked.push({
      id: def.id,
      category: def.category,
      title: def.title,
      description: def.description,
      assetKey: def.assetKey,
      pill: def.pill,
      assetUrl: assetUrlFor(def.assetKey),
      unlockedAt,
    });
  }

  if (newlyUnlocked.length > 0) {
    await user.save();
    if (io) {
      for (const item of newlyUnlocked) {
        io.to(`user:${userId}`).emit("ACHIEVEMENT_UNLOCKED", {
          achievement: item,
          unlockedAt: item.unlockedAt,
        });
      }
    }
  }

  return newlyUnlocked;
}

async function buildAchievementsPayload(userId) {
  await checkAndUnlockAchievements(userId, null);

  const user = await User.findById(userId).lean();
  if (!user) return null;

  const stats = (await Stats.findOne({ user: userId }).lean()) || {
    wins: {},
    gamesPlayed: {},
    bestStreak: 0,
    currentStreak: 0,
  };
  const extras = await loadExtras(userId);

  const unlockedMap = new Map(
    (user.unlockedAchievements || []).map((entry) => [
      String(entry.id),
      entry.unlockedAt,
    ]),
  );

  const items = ACHIEVEMENTS.map((def) => {
    const progress = resolveStatValue(def.rule.path, stats, user, extras);
    const target = def.rule.value;
    const unlocked =
      unlockedMap.has(def.id) || ruleSatisfied(def.rule, stats, user, extras);

    // For display: provisional ratings still show numeric progress, but stay locked.
    const ratingPath =
      def.rule.path && def.rule.path.startsWith("ratings.")
        ? def.rule.path.split(".")[1]
        : null;
    const ratingConfirmed = ratingPath
      ? isRatingConfirmed(user, ratingPath)
      : true;

    return {
      id: def.id,
      category: def.category,
      title: def.title,
      description: def.description,
      assetKey: def.assetKey,
      pill: def.pill,
      assetUrl: assetUrlFor(def.assetKey),
      unlocked,
      unlockedAt: unlockedMap.get(def.id) || null,
      progress: Math.min(progress, target),
      target,
      ...(ratingPath
        ? { ratingConfirmed, provisional: !ratingConfirmed }
        : {}),
    };
  });

  const unlockedCount = items.filter((i) => i.unlocked).length;

  return {
    categories: CATEGORIES,
    items,
    summary: {
      unlocked: unlockedCount,
      total: items.length,
      percent:
        items.length === 0
          ? 0
          : Math.round((unlockedCount / items.length) * 100),
    },
  };
}

module.exports = {
  checkAndUnlockAchievements,
  buildAchievementsPayload,
  resolveStatValue,
  ruleSatisfied,
  isRatingConfirmed,
  assetUrlFor,
  loadRatedWinCounts,
  RATING_CONFIRM_GAMES,
};
