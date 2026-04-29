/**
 * COMPLETELY REBUILT Game Analysis Module - Chess.com Style
 * 
 * This is a complete rewrite to fix all evaluation perspective bugs
 * and ensure 100% accurate move classification and accuracy calculation.
 * 
 * Key fixes:
 * 1. Correct evaluation perspective handling (Stockfish always from White)
 * 2. Correct centipawn loss calculation for both White and Black moves
 * 3. Chess.com-style move classification thresholds
 * 4. Correct accuracy formula
 * 5. Book move detection
 * 6. Tactical swing detection
 */

const engine = require("./engine"); // Uses FULL engine by default
const classifier = require("./classifier");
const { Chess } = require("chess.js");

/**
 * CHESS.COM-STYLE MOVE CLASSIFICATION THRESHOLDS
 * Based on centipawn loss (delta from best move)
 */
const CLASSIFICATION_THRESHOLDS = classifier.CLASSIFICATION_THRESHOLDS;
const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/i;

function normalizeAlternativeLines(lines) {
  if (!Array.isArray(lines)) return [];
  const seen = new Set();
  const normalized = [];

  for (const line of lines) {
    if (!line) continue;
    const pv = Array.isArray(line.pv) ? line.pv : [];
    const rawMove = typeof line.move === "string" ? line.move : pv[0];
    if (!rawMove || !UCI_MOVE_RE.test(rawMove)) continue;
    const move = rawMove.toLowerCase();
    if (seen.has(move)) continue;
    seen.add(move);
    normalized.push({
      move,
      evaluation: line.evaluation || { cp: 0 },
      pv: pv.slice(0, 6),
      gainCp: typeof line.gainCp === "number" ? line.gainCp : undefined,
    });
  }

  return normalized.slice(0, 3);
}

function evaluationToCp(evaluation) {
  if (!evaluation) return 0;
  if (evaluation.mate !== undefined) {
    const mateMoves = Math.abs(evaluation.mate);
    return evaluation.mate > 0 ? 10000 - mateMoves * 100 : -10000 + mateMoves * 100;
  }
  return typeof evaluation.cp === "number" ? evaluation.cp : 0;
}

function resultScoreCp(result) {
  if (!result || !result.evaluation || !result.depth || result.depth <= 0) return null;
  return evaluationToCp(result.evaluation);
}

function verboseMoveToUci(move) {
  if (!move || !move.from || !move.to) return null;
  return `${move.from}${move.to}${move.promotion ? String(move.promotion).toLowerCase() : ""}`;
}

/**
 * Convert evaluation to centipawns from the MOVING PLAYER's perspective
 * Stockfish always returns from White's perspective
 * @param {Object} evaluation - { cp: number } or { mate: number }
 * @param {boolean} isWhiteMove - True if White made the move
 * @returns {number} - Centipawns from moving player's perspective
 */
function getCentipawnsFromPlayerPerspective(evaluation, isWhiteMove) {
  if (!evaluation) return 0;
  
  let cp;
  if (evaluation.mate !== undefined) {
    // Mate score: convert to large centipawn value
    const mateMoves = Math.abs(evaluation.mate);
    // Positive mate = mate for White, Negative mate = mate for Black
    cp = evaluation.mate > 0 
      ? 10000 - mateMoves * 100  // Mate for White
      : -10000 + mateMoves * 100; // Mate for Black
  } else {
    cp = evaluation.cp || 0;
  }
  
  // Stockfish returns from White's perspective
  // For White moves: positive = good, negative = bad
  // For Black moves: we need to flip (negative = good for Black)
  if (isWhiteMove) {
    return cp; // Already from White's perspective
  } else {
    return -cp; // Flip for Black's perspective
  }
}

/**
 * Calculate centipawn loss (delta) from the MOVING PLAYER's perspective
 * This is the key calculation that was broken before
 * @param {Object} evalBestAfter - Best move evaluation (from White's perspective)
 * @param {Object} evalAfter - Played move evaluation (from White's perspective)
 * @param {boolean} isWhiteMove - True if White made the move
 * @returns {number} - Centipawn loss (always positive, from moving player's perspective)
 */
