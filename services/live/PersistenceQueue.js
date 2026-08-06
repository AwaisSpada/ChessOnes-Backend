/**
 * Phase 2 PersistenceQueue — ordered async Mongo writes per gameId.
 * Retry-ready (one automatic retry). Does not change game rules.
 */

const Game = require("../../models/Game");

/** @type {Map<string, Promise<unknown>>} */
const chains = new Map();

function enqueue(gameId, task) {
  const id = String(gameId);
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  chains.set(id, next);
  next.finally(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
  return next;
}

async function persistLiveGamePatch(gameId, patch, syncVersion) {
  const id = String(gameId);
  const filter = {
    gameId: id,
  };
  // Fence: only advance if DB syncVersion is behind or equal missing.
  if (typeof syncVersion === "number") {
    filter.$or = [
      { syncVersion: { $exists: false } },
      { syncVersion: { $lt: syncVersion } },
      { syncVersion },
    ];
  }

  const run = async () => {
    await Game.updateOne(filter, { $set: patch });
  };

  try {
    await run();
  } catch (err) {
    console.error(
      `[PersistenceQueue] persist failed game=${id}, retrying once:`,
      err?.message || err
    );
    await run();
  }
}

/**
 * Enqueue a full state persist from a LiveGame instance.
 */
function enqueueLiveGamePersist(live) {
  if (!live?.gameId) return Promise.resolve();
  const syncVersion = live.syncVersion;
  const patch = {
    board: live.board,
    moves: live.moves,
    currentTurn: live.currentTurn,
    status: live.status,
    result: live.result,
    timeRemaining: {
      white: live.timeRemaining?.white,
      black: live.timeRemaining?.black,
    },
    timeControl: live.timeControl,
    clockStartedAt: live.clockStartedAt,
    syncVersion: live.syncVersion,
    positionHistory: live.positionHistory || [],
  };
  return enqueue(live.gameId, () =>
    persistLiveGamePatch(live.gameId, patch, syncVersion)
  );
}

function flush(gameId) {
  const id = String(gameId);
  return chains.get(id) || Promise.resolve();
}

module.exports = {
  enqueue,
  enqueueLiveGamePersist,
  persistLiveGamePatch,
  flush,
};
