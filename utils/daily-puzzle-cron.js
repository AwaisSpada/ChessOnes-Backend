const { ensureAssignmentForDate } = require("./daily-puzzle-service");
const {
  initLaunchDateKey,
  backfillDailyPuzzlesSinceLaunch,
} = require("./daily-puzzle-launch");
const {
  todayDateKey,
  getLaunchDateKey,
  msUntilNextUtcMidnight,
} = require("./daily-puzzle-dates");

async function assignTodayDailyPuzzle() {
  const today = todayDateKey();
  const assignment = await ensureAssignmentForDate(today);
  if (assignment) {
    console.log(`📅 Daily puzzle assigned for ${today}`);
  } else {
    console.warn(`📅 No daily puzzle assigned for ${today} (pool empty or before launch)`);
  }
  return assignment;
}

/**
 * At each UTC midnight, assign that calendar day's puzzle from the DailyPuzzle pool.
 * Also assigns today once on startup if today >= launch and not yet assigned.
 */
async function startDailyPuzzleMidnightScheduler() {
  await initLaunchDateKey();
  await backfillDailyPuzzlesSinceLaunch();

  const launch = getLaunchDateKey();
  console.log(`📅 Daily puzzle launch date (UTC): ${launch}`);

  assignTodayDailyPuzzle().catch((err) => {
    console.error("[Daily Puzzle] startup assignment failed:", err);
  });

  const delay = msUntilNextUtcMidnight();
  console.log(
    `📅 Next daily puzzle rotation in ${Math.round(delay / 60000)} minutes (UTC midnight)`,
  );

  setTimeout(() => {
    assignTodayDailyPuzzle().catch((err) => {
      console.error("[Daily Puzzle] midnight assignment failed:", err);
    });
    setInterval(() => {
      assignTodayDailyPuzzle().catch((err) => {
        console.error("[Daily Puzzle] midnight assignment failed:", err);
      });
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

module.exports = { startDailyPuzzleMidnightScheduler, assignTodayDailyPuzzle };
