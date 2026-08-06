/**
 * Phase 3 AbandonManager — first-move abandon + disconnect grace ownership.
 * NEVER inspects chess clocks / timeRemaining / flag deadlines.
 */

const ReconnectManager = require("./ReconnectManager");
const LiveGameManager = require("./LiveGameManager");
const ClockScheduler = require("./ClockScheduler");
const liveGameEnd = require("./liveGameEnd");

/** Match mobile/web useFirstMoveAbandonTimer totals (seconds → ms). */
const ABANDON_WINDOW_MS = {
  bullet: 15_000,
  blitz: 20_000,
  rapid: 25_000,
};

function abandonWindowMsForCategory(category) {
  if (category && ABANDON_WINDOW_MS[category] != null) {
    return ABANDON_WINDOW_MS[category];
  }
  return ABANDON_WINDOW_MS.blitz;
}

function resolveCategory(live) {
  if (live?.category && ABANDON_WINDOW_MS[live.category] != null) {
    return live.category;
  }
  const initial = live?.timeControl?.initial;
  if (typeof initial !== "number" || !Number.isFinite(initial) || initial <= 0) {
    return null;
  }
  const minutes = initial / 60000;
  if (minutes < 3) return "bullet";
  if (minutes < 10) return "blitz";
  return "rapid";
}

/**
 * Absolute deadline for first-move abandon, or null if not applicable.
 * White ply0: clockStartedAt + window
 * Black ply1: last move timestamp + window (fresh)
 * ply >= 2: none
 */
function abandonDeadlineMs(live, _now = Date.now()) {
  if (!live || live.status !== "active") return null;
  if (live.type !== "multiplayer" && live.type !== "friend") return null;

  const ply = Array.isArray(live.moves) ? live.moves.length : 0;
  if (ply >= 2) return null;

  const category = resolveCategory(live);
  if (!category) return null;
  const windowMs = abandonWindowMsForCategory(category);

  if (ply === 0) {
    if (live.currentTurn !== "white") return null;
    if (!live.clockStartedAt) return null;
    const start = new Date(live.clockStartedAt).getTime();
    if (!Number.isFinite(start)) return null;
    return start + windowMs;
  }

  if (live.currentTurn !== "black") return null;
  const last = live.moves[live.moves.length - 1];
  if (!last?.timestamp) return null;
  const anchor = new Date(last.timestamp).getTime();
  if (!Number.isFinite(anchor)) return null;
  return anchor + windowMs;
}

function shouldAbandonNow(live, now = Date.now()) {
  const deadline = abandonDeadlineMs(live, now);
  if (deadline == null) return false;
  return now >= deadline;
}

/**
 * Scheduler callback — revalidate ply/turn/deadline; never inspect chess clocks.
 */
async function onFirstMoveAbandonFire(gameId) {
  if (!ClockScheduler.isArmed()) return;

  const live = LiveGameManager.get(gameId);
  if (!live || live.status !== "active") return;

  await live.runSerialized(async () => {
    if (live.status !== "active") return;

    const now = Date.now();
    if (!shouldAbandonNow(live, now)) {
      ClockScheduler.rescheduleAll(live);
      return;
    }

    const loser = live.currentTurn === "black" ? "black" : "white";
    const winner = loser === "white" ? "black" : "white";

    await liveGameEnd.finalizeServerEnd(
      live,
      { winner, reason: "first-move-abandon" },
      { status: "abandoned" }
    );
  });
}

function scheduleDisconnectGrace(userId, gameId, graceMs) {
  return ReconnectManager.scheduleDisconnectGameEnd(userId, gameId, graceMs);
}

function cancelDisconnectGrace(userId, gameId) {
  return ReconnectManager.cancelPendingDisconnectGameEnd(userId, gameId);
}

function cancelDisconnectGraceForUser(userId) {
  return ReconnectManager.cancelPendingDisconnectEndsForUser(userId);
}

module.exports = {
  ABANDON_WINDOW_MS,
  abandonWindowMsForCategory,
  resolveCategory,
  abandonDeadlineMs,
  shouldAbandonNow,
  onFirstMoveAbandonFire,
  scheduleDisconnectGrace,
  cancelDisconnectGrace,
  cancelDisconnectGraceForUser,
  DISCONNECT_GAME_END_GRACE_MS: ReconnectManager.DISCONNECT_GAME_END_GRACE_MS,
  DISCONNECT_ARENA_GAME_END_GRACE_MS:
    ReconnectManager.DISCONNECT_ARENA_GAME_END_GRACE_MS,
};
