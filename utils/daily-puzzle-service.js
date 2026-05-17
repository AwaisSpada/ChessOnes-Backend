const DailyPuzzle = require("../models/DailyPuzzle");
const DailyPuzzleAssignment = require("../models/DailyPuzzleAssignment");
const DailyPuzzleUserProgress = require("../models/DailyPuzzleUserProgress");
const User = require("../models/User");
const {
  todayDateKey,
  addDaysToDateKey,
  isFutureDateKey,
  isValidDateKey,
  isBeforeLaunchDateKey,
} = require("./daily-puzzle-dates");

async function pickUnusedPuzzle() {
  return DailyPuzzle.findOne({ usedOnDateKey: null })
    .sort({ importOrder: 1, createdAt: 1 })
    .exec();
}

/**
 * Assign the next unused pool puzzle to `dateKey` if not already assigned.
 * Never reuses a puzzle that was assigned before.
 */
async function ensureAssignmentForDate(dateKey) {
  if (!isValidDateKey(dateKey)) {
    throw new Error("Invalid date key");
  }
  if (isFutureDateKey(dateKey)) {
    return null;
  }
  if (isBeforeLaunchDateKey(dateKey)) {
    return null;
  }

  const existing = await DailyPuzzleAssignment.findOne({ dateKey }).populate(
    "puzzle"
  );
  if (existing) return existing;

  const puzzle = await pickUnusedPuzzle();
  if (!puzzle) {
    return null;
  }

  puzzle.usedOnDateKey = dateKey;
  await puzzle.save();

  return DailyPuzzleAssignment.create({
    dateKey,
    puzzle: puzzle._id,
  }).then((doc) => doc.populate("puzzle"));
}

async function getUserProgress(userId, dateKey) {
  if (!userId) return null;
  return DailyPuzzleUserProgress.findOne({ user: userId, dateKey }).lean();
}

function computeDisplayStreak(user) {
  const streak = user?.dailyPuzzleStreak ?? 0;
  const last = user?.dailyPuzzleLastStreakDate;
  if (!last || streak <= 0) return 0;

  const today = todayDateKey();
  const yesterday = addDaysToDateKey(today, -1);
  if (last === today || last === yesterday) return streak;
  return 0;
}

/**
 * Streak only advances when solving today's puzzle on today's calendar day.
 */
async function applyDailyStreakOnSolve(user, solvedDateKey) {
  const today = todayDateKey();
  if (solvedDateKey !== today) return user;

  const last = user.dailyPuzzleLastStreakDate;
  if (last === today) return user;

  const yesterday = addDaysToDateKey(today, -1);
  if (last === yesterday) {
    user.dailyPuzzleStreak = (user.dailyPuzzleStreak || 0) + 1;
  } else {
    user.dailyPuzzleStreak = 1;
  }
  user.dailyPuzzleLastStreakDate = today;
  await user.save();
  return user;
}

async function markSolved({ userId, dateKey, timeSpent = 0 }) {
  let progress = await DailyPuzzleUserProgress.findOne({
    user: userId,
    dateKey,
  });

  if (progress?.solved) {
    return { progress, alreadySolved: true };
  }

  if (!progress) {
    progress = new DailyPuzzleUserProgress({
      user: userId,
      dateKey,
      solved: true,
      solvedAt: new Date(),
      timeSpent,
    });
  } else {
    progress.solved = true;
    progress.solvedAt = new Date();
    progress.timeSpent = timeSpent || progress.timeSpent;
  }
  await progress.save();

  const user = await User.findById(userId);
  if (user) {
    await applyDailyStreakOnSolve(user, dateKey);
  }

  return { progress, alreadySolved: false };
}

async function getCalendarForUser(userId, { fromKey, toKey }) {
  const assignments = await DailyPuzzleAssignment.find({
    dateKey: { $gte: fromKey, $lte: toKey },
  })
    .select("dateKey")
    .lean();

  const progressList = userId
    ? await DailyPuzzleUserProgress.find({
        user: userId,
        dateKey: { $gte: fromKey, $lte: toKey },
        solved: true,
      })
        .select("dateKey solved solvedAt")
        .lean()
    : [];

  const solvedSet = new Set(progressList.map((p) => p.dateKey));
  const assignedSet = new Set(assignments.map((a) => a.dateKey));

  const days = [];
  let cursor = fromKey;
  while (cursor <= toKey) {
    const available =
      !isBeforeLaunchDateKey(cursor) && !isFutureDateKey(cursor);
    days.push({
      dateKey: cursor,
      assigned: available && assignedSet.has(cursor),
      solved: solvedSet.has(cursor),
      available,
    });
    cursor = addDaysToDateKey(cursor, 1);
  }

  return days;
}

module.exports = {
  ensureAssignmentForDate,
  getUserProgress,
  markSolved,
  getCalendarForUser,
  computeDisplayStreak,
  pickUnusedPuzzle,
};
