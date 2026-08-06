/**
 * Phase 1–2 LiveGameManager — in-memory registry + hydration.
 * Follows live-game-hydration-policy: LiveGame wins when present; Mongo only on miss.
 * Phase 2: HTTP adapter mutates via LiveGame.applyMove; PersistenceQueue writes Mongo.
 */

const Game = require("../../models/Game");
const LiveGame = require("./LiveGame");
const ClockManager = require("./ClockManager");
const { LIVE_MEMORY_SNAPSHOT } = require("./flags");

/** @type {Map<string, LiveGame>} */
const games = new Map();

/** @type {Map<string, Promise<LiveGame|null>>} */
const hydrateInFlight = new Map();

function isFlagOn() {
  return LIVE_MEMORY_SNAPSHOT === true;
}

function toLeanDoc(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === "function") {
    return doc.toObject();
  }
  return doc;
}

function get(gameId) {
  if (!gameId) return null;
  return games.get(String(gameId)) || null;
}

function has(gameId) {
  if (!gameId) return false;
  return games.has(String(gameId));
}

function activeCount() {
  return games.size;
}

/**
 * Insert from a just-created/loaded doc. If already present, return existing (never overwrite).
 * @returns {LiveGame|null}
 */
function createFromDoc(gameDoc) {
  const doc = toLeanDoc(gameDoc);
  if (!doc?.gameId) return null;
  if (!ClockManager.isLiveHumanGame(doc)) return null;

  const id = String(doc.gameId);
  const existing = games.get(id);
  if (existing) return existing;

  const live = LiveGame.fromMongoDoc(doc);
  games.set(id, live);
  try {
    const ClockScheduler = require("./ClockScheduler");
    if (ClockScheduler.isArmed()) ClockScheduler.rescheduleAll(live);
  } catch (_) {
    /* Phase 3 optional */
  }
  return live;
}

/**
 * If LiveGame exists, update it from authoritative Mongo/HTTP result (post-move sync).
 * Does not hydrate finished games that were never cached.
 * Never used on read paths to "refresh from Mongo over RAM" for a different purpose —
 * this updates the same instance after HTTP remains authoritative in Phase 1.
 */
function syncFromAuthoritativeDoc(gameDoc) {
  if (!isFlagOn()) return null;
  const doc = toLeanDoc(gameDoc);
  if (!doc?.gameId) return null;
  if (!ClockManager.isLiveHumanGame(doc)) return null;

  const id = String(doc.gameId);
  const existing = games.get(id);
  if (existing) {
    existing.applyAuthoritativeDoc(doc);
    try {
      const ClockScheduler = require("./ClockScheduler");
      if (ClockScheduler.isArmed()) ClockScheduler.rescheduleAll(existing);
    } catch (_) {
      /* ignore */
    }
    return existing;
  }
  // Only auto-create while active — avoid caching finished games from move end.
  if (doc.status === "active") {
    return createFromDoc(doc);
  }
  return null;
}

function evict(gameId) {
  if (!gameId) return false;
  const id = String(gameId);
  hydrateInFlight.delete(id);
  try {
    require("./ClockScheduler").cancel(id);
  } catch (_) {
    /* ignore */
  }
  return games.delete(id);
}

/**
 * Hydrate from Mongo only on cache miss. Existing LiveGame always returned as-is.
 * Skips non-live-human. Does not hydrate completed/abandoned on miss (policy §4.3).
 * @returns {Promise<LiveGame|null>}
 */
async function getOrHydrate(gameId) {
  if (!gameId) return null;
  const id = String(gameId);

  const cached = games.get(id);
  if (cached) return cached;

  const inflight = hydrateInFlight.get(id);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const doc = await Game.findOne({ gameId: id }).lean();
      if (!doc) return null;
      if (!ClockManager.isLiveHumanGame(doc)) return null;

      // Race: another createFromDoc may have won while we queried.
      const again = games.get(id);
      if (again) return again;

      // Finished games: Mongo-only unless already in memory (handled above).
      if (doc.status === "completed" || doc.status === "abandoned") {
        return null;
      }

      return createFromDoc(doc);
    } finally {
      hydrateInFlight.delete(id);
    }
  })();

  hydrateInFlight.set(id, promise);
  return promise;
}

/**
 * Build snapshot for socket emit when flag on; null → caller uses legacy Mongo path.
 */
async function trySnapshot(gameId) {
  if (!isFlagOn()) return null;
  const live = await getOrHydrate(gameId);
  if (!live) return null;
  return live.snapshot();
}

module.exports = {
  get,
  getOrHydrate,
  createFromDoc,
  syncFromAuthoritativeDoc,
  has,
  evict,
  activeCount,
  trySnapshot,
  isFlagOn,
};
