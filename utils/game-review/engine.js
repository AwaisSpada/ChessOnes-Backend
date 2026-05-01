/**
 * Stockfish Engine Communication Module - FULL and LITE Engines
 * 
 * Supports TWO separate engine instances:
 * 1. FULL Engine: High-depth analysis (depth 18+) for comprehensive game review
 *    - Used once per completed game
 *    - Computes: evalBefore/evalAfter, centipawn loss, best move, alternative lines, eval graph
 * 2. LITE Engine: Quick-review analysis (depth/movetime from caller, typical depth 12)
 *    - Used during replay navigation for UX features (arrows, quick eval)
 *    - Results are NOT persisted
 * 
 * Each engine runs in a separate process to avoid interference.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// FULL Engine (comprehensive analysis)
let fullEngineProcess = null;
let fullEngineReady = false;
const fullRequestQueue = [];
let fullProcessingRequest = false;

// LITE Engine (quick evaluations)
let liteEngineProcess = null;
let liteEngineReady = false;
const liteRequestQueue = [];
let liteProcessingRequest = false;

function getStockfishPath() {
  const stockfishDir = path.join(__dirname, "..", "..", "stockfish");
  const isWindows = process.platform === "win32";

  if (isWindows) {
    const windowsPath = path.join(
      stockfishDir,
      "Windows",
      "stockfish-windows-x86-64-avx2.exe"
    );
    if (fs.existsSync(windowsPath)) {
      return windowsPath;
    }
  } else {
    const linuxPath = path.join(
      stockfishDir,
      "Linux",
      "stockfish-ubuntu-x86-64-avx2"
    );
    if (fs.existsSync(linuxPath)) {
      return linuxPath;
    }
  }

  return "stockfish";
}

const STOCKFISH_PATH = getStockfishPath();

/**
 * Initialize FULL engine (high-depth analysis)
 */
function initFullEngine() {
  if (fullEngineProcess && fullEngineReady) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (STOCKFISH_PATH !== "stockfish" && !fs.existsSync(STOCKFISH_PATH)) {
      return reject(new Error(`Stockfish binary not found at: ${STOCKFISH_PATH}`));
    }

    if (process.platform !== "win32") {
      try {
        fs.chmodSync(STOCKFISH_PATH, 0o755);
      } catch (err) {
        console.warn(`[GameReview-FULL] Could not set execute permissions: ${err.message}`);
      }
    }

    try {
      const spawnPath = STOCKFISH_PATH !== "stockfish" 
        ? path.resolve(STOCKFISH_PATH) 
        : STOCKFISH_PATH;

      console.log(`[GameReview-FULL] Spawning Stockfish from: ${spawnPath}`);
      fullEngineProcess = spawn(spawnPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!fullEngineProcess || fullEngineProcess.pid === undefined) {
        return reject(new Error("Failed to create FULL Stockfish process"));
      }

      console.log(`[GameReview-FULL] Process started, PID: ${fullEngineProcess.pid}`);

      let stdoutBuffer = "";
      let resolved = false;

      const initTimeout = setTimeout(() => {
        if (!resolved && !fullEngineReady) {
          resolved = true;
          if (fullEngineProcess) {
            try {
              fullEngineProcess.kill();
            } catch (e) {}
          }
          fullEngineProcess = null;
          fullEngineReady = false;
          reject(new Error(`FULL Stockfish initialization timeout after 10s. Path: ${spawnPath}`));
        }
      }, 10000);

      fullEngineProcess.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "uciok" && !resolved) {
            resolved = true;
            clearTimeout(initTimeout);
            fullEngineReady = true;
            console.log("[GameReview-FULL] Engine ready (uciok received)");
            resolve();
            return;
          }
        }
      });

      fullEngineProcess.stderr.on("data", (data) => {
        console.error("[GameReview-FULL][stderr]:", data.toString());
      });

      fullEngineProcess.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(initTimeout);
          fullEngineProcess = null;
          fullEngineReady = false;
          reject(err);
        }
      });

      fullEngineProcess.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(initTimeout);
          fullEngineProcess = null;
          fullEngineReady = false;
          reject(new Error(`FULL Stockfish engine exited with code ${code} during initialization`));
        } else if (code !== 0 && code !== null) {
          console.error(`[GameReview-FULL] Engine exited with code ${code}`);
        }
      });

      fullEngineProcess.stdin.write("uci\n");
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Initialize LITE engine (quick evaluations)
 */
