const DailyPuzzleAssignment = require("../models/DailyPuzzleAssignment");
const { ensureAssignmentForDate } = require("./daily-puzzle-service");
const {
  todayDateKey,
  addDaysToDateKey,
  isValidDateKey,
  setLaunchDateKeyCache,
  getLaunchDateKey,
} = require("./daily-puzzle-dates");

/**
 * Resolve launch date: env wins, else earliest assignment in DB, else today.
 */
async function initLaunchDateKey() {
  const fromEnv = process.env.DAILY_PUZZLE_LAUNCH_DATE;
  if (fromEnv && isValidDateKey(fromEnv)) {
    setLaunchDateKeyCache(fromEnv);
    return fromEnv;
  }

  const earliest = await DailyPuzzleAssignment.findOne()
    .sort({ dateKey: 1 })
    .select("dateKey")
    .lean();

  if (earliest?.dateKey) {
    setLaunchDateKeyCache(earliest.dateKey);
    return earliest.dateKey;
  }

  const today = todayDateKey();
  setLaunchDateKeyCache(today);
  return today;
}

/** Ensure every day from launch through today has a puzzle assigned (backfill missed days). */
async function backfillDailyPuzzlesSinceLaunch() {
  const launch = getLaunchDateKey();
  const today = todayDateKey();
  if (launch > today) return;

  let cursor = launch;
  let assigned = 0;
  while (cursor <= today) {
    const doc = await ensureAssignmentForDate(cursor);
    if (doc) assigned += 1;
    cursor = addDaysToDateKey(cursor, 1);
  }
  console.log(
    `📅 Daily puzzle backfill ${launch} → ${today}: ${assigned} day(s) with assignments`,
  );
}

module.exports = { initLaunchDateKey, backfillDailyPuzzlesSinceLaunch };
