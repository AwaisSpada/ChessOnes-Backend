/**
 * In-process Fishnet work queue (lila-compatible job shape).
 * Local Node worker and HTTP /fishnet clients share this queue.
 */

const crypto = require("crypto");
const { resolveReviewEngine } = require("../game-review/review-nodes");
const evalCache = require("./eval-cache");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const queued = [];
const jobs = new Map();

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function nodesObject(nodes) {
  const n = Math.max(100000, Math.min(5000000, Number(nodes) || 1000000));
  return {
    sf16: n,
    sf15: n,
    classical: Math.min(4050000, Math.round(n * 2.7)),
  };
}

function toAcquirePayload(job) {
  return {
    work: {
      type: "analysis",
      id: job.id,
      nodes: nodesObject(job.nodes),
      timeout: job.timeoutMs || 120000,
    },
    game_id: job.gameId || "",
    position: START_FEN,
    variant: "standard",
    moves: job.moves.join(" "),
    skipPositions: job.skipPositions || [],
  };
}

function enqueue(moves, options = {}) {
  const engine = resolveReviewEngine(options);
  const id = makeId();
  const job = {
    id,
    gameId: options.gameId || "",
    moves: Array.isArray(moves) ? moves.map((m) => String(m).toLowerCase()) : [],
    nodes: engine.nodes,
    timeoutMs: 120000,
    skipPositions: evalCache.skipIndices(
      Array.isArray(moves) ? moves.map((m) => String(m).toLowerCase()) : [],
      engine.nodes
    ),
    origin: "user",
    createdAt: Date.now(),
    acquiredAt: null,
    analysis: null,
    error: null,
    waiters: [],
  };
  jobs.set(id, job);
  queued.push(id);
  console.log(`[Fishnet] queued ${id} plies=${job.moves.length} nodes=${job.nodes}`);
  return job;
}

function waitForJob(id, timeoutMs = 60 * 60 * 1000) {
  const job = jobs.get(id);
  if (!job) return Promise.reject(new Error("unknown fishnet job"));
  if (job.analysis) return Promise.resolve(job);
  if (job.error) return Promise.reject(new Error(job.error));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      job.waiters = job.waiters.filter((w) => w.reject !== reject);
      reject(new Error(`fishnet job timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    job.waiters.push({
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

function acquire({ slow } = {}) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.acquiredAt && !job.analysis && now - job.acquiredAt > 10 * 60 * 1000) {
      job.acquiredAt = null;
      queued.unshift(id);
      console.warn(`[Fishnet] requeued stale ${id}`);
    }
  }
  while (queued.length) {
    const id = queued.shift();
    const job = jobs.get(id);
    if (!job || job.analysis || job.error) continue;
    if (slow && job.origin === "user") {
      queued.push(id);
      continue;
    }
    job.acquiredAt = Date.now();
    return job;
  }
  return null;
}

function complete(id, analysis, stockfish) {
  const job = jobs.get(id);
  if (!job) return false;
  job.analysis = analysis;
  job.stockfish = stockfish || null;
  job.acquiredAt = null;
  const waiters = job.waiters.splice(0);
  waiters.forEach((w) => w.resolve(job));
  console.log(`[Fishnet] completed ${id} entries=${Array.isArray(analysis) ? analysis.length : 0}`);
  const gc = setTimeout(() => jobs.delete(id), 5 * 60 * 1000);
  if (typeof gc.unref === "function") gc.unref();
  return true;
}

function fail(id, message) {
  const job = jobs.get(id);
  if (!job) return false;
  job.error = message || "fishnet failed";
  job.acquiredAt = null;
  const waiters = job.waiters.splice(0);
  waiters.forEach((w) => w.reject(new Error(job.error)));
  jobs.delete(id);
  return true;
}

function abort(id) {
  const job = jobs.get(id);
  if (!job || job.analysis) return false;
  job.acquiredAt = null;
  queued.unshift(id);
  return true;
}

function status() {
  let acquired = 0;
  let waiting = 0;
  let oldest = 0;
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.analysis || job.error) continue;
    if (job.acquiredAt) acquired += 1;
    else {
      waiting += 1;
      oldest = Math.max(oldest, Math.round((now - job.createdAt) / 1000));
    }
  }
  return {
    analysis: {
      user: { acquired, queued: waiting, oldest },
      system: { acquired: 0, queued: 0, oldest: 0 },
    },
  };
}

async function enqueueAndWait(moves, options = {}) {
  const job = enqueue(moves, options);
  return waitForJob(job.id, options.waitTimeoutMs || 60 * 60 * 1000);
}

module.exports = {
  START_FEN,
  enqueue,
  waitForJob,
  enqueueAndWait,
  acquire,
  complete,
  fail,
  abort,
  status,
  toAcquirePayload,
  nodesObject,
};