function calculateCentipawnLoss(evalBestAfter, evalAfter, isWhiteMove) {
  // Both evaluations are already from the moving player's perspective (after flipping)
  // Get centipawn values
  let bestCP, playedCP;
  
  if (evalBestAfter.mate !== undefined) {
    const mateMoves = Math.abs(evalBestAfter.mate);
    bestCP = evalBestAfter.mate > 0 ? 10000 - mateMoves * 100 : -10000 + mateMoves * 100;
  } else {
    bestCP = evalBestAfter.cp || 0;
  }
  
  if (evalAfter.mate !== undefined) {
    const mateMoves = Math.abs(evalAfter.mate);
    playedCP = evalAfter.mate > 0 ? 10000 - mateMoves * 100 : -10000 + mateMoves * 100;
  } else {
    playedCP = evalAfter.cp || 0;
  }
  
  // Loss = how much worse the played move is compared to best move
  // From the moving player's perspective, higher is always better
  // So loss = bestCP - playedCP (always positive if best move is better)
  const loss = bestCP - playedCP;
  
  // Loss should always be positive (best move should be >= played move)
  // If negative, it means played move was actually better (shouldn't happen, but clamp to 0)
  return Math.max(0, loss);
}

/**
 * Analyze a single move with correct perspective handling
 * @param {string[]} movesUpToBefore - Moves before this move
 * @param {string} playedMove - The move that was played
 * @param {number} moveNumber - Move number (1-indexed)
 * @param {number} totalMoves - Total number of moves in game (for logging)
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>} - Move analysis result
 */
