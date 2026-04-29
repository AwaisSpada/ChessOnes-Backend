const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

function getStockfishPath() {
  const stockfishDir = path.join(__dirname, "..", "..", "stockfish");
  const isWindows = process.platform === "win32";
  if (isWindows) {
    const windowsPath = path.join(stockfishDir, "Windows", "stockfish-windows-x86-64-avx2.exe");
    if (fs.existsSync(windowsPath)) return windowsPath;
  } else {
    const linuxPath = path.join(stockfishDir, "Linux", "stockfish-ubuntu-x86-64-avx2");
    if (fs.existsSync(linuxPath)) return linuxPath;
  }
  return "stockfish";
}

const STOCKFISH_PATH = getStockfishPath();

class EngineInstance {
  constructor(id) {
    this.id = id;
    this.process = null;
    this.isReady = false;
    this.isProcessing = false;
    this.queue = [];
  }

  async init(type = "FULL") {
    if (this.process && this.isReady) return;

    return new Promise((resolve, reject) => {
      if (STOCKFISH_PATH !== "stockfish" && !fs.existsSync(STOCKFISH_PATH)) {
        return reject(new Error(`Stockfish binary not found at: ${STOCKFISH_PATH}`));
      }
      if (process.platform !== "win32") {
        try { fs.chmodSync(STOCKFISH_PATH, 0o755); } catch (e) {}
      }

      const spawnPath = STOCKFISH_PATH !== "stockfish" ? path.resolve(STOCKFISH_PATH) : STOCKFISH_PATH;
      this.process = spawn(spawnPath, [], { stdio: ["pipe", "pipe", "pipe"] });

      let stdoutBuffer = "";
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.kill();
          reject(new Error(`Engine init timeout`));
        }
      }, 10000);

      this.process.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim() === "uciok" && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.isReady = true;
            resolve();
            return;
          }
        }
      });

      this.process.stderr.on("data", (data) => {
        console.error(`[EnginePool] Engine ${this.id} error:`, data.toString());
      });

      this.process.on("error", (err) => {
        if (!resolved) { resolved = true; clearTimeout(timeout); this.kill(); reject(err); }
      });
      this.process.on("exit", () => {
        if (!resolved) { resolved = true; clearTimeout(timeout); this.kill(); reject(new Error("Engine exited")); }
        this.kill();
      });
      this.process.stdin.write("uci\n");
    });
  }

  kill() {
    if (this.process) {
      try { this.process.kill(); } catch (e) {}
    }
    this.process = null;
    this.isReady = false;
  }

  async sendCommand(command, options = {}) {
    const { timeout = 10000, expectBestMove = false } = options;

    if (command === "ucinewgame" || command.startsWith("position ") || command.startsWith("setoption ") || command === "isready") {
      return new Promise((resolve, reject) => {
        if (this.isProcessing) { this.queue.push({ command, options, resolve, reject }); return; }
        this.isProcessing = true;
        try {
          this.process.stdin.write(`${command}\n`);
          if (command === "isready") {
            let stdoutBuffer = "";
            let resolved = false;
            const timeoutId = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                this.isProcessing = false;
                this.processNext();
                reject(new Error(`isready timeout`));
              }
            }, timeout);
            const dataHandler = (data) => {
              stdoutBuffer += data.toString();
              if (stdoutBuffer.includes("readyok") && !resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                this.process.stdout.removeListener("data", dataHandler);
                this.isProcessing = false;
                this.processNext();
                resolve();
              }
            };
            this.process.stdout.on("data", dataHandler);
          } else {
            setTimeout(() => {
              this.isProcessing = false;
              this.processNext();
              resolve({ bestMove: null, evaluation: { cp: 0 } });
            }, 50);
          }
        } catch (e) { this.isProcessing = false; this.processNext(); reject(e); }
      });
    }

    return new Promise((resolve, reject) => {
      if (this.isProcessing) { this.queue.push({ command, options, resolve, reject }); return; }
      this.isProcessing = true;
      let stdoutBuffer = "";
      let bestMove = null;
      let pv = null;
      let alternativeLines = [];
      let evaluation = null;
      let depth = 0;
      let mate = null;
      let resolved = false;
      const isGo = command.trim().startsWith("go");

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          cleanup(new Error(`Engine command timeout: ${command}`), null);
        }
      }, timeout);

      const cleanup = (err, data) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        if (this.process && this.process.stdout) {
          try { this.process.stdout.removeListener("data", dataHandler); } catch (e) {}
        }
        this.isProcessing = false;
        this.processNext();
        if (err) reject(err); else resolve(data);
      };

      const dataHandler = (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("info")) {
            if (isGo) {
              const depthMatch = trimmed.match(/depth (\d+)/);
              if (depthMatch) depth = parseInt(depthMatch[1], 10);

              const multiPVMatch = trimmed.match(/multipv (\d+)/);
              const multiPV = multiPVMatch ? parseInt(multiPVMatch[1], 10) : 1;

              let lineEval = null;
              const cpMatch = trimmed.match(/score cp (-?\d+)/);
              if (cpMatch) lineEval = { cp: parseInt(cpMatch[1], 10) };
              const mateMatch = trimmed.match(/score mate (-?\d+)/);
              if (mateMatch) lineEval = { mate: parseInt(mateMatch[1], 10) };

              let linePv = null;
              const pvMatch = trimmed.match(/\bpv\s+(.+)/);
              if (pvMatch) linePv = pvMatch[1].trim().split(/\s+/);

              if (multiPV === 1) {
                if (lineEval) {
                  if (lineEval.cp !== undefined) {
                    evaluation = lineEval.cp;
                    mate = null;
                  } else if (lineEval.mate !== undefined) {
                    mate = lineEval.mate;
                    evaluation = null;
                  }
                }
                if (linePv) pv = linePv;
                if (linePv && lineEval && !alternativeLines[0]) {
                  alternativeLines[0] = { pv: linePv, evaluation: lineEval };
                }
              }

              if (linePv && lineEval) {
                alternativeLines[multiPV - 1] = {
                  pv: linePv,
                  evaluation: lineEval,
                };
              }
            } else {
              const depthMatch = trimmed.match(/depth (\d+)/);
              if (depthMatch) depth = parseInt(depthMatch[1], 10);
              const cpMatch = trimmed.match(/score cp (-?\d+)/);
              if (cpMatch) {
                evaluation = parseInt(cpMatch[1], 10);
                mate = null;
              }
              const mateMatch = trimmed.match(/score mate (-?\d+)/);
              if (mateMatch) {
                mate = parseInt(mateMatch[1], 10);
                evaluation = null;
              }
              const pvMatch = trimmed.match(/pv\s+(.+)/);
              if (pvMatch) pv = pvMatch[1].trim().split(/\s+/);
            }
          }

          if (trimmed.startsWith("bestmove")) {
            const parts = trimmed.split(/\s+/);
            if (parts.length > 1 && parts[1] !== "none") bestMove = parts[1];
            if (!resolved) {
              if (mate === null && evaluation === null) {
                cleanup(new Error("Stockfish returned no score before bestmove"), null);
                return;
              }
              const evaluationObj = mate !== null ? { mate } : { cp: evaluation };
              cleanup(null, {
                bestMove,
                evaluation: evaluationObj,
                pv: pv || [],
                depth,
                alternativeLines: isGo ? alternativeLines.filter(Boolean) : [],
              });
            }
            return;
          }

          if (!expectBestMove && evaluation !== null && !resolved) {
            cleanup(null, {
              bestMove: null,
              evaluation: mate !== null ? { mate } : { cp: evaluation },
              pv: pv || [],
              depth,
              alternativeLines: isGo ? alternativeLines.filter(Boolean) : [],
            });
            return;
          }
        }
      };

      this.process.stdout.on("data", dataHandler);
      this.process.stdin.write(`${command}\n`);
    });
  }

  processNext() {
    if (this.queue.length === 0) return;
    const { command, options, resolve, reject } = this.queue.shift();
    this.sendCommand(command, options).then(resolve).catch(reject);
  }
}

