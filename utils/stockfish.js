const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const { resolveStockfishBinary } = require("./resolveStockfishBinary");

function getStockfishPath() {
  const resolved = resolveStockfishBinary(path.join(__dirname, "..", "stockfish"));
  console.log(`[Stockfish] Using binary: ${resolved}`);
  return resolved;
}

const STOCKFISH_PATH = getStockfishPath();
const BOT_INTELLIGENCE_CONFIG = {
  eloThresholds: {
    beginnerMax: 799,
    highEloMin: 2200,
  },
  multiPvWeights: {
    high: [0.9, 0.07, 0.03], // Top, 2nd, 3rd
    medium: [0.7, 0.2, 0.1], // Top, 2nd, 3rd
    beginner: [0.58, 0.27, 0.15], // More 3rd-best variety for low Elo bots
  },
  endgame: {
    pieceCountMax: 10,
    // Match mobile `endgameSearchBoost` (depth bump only; movetime unchanged).
    depthBonus: 1,
    killerInstinct: {
      cpThreshold: 500, // +5.0 pawns
      winningMateOnly: true,
    },
  },
};

/**
 * Map site ELO → Stockfish knobs.
 * Aligned with mobile `BotDifficultyMapper.mapRatingToStockfishConfig` +
 * `BotEngineConfigurator.configureEngineForBot` (UCI LimitStrength / MultiPV).
 */
function getStockfishConfig(elo, timeRemaining = null, customConfig = null) {
  const requestedElo =
    customConfig &&
    typeof customConfig === "object" &&
    typeof customConfig.elo === "number"
      ? customConfig.elo
      : elo;

  // Site Elo is always clamped to the bot roster range.
  const siteElo = Math.max(
    500,
    Math.min(2800, typeof requestedElo === "number" ? Math.round(requestedElo) : 1500)
  );
  // Stockfish UCI_Elo floor ~1320; below that weaken via Skill Level + depth/nodes.
  const engineElo = Math.max(1320, siteElo);
  let skillLevel = Math.round(((siteElo - 500) / 2300) * 20);
  skillLevel = Math.max(0, Math.min(20, skillLevel));

  let depth;
  if (siteElo <= 600) depth = 2;
  else if (siteElo <= 800) depth = 3;
  else if (siteElo <= 1000) depth = 4;
  else if (siteElo <= 1150) depth = 5;
  else if (siteElo < 1320) depth = 6;
  else if (siteElo < 1600) depth = Math.floor(siteElo / 100) - 1; // 1550 → 14
  else if (siteElo < 2000) depth = Math.floor(siteElo / 100); // 1700 → 17
  else depth = Math.floor(siteElo / 100) + 1;
  depth = Math.max(2, Math.min(28, depth));

  let movetime;
  if (siteElo < 1000) movetime = 700;
  else if (siteElo < 1300) movetime = 1200;
  else if (siteElo < 1600) movetime = 2400;
  else if (siteElo < 1900) movetime = 2800;
  else if (siteElo < 2200) movetime = 3200;
  else movetime = 4000;

  let nodes;
  if (siteElo < 1000) nodes = 25000;
  else if (siteElo < 1300) nodes = 80000;
  else if (siteElo < 1600) nodes = 400000;
  else if (siteElo < 1900) nodes = 650000;
  else if (siteElo < 2200) nodes = 900000;
  else if (siteElo < 2500) nodes = 1200000;
  else nodes = 1800000;

  // Match mobile: LimitStrength only ≥1400; weak bots use Skill Level + MultiPV 3.
  let useLimitStrength = siteElo >= 1400;
  let multipv = siteElo < 1400 ? 3 : 2;

  const delayT = (siteElo - 500) / 2300;
  let artificialDelay = Math.round(3000 - delayT * 2000);

  // Keep enough reserve in timed games and reduce human-delay progressively.
  if (typeof timeRemaining === "number" && timeRemaining > 0) {
    const reserve = Math.max(50, Math.min(800, Math.floor(timeRemaining * 0.04)));
    const maxThinkBudget = Math.max(120, timeRemaining - reserve);
    movetime = Math.min(movetime, maxThinkBudget);
    if (timeRemaining < 30000) {
      nodes = Math.max(40000, Math.round(nodes * 0.35));
      depth = Math.max(2, depth - 3);
      artificialDelay = 0;
    } else if (timeRemaining < 60000) {
      nodes = Math.max(60000, Math.round(nodes * 0.55));
      depth = Math.max(3, depth - 2);
      artificialDelay = Math.min(artificialDelay, Math.floor(timeRemaining * 0.12));
    } else if (timeRemaining < 180000) {
      artificialDelay = Math.min(artificialDelay, 700);
    }
  }

  // Optional direct custom overrides (if explicitly provided).
  if (customConfig && typeof customConfig === "object") {
    if (typeof customConfig.skillLevel === "number") {
      skillLevel = Math.max(0, Math.min(20, Math.round(customConfig.skillLevel)));
    }
    if (typeof customConfig.depth === "number") {
      depth = Math.max(1, Math.min(40, Math.round(customConfig.depth)));
    }
    if (typeof customConfig.movetime === "number") {
      movetime = Math.max(50, Math.min(6000, Math.round(customConfig.movetime)));
    }
    if (typeof customConfig.nodes === "number") {
      nodes = Math.max(1000, Math.round(customConfig.nodes));
    }
    if (typeof customConfig.multipv === "number") {
      multipv = Math.max(1, Math.min(3, Math.round(customConfig.multipv)));
    }
    if (typeof customConfig.useLimitStrength === "boolean") {
      useLimitStrength = customConfig.useLimitStrength;
    }
    if (customConfig.disableArtificialDelay === true) {
      artificialDelay = 0;
    } else if (typeof customConfig.artificialDelayMs === "number") {
      artificialDelay = Math.max(0, Math.round(customConfig.artificialDelayMs));
    }
  }

  return {
    siteElo,
    engineElo,
    skillLevel,
    depth,
    movetime,
    nodes,
    useLimitStrength,
    multipv,
    artificialDelay,
  };
}

