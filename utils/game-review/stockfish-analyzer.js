/**
 * Stockfish Move Analyzer
 * 
 * Analyzes moves using Stockfish engine with detailed evaluation.
 * Uses the deepest info line with PV for best accuracy.
 */

const engine = require("./engine");
const classifier = require("./classifier");

/**
 * Convert mate score to centipawn proxy for calculations
 * @param {Object} evaluation - { cp: number } or { mate: number }
 * @returns {number} - Centipawn value (large number for mate)
 */
function mateToCentipawn(evaluation) {
  if (!evaluation) return 0;
  
  if (classifier.isMateScore(evaluation)) {
    const mateMoves = Math.abs(evaluation.mate);
    // Mate in N: positive = winning, negative = losing
    // Convert to large centipawn value (10000 - N*100 for winning, -10000 + N*100 for losing)
    return evaluation.mate > 0 
      ? 10000 - mateMoves * 100 
      : -10000 + mateMoves * 100;
  }
  
  return evaluation.cp || 0;
}

/**
 * Get numeric evaluation value (centipawn or mate proxy)
 * @param {Object} evaluation - { cp: number } or { mate: number }
 * @returns {number} - Numeric value
 */
function getEvalValue(evaluation) {
  return mateToCentipawn(evaluation);
}

/**
 * Label move based on centipawn loss
 * @param {number} centipawnLoss - Loss in centipawns
 * @returns {string} - Label: "good", "inaccuracy", "mistake", "blunder"
 */
function labelMove(centipawnLoss) {
  if (centipawnLoss >= 300) {
    return "blunder";
  } else if (centipawnLoss >= 150) {
    return "mistake";
  } else if (centipawnLoss >= 50) {
    return "inaccuracy";
  }
  return "good";
}

/**
 * Analyze moves with Stockfish
 * 
 * @param {string[]} movesArray - Array of UCI moves (e.g., ["e2e4", "e7e5", "g1f3"])
 * @param {Object} options - Analysis options
 * @param {number} options.depth - Search depth (default: 15)
 * @param {number} options.movetime - Time per move in ms (overrides depth if provided)
 * @param {number} options.multiPV - Number of principal variations (default: 1)
 * @param {number} options.timeoutPerMove - Timeout per move in ms (default: 10000)
 * 
 * @returns {Promise<Array>} - Array of move analysis results
 * 
 * @example
 * const moves = ["e2e4", "e7e5", "g1f3"];
 * const results = await analyzeMovesWithStockfish(moves, { depth: 15 });
 * // Returns:
 * // [
 * //   {
 * //     moveNumber: 1,
 * //     playedMove: "e2e4",
 * //     bestMove: "e2e4",
 * //     evalBefore: 20,
 * //     evalAfter: 10,
 * //     evalBestAfter: 25,
 * //     centipawnLoss: 15,
 * //     label: "good",
 * //     pv: "e2e4 e7e5 Nf3"
 * //   },
 * //   ...
 * // ]
 */