function initLiteEngine() {
  if (liteEngineProcess && liteEngineReady) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (STOCKFISH_PATH !== "stockfish" && !fs.existsSync(STOCKFISH_PATH)) {
      return reject(new Error(`Stockfish binary not found at: ${STOCKFISH_PATH}`));
    }

    if (process.platform !== "win32") {
      try {
        fs.chmodSync(STOCKFISH_PATH, 0o755);
      } catch (err) {
        console.warn(`[GameReview-LITE] Could not set execute permissions: ${err.message}`);
      }
    }

    try {
      const spawnPath = STOCKFISH_PATH !== "stockfish" 
        ? path.resolve(STOCKFISH_PATH) 
        : STOCKFISH_PATH;

      console.log(`[GameReview-LITE] Spawning Stockfish from: ${spawnPath}`);
      liteEngineProcess = spawn(spawnPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!liteEngineProcess || liteEngineProcess.pid === undefined) {
        return reject(new Error("Failed to create LITE Stockfish process"));
      }

      console.log(`[GameReview-LITE] Process started, PID: ${liteEngineProcess.pid}`);

      let stdoutBuffer = "";
      let resolved = false;

      const initTimeout = setTimeout(() => {
        if (!resolved && !liteEngineReady) {
          resolved = true;
          if (liteEngineProcess) {
            try {
              liteEngineProcess.kill();
            } catch (e) {}
          }
          liteEngineProcess = null;
          liteEngineReady = false;
          reject(new Error(`LITE Stockfish initialization timeout after 10s. Path: ${spawnPath}`));
        }
      }, 10000);

      liteEngineProcess.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "uciok" && !resolved) {
            resolved = true;
            clearTimeout(initTimeout);
            liteEngineReady = true;
            console.log("[GameReview-LITE] Engine ready (uciok received)");
            resolve();
            return;
          }
        }
      });

      liteEngineProcess.stderr.on("data", (data) => {
        console.error("[GameReview-LITE][stderr]:", data.toString());
      });

      liteEngineProcess.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(initTimeout);
          liteEngineProcess = null;
          liteEngineReady = false;
          reject(err);
        }
      });

      liteEngineProcess.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(initTimeout);
          liteEngineProcess = null;
          liteEngineReady = false;
          reject(new Error(`LITE Stockfish engine exited with code ${code} during initialization`));
        } else if (code !== 0 && code !== null) {
          console.error(`[GameReview-LITE] Engine exited with code ${code}`);
        }
      });

      liteEngineProcess.stdin.write("uci\n");
    } catch (err) {
      reject(err);
    }
  });
}

async function ensureFullEngineReady() {
  if (fullEngineProcess && fullEngineReady) {
    if (fullEngineProcess.killed || fullEngineProcess.exitCode !== null) {
      console.log("[GameReview-FULL] Engine process died, reinitializing...");
      fullEngineProcess = null;
      fullEngineReady = false;
    } else {
      return Promise.resolve();
    }
  }

  if (!fullEngineProcess) {
    console.log("[GameReview-FULL] Initializing Stockfish engine...");
    await initFullEngine();
  }

  if (!fullEngineReady) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("FULL Stockfish engine did not become ready within 10 seconds"));
      }, 10000);

      const check = setInterval(() => {
        if (fullEngineReady) {
          clearInterval(check);
          clearTimeout(timeout);
          console.log("[GameReview-FULL] Engine ready confirmed");
          resolve();
        }
        if (fullEngineProcess && (fullEngineProcess.killed || fullEngineProcess.exitCode !== null)) {
          clearInterval(check);
          clearTimeout(timeout);
          fullEngineProcess = null;
          fullEngineReady = false;
          reject(new Error("FULL Stockfish engine process exited during initialization"));
        }
      }, 100);
    });
  }
}

async function ensureLiteEngineReady() {
  if (liteEngineProcess && liteEngineReady) {
    if (liteEngineProcess.killed || liteEngineProcess.exitCode !== null) {
      console.log("[GameReview-LITE] Engine process died, reinitializing...");
      liteEngineProcess = null;
      liteEngineReady = false;
    } else {
      return Promise.resolve();
    }
  }

  if (!liteEngineProcess) {
    console.log("[GameReview-LITE] Initializing Stockfish engine...");
    await initLiteEngine();
  }

  if (!liteEngineReady) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("LITE Stockfish engine did not become ready within 10 seconds"));
      }, 10000);

      const check = setInterval(() => {
        if (liteEngineReady) {
          clearInterval(check);
          clearTimeout(timeout);
          console.log("[GameReview-LITE] Engine ready confirmed");
          resolve();
        }
        if (liteEngineProcess && (liteEngineProcess.killed || liteEngineProcess.exitCode !== null)) {
          clearInterval(check);
          clearTimeout(timeout);
          liteEngineProcess = null;
          liteEngineReady = false;
          reject(new Error("LITE Stockfish engine process exited during initialization"));
        }
      }, 100);
    });
  }
}