function getBoardPhase(board) {
  const pieceCount = Array.isArray(board) ? board.filter(Boolean).length : 32;
  if (pieceCount >= 26) return { phase: "opening", pieceCount };
  if (pieceCount <= 10) return { phase: "endgame", pieceCount };
  return { phase: "middlegame", pieceCount };
}

function parseInfoLineForMultiPv(line) {
  if (!line.startsWith("info ")) return null;
  const multipvMatch = line.match(/\bmultipv\s+(\d+)/i);
  const pvMatch = line.match(/\bpv\s+([a-h][1-8][a-h][1-8][nbrq]?)/i);
  if (!multipvMatch || !pvMatch) return null;
  const rank = parseInt(multipvMatch[1], 10);
  if (!Number.isFinite(rank) || rank <= 0) return null;
  const depthMatch = line.match(/\bdepth\s+(\d+)/i);
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/i);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/i);
  return {
    rank,
    uci: pvMatch[1],
    depth: depthMatch ? parseInt(depthMatch[1], 10) : 0,
    cp: cpMatch ? parseInt(cpMatch[1], 10) : null,
    mate: mateMatch ? parseInt(mateMatch[1], 10) : null,
  };
}

function selectMoveFromMultiPv(lines, siteElo, killerInstinct) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { selected: null, rank: 1 };
  }
  const ordered = [...lines]
    .filter((l) => l && typeof l.rank === "number" && typeof l.uci === "string")
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
  if (ordered.length === 0) return { selected: null, rank: 1 };
  if (killerInstinct || ordered.length === 1) {
    return { selected: ordered[0], rank: ordered[0].rank || 1 };
  }
  const { beginnerMax, highEloMin } = BOT_INTELLIGENCE_CONFIG.eloThresholds;
  const weights =
    siteElo <= beginnerMax
      ? BOT_INTELLIGENCE_CONFIG.multiPvWeights.beginner
      : siteElo >= highEloMin
        ? BOT_INTELLIGENCE_CONFIG.multiPvWeights.high
        : BOT_INTELLIGENCE_CONFIG.multiPvWeights.medium;
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < ordered.length; i++) {
    acc += weights[i] ?? 0;
    if (r <= acc) return { selected: ordered[i], rank: ordered[i].rank || i + 1 };
  }
  const fallback = ordered[0];
  return { selected: fallback, rank: fallback.rank || 1 };
}

function computeDynamicThinkingDelay(baseDelayMs, meta, timeRemaining = null) {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) return 0;
  const phase = meta?.phase || "middlegame";
  const topCp = typeof meta?.topCp === "number" ? Math.abs(meta.topCp) : null;
  const secondCp = typeof meta?.secondCp === "number" ? Math.abs(meta.secondCp) : null;
  const cpGap =
    topCp != null && secondCp != null ? Math.abs(topCp - secondCp) : null;
  const hasMate = typeof meta?.topMate === "number";
  let factor = 1;
  if (phase === "opening") factor = 0.75;
  else if (phase === "endgame") factor = 0.65;
  else factor = 1.15;
  if (phase === "middlegame" && (cpGap == null || cpGap < 35)) factor *= 1.2;
  if (hasMate || (topCp != null && topCp >= 500)) factor *= 0.6;
  if (meta?.selectedRank && meta.selectedRank > 1) factor *= 1.12;
  let delay = Math.round(baseDelayMs * factor);
  if (typeof timeRemaining === "number" && timeRemaining > 0) {
    if (timeRemaining < 30000) delay = Math.min(delay, 120);
    else if (timeRemaining < 60000) delay = Math.min(delay, 280);
  }
  return Math.max(0, delay);
}

// Helper to convert board index (0..63) to algebraic square like "e4"
function indexToSquare(index) {
  const files = "abcdefgh";
  const row = Math.floor(index / 8); // 0 (8th rank) .. 7 (1st rank)
  const col = index % 8;
  const file = files[col];
  const rank = 8 - row;
  return `${file}${rank}`;
}