class EnginePool {
  constructor(size = 1) {
    this.size = size;
    this.pool = [];
    this.inUse = new Set();
    this.waitingQueue = [];
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    console.log(`[EnginePool] Initializing pool of size ${this.size}`);
    for (let i = 0; i < this.size; i++) {
      const engine = new EngineInstance(i);
      await engine.init();
      this.pool.push(engine);
    }
    this.initialized = true;
  }

  async acquire() {
    if (!this.initialized) await this.init();

    const available = this.pool.find(e => !this.inUse.has(e.id));
    if (available) {
      this.inUse.add(available.id);
      try {
        await available.sendCommand("ucinewgame", { timeout: 2000 });
        await available.sendCommand("isready", { timeout: 5000 });
      } catch (err) {
        console.error("[EnginePool] Failed to reset acquired engine", err);
      }
      return available;
    }

    console.log(`[EnginePool] All engines busy. Queueing request...`);
    return new Promise((resolve) => {
      this.waitingQueue.push(resolve);
    });
  }

  release(engine) {
    if (this.inUse.has(engine.id)) {
      this.inUse.delete(engine.id);
      if (this.waitingQueue.length > 0) {
        const next = this.waitingQueue.shift();
        this.inUse.add(engine.id);

        engine.sendCommand("ucinewgame", { timeout: 2000 })
          .then(() => engine.sendCommand("isready", { timeout: 5000 }))
          .then(() => next(engine))
          .catch((err) => {
            console.error("[EnginePool] Failed to reset engine on reuse", err);
            next(engine);
          });
      }
    }
  }
}

const maxPoolSize = Math.max(1, Math.floor(os.cpus().length / 2));
const fullPool = new EnginePool(maxPoolSize);
const litePool = new EnginePool(2);

module.exports = {
  fullPool,
  litePool,
};
