/**
 * In-process Fishnet-style analyzer (lichess-org/fishnet + lila Work.Origin).
 * Sequential backwards `go nodes N`, MultiPV 1, ignore PV1 bound scores.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { Chess } = require("chess.js");
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
  // Fishnet analyses a game on one engine (shared hash, backwards).
  return 1;
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
  const bound = /\blowerbound\b/.test(trimmed) || /\bupperbound\b/.test(trimmed);
  const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
  const skipPv1Bound = bound && multipv === 1;
  return {
    depth: depthMatch ? parseInt(depthMatch[1], 10) : null,
    nodes: nodesMatch ? parseInt(nodesMatch[1], 10) : null,
    multipv,
    bound,
    evaluation: skipPv1Bound
      ? null
      : mateMatch
        ? { mate: parseInt(mateMatch[1], 10) }
        : cpMatch
          ? { cp: parseInt(cpMatch[1], 10) }
          : null,
    pv: skipPv1Bound ? null : pvMatch ? pvMatch[1].trim().split(/\s+/) : null,
  };
}

function playMoves(moves) {
  const board = new Chess();
  for (const uci of moves || []) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const played = board.move({ from, to, promotion });
    if (!played) return null;
  }
  return board;
}

function fenFromMoves(moves) {
  const board = playMoves(moves);
  return board ? board.fen() : null;
}

function gameOverEval(moves) {
  try {
    const board = playMoves(moves);
    if (!board) return null;
    if (board.isCheckmate()) return { mate: 0 };
    if (board.isStalemate() || board.isInsufficientMaterial() || board.isDraw()) {
      return { cp: 0 };
    }
  } catch (_e) {
    return null;
  }
  return null;
}

class ReviewWorker {
  constructor(id, logTag = "LiteReviewPool", opts = {}) {
    this.id = id;
    this.logTag = logTag;
    this.threads = Math.max(1, Math.min(8, Number(opts.threads) || 1));
    this.hashMb = Math.max(16, Math.min(1024, Number(opts.hashMb) || 16));
    this.process = null;
    this.ready = false;
    this.busy = false;
    this.stdoutBuffer = "";
    this.waiters = [];
    this._starting = null;
  }

  async start() {
    if (this.process && this.ready) return;
    if (this._starting) return this._starting;
    this._starting = this._spawnAndUci().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _spawnAndUci() {
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

    const child = spawn(spawnPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    this.ready = false;
    this.stdoutBuffer = "";

    child.stdout.on("data", (data) => {
      this.stdoutBuffer += data.toString();
      this._drain();
    });
    child.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.warn(`[${this.logTag}] worker ${this.id} stderr: ${msg}`);
    });
    child.on("error", (err) => {
      if (this.process !== child) return;
      this.ready = false;
      this.process = null;
      this._rejectWaiters(err);
    });
    child.on("exit", (code) => {
      if (this.process !== child) return;
      this.ready = false;
      this.process = null;
      this._rejectWaiters(new Error(`worker ${this.id} exited (${code})`));
    });

    await this._writeAndWait("uci", (line) => line === "uciok", 10000);
    this._write("setoption name UCI_Chess960 value false");
    this._write(`setoption name Threads value ${this.threads}`);
    this._write(`setoption name Hash value ${this.hashMb}`);
    this._write("setoption name MultiPV value 1");
    await this._writeAndWait("isready", (line) => line === "readyok", 8000);
    this.ready = true;
    console.log(
      `[${this.logTag}] worker ${this.id} ready pid=${this.process.pid} threads=${this.threads} hash=${this.hashMb}`
    );
  }

  _rejectWaiters(err) {
    const pending = this.waiters.splice(0);
    pending.forEach((w) => {
      if (w.timer) clearTimeout(w.timer);
      if (w.stopGrace) clearTimeout(w.stopGrace);
      try {
        w.reject(err);
      } catch (_e) {}
    });
  }

  async restart() {
    if (this._starting) {
      try {
        await this._starting;
      } catch (_e) {}
    }
    await this.stopAndWait();
    await this.start();
  }

  async stopAndWait() {
    const child = this.process;
    this.ready = false;
    this.stdoutBuffer = "";
    this._rejectWaiters(new Error(`worker ${this.id} stopped`));
    this.process = null;
    if (!child) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_e) {}
        finish();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(killer);
        finish();
      });
      try {
        child.stdin.write("quit\n");
      } catch (_e) {}
      try {
        child.kill();
      } catch (_e) {}
    });
  }

  kill() {
    const child = this.process;
    this.ready = false;
    this.stdoutBuffer = "";
    this.waiters.splice(0);
    this.process = null;
    if (!child) return;
    try {
      child.stdin.write("quit\n");
    } catch (_e) {}
    try {
      child.kill();
    } catch (_e) {}
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
        if (current.stopGrace) clearTimeout(current.stopGrace);
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
    const n = Math.max(100000, Math.min(5000000, Number(nodes) || 1000000));
    const mpv = Math.max(1, Math.min(3, Number(multipv) || 1));
    this._write(`setoption name MultiPV value ${mpv}`);

    const over = gameOverEval(moves);
    if (over) {
      return {
        bestMove: null,
        evaluation: over,
        pv: [],
        depth: 0,
        nodes: 0,
        alternativeLines: [],
        fishnetSkippedSearch: true,
      };
    }

    const fen = fenFromMoves(moves);
    const positionCmd = fen
      ? `position fen ${fen}`
      : Array.isArray(moves) && moves.length > 0
        ? `position startpos moves ${moves.join(" ")}`
        : "position startpos";
    this._write(positionCmd);

    const goTimeout = timeoutMs || Math.max(20000, Math.min(180000, Math.round(n / 8) + 8000));
    const goCmd = `go nodes ${n}`;

    return new Promise((resolve, reject) => {
      let depth = 0;
      let nodeCount = 0;
      let bestMove = null;
      let pv = [];
      let evaluation = null;
      const multiPvLines = new Map();

      const timer = setTimeout(() => {
        try {
          this._write("stop");
        } catch (_e) {}
        waiter.stopGrace = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`worker ${this.id} go timeout after ${goTimeout}ms`));
        }, 2000);
      }, goTimeout);

      const waiter = {
        timer,
        stopGrace: null,
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
          if (waiter.stopGrace) clearTimeout(waiter.stopGrace);
          if (!evaluation) {
            const terminal = gameOverEval(moves);
            if (terminal) {
              resolve({
                bestMove: null,
                evaluation: terminal,
                pv: [],
                depth: 0,
                nodes: nodeCount,
                alternativeLines: [],
                fishnetSkippedSearch: true,
              });
              return;
            }
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
    const worker = this.workers[0];
    if (!worker) throw new Error("no review worker");
    return analyzePositionsWithWorker(worker, positions, options);
  }
}

/**
 * One game on one exclusive engine (Fishnet): ucinewgame, then plies backwards.
 * Never share this process with bots / live play.
 */