// Derive castling rights from current board + move history
function getCastlingRights(board, moveHistory = []) {
  let canCastleK = false;
  let canCastleQ = false;
  let canCastlek = false;
  let canCastleq = false;

  // Starting squares (0‑based indices)
  const WHITE_KING = 60; // e1
  const WHITE_ROOK_A = 56; // a1
  const WHITE_ROOK_H = 63; // h1
  const BLACK_KING = 4; // e8
  const BLACK_ROOK_A = 0; // a8
  const BLACK_ROOK_H = 7; // h8

  const moves = Array.isArray(moveHistory) ? moveHistory : [];

  // White
  const whiteKingOnStart = board[WHITE_KING] === "K";
  const whiteKingsideRookOnStart = board[WHITE_ROOK_H] === "R";
  const whiteQueensideRookOnStart = board[WHITE_ROOK_A] === "R";

  const whiteKingMoved = moves.some(
    (m) =>
      m &&
      typeof m.from === "number" &&
      typeof m.to === "number" &&
      m.piece === "K"
  );
  const whiteRookA_Moved = moves.some(
    (m) =>
      m &&
      typeof m.from === "number" &&
      m.from === WHITE_ROOK_A &&
      (m.piece === "R" || m.piece === "r")
  );
  const whiteRookH_Moved = moves.some(
    (m) =>
      m &&
      typeof m.from === "number" &&
      m.from === WHITE_ROOK_H &&
      (m.piece === "R" || m.piece === "r")
  );

  if (whiteKingOnStart && !whiteKingMoved) {
    if (whiteKingsideRookOnStart && !whiteRookH_Moved) {
      canCastleK = true;
    }
    if (whiteQueensideRookOnStart && !whiteRookA_Moved) {
      canCastleQ = true;
    }
  }

  // Black
  const blackKingOnStart = board[BLACK_KING] === "k";
  const blackKingsideRookOnStart = board[BLACK_ROOK_H] === "r";
  const blackQueensideRookOnStart = board[BLACK_ROOK_A] === "r";

  const blackKingMoved = moves.some(
    (m) =>
      m &&
      typeof m.from === "number" &&
      typeof m.to === "number" &&
      m.piece === "k"
  );
  const blackRookA_Moved = moves.some(
    (m) =>
      m &&
      typeof m.from === "number" &&
      m.from === BLACK_ROOK_A &&
      (m.piece === "R" || m.piece === "r")
  );
  const blackRookH_Moved = moves.some(
    (m) =>
      m &&
      typeof m.from === "number" &&
      m.from === BLACK_ROOK_H &&
      (m.piece === "R" || m.piece === "r")
  );

  if (blackKingOnStart && !blackKingMoved) {
    if (blackKingsideRookOnStart && !blackRookH_Moved) {
      canCastlek = true;
    }
    if (blackQueensideRookOnStart && !blackRookA_Moved) {
      canCastleq = true;
    }
  }

  let rights = "";
  if (canCastleK) rights += "K";
  if (canCastleQ) rights += "Q";
  if (canCastlek) rights += "k";
  if (canCastleq) rights += "q";
  return rights || "-";
}

// Derive en passant target square from the last move, if applicable
function getEnPassantSquare(moveHistory = []) {
  if (!Array.isArray(moveHistory) || moveHistory.length === 0) {
    return "-";
  }

  const lastMove = moveHistory[moveHistory.length - 1];
  if (
    !lastMove ||
    typeof lastMove.from !== "number" ||
    typeof lastMove.to !== "number" ||
    !lastMove.piece
  ) {
    return "-";
  }

  const piece = lastMove.piece;
  const isPawn = piece.toLowerCase() === "p";
  if (!isPawn) return "-";

  const fromRow = Math.floor(lastMove.from / 8);
  const toRow = Math.floor(lastMove.to / 8);
  if (Math.abs(toRow - fromRow) !== 2) {
    return "-"; // Not a two‑square pawn move
  }

  const midRow = (fromRow + toRow) / 2;
  const col = lastMove.to % 8;
  const epIndex = midRow * 8 + col;
  return indexToSquare(epIndex);
}

/**
 * Prefer chess.js FEN from move history (Stockfish 19 rejects illegal EP/castling FENs).
 * Falls back to manual board assembly when history cannot be replayed.
 */
function boardToFEN(board, currentTurn, moveHistory = []) {
  try {
    const { Chess } = require("chess.js");
    const chess = new Chess();
    const moves = Array.isArray(moveHistory) ? moveHistory : [];
    let replayed = true;
    for (const m of moves) {
      if (!m || typeof m.from !== "number" || typeof m.to !== "number") {
        replayed = false;
        break;
      }
      const from = indexToSquare(m.from);
      const to = indexToSquare(m.to);
      let promotion;
      if (m.promotion) {
        const p = String(m.promotion).toLowerCase();
        promotion = p[0] === "q" || p === "queen" ? "q"
          : p[0] === "r" || p === "rook" ? "r"
          : p[0] === "b" || p === "bishop" ? "b"
          : p[0] === "n" || p === "knight" ? "n"
          : undefined;
      }
      const played = chess.move({ from, to, promotion });
      if (!played) {
        replayed = false;
        break;
      }
    }
    if (replayed) {
      const expectedTurn = currentTurn === "white" ? "w" : "b";
      if (chess.turn() === expectedTurn) {
        return chess.fen();
      }
    }
  } catch {
    // fall through to manual FEN
  }

  let fen = "";

  // Build board position
  for (let row = 0; row < 8; row++) {
    let emptyCount = 0;
    for (let col = 0; col < 8; col++) {
      const idx = row * 8 + col;
      const piece = board[idx];

      if (!piece) {
        emptyCount++;
      } else {
        if (emptyCount > 0) {
          fen += emptyCount;
          emptyCount = 0;
        }
        fen += piece;
      }
    }
    if (emptyCount > 0) {
      fen += emptyCount;
    }
    if (row < 7) fen += "/";
  }

  // Add turn
  fen += ` ${currentTurn === "white" ? "w" : "b"}`;

  // Add castling rights derived from board + history
  const castling = getCastlingRights(board, moveHistory);
  fen += ` ${castling}`;

  // EP only for the opponent of the side that just double-pushed.
  let epSquare = getEnPassantSquare(moveHistory);
  if (epSquare && epSquare !== "-") {
    const last = moveHistory[moveHistory.length - 1];
    const lastIsWhite = last && typeof last.piece === "string" && last.piece === last.piece.toUpperCase();
    const sideToMoveIsWhite = currentTurn === "white";
    if (lastIsWhite === sideToMoveIsWhite) {
      epSquare = "-";
    }
  }
  fen += ` ${epSquare || "-"}`;

  // Add halfmove and fullmove (simplified)
  fen += ` 0 ${Math.floor(moveHistory.length / 2) + 1}`;

  return fen;
}

// Convert board array to UCI move format (e.g., "e2e4")
function boardIndexToUCI(from, to) {
  const files = "abcdefgh";
  const ranks = "12345678";

  const fromFile = from % 8;
  const fromRank = 7 - Math.floor(from / 8);
  const toFile = to % 8;
  const toRank = 7 - Math.floor(to / 8);

  return `${files[fromFile]}${ranks[fromRank]}${files[toFile]}${ranks[toRank]}`;
}