/**
 * Send command to FULL engine
 */
async function sendFullCommand(command, options = {}) {
  await ensureFullEngineReady();
  return sendCommandInternal(command, options, "FULL", fullEngineProcess, fullRequestQueue, {
    getProcessingRequest: () => fullProcessingRequest,
    setProcessingRequest: (val) => { fullProcessingRequest = val; },
    getReady: () => fullEngineReady,
  });
}

/**
 * Send command to LITE engine
 */
async function sendLiteCommand(command, options = {}) {
  await ensureLiteEngineReady();
  return sendCommandInternal(command, options, "LITE", liteEngineProcess, liteRequestQueue, {
    getProcessingRequest: () => liteProcessingRequest,
    setProcessingRequest: (val) => { liteProcessingRequest = val; },
    getReady: () => liteEngineReady,
  });
}

/**
 * Internal command sender (shared logic for FULL and LITE)
 */
async function sendCommandInternal(command, options, engineType, engineProcess, requestQueue, state) {
  const { timeout = 10000, expectBestMove = false, multipv = 1 } = options;

  // Handle special commands that don't need response parsing
  if (command === "ucinewgame" || command.startsWith("position ")) {
    return new Promise((resolve, reject) => {
      if (state.getProcessingRequest()) {
        requestQueue.push({ command, options, resolve, reject });
        return;
      }
      state.setProcessingRequest(true);
      try {
        engineProcess.stdin.write(`${command}\n`);
        setTimeout(() => {
          state.setProcessingRequest(false);
          processNextInQueue(engineType, requestQueue, state);
          resolve({ bestMove: null, evaluation: { cp: 0 }, pv: [], depth: 0, nodes: 0, time: 0 });
        }, 50);
      } catch (err) {
        state.setProcessingRequest(false);
        processNextInQueue(engineType, requestQueue, state);
        reject(err);
      }
    });
  }

  if (command === "isready") {
    return new Promise((resolve, reject) => {
      if (state.getProcessingRequest()) {
        requestQueue.push({ command, options, resolve, reject });
        return;
      }
      state.setProcessingRequest(true);
      let stdoutBuffer = "";
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          state.setProcessingRequest(false);
          clearTimeout(timeoutId);
          if (engineProcess && engineProcess.stdout) {
            try {
              engineProcess.stdout.removeListener("data", dataHandler);
            } catch (err) {}
          }
          processNextInQueue(engineType, requestQueue, state);
          reject(new Error(`${engineType} isready timeout after ${timeout}ms`));
        }
      }, timeout);

      const dataHandler = (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "readyok" && !resolved) {
            resolved = true;
            state.setProcessingRequest(false);
            clearTimeout(timeoutId);
            if (engineProcess && engineProcess.stdout) {
              try {
                engineProcess.stdout.removeListener("data", dataHandler);
              } catch (err) {}
            }
            processNextInQueue(engineType, requestQueue, state);
            resolve({ bestMove: null, evaluation: { cp: 0 }, pv: [], depth: 0, nodes: 0, time: 0 });
            return;
          }
        }
      };

      engineProcess.stdout.on("data", dataHandler);
      engineProcess.stdin.write(`${command}\n`);
    });
  }

  // Regular command handling
  return new Promise((resolve, reject) => {
    if (state.getProcessingRequest()) {
      requestQueue.push({ command, options, resolve, reject });
      return;
    }

    state.setProcessingRequest(true);
    let stdoutBuffer = "";
    let bestMove = null;
    let pv = null;
    let evaluation = null;
    let depth = 0;
    let nodes = 0;
    let time = 0;
    let mate = null;
    let resolved = false;
    const multiPvLines = new Map();

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`${engineType} command timeout after ${timeout}ms: ${command.substring(0, 50)}`));
      }
    }, timeout);

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      state.setProcessingRequest(false);
      clearTimeout(timeoutId);
      if (engineProcess && engineProcess.stdout) {
        try {
          engineProcess.stdout.removeListener("data", dataHandler);
        } catch (err) {}
      }
      processNextInQueue(engineType, requestQueue, state);
    };

    const dataHandler = (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("info")) {
          const depthMatch = trimmed.match(/depth (\d+)/);
          if (depthMatch) depth = parseInt(depthMatch[1], 10);

          const nodesMatch = trimmed.match(/nodes (\d+)/);
          if (nodesMatch) nodes = parseInt(nodesMatch[1], 10);

          const timeMatch = trimmed.match(/time (\d+)/);
          if (timeMatch) time = parseInt(timeMatch[1], 10);

          const multipvMatch = trimmed.match(/\bmultipv (\d+)/);
          const lineMultiPv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;

          const cpMatch = trimmed.match(/score cp (-?\d+)/);
          const mateMatch = trimmed.match(/score mate (-?\d+)/);
          const pvMatch = trimmed.match(/pv\s+(.+)/);
          const linePv = pvMatch ? pvMatch[1].trim().split(/\s+/) : null;
          const lineEval = mateMatch
            ? { mate: parseInt(mateMatch[1], 10) }
            : cpMatch
              ? { cp: parseInt(cpMatch[1], 10) }
              : null;

          if (lineMultiPv === 1 && lineEval) {
            if (lineEval.mate !== undefined) {
              mate = lineEval.mate;
              evaluation = null;
            } else {
              evaluation = lineEval.cp;
              mate = null;
            }
          }

          if (lineMultiPv === 1 && linePv) {
            pv = linePv;
          }

          if (lineEval && linePv) {
            multiPvLines.set(lineMultiPv, {
              multipv: lineMultiPv,
              move: linePv[0] || null,
              pv: linePv,
              evaluation: lineEval,
            });
          }
        }

        if (trimmed.startsWith("bestmove")) {
          const parts = trimmed.split(/\s+/);
          if (parts.length > 1 && parts[1] !== "none") {
            bestMove = parts[1];
          }
          if (!resolved) {
            cleanup();
            
            // MANDATORY: Validate that we have at least ONE score (cp or mate) before resolving
            // DO NOT default to 0 - this causes evaluationGraph to be all zeros
            if (mate === null && evaluation === null) {
              const errorMsg = `Stockfish did not return score cp or score mate before bestmove. This indicates Stockfish timeout or error.`;
              console.error(`[Engine] ${errorMsg}`);
              console.error(`[Engine] Last depth: ${depth}, time: ${time}, nodes: ${nodes}`);
              reject(new Error(errorMsg));
              return;
            }
            
            // Build evaluation object - MUST have either cp or mate
            const evaluationObj = mate !== null ? { mate } : { cp: evaluation };
            
            console.log(`[Engine] Resolving with evaluation:`, JSON.stringify(evaluationObj));
            
            resolve({
              bestMove,
              evaluation: evaluationObj,
              pv: pv || [],
              depth,
              nodes,
              time,
              alternativeLines: Array.from(multiPvLines.values()).sort((a, b) => a.multipv - b.multipv),
            });
          }
          return;
        }

        if (!expectBestMove && evaluation !== null && !resolved) {
          cleanup();
          resolve({
            bestMove: null,
            evaluation: { cp: evaluation },
            pv: pv || [],
            depth,
            nodes,
            time,
          });
          return;
        }
      }
    };

    engineProcess.stdout.on("data", dataHandler);
    if (command.startsWith("go ")) {
      const clampedMultiPv = Math.max(1, Math.min(3, Number(multipv) || 1));
      engineProcess.stdin.write(`setoption name MultiPV value ${clampedMultiPv}\n`);
    }
    engineProcess.stdin.write(`${command}\n`);
  });
}

