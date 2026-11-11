/**
 * Persistent Stockfish workers for game review (not live play).
 * One search per position: `go nodes N` + MultiPV 2.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { resolveReviewEngine } = require("./review-nodes");

function getStockfishPath() {
  const { resolveStockfishBinary } = require("../resolveStockfishBinary");
  return resolveStockfishBinary(path.join(__dirname, "..", "..", "stockfish"));
}

const STOCKFISH_PATH = getStockfishPath();

function workerCount() {
  const env = Number(process.env.REVIEW_ENGINE_WORKERS);
  if (Number.isFinite(env) && env >= 1) {
    return Math.min(4, Math.max(1, Math.round(env)));
  }
  const cpus = (os.cpus() && os.cpus().length) || 1;
  return Math.min(4, Math.max(1, cpus));
}

function nodesFromReviewOptions(options = {}) {
  return resolveReviewEngine(options).nodes;
}

function parseInfoLine(trimmed) {
  const depthMatch = trimmed.match(/depth (\d+)/);
  const nodesMatch = trimmed.match(/nodes (\d+)/);
  const multipvMatch = trimmed.match(/\bmultipv (\d+)/);
  const cpMatch = trimmed.match(/score cp (-?\d+)/);
  const mateMatch = trimmed.match(/score mate (-?\d+)/);
  const pvMatch = trimmed.match(/\bpv\s+(.+)/);
  return {
    depth: depthMatch ? parseInt(depthMatch[1], 10) : null,
    nodes: nodesMatch ? parseInt(nodesMatch[1], 10) : null,
    multipv: multipvMatch ? parseInt(multipvMatch[1], 10) : 1,
    evaluation: mateMatch
      ? { mate: parseInt(mateMatch[1], 10) }
      : cpMatch
        ? { cp: parseInt(cpMatch[1], 10) }
        : null,
    pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : null,
  };
}

class ReviewWorker {
  constructor(id) {
    this.id = id;
    this.process = null;
    this.ready = false;
    this.busy = false;
    this.stdoutBuffer = "";
    this.waiters = [];
  }

  async start() {
    if (this.process && this.ready) return;
    if (STOCKFISH_PATH !== "stockfish" && !fs.existsSync(STOCKFISH_PATH)) {
      throw new Error(`Stockfish binary not found at: ${STOCKFISH_PATH}`);
    }
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(STOCKFISH_PATH, 0o755);
      } catch (_e) {}
    }
    const spawnPath =
      STOCKFISH_PATH !== "stockfish" ? path.resolve(STOCKFISH_PATH) : STOCKFISH_PATH;

    this.process = spawn(spawnPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.ready = false;
    this.stdoutBuffer = "";

    this.process.stdout.on("data", (data) => {
      this.stdoutBuffer += data.toString();
      this._drain();
    });
    this.process.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.warn(`[LiteReviewPool] worker ${this.id} stderr: ${msg}`);
    });
    this.process.on("error", (err) => {
      this.ready = false;
      const pending = this.waiters.splice(0);
      pending.forEach((w) => w.reject(err));
    });
    this.process.on("exit", (code) => {
      this.ready = false;
      this.process = null;
      const pending = this.waiters.splice(0);
      pending.forEach((w) => w.reject(new Error(`worker ${this.id} exited (${code})`)));
    });

    await this._writeAndWait("uci", (line) => line === "uciok", 10000);
    this._write("setoption name Threads value 1");
    this._write("setoption name Hash value 64");
    this._write("setoption name MultiPV value 2");
    await this._writeAndWait("isready", (line) => line === "readyok", 8000);
    this.ready = true;
    console.log(`[LiteReviewPool] worker ${this.id} ready pid=${this.process.pid}`);
  }

  async restart() {
    this.kill();
    await this.start();
  }

  kill() {
    if (this.process) {
      try {
        this.process.stdin.write("quit\n");
      } catch (_e) {}
      try {
        this.process.kill();
      } catch (_e) {}
    }
    this.process = null;
    this.ready = false;
    this.stdoutBuffer = "";
    this.waiters.splice(0);
  }

  _write(cmd) {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error(`worker ${this.id} stdin closed`);
    }
    this.process.stdin.write(`${cmd}\n`);
  }

  _drain() {
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || this.waiters.length === 0) continue;
      const current = this.waiters[0];
      try {
        current.onLine(line);
      } catch (err) {
        this.waiters.shift();
        clearTimeout(current.timer);
        current.reject(err);
      }
    }
  }

  _writeAndWait(command, onLinePredicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`worker ${this.id} timeout: ${command}`));
      }, timeoutMs);
      const waiter = {
        timer,
        onLine: (line) => {
          if (!onLinePredicate(line)) return;
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          clearTimeout(timer);
          resolve();
        },
        reject,
      };
      this.waiters.push(waiter);
      this._write(command);
    });
  }

  async newGame() {
    if (!this.ready) await this.start();
    this._write("ucinewgame");
    await this._writeAndWait("isready", (line) => line === "readyok", 8000);
  }

  async analyzePosition(moves, { nodes, timeoutMs, multipv }) {
    if (!this.ready) await this.start();
    const n = Math.max(100000, Math.min(2000000, Number(nodes) || 300000));
    const mpv = Math.max(1, Math.min(3, Number(multipv) || 2));
    this._write(`setoption name MultiPV value ${mpv}`);

    let positionCmd = "position startpos";
    if (Array.isArray(moves) && moves.length > 0) {
      positionCmd += ` moves ${moves.join(" ")}`;
    }
    this._write(positionCmd);

    const goTimeout = timeoutMs || Math.max(8000, Math.min(30000, 4000 + Math.round(n / 20)));
    const goCmd = `go nodes ${n}`;

    return new Promise((resolve, reject) => {
      let depth = 0;
      let nodeCount = 0;
      let bestMove = null;
      let pv = [];
      let evaluation = null;
      const multiPvLines = new Map();

      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`worker ${this.id} go timeout after ${goTimeout}ms`));
      }, goTimeout);

      const waiter = {
        timer,
        onLine: (line) => {
          if (line.startsWith("info")) {
            const parsed = parseInfoLine(line);
            if (parsed.depth != null) depth = parsed.depth;
            if (parsed.nodes != null) nodeCount = parsed.nodes;
            if (parsed.evaluation && parsed.pv) {
              multiPvLines.set(parsed.multipv, {
                multipv: parsed.multipv,
                move: parsed.pv[0] || null,
                pv: parsed.pv,
                evaluation: parsed.evaluation,
              });
            }
            if (parsed.multipv === 1 && parsed.evaluation) {
              evaluation = parsed.evaluation;
            }
            if (parsed.multipv === 1 && parsed.pv) {
              pv = parsed.pv;
            }
            return;
          }
          if (!line.startsWith("bestmove")) return;
          const parts = line.split(/\s+/);
          if (parts.length > 1 && parts[1] !== "none") bestMove = parts[1];
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          clearTimeout(timer);
          if (!evaluation) {
            reject(new Error("Stockfish returned no score before bestmove"));
            return;
          }
          resolve({
            bestMove,
            evaluation,
            pv,
            depth,
            nodes: nodeCount,
            alternativeLines: Array.from(multiPvLines.values()).sort(
              (a, b) => a.multipv - b.multipv
            ),
          });
        },
        reject,
      };
      this.waiters.push(waiter);
      this._write(goCmd);
    });
  }
}

class LiteReviewPool {
  constructor() {
    this.workers = [];
    this.initPromise = null;
    this.batchTail = Promise.resolve();
  }

  async ensure() {
    if (this.workers.length && this.workers.every((w) => w.ready)) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const n = workerCount();
      console.log(`[LiteReviewPool] starting ${n} workers`);
      this.workers = Array.from({ length: n }, (_, i) => new ReviewWorker(i));
      await Promise.all(this.workers.map((w) => w.start()));
    })();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  /**
   * Analyze N+1 positions for one game. Positions: [{ ply, moves }].
   * Serialized per batch so two reviews don't interleave hash tables.
   */
  analyzePositions(positions, options = {}) {
    const run = this.batchTail.then(() => this._analyzePositions(positions, options));
    this.batchTail = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async _analyzePositions(positions, options) {
    await this.ensure();
    const nodes = nodesFromReviewOptions(options);
    const multipv = 2;
    const started = Date.now();

    await Promise.all(
      this.workers.map((w) =>
        w.newGame().catch(async (err) => {
          console.warn(`[LiteReviewPool] worker ${w.id} newGame failed, restart`, err.message);
          await w.restart();
          await w.newGame();
        })
      )
    );

    const results = new Array(positions.length);
    let cursor = 0;
    const nextIndex = () => {
      const i = cursor;
      cursor += 1;
      return i < positions.length ? i : -1;
    };

    const runWorker = async (worker) => {
      for (;;) {
        const i = nextIndex();
        if (i < 0) return;
        const pos = positions[i];
        try {
          results[i] = await worker.analyzePosition(pos.moves, { nodes, multipv });
        } catch (err) {
          console.warn(
            `[LiteReviewPool] ply ${pos.ply} failed on worker ${worker.id}: ${err.message}`
          );
          try {
            await worker.restart();
            await worker.newGame();
            results[i] = await worker.analyzePosition(pos.moves, { nodes, multipv });
          } catch (err2) {
            results[i] = {
              error: err2.message || err.message,
              bestMove: null,
              evaluation: { cp: 0 },
              pv: [],
              depth: 0,
              nodes: 0,
              alternativeLines: [],
            };
          }
        }
      }
    };

    await Promise.all(this.workers.map((w) => runWorker(w)));
    console.log(
      `[LiteReviewPool] ${positions.length} positions, nodes=${nodes}, workers=${this.workers.length}, ${Date.now() - started}ms`
    );
    return { results, nodes };
  }
}

const liteReviewPool = new LiteReviewPool();

module.exports = {
  liteReviewPool,
  nodesFromReviewOptions,
  workerCount,
};