// Convert UCI move to board indices
// Handles both regular moves (e2e4) and promotions (e7e8q)
function uciToBoardIndices(uci) {
  if (uci.length < 4) return null;

  const files = "abcdefgh";
  const ranks = "12345678";

  const fromFile = files.indexOf(uci[0]);
  const fromRank = 8 - parseInt(uci[1]);
  const toFile = files.indexOf(uci[2]);
  const toRank = 8 - parseInt(uci[3]);

  if (
    fromFile === -1 ||
    fromRank < 0 ||
    fromRank > 7 ||
    toFile === -1 ||
    toRank < 0 ||
    toRank > 7
  ) {
    return null;
  }

  const result = {
    from: fromRank * 8 + fromFile,
    to: toRank * 8 + toFile,
  };

  // Check for promotion (5th character: q, r, b, n)
  if (uci.length >= 5) {
    const promotionChar = uci[4].toLowerCase();
    const promotionMap = {
      q: "queen",
      r: "rook",
      b: "bishop",
      n: "knight",
    };
    if (promotionMap[promotionChar]) {
      result.promotion = promotionMap[promotionChar];
    }
  }

  return result;
}

// ---------- Native Stockfish engine integration (UCI over stdin/stdout) ----------

let engineProcess = null;
let engineReady = false;
let pendingRequest = null; // { resolve, reject, timeoutId, multiPvLines: Map<number, ...>, config }

function initEngine() {
  if (engineProcess) {
    return;
  }

  // Check if binary exists (unless it's a system PATH command)
  if (STOCKFISH_PATH !== "stockfish") {
    const absolutePath = path.resolve(STOCKFISH_PATH);
    console.log(`[Stockfish] Resolved path: ${absolutePath}`);
    console.log(`[Stockfish] Path exists: ${fs.existsSync(STOCKFISH_PATH)}`);

    if (!fs.existsSync(STOCKFISH_PATH)) {
      console.error(
        `[Stockfish] Binary not found at: ${STOCKFISH_PATH} (absolute: ${absolutePath}). Falling back to internal bot.`
      );
      engineProcess = null;
      engineReady = false;
      return;
    }

    // On Linux/Unix, ensure the binary is executable
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(STOCKFISH_PATH, 0o755);
        const stats = fs.statSync(STOCKFISH_PATH);
        console.log(
          `[Stockfish] Binary permissions set. Is executable: ${
            (stats.mode & parseInt("111", 8)) !== 0
          }`
        );
      } catch (err) {
        console.warn(
          `[Stockfish] Could not set execute permissions on ${STOCKFISH_PATH}:`,
          err.message
        );
      }
    }
  }

  try {
    // Spawn the Stockfish engine process
    // Use absolute path to avoid any path resolution issues
    const spawnPath =
      STOCKFISH_PATH !== "stockfish"
        ? path.resolve(STOCKFISH_PATH)
        : STOCKFISH_PATH;

    console.log(`[Stockfish] Spawning process: ${spawnPath}`);
    engineProcess = spawn(spawnPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Verify process was created
    if (!engineProcess || engineProcess.pid === undefined) {
      throw new Error("Failed to create process (pid is undefined)");
    }

    console.log(
      `[Stockfish] Process spawned successfully. PID: ${engineProcess.pid}`
    );
  } catch (err) {
    console.error(
      "[Stockfish] Failed to spawn engine. Falling back to internal bot.",
      err
    );
    engineProcess = null;
    engineReady = false;
    return;
  }

  engineProcess.stdout.on("data", (data) => {
    const text = data.toString();
    // Enable logging to debug initialization issues
    console.log("[Stockfish][stdout]:", text.trim());

    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (line === "uciok") {
          console.log("[Stockfish] Engine is ready (uciok received)");
          engineReady = true;
        }

        if (pendingRequest && line.startsWith("info ")) {
          const parsed = parseInfoLineForMultiPv(line);
          if (parsed && pendingRequest.multiPvLines) {
            const prev = pendingRequest.multiPvLines.get(parsed.rank);
            if (!prev || (parsed.depth || 0) >= (prev.depth || 0)) {
              pendingRequest.multiPvLines.set(parsed.rank, parsed);
            }
          }
        }

        if (line.startsWith("bestmove") && pendingRequest) {
          // Parse "bestmove e7e8q" or "bestmove e7e8q ponder ..."
          const parts = line.split(" ");
          const bestMoveUci = parts[1]; // Get the move (e.g., "e7e8q")
          const req = pendingRequest;
          pendingRequest = null;
          clearTimeout(req.timeoutId);

          try {
            // Raw MultiPV lines — personality / mistakes select outside the engine I/O.
            const multiPv = Array.from(req.multiPvLines?.values?.() || [])
              .sort((a, b) => a.rank - b.rank)
              .slice(0, 3);
            const lines = multiPv.map((l) => ({
              rank: l.rank,
              uci: l.uci,
              depth: l.depth || 0,
              centipawns: typeof l.cp === "number" ? l.cp : 0,
              mate: typeof l.mate === "number" ? l.mate : null,
            }));
            const indices = uciToBoardIndices(bestMoveUci);
            if (!bestMoveUci || bestMoveUci === "(none)") {
              req.reject(new Error("Stockfish returned no bestmove"));
            } else {
              req.resolve({
                bestMoveUci,
                lines,
                move: indices || null,
                meta: {
                  phase: req.config?.phase || "middlegame",
                  pieceCount: req.config?.pieceCount ?? null,
                  siteElo: req.config?.siteElo || 1500,
                },
              });
            }
          } catch (err) {
            req.reject(err);
          }
        }
      });
  });

  engineProcess.stderr.on("data", (data) => {
    console.error("[Stockfish][stderr]:", data.toString());
  });

  engineProcess.on("error", (err) => {
    console.error(
      "[Stockfish] Engine process error. Falling back to internal bot:",
      err
    );
    engineProcess = null;
    engineReady = false;
    if (pendingRequest) {
      pendingRequest.reject(
        new Error("Stockfish engine error before responding")
      );
      clearTimeout(pendingRequest.timeoutId);
      pendingRequest = null;
    }
  });

  engineProcess.on("exit", (code, signal) => {
    console.error("[Stockfish] Engine exited:", { code, signal });
    engineProcess = null;
    engineReady = false;
    if (pendingRequest) {
      pendingRequest.reject(
        new Error("Stockfish engine exited before responding")
      );
      clearTimeout(pendingRequest.timeoutId);
      pendingRequest = null;
    }
  });

  // Initialize UCI
  engineProcess.stdin.write("uci\n");
}