function processNextInQueue(engineType, requestQueue, state) {
  if (requestQueue.length === 0) {
    return;
  }

  const { command, options, resolve, reject } = requestQueue.shift();
  const sendFn = engineType === "FULL" ? sendFullCommand : sendLiteCommand;
  sendFn(command, options)
    .then(resolve)
    .catch(reject);
}

/**
 * Analyze position with FULL engine (high-depth, comprehensive)
 * @param {string[]} moves - Array of UCI moves
 * @param {Object} options - { depth: number, movetime: number }
 * @returns {Promise<Object>} - { evaluation, pv, depth, nodes, time, bestMove }
 */
async function analyzePositionFull(moves = [], options = {}) {
  const { depth = 18, movetime = 2000 } = options;
  
  let positionCmd = "position startpos";
  if (moves.length > 0) {
    positionCmd += ` moves ${moves.join(" ")}`;
  }

  try {
    await sendFullCommand(positionCmd, { timeout: 1000 });

    let goCmd;
    if (movetime) {
      goCmd = `go movetime ${movetime}`;
    } else {
      goCmd = `go depth ${depth}`;
    }

    const timeoutForGo = movetime ? movetime + 2000 : (depth * 1500);
    const result = await sendFullCommand(goCmd, { 
      expectBestMove: true, 
      timeout: Math.min(timeoutForGo, 8000)
    });
    return result;
  } catch (error) {
    console.error(`[GameReview-FULL] Error analyzing position:`, error.message);
    return {
      bestMove: null,
      evaluation: { cp: 0 },
      pv: [],
      depth: 0,
      nodes: 0,
      time: 0,
    };
  }
}