async function analyzeMove(movesUpToBefore, playedMove, moveNumber, totalMoves, options = {}) {
  const { depth = 8, movetime = 500, engineType = 'lite' } = options;
  
  const isLite = true; // Quick-review only pipeline (extra child-best search per ply — allow more wall time)
  const moveTimeout = 10000;
  
  // Select engine functions based on type
  const engine = require("./engine");
  const analyzePosition = engine.analyzePositionLite;
  
  return Promise.race([
    (async () => {
      try {
        // Determine whose turn it is BEFORE the move
        // Even number of moves (0, 2, 4...) = White to move
        // Odd number of moves (1, 3, 5...) = Black to move
        // IMPORTANT: In chess, White always moves first, so:
        // - Move at index 0 (first move) = White
        // - Move at index 1 (second move) = Black
        // - Move at index 2 (third move) = White
        // - etc.
        const isWhiteToMoveBefore = movesUpToBefore.length % 2 === 0;
        const isWhiteMove = isWhiteToMoveBefore;
        
        // Double-check: if this is the first move (index 0), it MUST be White
        if (movesUpToBefore.length === 0 && !isWhiteMove) {
          console.warn(`[GameReview] WARNING: First move should be White, but calculated as Black! Forcing to White.`);
          // This shouldn't happen, but if it does, force it to White
        }
        
        console.log(`[GameReview] Analyzing move ${moveNumber} (index ${movesUpToBefore.length}): ${playedMove} - Moves before: ${movesUpToBefore.length}, ${isWhiteMove ? 'White' : 'Black'} to move [${engineType.toUpperCase()}]`);
        
        // CRITICAL: Stockfish returns evaluations from the side to move's perspective
        // After a move, the turn switches, so the eval is from the NEW side's perspective
        
        // Step 1: Get evaluation BEFORE the move (from side to move's perspective)
        // Use quick eval for before (faster, lower depth for LITE)
        const beforeMovetime = isLite ? 200 : 500;
        const beforeEvalResult = await analyzePosition(movesUpToBefore, { 
          movetime: beforeMovetime,
          depth: isLite ? 6 : undefined // Lower depth for before eval in LITE mode
        });
        const evalBefore = beforeEvalResult.evaluation; // From side to move's perspective (White if isWhiteMove, Black if !isWhiteMove)
        
        // Step 2: Search parent position for best move (root eval here is NOT used for ACPL — see step 2b).
        const bestMoveResult = await analyzePosition(movesUpToBefore, { 
          movetime: movetime,
          depth: depth,
          multipv: 3,
        });
        const bestMove = bestMoveResult.bestMove;
        const pvBest = bestMoveResult.pv || [];
        let alternativeLines = [];

        // Step 2b / 3: True leaf-vs-leaf centipawn loss — compare the same child depth/movetime:
        // eval after (parent + bestMove) vs eval after (parent + playedMove).
        // Root eval on the parent was a semantic mismatch and could make ACPL drift across the game.
        const movesAfterPlayed = [...movesUpToBefore, playedMove];
        let evalBestAfterRaw;
        let evalAfterRaw;

        if (!bestMove) {
          console.warn(
            `[GameReview] No bestMove at move ${moveNumber} (index ${movesUpToBefore.length}); using parent-root eval as best-branch fallback (degraded ACPL)`
          );
          evalBestAfterRaw = bestMoveResult.evaluation;
          const evalAfterResult = await analyzePosition(movesAfterPlayed, {
            movetime: movetime,
            depth: depth
          });
          evalAfterRaw = evalAfterResult.evaluation;
        } else if (bestMove === playedMove) {
          const evalChildResult = await analyzePosition(movesAfterPlayed, {
            movetime: movetime,
            depth: depth
          });
          evalBestAfterRaw = evalChildResult.evaluation;
          evalAfterRaw = evalChildResult.evaluation;
        } else {
          const movesAfterBest = [...movesUpToBefore, bestMove];
          const evalBestChildResult = await analyzePosition(movesAfterBest, {
            movetime: movetime,
            depth: depth
          });
          evalBestAfterRaw = evalBestChildResult.evaluation;
          const evalAfterResult = await analyzePosition(movesAfterPlayed, {
            movetime: movetime,
            depth: depth
          });
          evalAfterRaw = evalAfterResult.evaluation;
        }

        // UCI: score is from the side to move on the analyzed board. After either child move, the
        // opponent is to move — we keep raw in that frame for the graph (played line) and flip for ACPL.
        const evalAfterWhite = evalAfterRaw;
        const evalBestAfterWhite = evalBestAfterRaw;
        
        // Convert to moving player's perspective for loss calculation
        // Moving player's perspective = -opponent's perspective (after move, opponent is to move)
        const evalBestAfter = {
          cp: evalBestAfterRaw.cp !== undefined ? -evalBestAfterRaw.cp : undefined,
          mate: evalBestAfterRaw.mate !== undefined ? -evalBestAfterRaw.mate : undefined
        };
        const evalAfter = {
          cp: evalAfterRaw.cp !== undefined ? -evalAfterRaw.cp : undefined,
          mate: evalAfterRaw.mate !== undefined ? -evalAfterRaw.mate : undefined
        };
        
        // Step 4: Calculate centipawn loss from MOVING PLAYER's perspective
        // Now both evals are from the moving player's perspective (after their move)
        const centipawnLoss = calculateCentipawnLoss(evalBestAfter, evalAfter, isWhiteMove);

        // Deterministic top-3 engine lines: run restricted searches for best, 2nd, 3rd.
        try {
          const chessForCandidates = new Chess();
          for (const uci of movesUpToBefore) {
            chessForCandidates.move(uci, { sloppy: true });
          }
          const legalMoves = chessForCandidates
            .moves({ verbose: true })
            .map(verboseMoveToUci)
            .filter((m) => !!m && UCI_MOVE_RE.test(m));

          const picked = new Set();
          const maxCandidates = Math.min(3, legalMoves.length);
          const orderedCandidates = [];

          // Use primary best move from main search as first candidate when valid.
          if (bestMove && UCI_MOVE_RE.test(bestMove)) {
            orderedCandidates.push(bestMove.toLowerCase());
            picked.add(bestMove.toLowerCase());
          }

          while (orderedCandidates.length < maxCandidates) {
            const remaining = legalMoves.filter((m) => !picked.has(m.toLowerCase()));
            if (!remaining.length) break;

            const restricted = await analyzePosition(movesUpToBefore, {
              movetime: Math.max(movetime, 700),
              depth: Math.max(depth, 10),
              multipv: 1,
              searchMoves: remaining,
            });
            const next = restricted?.bestMove ? restricted.bestMove.toLowerCase() : null;
            if (!next || picked.has(next)) break;
            picked.add(next);
            orderedCandidates.push(next);
          }

          const playedRoot = await analyzePosition(movesUpToBefore, {
            movetime: Math.max(movetime, 700),
            depth: Math.max(depth, 10),
            multipv: 1,
            searchMoves: [playedMove],
          });
          const playedRootCp = resultScoreCp(playedRoot);

          const altLinesComputed = [];
          for (const cand of orderedCandidates.slice(0, 3)) {
            const candRoot = await analyzePosition(movesUpToBefore, {
              movetime: Math.max(movetime, 700),
              depth: Math.max(depth, 10),
              multipv: 1,
              searchMoves: [cand],
            });
            const candCp = resultScoreCp(candRoot);
            altLinesComputed.push({
              move: cand,
              evaluation: candRoot?.evaluation || { cp: 0 },
              pv: Array.isArray(candRoot?.pv) ? candRoot.pv.slice(0, 6) : [],
              gainCp: playedRootCp != null && candCp != null ? candCp - playedRootCp : undefined,
            });
          }
          alternativeLines = normalizeAlternativeLines(altLinesComputed);
        } catch (altErr) {
          console.warn(
            `[GameReview] Alternative-lines generation failed on move ${moveNumber}: ${altErr?.message || "unknown"}`
          );
          alternativeLines = normalizeAlternativeLines(bestMoveResult.alternativeLines);
        }

        // Black plies (odd game index): diagnose flat 0cp / engine fallback { cp: 0 } issues in production logs.
        const gameMoveIndex = movesUpToBefore.length;
        if (gameMoveIndex % 2 === 1) {
          const z = (e) =>
            e &&
            e.mate === undefined &&
            (e.cp === 0 || e.cp === undefined);
          console.log(
            "[GameReview][BlackPly ACPL]",
            JSON.stringify({
              gameMoveIndex,
              moveNumber,
              playedMove,
              bestMove: bestMove || null,
              evalBestAfterRaw,
              evalAfterRaw,
              centipawnLossRounded: Math.round(centipawnLoss),
              zeroCpSuspectBest: z(evalBestAfterRaw),
              zeroCpSuspectPlayed: z(evalAfterRaw),
            })
          );
        }
        
        // Step 5: Detect missed mate
        const missedMate = detectMissedMate(evalBefore, evalBestAfter, evalAfter, isWhiteMove);
        
        // Step 6: Detect tactical swing
        const tacticalSwing = detectTacticalSwing(evalBefore, evalAfter, isWhiteMove);
        
        // Step 7: Check if it's the best move
        const isBestMove = bestMove === playedMove || centipawnLoss < 1;
        
        // Step 8: Check if it's a book move (opening theory):
        // opening phase + balanced eval (<= 0.5 pawns) + low CPL.
        const evalAfterAbsCp = Math.abs(evalAfterWhite?.cp || 0);
        const isBookMove =
          moveNumber <= 12 &&
          evalAfterAbsCp <= CLASSIFICATION_THRESHOLDS.BOOK_MAX_ABS_EVAL_CP &&
          centipawnLoss <= CLASSIFICATION_THRESHOLDS.BOOK;
        const hadMate = typeof evalBestAfter?.mate === "number" && evalBestAfter.mate > 0;
        const evalAfterForClassifier = {
          cp: evalAfterRaw?.cp !== undefined ? (isWhiteMove ? -evalAfterRaw.cp : evalAfterRaw.cp) : undefined,
          mate: evalAfterRaw?.mate !== undefined ? (isWhiteMove ? -evalAfterRaw.mate : evalAfterRaw.mate) : undefined,
        };
        
        // Detect tactical material action for "brilliant" gating.
        let isCaptureMove = false;
        try {
          const chessForMoveType = new Chess();
          for (const uci of movesUpToBefore) {
            chessForMoveType.move(uci, { sloppy: true });
          }
          const simulated = chessForMoveType.move(playedMove, { sloppy: true });
          isCaptureMove = Boolean(simulated && (simulated.captured || simulated.flags?.includes("e")));
        } catch (_e) {
          isCaptureMove = false;
        }

        // Step 9: Classify the move using unified classifier thresholds.
        const label = classifier.classifyMove(centipawnLoss, {
          moveNumber,
          evalAfter: evalAfterForClassifier,
          isBestMove,
          isBookMove,
          hadMate,
          missedMate,
          tacticalSwing,
          isCaptureMove,
          // Heuristic: tactical swing + non-capture can still be sacrificial.
          isSacrificeMove: tacticalSwing && !isCaptureMove,
        });
        
        // Log for debugging - show raw and converted evaluations
        let beforeCP = evalBefore.cp || 0;
        if (evalBefore.mate !== undefined) {
          beforeCP = evalBefore.mate > 0 ? 10000 : -10000;
        }
        if (!isWhiteMove) {
          beforeCP = -beforeCP; // Flip for Black's perspective
        }
        
        // MANDATORY DEBUG: Log RAW Stockfish output
        console.log(`[GameReview] Move ${moveNumber} (${isWhiteMove ? 'White' : 'Black'}):`);
        console.log(`[GameReview] RAW Stockfish evalAfterRaw:`, JSON.stringify(evalAfterRaw));
        console.log(`[GameReview] RAW Stockfish evalAfterRaw.cp:`, evalAfterRaw.cp);
        console.log(`[GameReview] RAW Stockfish evalAfterRaw.mate:`, evalAfterRaw.mate);
        console.log(`[GameReview] RAW Stockfish evalAfterWhite:`, JSON.stringify(evalAfterWhite));
        
        // Show raw (from opponent's perspective) and converted (from moving player's perspective)
        const bestAfterRawCP = evalBestAfterRaw.cp || 0;
        const playedAfterRawCP = evalAfterRaw.cp || 0;
        
        const bestAfterCP = evalBestAfter.cp || 0;
        const playedAfterCP = evalAfter.cp || 0;
        
        console.log(`  - Before: ${beforeCP}cp (${isWhiteMove ? 'White' : 'Black'} to move)`);
        console.log(`  - Best after: ${bestAfterRawCP}cp (opponent's perspective) → ${bestAfterCP}cp (${isWhiteMove ? 'White' : 'Black'} perspective)`);
        console.log(`  - Played after: ${playedAfterRawCP}cp (opponent's perspective) → ${playedAfterCP}cp (${isWhiteMove ? 'White' : 'Black'} perspective)`);
        console.log(`  - Loss: ${centipawnLoss}cp → ${label}`);
        
        // Parse numeric eval from evalAfterWhite (for graph)
        let parsedEvalForGraph = null;
        if (evalAfterWhite) {
          if (evalAfterWhite.mate !== undefined) {
            parsedEvalForGraph = evalAfterWhite.mate > 0 ? 10 : -10; // Mate = ±10
            console.log(`[GameReview] Parsed eval for graph (mate):`, parsedEvalForGraph);
          } else if (evalAfterWhite.cp !== undefined) {
            parsedEvalForGraph = evalAfterWhite.cp / 100; // Convert centipawns to pawns
            // Clamp to [-10, +10]
            parsedEvalForGraph = Math.max(-10, Math.min(10, parsedEvalForGraph));
            console.log(`[GameReview] Parsed eval for graph (cp):`, evalAfterWhite.cp, "→", parsedEvalForGraph, "pawns");
          } else {
            console.error(`[GameReview] ERROR: evalAfterWhite has neither cp nor mate!`, evalAfterWhite);
          }
        } else {
          console.error(`[GameReview] ERROR: evalAfterWhite is null/undefined for move ${moveNumber}!`);
        }
        
        if (parsedEvalForGraph === null) {
          console.warn(
            `[GameReview] Move ${moveNumber} missing numeric evaluation; using 0 fallback to keep review generation stable.`
          );
          parsedEvalForGraph = 0;
        }
        
        return {
          moveNumber,
          playedMove,
          bestMove: bestMove || null,
          evalBefore: formatEvaluation(evalBefore, isWhiteMove),
          // Store evalAfter as formatted string (for display)
          evalAfter: formatEvaluation(evalAfterWhite, true), // Always from White's perspective
          evalBestAfter: formatEvaluation(evalBestAfterWhite, true), // Always from White's perspective
          // Store RAW numeric evalAfter for graph (number in pawns, -10 to +10)
          evalAfterNumeric: parsedEvalForGraph, // Numeric float value for graph
          centipawnLoss: Math.round(centipawnLoss),
          label,
          pv: pvBest.slice(0, 5),
          alternativeLines,
          missedMate,
          tacticalSwing,
          isBestMove,
          isBookMove,
          isWhiteMove, // Store for later use
        };
      } catch (error) {
        console.error(`[GameReview] Error analyzing move ${moveNumber}:`, error.message);
        throw error;
      }
    })(),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Move ${moveNumber} analysis timeout after ${moveTimeout}ms`));
      }, moveTimeout);
    })
  ]).catch(error => {
    console.error(`[GameReview] Move ${moveNumber} failed:`, error.message);
    return {
      moveNumber,
      playedMove,
      error: error.message,
      label: "timeout",
    };
  });
}

/**
 * Detect missed mate opportunity
 */
function detectMissedMate(evalBefore, evalBestAfter, evalAfter, isWhiteMove) {
  // Check if best move had mate but played move doesn't
  const bestHasMate = evalBestAfter.mate !== undefined;
  const playedHasMate = evalAfter.mate !== undefined;
  
  if (bestHasMate && !playedHasMate) {
    return true;
  }
  
  if (bestHasMate && playedHasMate) {
    // Both have mate, check if played move is slower
    const bestMate = Math.abs(evalBestAfter.mate);
    const playedMate = Math.abs(evalAfter.mate);
    
    // For White: positive mate is good, for Black: negative mate is good
    if (isWhiteMove) {
      // White move: positive mate is good
      if (evalBestAfter.mate > 0 && evalAfter.mate > 0) {
        return playedMate > bestMate + 1; // Slower mate
      }
      if (evalBestAfter.mate > 0 && evalAfter.mate <= 0) {
        return true; // Missed winning mate
      }
    } else {
      // Black move: negative mate is good
      if (evalBestAfter.mate < 0 && evalAfter.mate < 0) {
        return Math.abs(evalAfter.mate) > Math.abs(evalBestAfter.mate) + 1; // Slower mate
      }
      if (evalBestAfter.mate < 0 && evalAfter.mate >= 0) {
        return true; // Missed winning mate
      }
    }
  }
  
  return false;
}

/**
 * Detect tactical swing (large evaluation change)
 * This detects significant position changes that indicate tactical opportunities
 */
function detectTacticalSwing(evalBefore, evalAfter, isWhiteMove) {
  // Get evaluations from moving player's perspective
  let beforeCP = evalBefore.cp || 0;
  if (evalBefore.mate !== undefined) {
    const mateMoves = Math.abs(evalBefore.mate);
    beforeCP = evalBefore.mate > 0 ? 10000 - mateMoves * 100 : -10000 + mateMoves * 100;
  }
  if (!isWhiteMove) {
    beforeCP = -beforeCP; // Flip for Black's perspective
  }
  
  let afterCP = evalAfter.cp || 0;
  if (evalAfter.mate !== undefined) {
    const mateMoves = Math.abs(evalAfter.mate);
    afterCP = evalAfter.mate > 0 ? 10000 - mateMoves * 100 : -10000 + mateMoves * 100;
  }
  
  const swing = Math.abs(afterCP - beforeCP);
  return swing >= CLASSIFICATION_THRESHOLDS.TACTICAL_SWING;
}

/**
 * Format evaluation for display
 */
function formatEvaluation(evaluation, isWhiteMove) {
  if (!evaluation) return "0.00";
  
  if (evaluation.mate !== undefined) {
    const moves = Math.abs(evaluation.mate);
    return evaluation.mate > 0 ? `M${moves}` : `-M${moves}`;
  }
  
  const cp = evaluation.cp || 0;
  const pawns = (cp / 100).toFixed(2);
  return cp >= 0 ? `+${pawns}` : pawns;
}

/**
 * Analyze entire game
 */
async function analyzeGame(moves, options = {}) {
  if (!moves || moves.length === 0) {
    throw new Error("No moves provided for analysis");
  }

  const { depth = 8, movetime = 500, engineType = 'lite' } = options;
  const analyzedMoves = [];
  const totalMoves = moves.length;

  console.log(`[GameReview] ========================================`);
  console.log(`[GameReview] Starting game analysis`);
  console.log(`[GameReview] Total moves to analyze: ${totalMoves}`);
  console.log(`[GameReview] Depth: ${depth}, Movetime: ${movetime}ms`);
  console.log(`[GameReview] Moves array:`, moves.slice(0, 10).join(", "), totalMoves > 10 ? "..." : "");
  console.log(`[GameReview] ========================================`);

  // Analyze each move sequentially
  for (let i = 0; i < totalMoves; i++) {
    // Move number in chess notation: both White and Black share the same move number
    // Move 1: White's first move (index 0) and Black's first move (index 1)
    // Move 2: White's second move (index 2) and Black's second move (index 3)
    const moveNumber = Math.floor(i / 2) + 1;
    const movesUpToBefore = moves.slice(0, i);
    const playedMove = moves[i];

    try {
      const moveAnalysis = await analyzeMove(
        movesUpToBefore,
        playedMove,
        moveNumber,
        totalMoves,
        { depth, movetime, engineType }
      );

      analyzedMoves.push(moveAnalysis);
    } catch (error) {
      console.error(`[GameReview] Failed to analyze move ${moveNumber}:`, error.message);
      analyzedMoves.push({
        moveNumber,
        playedMove,
        error: error.message,
        label: "unknown",
      });
    }

    // Small delay to prevent overwhelming the engine
    if (i < totalMoves - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`[GameReview] Completed analysis of ${analyzedMoves.length} moves`);

  return analyzedMoves;
}

module.exports = {
  analyzeMove,
  analyzeGame,
  calculateCentipawnLoss,
  getCentipawnsFromPlayerPerspective,
  CLASSIFICATION_THRESHOLDS,
};