function ensureEngineReady() {
  initEngine();
  if (!engineProcess) {
    return Promise.reject(
      new Error(
        "Stockfish engine not available (binary missing or failed to start)"
      )
    );
  }

  // Check if process is still running
  if (engineProcess.killed || engineProcess.exitCode !== null) {
    console.error(
      "[Stockfish] Engine process has exited. Exit code:",
      engineProcess.exitCode
    );
    engineProcess = null;
    engineReady = false;
    return Promise.reject(
      new Error("Stockfish engine process exited unexpectedly")
    );
  }

  if (engineReady) return Promise.resolve();

  console.log("[Stockfish] Waiting for engine to become ready...");
  return new Promise((resolve, reject) => {
    // Increased timeout to 10 seconds for slower systems (like Render)
    const timeout = 100000000000000000000000000000000000;
    const start = Date.now();
    const check = () => {
      if (engineReady) {
        console.log("[Stockfish] Engine ready confirmed");
        return resolve();
      }

      // Check if process died while waiting
      if (
        engineProcess &&
        (engineProcess.killed || engineProcess.exitCode !== null)
      ) {
        console.error(
          "[Stockfish] Engine process died while waiting for ready"
        );
        engineProcess = null;
        engineReady = false;
        return reject(
          new Error("Stockfish engine process exited while initializing")
        );
      }

      const elapsed = Date.now() - start;
      if (elapsed > timeout) {
        console.error(
          `[Stockfish] Timeout after ${elapsed}ms. Engine ready: ${engineReady}`
        );
        return reject(
          new Error(
            `Stockfish engine did not become ready in time (${timeout}ms)`
          )
        );
      }
      setTimeout(check, 100); // Check every 100ms instead of 50ms
    };
    check();
  });
}

async function getBestMoveFromEngine(
  board,
  currentTurn,
  moveHistory,
  elo,
  timeRemaining = null,
  customConfig = null
) {
  await ensureEngineReady();

  if (pendingRequest) {
    // Engine is currently busy with another request; avoid queue complexity for now.
    throw new Error("Stockfish engine is busy");
  }

  const injected = customConfig && customConfig.engineConfiguration;
  let siteElo;
  let engineElo;
  let skillLevel;
  let useLimitStrength;
  let multipv;
  let effectiveDepth;
  let effectiveMovetime;
  let effectiveNodes;

  if (injected && injected.uci && injected.search) {
    siteElo = injected.siteElo || elo || 1500;
    engineElo = injected.uci.uciElo;
    skillLevel = injected.uci.skillLevel;
    useLimitStrength = Boolean(injected.uci.useLimitStrength);
    multipv = injected.uci.multipv || 1;
    effectiveDepth = injected.search.depth;
    effectiveMovetime = injected.search.movetime;
    effectiveNodes = injected.search.nodes || 0;
  } else {
    const mapped = getStockfishConfig(elo || 1500, timeRemaining, customConfig);
    siteElo = mapped.siteElo;
    engineElo = mapped.engineElo;
    skillLevel = mapped.skillLevel;
    useLimitStrength = mapped.useLimitStrength;
    multipv = mapped.multipv;
    effectiveDepth = mapped.depth;
    effectiveMovetime = mapped.movetime;
    effectiveNodes = mapped.nodes;
    const endgameCfg = BOT_INTELLIGENCE_CONFIG.endgame;
    const { phase: egPhase, pieceCount: egPieces } = getBoardPhase(board);
    if (egPhase === "endgame" || egPieces <= endgameCfg.pieceCountMax) {
      effectiveDepth = Math.min(40, mapped.depth + endgameCfg.depthBonus);
    }
  }

  if (multipv > 1) {
    effectiveDepth = Math.max(effectiveDepth, 2);
  }
  const { phase, pieceCount } = getBoardPhase(board);
  const fen = boardToFEN(board, currentTurn, moveHistory);

  // Prepare a promise that will be resolved when we see "bestmove" on stdout
  const promise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRequest) {
        pendingRequest = null;
      }
      reject(new Error("Stockfish move timeout"));
    }, Math.min(45000, Math.max(8000, effectiveMovetime * 4 + 2000)));

    pendingRequest = {
      resolve,
      reject,
      timeoutId,
      multiPvLines: new Map(),
      config: { siteElo, phase, pieceCount },
    };
  });

  // Send new-game / options and position — UCI knobs match mobile StockfishClient.
  engineProcess.stdin.write("ucinewgame\n");
  engineProcess.stdin.write("isready\n");
  if (useLimitStrength) {
    engineProcess.stdin.write("setoption name UCI_LimitStrength value true\n");
    engineProcess.stdin.write(`setoption name UCI_Elo value ${engineElo}\n`);
  } else {
    engineProcess.stdin.write("setoption name UCI_LimitStrength value false\n");
    engineProcess.stdin.write(`setoption name Skill Level value ${skillLevel}\n`);
  }
  engineProcess.stdin.write(`setoption name MultiPV value ${multipv}\n`);
  engineProcess.stdin.write("setoption name Threads value 1\n");
  engineProcess.stdin.write("setoption name Hash value 16\n");
  // Same go shape as mobile: depth + movetime + nodes (no clock in go).
  const goParts = [
    "go",
    `depth ${effectiveDepth}`,
    `movetime ${Math.max(80, effectiveMovetime)}`,
  ];
  if (effectiveNodes > 0) {
    goParts.push(`nodes ${Math.round(effectiveNodes)}`);
  }
  const goCmd = goParts.join(" ");
  console.log(
    `[Stockfish][UCI] Elo: ${siteElo} -> Target: ${engineElo}, LimitStrength: ${useLimitStrength}, Skill: ${skillLevel}, MultiPV: ${multipv}, Depth: ${effectiveDepth}, Movetime: ${effectiveMovetime}, Nodes: ${effectiveNodes}, Phase: ${phase}`
  );
  console.log(`[Stockfish][UCI] ${goCmd}`);
  engineProcess.stdin.write(`position fen ${fen}\n`);
  engineProcess.stdin.write(`${goCmd}\n`);

  return promise;
}