/**
 * Analyze position with LITE engine (quick review depth range)
 * @param {string[]} moves - Array of UCI moves
 * @param {Object} options - { depth: number, movetime: number }
 * @returns {Promise<Object>} - { evaluation, pv, depth, nodes, time, bestMove }
 */
async function analyzePositionLite(moves = [], options = {}) {
  const { depth = 12, movetime = 600, multipv = 1, searchMoves = null } = options;

  const clampedDepth = Math.max(4, Math.min(20, Math.round(depth)));
  
  let positionCmd = "position startpos";
  if (moves.length > 0) {
    positionCmd += ` moves ${moves.join(" ")}`;
  }

  try {
    await sendLiteCommand(positionCmd, { timeout: 1000 });

    // Use both depth and movetime: search to depth X but stop if movetime exceeded
    let goCmd = `go depth ${clampedDepth} movetime ${movetime}`;
    if (Array.isArray(searchMoves) && searchMoves.length > 0) {
      goCmd += ` searchmoves ${searchMoves.join(" ")}`;
    }

    // Timeout should be slightly longer than movetime
    const timeoutForGo = movetime + 1000; // Give 1 second buffer
    
    const result = await sendLiteCommand(goCmd, { 
      expectBestMove: true, 
      timeout: Math.min(timeoutForGo, 2000), // Max 2 seconds for LITE engine
      multipv,
    });
    return result;
  } catch (error) {
    console.error(`[GameReview-LITE] Error analyzing position:`, error.message);
    return {
      bestMove: null,
      evaluation: { cp: 0 },
      pv: [],
      depth: 0,
      nodes: 0,
      time: 0,
    };
  }
}

/**
 * Get best move using FULL engine
 */
async function getBestMoveFull(moves = [], options = {}) {
  const result = await analyzePositionFull(moves, options);
  return result.bestMove;
}

/**
 * Get best move using LITE engine
 */
async function getBestMoveLite(moves = [], options = {}) {
  const result = await analyzePositionLite(moves, options);
  return result.bestMove;
}

/**
 * Cleanup FULL engine
 */
function cleanupFull() {
  if (fullEngineProcess) {
    try {
      fullEngineProcess.stdin.write("quit\n");
    } catch (err) {}
    fullEngineProcess = null;
    fullEngineReady = false;
  }
}

/**
 * Cleanup LITE engine
 */
function cleanupLite() {
  if (liteEngineProcess) {
    try {
      liteEngineProcess.stdin.write("quit\n");
    } catch (err) {}
    liteEngineProcess = null;
    liteEngineReady = false;
  }
}

// Legacy exports for backward compatibility (use FULL engine)
async function ensureEngineReady() {
  return ensureFullEngineReady();
}

async function sendCommand(command, options = {}) {
  return sendFullCommand(command, options);
}

async function analyzePosition(moves = [], options = {}) {
  return analyzePositionFull(moves, options);
}

async function getBestMove(moves = [], options = {}) {
  return getBestMoveFull(moves, options);
}

function cleanup() {
  cleanupFull();
}

module.exports = {
  // NEW: Separate FULL and LITE engines
  analyzePositionFull,
  analyzePositionLite,
  getBestMoveFull,
  getBestMoveLite,
  sendFullCommand,
  sendLiteCommand,
  ensureFullEngineReady,
  ensureLiteEngineReady,
  cleanupFull,
  cleanupLite,
  
  // Legacy exports (use FULL engine for backward compatibility)
  initEngine: initFullEngine,
  ensureEngineReady,
  analyzePosition,
  getBestMove,
  sendCommand,
  cleanup,
};
