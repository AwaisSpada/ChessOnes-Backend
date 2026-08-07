/**
 * Phase 3 ClockScheduler — owns all live timer handles.
 * Schedules from absolute deadlineMs only. No chess logic.
 *
 * Future (Phase 6, docs only): optional coarse periodic sweeper as safety net.
 * Primary detection remains absolute-deadline setTimeout.
 */

const {
  LIVE_SERVER_TIMEOUTS,
  LIVE_MEMORY_SNAPSHOT,
} = require("./flags");
const ClockAuthority = require("./ClockAuthority");

/** @type {Map<string, { flag?: { deadlineMs: number, handle: NodeJS.Timeout }, abandon?: { deadlineMs: number, handle: NodeJS.Timeout } }>} */
const timers = new Map();

function isArmed() {
  return LIVE_SERVER_TIMEOUTS === true && LIVE_MEMORY_SNAPSHOT === true;
}

function clearKind(entry, kind) {
  if (!entry?.[kind]) return;
  clearTimeout(entry[kind].handle);
  delete entry[kind];
}

function cancel(gameId) {
  const id = String(gameId);
  const entry = timers.get(id);
  if (!entry) return;
  clearKind(entry, "flag");
  clearKind(entry, "abandon");
  timers.delete(id);
}

function getOrCreate(gameId) {
  const id = String(gameId);
  let entry = timers.get(id);
  if (!entry) {
    entry = {};
    timers.set(id, entry);
  }
  return entry;
}

/**
 * Arm a single absolute-deadline timer.
 * delay = max(0, deadlineMs - now); deadline itself is never drift-chained.
 */
function arm(gameId, kind, deadlineMs, onFire) {
  const id = String(gameId);
  const entry = getOrCreate(id);
  clearKind(entry, kind);

  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return;

  const now = Date.now();
  const delay = Math.max(0, deadlineMs - now);
  const handle = setTimeout(() => {
    const current = timers.get(id);
    // Only the latest armed handle may execute — ignore stale callbacks.
    if (current?.[kind]?.handle !== handle) return;
    clearKind(current, kind);
    if (!current.flag && !current.abandon) timers.delete(id);
    try {
      onFire(id, deadlineMs);
    } catch (err) {
      console.error(
        `[ClockScheduler] ${kind} fire failed game=${id}:`,
        err?.message || err
      );
    }
  }, delay);

  entry[kind] = { deadlineMs, handle };
}

function rescheduleFlag(live) {
  if (!isArmed() || !live?.gameId) return;
  const id = String(live.gameId);
  const entry = getOrCreate(id);
  clearKind(entry, "flag");

  if (live.status !== "active") return;

  const now = Date.now();
  const deadlineMs = ClockAuthority.flagDeadlineMs(live, now);
  if (deadlineMs == null) return;

  arm(id, "flag", deadlineMs, () => {
    void require("./TimeoutManager").onFlag(id);
  });
}

function rescheduleAbandon(live) {
  if (!isArmed() || !live?.gameId) return;
  const id = String(live.gameId);
  const entry = getOrCreate(id);
  clearKind(entry, "abandon");

  if (live.status !== "active") return;

  const now = Date.now();
  const deadlineMs = require("./AbandonManager").abandonDeadlineMs(live, now);
  if (deadlineMs == null) return;

  arm(id, "abandon", deadlineMs, () => {
    void require("./AbandonManager").onFirstMoveAbandonFire(id);
  });
}

/**
 * Recreate all timers from current LiveGame state.
 * Safe after move, startClocks, hydrate, reconnect, and process restart.
 */
function rescheduleAll(live) {
  if (!isArmed() || !live?.gameId) return;
  if (live.status !== "active") {
    cancel(live.gameId);
    return;
  }
  rescheduleFlag(live);
  rescheduleAbandon(live);
}

function getDebugState(gameId) {
  const entry = timers.get(String(gameId));
  if (!entry) return null;
  return {
    flagDeadlineMs: entry.flag?.deadlineMs ?? null,
    abandonDeadlineMs: entry.abandon?.deadlineMs ?? null,
  };
}

module.exports = {
  isArmed,
  cancel,
  rescheduleFlag,
  rescheduleAbandon,
  rescheduleAll,
  getDebugState,
  FUTURE_COARSE_SWEEPER:
    "Phase 6 optional periodic safety net — not implemented in Phase 3",
};