function moveHistoryToUci(moveHistory = []) {
  const promoMap = {
    queen: "q",
    rook: "r",
    bishop: "b",
    knight: "n",
    q: "q",
    r: "r",
    b: "b",
    n: "n",
  };
  return (Array.isArray(moveHistory) ? moveHistory : [])
    .map((m) => {
      if (!m || typeof m.from !== "number" || typeof m.to !== "number") return null;
      let uci = boardIndexToUCI(m.from, m.to);
      if (m.promotion) {
        const p = promoMap[String(m.promotion).toLowerCase()];
        if (p) uci += p;
      }
      return uci;
    })
    .filter(Boolean);
}

function lastMoveWasCapture(_board, moveHistory) {
  if (!Array.isArray(moveHistory) || moveHistory.length === 0) return false;
  const last = moveHistory[moveHistory.length - 1];
  return Boolean(last && last.captured);
}

// Get best move using Stockfish + mobile-parity bot AI (personality / book / mistakes).
async function getBestMove(
  board,
  currentTurn,
  moveHistory,
  elo,
  timeRemaining = null,
  customConfig = null
) {
  const cfg = customConfig && typeof customConfig === "object" ? customConfig : {};

  // Hints / raw engine: skip personality pipeline, take Stockfish bestmove.
  if (cfg.hintMode === true || cfg.disableBotAI === true) {
    try {
      const engineResult = await getBestMoveFromEngine(
        board,
        currentTurn,
        moveHistory,
        elo,
        timeRemaining,
        { ...cfg, disableArtificialDelay: true }
      );
      if (engineResult?.move) return engineResult.move;
      if (engineResult?.bestMoveUci) {
        const indices = uciToBoardIndices(engineResult.bestMoveUci);
        if (indices) return indices;
      }
      return getFallbackMove(board, currentTurn);
    } catch (err) {
      console.error("Stockfish hint error, using fallback move:", err.message);
      return getFallbackMove(board, currentTurn);
    }
  }

  try {
    const {
      resolveBotProfile,
      pickBotMove,
      buildPositionContext,
    } = require("./bot-ai");

    const fen = boardToFEN(board, currentTurn, moveHistory);
    const uciHistory = moveHistoryToUci(moveHistory);
    const lastMoveUci = uciHistory.length ? uciHistory[uciHistory.length - 1] : undefined;
    const whiteTime =
      typeof cfg.whiteTime === "number" && cfg.whiteTime > 0 ? cfg.whiteTime : null;
    const blackTime =
      typeof cfg.blackTime === "number" && cfg.blackTime > 0 ? cfg.blackTime : null;
    const botClockMs =
      currentTurn === "white"
        ? whiteTime || timeRemaining || 600000
        : blackTime || timeRemaining || 600000;
    const opponentClockMs =
      currentTurn === "white"
        ? blackTime || 600000
        : whiteTime || 600000;
    const incrementMs =
      typeof cfg.incrementMs === "number"
        ? cfg.incrementMs
        : typeof cfg.increment === "number"
          ? cfg.increment > 0 && cfg.increment <= 60
            ? cfg.increment * 1000
            : cfg.increment
          : 0;

    const profile = resolveBotProfile({
      botKey: cfg.botKey || cfg.botId || cfg.key,
      botName: cfg.botName || cfg.name,
      elo: typeof cfg.elo === "number" ? cfg.elo : elo,
    });

    const context = buildPositionContext({
      fen,
      uciHistory,
      botClockMs,
      opponentClockMs,
      incrementMs,
      lastMoveUci,
      lastMoveWasCapture: lastMoveWasCapture(board, moveHistory),
    });

    const picked = await pickBotMove({
      profile,
      context,
      botColor: currentTurn === "black" ? "black" : "white",
      searchEngine: async (_fen, engineConfiguration) => {
        const raw = await getBestMoveFromEngine(
          board,
          currentTurn,
          moveHistory,
          profile.rating,
          botClockMs,
          {
            ...cfg,
            engineConfiguration,
            disableArtificialDelay: true,
          }
        );
        return {
          bestMoveUci: raw.bestMoveUci,
          lines: raw.lines || [],
        };
      },
    });

    console.log(
      `[BotAI] ${profile.id}@${profile.rating} source=${picked.source} rank=${picked.selectedRank} kind=${picked.thinkPlan?.kind} uci=${picked.uci} elapsed=${picked.elapsedMs}ms`
    );

    const indices = uciToBoardIndices(picked.uci);
    if (!indices) {
      console.warn("[BotAI] Invalid UCI from pipeline, falling back:", picked.uci);
      return getFallbackMove(board, currentTurn);
    }
    return indices;
  } catch (err) {
    console.error("Stockfish/BotAI error, using fallback move:", err.message);
    return getFallbackMove(board, currentTurn);
  }
}