async function analyzeMovesWithStockfish(movesArray, options = {}) {
  const {
    depth = 15,
    movetime = null,
    multiPV = 1,
    timeoutPerMove = 10000,
  } = options;

  if (!movesArray || !Array.isArray(movesArray) || movesArray.length === 0) {
    throw new Error("movesArray must be a non-empty array of UCI moves");
  }

  // Ensure engine is ready
  await engine.ensureEngineReady();

  // Send ucinewgame once at the start
  try {
    await engine.sendCommand("ucinewgame", { timeout: 5000 });
    await engine.sendCommand("isready", { timeout: 5000 });
  } catch (err) {
    console.warn("[StockfishAnalyzer] Warning: ucinewgame/isready failed:", err.message);
  }

  const results = [];

  // Analyze each move
  for (let i = 0; i < movesArray.length; i++) {
    const moveNumber = i + 1;
    const playedMove = movesArray[i];
    const movesUpToBefore = movesArray.slice(0, i);
    const movesUpToAfter = movesArray.slice(0, i + 1);

    // Per-move timeout wrapper
    const moveAnalysis = Promise.race([
      (async () => {
        try {
          // Step 1: Build position before move and get best move
          const positionBeforeCmd = movesUpToBefore.length > 0
            ? `position startpos moves ${movesUpToBefore.join(" ")}`
            : "position startpos";

          await engine.sendCommand(positionBeforeCmd, { timeout: 1000 });

          // Step 2: Send go command and get best move with deepest PV
          let goCmd;
          if (movetime) {
            goCmd = `go movetime ${movetime}`;
          } else {
            goCmd = `go depth ${depth}`;
            if (multiPV > 1) {
              goCmd += ` multipv ${multiPV}`;
            }
          }

          const bestMoveResult = await engine.sendCommand(goCmd, {
            expectBestMove: true,
            timeout: movetime ? movetime + 2000 : depth * 1000 + 2000,
          });

          // The engine already captures the deepest info line with PV
          // (it updates PV whenever it sees a new info line with pv)
          const bestMove = bestMoveResult.bestMove || null;
          const evalBestAfter = bestMoveResult.evaluation || { cp: 0 };
          const pvBest = bestMoveResult.pv || []; // This is from the deepest info line

          // Get evaluation before move (quick shallow search)
          const evalBeforeResult = await engine.sendCommand(
            `go depth 1 movetime 300`,
            { expectBestMove: true, timeout: 2000 }
          );
          const evalBefore = evalBeforeResult.evaluation || { cp: 0 };

          // Step 3: Apply player's move and get evaluation after
          const positionAfterCmd = `position startpos moves ${movesUpToAfter.join(" ")}`;
          await engine.sendCommand(positionAfterCmd, { timeout: 1000 });

          const evalAfterResult = await engine.sendCommand(goCmd, {
            expectBestMove: true,
            timeout: movetime ? movetime + 2000 : depth * 1000 + 2000,
          });
          const evalAfter = evalAfterResult.evaluation || { cp: 0 };

          // Step 4: Calculate centipawn loss
          const evalBestAfterCP = getEvalValue(evalBestAfter);
          const evalAfterCP = getEvalValue(evalAfter);
          const centipawnLoss = Math.max(0, evalBestAfterCP - evalAfterCP);

          // Step 5: Label move
          const label = labelMove(centipawnLoss);

          // Format PV as space-separated string
          const pvString = pvBest.join(" ");

          // Get numeric eval values for return
          const evalBeforeValue = getEvalValue(evalBefore);
          const evalAfterValue = evalAfterCP;
          const evalBestAfterValue = evalBestAfterCP;

          return {
            moveNumber,
            playedMove,
            bestMove,
            evalBefore: evalBeforeValue,
            evalAfter: evalAfterValue,
            evalBestAfter: evalBestAfterValue,
            centipawnLoss: Math.round(centipawnLoss),
            label,
            pv: pvString,
            // Additional info
            evalBeforeRaw: evalBefore,
            evalAfterRaw: evalAfter,
            evalBestAfterRaw: evalBestAfter,
          };
        } catch (error) {
          console.error(`[StockfishAnalyzer] Error analyzing move ${moveNumber}:`, error.message);
          throw error;
        }
      })(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Move ${moveNumber} analysis timeout after ${timeoutPerMove}ms`));
        }, timeoutPerMove);
      }),
    ]).catch((error) => {
      // Graceful error handling
      console.error(`[StockfishAnalyzer] Move ${moveNumber} failed:`, error.message);
      return {
        moveNumber,
        playedMove,
        bestMove: null,
        evalBefore: 0,
        evalAfter: 0,
        evalBestAfter: 0,
        centipawnLoss: 0,
        label: "timeout",
        pv: "",
        error: error.message,
      };
    });

    const result = await moveAnalysis;
    results.push(result);

    // Small delay between moves to prevent overwhelming the engine
    if (i < movesArray.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return results;
}

module.exports = {
  analyzeMovesWithStockfish,
  mateToCentipawn,
  getEvalValue,
  labelMove,
};

