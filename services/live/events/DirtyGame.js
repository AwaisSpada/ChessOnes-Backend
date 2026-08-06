/**
 * ADR-007 DirtyGame — persistence health only. Never mutates LiveGame.
 */

const DEFAULT_ALERT_THRESHOLD = (() => {
  const n = Number(process.env.DIRTY_GAME_ALERT_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 5;
})();

/** @type {Map<string, { dirty: boolean, lastFailedSyncVersion: number|null, failCount: number, lastErrorAt: number|null, lastError: string|null, alerted: boolean }>} */
const dirtyGames = new Map();

/** Simple metrics counters */
const metrics = {
  persistFail: 0,
  dirtyMark: 0,
  dirtyClear: 0,
  alerts: 0,
};

function get(gameId) {
  return dirtyGames.get(String(gameId)) || null;
}

function mark(gameId, { syncVersion = null, error = null } = {}) {
  const id = String(gameId);
  const prev = dirtyGames.get(id) || {
    dirty: false,
    lastFailedSyncVersion: null,
    failCount: 0,
    lastErrorAt: null,
    lastError: null,
    alerted: false,
  };
  prev.dirty = true;
  prev.lastFailedSyncVersion =
    typeof syncVersion === "number" ? syncVersion : prev.lastFailedSyncVersion;
  prev.failCount += 1;
  prev.lastErrorAt = Date.now();
  prev.lastError = error ? String(error.message || error) : prev.lastError;
  dirtyGames.set(id, prev);
  metrics.persistFail += 1;
  metrics.dirtyMark += 1;

  if (prev.failCount >= DEFAULT_ALERT_THRESHOLD && !prev.alerted) {
    prev.alerted = true;
    metrics.alerts += 1;
    console.error(
      `[DirtyGame] ALERT game=${id} failCount=${prev.failCount} syncVersion=${prev.lastFailedSyncVersion} err=${prev.lastError}`
    );
  }
  return prev;
}

function clear(gameId) {
  const id = String(gameId);
  if (dirtyGames.has(id)) {
    dirtyGames.delete(id);
    metrics.dirtyClear += 1;
  }
}

function size() {
  return dirtyGames.size;
}

function getMetrics() {
  return { ...metrics, dirtyGames: dirtyGames.size };
}

function _resetForTests() {
  dirtyGames.clear();
  metrics.persistFail = 0;
  metrics.dirtyMark = 0;
  metrics.dirtyClear = 0;
  metrics.alerts = 0;
}

module.exports = {
  get,
  mark,
  clear,
  size,
  getMetrics,
  DEFAULT_ALERT_THRESHOLD,
  _resetForTests,
};