// Fallback move generator (uses proper chess engine for legal moves)
// This handles ALL piece types and validates moves don't leave king in check
function getFallbackMove(board, currentTurn) {
  const {
    getAllLegalMoves,
    isCheckmate,
    isStalemate,
  } = require("./chess-engine");
  const isWhite = currentTurn === "white";

  // Check if game is already over (checkmate/stalemate)
  if (isCheckmate(board, isWhite)) {
    throw new Error("Checkmate - no legal moves available");
  }
  if (isStalemate(board, isWhite)) {
    throw new Error("Stalemate - no legal moves available");
  }

  // Use proper chess engine to get ALL legal moves (handles all piece types: pawn, rook, knight, bishop, queen, king)
  // This function validates moves don't leave king in check
  const legalMoves = getAllLegalMoves(board, isWhite);

  if (legalMoves.length === 0) {
    // This should not happen if we checked checkmate/stalemate above, but safety check
    throw new Error("No legal moves available");
  }

  // Return a random legal move
  return legalMoves[Math.floor(Math.random() * legalMoves.length)];
}

// Simple move generator for fallback
function getSimplePossibleMoves(board, position, piece) {
  const moves = [];
  const row = Math.floor(position / 8);
  const col = position % 8;
  const isWhite = piece === piece.toUpperCase();
  const direction = isWhite ? -1 : 1;

  switch (piece.toLowerCase()) {
    case "p": // Pawn
      const oneStep = position + direction * 8;
      if (oneStep >= 0 && oneStep < 64 && !board[oneStep]) {
        moves.push(oneStep);
      }
      // Diagonal captures
      const captureLeft = position + direction * 8 - 1;
      const captureRight = position + direction * 8 + 1;
      if (
        captureLeft >= 0 &&
        captureLeft < 64 &&
        col > 0 &&
        board[captureLeft] &&
        (board[captureLeft].toUpperCase() === board[captureLeft]) !== isWhite
      ) {
        moves.push(captureLeft);
      }
      if (
        captureRight >= 0 &&
        captureRight < 64 &&
        col < 7 &&
        board[captureRight] &&
        (board[captureRight].toUpperCase() === board[captureRight]) !== isWhite
      ) {
        moves.push(captureRight);
      }
      break;
    case "n": // Knight
      const knightMoves = [-17, -15, -10, -6, 6, 10, 15, 17];
      for (const move of knightMoves) {
        const newPos = position + move;
        if (newPos >= 0 && newPos < 64) {
          const newRow = Math.floor(newPos / 8);
          const newCol = newPos % 8;
          if (Math.abs(newRow - row) <= 2 && Math.abs(newCol - col) <= 2) {
            if (
              !board[newPos] ||
              (board[newPos].toUpperCase() === board[newPos]) !== isWhite
            ) {
              moves.push(newPos);
            }
          }
        }
      }
      break;
    // Add more pieces as needed for fallback
    default:
      break;
  }

  return moves;
}

// Find immediate checkmate moves (1-ply checkmate)
function findCheckmateMove(board, currentTurn, moveHistory) {
  const {
    getAllLegalMoves,
    makeMove,
    isKingInCheck,
  } = require("./chess-engine");
  const isWhite = currentTurn === "white";

  // Get all legal moves for current player
  const legalMoves = getAllLegalMoves(board, isWhite);

  for (const move of legalMoves) {
    // Simulate the move
    const newBoard = [...board];
    newBoard[move.to] = newBoard[move.from];
    newBoard[move.from] = null;

    // Handle special moves (castling, en passant) if needed
    // For simplicity, we'll check basic moves first

    // Check if opponent's king is in check after this move
    const opponentIsWhite = !isWhite;
    const opponentInCheck = isKingInCheck(newBoard, opponentIsWhite);

    if (opponentInCheck) {
      // Check if opponent has any legal moves to escape check
      const opponentLegalMoves = getAllLegalMoves(newBoard, opponentIsWhite);
      if (opponentLegalMoves.length === 0) {
        // Checkmate! Return this move
        return { from: move.from, to: move.to };
      }
    }
  }

  return null; // No checkmate found
}

// ---------- Lightweight evaluation for advantage bar ----------

let evalEngineProcess = null;
let evalEngineReady = false;
let evalPendingRequest = null;

function initEvalEngine() {
  if (evalEngineProcess) {
    return;
  }

  const stockfishPath = STOCKFISH_PATH;

  try {
    const spawnPath =
      stockfishPath !== "stockfish"
        ? path.resolve(stockfishPath)
        : stockfishPath;

    evalEngineProcess = spawn(spawnPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Global handler only for initialization
    let initBuffer = "";
    evalEngineProcess.stdout.on("data", (data) => {
      const text = data.toString();
      initBuffer += text;
      const lines = initBuffer.split("\n");
      initBuffer = lines.pop() || "";

      for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
        if (line === "uciok") {
          evalEngineReady = true;
        }
      }
    });

    evalEngineProcess.stderr.on("data", (data) => {
      // Silent - we don't need to log eval engine stderr
    });

    evalEngineProcess.on("error", (err) => {
      evalEngineProcess = null;
      evalEngineReady = false;
      if (evalPendingRequest) {
        evalPendingRequest.reject(err);
        evalPendingRequest = null;
      }
    });

    evalEngineProcess.on("exit", (code, signal) => {
      evalEngineProcess = null;
      evalEngineReady = false;
      if (evalPendingRequest) {
        evalPendingRequest.reject(new Error("Eval engine exited"));
        evalPendingRequest = null;
      }
    });

    evalEngineProcess.stdin.write("uci\n");
  } catch (err) {
    evalEngineProcess = null;
    evalEngineReady = false;
  }
}

