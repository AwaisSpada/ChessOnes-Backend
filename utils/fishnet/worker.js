/**
 * Dedicated review Fishnet fleet — our Stockfish binary, isolated from bots/live play.
 * Each member owns one engine: one game at a time, backwards search (hash).
 * Multiple games run in parallel across the fleet.
 */

const os = require("os");
const queue = require("./queue");
const { resultsToAnalysis } = require("./ingest");
const {
  ReviewWorker,
  analyzePositionsWithWorker,
} = require("../game-review/lite-review-pool");
const evalCache = require("./eval-cache");

let running = false;
let startPromise = null;
const members = [];

function fleetSize() {
  const env = Number(process.env.FISHNET_FLEET_SIZE || process.env.REVIEW_FLEET_SIZE);
  if (Number.isFinite(env) && env >= 1) {
    return Math.min(8, Math.max(1, Math.round(env)));
  }
  const cpus = (os.cpus() && os.cpus().length) || 1;
  return Math.min(2, Math.max(1, Math.floor(cpus / 4) || 1));
}

function fleetThreads() {
  const env = Number(process.env.FISHNET_THREADS);
  if (Number.isFinite(env) && env >= 1) return Math.min(8, Math.round(env));
  const cpus = (os.cpus() && os.cpus().length) || 1;
  return Math.min(2, Math.max(1, Math.floor(cpus / 4) || 1));
}

function fleetHashMb() {
  const env = Number(process.env.FISHNET_HASH_MB);
  if (Number.isFinite(env) && env >= 16) return Math.min(1024, Math.round(env));
  return 64;
}

async function processJob(job, engine) {
  const moves = job.moves || [];
  const positions = [];
  const skipByPly = new Map();
  for (let ply = 0; ply <= moves.length; ply++) {
    const slice = moves.slice(0, ply);
    positions.push({ ply, moves: slice });
    const hit = evalCache.get(slice, job.nodes);
    if (hit) skipByPly.set(ply, hit);
  }
  const { results } = await analyzePositionsWithWorker(engine, positions, {
    nodes: job.nodes,
    skipByPly,
  });
  for (let ply = 0; ply < results.length; ply++) {
    evalCache.set(moves.slice(0, ply), results[ply], job.nodes);
  }
  const analysis = resultsToAnalysis(results);
  queue.complete(job.id, analysis, {
    flavor: "nnue",
    version: `OfficialStockfish/ChessOnes-fleet-${engine.id}/nogit`,
  });
}

async function memberLoop(engine) {
  console.log(`[FishnetFleet] member ${engine.id} loop`);
  while (running) {
    const job = queue.acquire();
    if (!job) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    try {
      console.log(
        `[FishnetFleet] engine ${engine.id} job ${job.id} plies=${job.moves.length} nodes=${job.nodes}`
      );
      await processJob(job, engine);
    } catch (err) {
      console.error(`[FishnetFleet] engine ${engine.id} failed ${job.id}:`, err.message);
      queue.fail(job.id, err.message);
      try {
        await engine.restart();
      } catch (_e) {}
    }
  }
}

function start() {
  if (process.env.FISHNET_DISABLE_LOCAL_WORKER === "1") {
    console.log("[FishnetFleet] disabled (FISHNET_DISABLE_LOCAL_WORKER=1) — use HTTP clients");
    return Promise.resolve();
  }
  if (startPromise) return startPromise;
  startPromise = (async () => {
    running = true;
    const n = fleetSize();
    const threads = fleetThreads();
    const hashMb = fleetHashMb();
    console.log(
      `[FishnetFleet] starting ${n} review engines threads=${threads} hash=${hashMb}MB (bots/live untouched)`
    );
    for (let i = 0; i < n; i++) {
      const engine = new ReviewWorker(`fleet-${i}`, "FishnetFleet", { threads, hashMb });
      await engine.start();
      members.push({ engine, loop: memberLoop(engine) });
    }
  })().catch((err) => {
    running = false;
    startPromise = null;
    throw err;
  });
  return startPromise;
}

function stop() {
  running = false;
  members.forEach((m) => {
    try {
      m.engine.kill();
    } catch (_e) {}
  });
  members.length = 0;
}

module.exports = { start, stop, processJob, fleetSize, fleetThreads, fleetHashMb };
