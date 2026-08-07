/**
 * Phase 3 ClockAuthority — sole chess-time calculator for the live layer.
 * Delegates formulas to ClockManager (liveGameSync + increment). Never schedules timers.
 */

const ClockManager = require("./ClockManager");

function isLiveHumanGame(game) {
  return ClockManager.isLiveHumanGame(game);
}

function ensureTimeRemaining(game, fallbackMs) {
  return ClockManager.ensureTimeRemaining(game, fallbackMs);
}

function activeSide(game) {
  return game?.currentTurn === "black" ? "black" : "white";
}

function isUntimed(game) {
  const initial = game?.timeControl?.initial;
  return typeof initial === "number" && initial <= 0;
}

function effectiveRemaining(game, now = Date.now()) {
  return ClockManager.getEffectiveTimeRemaining(game, now);
}

/**
 * Compute drain for the side to move — does NOT mutate storedRemaining.
 * @returns {{ timedOut: boolean, elapsedMs: number, side: string, remainingMs?: number }}
 */
function drainSideToMove(game, now = Date.now()) {
  return ClockManager.applyServerElapsedClock(game, now);
}

/**
 * Commit a prior drain into storedRemaining. Pair only with a new move
 * timestamp or terminal flag in the same authoritative transition.
 */
function commitElapsedClock(game, clockResult) {
  return ClockManager.commitElapsedClock(game, clockResult);
}

function applyIncrement(game, moverColor) {
  return ClockManager.applyFischerIncrementToMover(game, moverColor);
}

function bumpSyncVersion(game) {
  return ClockManager.bumpSyncVersion(game);
}

function withLiveSync(game, payload, overrides) {
  return ClockManager.withLiveSync(game, payload, overrides);
}

function buildLiveSyncFields(game, overrides) {
  return ClockManager.buildLiveSyncFields(game, overrides);
}

/**
 * Absolute wall-clock deadline (ms since epoch) when the side to move flags.
 * Recomputed from serverNow + effective remaining — never chained drift.
 * @returns {number|null} null if no flag timer should be armed
 */
function flagDeadlineMs(game, now = Date.now()) {
  if (!game || game.status !== "active") return null;
  if (!isLiveHumanGame(game)) return null;
  if (isUntimed(game)) return null;

  const started =
    (game.moves && game.moves.length > 0) || Boolean(game.clockStartedAt);
  if (!started) return null;

  const effective = effectiveRemaining(game, now);
  const side = activeSide(game);
  const remaining = effective?.[side];
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;

  // Already flagged — fire as soon as the event loop allows.
  if (remaining <= 0) return now;

  return now + remaining;
}

module.exports = {
  isLiveHumanGame,
  ensureTimeRemaining,
  activeSide,
  isUntimed,
  effectiveRemaining,
  drainSideToMove,
  commitElapsedClock,
  applyIncrement,
  bumpSyncVersion,
  withLiveSync,
  buildLiveSyncFields,
  flagDeadlineMs,
  // Escape hatch for snapshot helpers that still expect ClockManager names:
  getEffectiveTimeRemaining: effectiveRemaining,
  applyServerElapsedClock: drainSideToMove,
  applyFischerIncrementToMover: applyIncrement,
};
