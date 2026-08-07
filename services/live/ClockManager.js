/**
 * Phase 0 ClockManager — facade only.
 * Delegates to utils/liveGameSync.js and utils/clockIncrement.js with identical semantics.
 * No new clock formulas. No LiveGame. No timers.
 */

const liveGameSync = require("../../utils/liveGameSync");
const clockIncrement = require("../../utils/clockIncrement");

module.exports = {
  isLiveHumanGame: liveGameSync.isLiveHumanGame,
  ensureTimeRemaining: liveGameSync.ensureTimeRemaining,
  getEffectiveTimeRemaining: liveGameSync.getEffectiveTimeRemaining,
  applyServerElapsedClock: liveGameSync.applyServerElapsedClock,
  commitElapsedClock: liveGameSync.commitElapsedClock,
  bumpSyncVersion: liveGameSync.bumpSyncVersion,
  getPly: liveGameSync.getPly,
  buildLiveSyncFields: liveGameSync.buildLiveSyncFields,
  withLiveSync: liveGameSync.withLiveSync,

  normalizeIncrementToMs: clockIncrement.normalizeIncrementToMs,
  applyFischerIncrementToMover: clockIncrement.applyFischerIncrementToMover,
};