function ensureEvalEngineReady() {
  initEvalEngine();
  if (!evalEngineProcess) {
    return Promise.reject(new Error("Eval engine not available"));
  }

  if (evalEngineProcess.killed || evalEngineProcess.exitCode !== null) {
    evalEngineProcess = null;
    evalEngineReady = false;
    return Promise.reject(new Error("Eval engine process exited"));
  }

  if (evalEngineReady) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = 5000;
    const start = Date.now();
    const check = () => {
      if (evalEngineReady) {
        return resolve();
      }
      if (evalEngineProcess && (evalEngineProcess.killed || evalEngineProcess.exitCode !== null)) {
        evalEngineProcess = null;
        evalEngineReady = false;
        return reject(new Error("Eval engine process exited while initializing"));
      }
      if (Date.now() - start > timeout) {
        return reject(new Error("Eval engine did not become ready in time"));
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/**
 * Get lightweight evaluation for advantage bar
 * @param {string} fen - FEN position string
 * @returns {Promise<number>} - Evaluation in centipawns (clamped to -1000 to +1000)
 */
async function getPositionEvaluation(fen) {
  const startTime = Date.now();
  console.log("[AdvantageBar-Eval] ⚡ Starting evaluation request");
  console.log("[AdvantageBar-Eval] 📋 FEN:", fen);

  try {
    await ensureEvalEngineReady();
  } catch (err) {
    console.error("[AdvantageBar-Eval] ❌ Engine not available:", err.message);
    return 0; // Return 0 if engine unavailable
  }

  if (evalPendingRequest) {
    // Cancel previous request
    console.log("[AdvantageBar-Eval] ⚠️ Cancelling previous evaluation request");
    clearTimeout(evalPendingRequest.timeoutId);
    evalPendingRequest.reject(new Error("New evaluation request"));
    evalPendingRequest = null;
  }

  return new Promise((resolve, reject) => {
    let evaluation = null;
    let depth = 0;
    let isMate = false;
    let mateMoves = null;
    const timeoutId = setTimeout(() => {
      if (evalPendingRequest) {
        evalPendingRequest = null;
      }
      const elapsed = Date.now() - startTime;
      console.error(`[AdvantageBar-Eval] ⏱️ Evaluation timeout after ${elapsed}ms`);
      reject(new Error("Evaluation timeout"));
    }, 3000); // 3 second timeout

    const dataHandler = (data) => {
      const text = data.toString();
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

      for (const line of lines) {
        if (line.startsWith("info")) {
          // Extract depth
          const depthMatch = line.match(/depth (\d+)/);
          if (depthMatch) {
            const newDepth = parseInt(depthMatch[1], 10);
            if (newDepth > depth) {
              depth = newDepth;
            }
          }

          // Extract centipawn evaluation
          const cpMatch = line.match(/score cp (-?\d+)/);
          if (cpMatch) {
            evaluation = parseInt(cpMatch[1], 10);
            isMate = false;
            mateMoves = null;
          }

          // Extract mate evaluation - keep mate moves separately, don't convert to centipawns
          const mateMatch = line.match(/score mate (-?\d+)/);
          if (mateMatch) {
            mateMoves = parseInt(mateMatch[1], 10);
            evaluation = mateMoves; // Store raw mate moves for post-processing
            isMate = true;
          }
        }

        if (line.startsWith("bestmove")) {
          evalEngineProcess.stdout.removeListener("data", dataHandler);
          clearTimeout(timeoutId);
          evalPendingRequest = null;

          const elapsed = Date.now() - startTime;

          // Return raw evaluation and mate status (no clamping here - post-processing will handle it)
          if (evaluation !== null) {
            const rawEval = evaluation;
            
            console.log("[AdvantageBar-Eval] ✅ Evaluation complete:");
            console.log(`[AdvantageBar-Eval]    📊 Depth: ${depth}`);
            console.log(`[AdvantageBar-Eval]    💎 Raw evaluation: ${rawEval} centipawns${isMate ? " (MATE)" : ""}`);
            console.log(`[AdvantageBar-Eval]    ⏱️ Time taken: ${elapsed}ms`);
            
            resolve({
              centipawns: isMate ? 0 : rawEval, // Don't convert mate to centipawns
              isMate: isMate,
              mateMoves: isMate ? mateMoves : null
            });
          } else {
            console.warn("[AdvantageBar-Eval] ⚠️ No evaluation found, returning 0");
            console.log(`[AdvantageBar-Eval]    ⏱️ Time taken: ${elapsed}ms`);
            resolve({ centipawns: 0, isMate: false, mateMoves: null });
          }
          return;
        }
      }
    };

    evalEngineProcess.stdout.on("data", dataHandler);
    evalPendingRequest = { resolve, reject, timeoutId };

    // Send position and go command
    // Use depth 8 or fixed movetime ~120ms for advantage bar
    console.log("[AdvantageBar-Eval] 📤 Sending commands to Stockfish (depth 8)");
    evalEngineProcess.stdin.write("ucinewgame\n");
    evalEngineProcess.stdin.write("isready\n");
    evalEngineProcess.stdin.write(`position fen ${fen}\n`);
    // Use depth 12 for advantage bar evaluation (lightweight, fast)
    evalEngineProcess.stdin.write("go depth 12\n");
  });
}

module.exports = {
  getBestMove,
  getStockfishConfig,
  boardToFEN,
  boardIndexToUCI,
  uciToBoardIndices,
  findCheckmateMove,
  getPositionEvaluation,
};
