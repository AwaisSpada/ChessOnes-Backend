/** Platform daily puzzle calendar uses UTC date keys (YYYY-MM-DD). */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function todayDateKey() {
  return toDateKey(new Date());
}

function parseDateKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysToDateKey(dateKey, days) {
  const d = parseDateKey(dateKey);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateKey(d);
}

function isFutureDateKey(dateKey) {
  return dateKey > todayDateKey();
}

function isValidDateKey(dateKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) && !Number.isNaN(parseDateKey(dateKey).getTime());
}

/** Set at startup from env or earliest assignment in DB (see daily-puzzle-launch.js). */
let launchDateKeyCache = null;

function setLaunchDateKeyCache(dateKey) {
  if (dateKey && isValidDateKey(dateKey)) {
    launchDateKeyCache = dateKey;
  }
}

/**
 * First calendar day the daily puzzle feature is live (YYYY-MM-DD, UTC).
 * Prefer DAILY_PUZZLE_LAUNCH_DATE in .env; else earliest assignment date after init.
 */
function getLaunchDateKey() {
  if (launchDateKeyCache) return launchDateKeyCache;
  const fromEnv = process.env.DAILY_PUZZLE_LAUNCH_DATE;
  if (fromEnv && isValidDateKey(fromEnv)) return fromEnv;
  return todayDateKey();
}

function isBeforeLaunchDateKey(dateKey) {
  return dateKey < getLaunchDateKey();
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return Math.max(0, next.getTime() - now.getTime());
}

module.exports = {
  toDateKey,
  todayDateKey,
  parseDateKey,
  addDaysToDateKey,
  isFutureDateKey,
  isValidDateKey,
  getLaunchDateKey,
  setLaunchDateKeyCache,
  isBeforeLaunchDateKey,
  msUntilNextUtcMidnight,
};