function cacheCoversMultipv(cached, multipv) {
  if (!cached || !cached.evaluation) return false;
  if (multipv <= 1) return true;
  const alts = Array.isArray(cached.alternativeLines) ? cached.alternativeLines : [];
  return alts.length >= Math.min(3, multipv);
}

async function analyzePositionsWithWorker(worker, positions, options = {}) {
  const nodes = nodesFromReviewOptions(options);
  const multipv = Math.max(1, Math.min(3, Number(options.multipv) || 3));
  const started = Date.now();
  if (!worker) throw new Error("no review worker");

  try {
    await worker.newGame();
  } catch (err) {
    console.warn(`[${worker.logTag || "LiteReviewPool"}] worker ${worker.id} newGame failed, restart`, err.message);
    await worker.restart();
    await worker.newGame();
  }

  const skipByPly = options.skipByPly instanceof Map ? options.skipByPly : null;
  const results = new Array(positions.length);
  const order = positions
    .map((pos, i) => i)
    .sort((a, b) => (positions[b].ply || b) - (positions[a].ply || a));

  let searched = 0;
  let skipped = 0;
  for (const i of order) {
    const pos = positions[i];
    const cached = skipByPly && skipByPly.has(pos.ply) ? skipByPly.get(pos.ply) : null;
    if (cacheCoversMultipv(cached, multipv)) {
      results[i] = cached;
      skipped += 1;
      continue;
    }
    searched += 1;
    try {
      results[i] = await worker.analyzePosition(pos.moves, { nodes, multipv });
    } catch (err) {
      console.warn(
        `[${worker.logTag || "LiteReviewPool"}] ply ${pos.ply} failed on worker ${worker.id}: ${err.message}`
      );
      const fallbackNodes = Math.max(100000, Math.min(250000, Math.round(Number(nodes) / 4) || 100000));
      try {
        await worker.restart();
        await worker.newGame();
        results[i] = await worker.analyzePosition(pos.moves, { nodes, multipv });
      } catch (err2) {
        console.warn(
          `[${worker.logTag || "LiteReviewPool"}] ply ${pos.ply} retry failed, shallow fallback: ${err2.message}`
        );
        try {
          await worker.restart();
          await worker.newGame();
          results[i] = await worker.analyzePosition(pos.moves, {
            nodes: fallbackNodes,
            multipv,
            timeoutMs: 20000,
          });
        } catch (err3) {
          results[i] = {
            error: err3.message || err2.message || err.message,
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
  }
  console.log(
    `[${worker.logTag || "LiteReviewPool"}] ${positions.length} positions searched=${searched} cacheHits=${skipped} nodes=${nodes} engine=${worker.id} ${Date.now() - started}ms`
  );
  return { results, nodes };
}

const liteReviewPool = new LiteReviewPool();

module.exports = {
  liteReviewPool,
  nodesFromReviewOptions,
  workerCount,
  ReviewWorker,
  analyzePositionsWithWorker,
  gameOverEval,
  fenFromMoves,
};
