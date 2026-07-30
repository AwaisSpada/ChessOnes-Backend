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

async function computeDisplayStreak(userOrId) {
  const userId = userOrId?._id || userOrId?.id || userOrId;
  if (!userId) return 0;

  const today = todayDateKey();
  const fromKey = addDaysToDateKey(today, -365);

  const progressList = await DailyPuzzleUserProgress.find({
    user: userId,
    dateKey: { $gte: fromKey, $lte: today },
    solved: true,
  })
    .select("dateKey")
    .lean();

  const solvedSet = new Set(progressList.map((p) => p.dateKey));
  // End-of-day grace: until today is solved, keep showing the chain from
  // yesterday if yesterday was solved (user still has the rest of today).
  const yesterday = addDaysToDateKey(today, -1);
  let cursor = null;
  if (solvedSet.has(today)) cursor = today;
  else if (solvedSet.has(yesterday)) cursor = yesterday;

  let count = 0;
  const newestInChain = cursor;
  while (cursor && solvedSet.has(cursor)) {
    count += 1;
    cursor = addDaysToDateKey(cursor, -1);
  }

  // If we were called with a real user document, keep DB fields in sync.
  if (userOrId && typeof userOrId.save === "function") {
    const expectedLast = count > 0 ? newestInChain : null;

    const currentStreak = userOrId.dailyPuzzleStreak ?? 0;
    const currentLast = userOrId.dailyPuzzleLastStreakDate ?? null;

    const shouldUpdate = currentStreak !== count || currentLast !== expectedLast;
    if (shouldUpdate) {
      userOrId.dailyPuzzleStreak = count;
      userOrId.dailyPuzzleLastStreakDate = expectedLast;
      await userOrId.save();
    }
  }

  return count;
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
