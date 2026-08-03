const User = require("../models/User");
const Stats = require("../models/Stats");
const PuzzleAttempt = require("../models/PuzzleAttempt");
const { ACHIEVEMENTS, CATEGORIES } = require("../constants/achievementsCatalog");

function accountYears(createdAt) {
  if (!createdAt) return 0;
  const start = new Date(createdAt).getTime();
  if (!Number.isFinite(start)) return 0;
  const ms = Date.now() - start;
  return Math.max(0, Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000)));
}

/**
 * Resolve a dotted path against stats + user + extras.
 * Supports: wins.*, ratings.*, puzzles.solved, account.years, bestStreak, currentStreak
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
  const current = resolveStatValue(rule.path, stats, user, extras);
  if (rule.op === "gte") return current >= rule.value;
  if (rule.op === "exact") return current === rule.value;
  return false;
}

function assetUrlFor(assetKey) {
  return `/badges/${assetKey}.png`;
}

async function loadExtras(userId) {
  const puzzlesSolved = await PuzzleAttempt.countDocuments({
    user: userId,
    solved: true,
  });
  return { puzzlesSolved };
}

/**
 * Persist newly qualified catalog achievements and emit ACHIEVEMENT_UNLOCKED.
 */
async function checkAndUnlockAchievements(userId, io = null) {
  const user = await User.findById(userId);
  if (!user) return [];

  const stats = await Stats.findOne({ user: userId });
  // Stats optional for puzzle/anniversary-only unlocks
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
  assetUrlFor,
};
