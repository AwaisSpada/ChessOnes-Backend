/**
 * Game Analysis Module - REPLACED BY analyzer-v2.js
 * 
 * This file is kept for backward compatibility but the new implementation
 * is in analyzer-v2.js with correct perspective handling.
 * 
 * TODO: Remove this file once analyzer-v2.js is fully tested and integrated.
 */

const analyzerV2 = require("./analyzer-v2");
const classifier = require("./classifier");
const moveSuggestions = require("./move-suggestions");

// Helper to check if evaluation is a mate score
function isMateScore(evaluation) {
  return evaluation && typeof evaluation.mate === "number";
}

/**
 * Analyze a single move
 * @param {string[]} movesUpToBefore - Moves before this move
 * @param {string} playedMove - The move that was played
 * @param {number} moveNumber - Move number (1-indexed)
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>} - Move analysis result
 */
/**
 * Normalize evaluation to White's perspective
 * IMPORTANT: Stockfish ALWAYS returns evaluations from White's perspective (UCI standard)
 * Positive = good for White, Negative = good for Black
 * However, we need to ensure we're calculating loss from the MOVING PLAYER's perspective
 * @param {Object} evaluation - { cp: number } or { mate: number }
 * @param {boolean} isWhiteToMove - True if it's White's turn (for reference, but Stockfish is always from White)
 * @returns {Object} - Evaluation (already from White's perspective in Stockfish)
 */
function normalizeToWhitePerspective(evaluation, isWhiteToMove) {
  if (!evaluation) return { cp: 0 };
  
  // Stockfish always returns from White's perspective, so no normalization needed
  // But we keep this function for clarity and potential future engines that differ
  return evaluation;
}

async function analyzeMove(movesUpToBefore, playedMove, moveNumber, options = {}) {
  const { depth = 15, movetime = 1500 } = options; // Balanced: depth 15, 1.5 seconds per position
  
  // Per-move timeout: 5 seconds max per move (3 positions * ~1.5s each)
  const moveTimeout = 5000;
  
  return Promise.race([
    (async () => {
      try {
        console.log(`[GameReview] Analyzing move ${moveNumber}: ${playedMove}`);
        
        // Determine whose turn it is BEFORE the move
        // Even number of moves (0, 2, 4...) = White to move
        // Odd number of moves (1, 3, 5...) = Black to move
        const isWhiteToMoveBefore = movesUpToBefore.length % 2 === 0;
        const isBlackToMoveBefore = !isWhiteToMoveBefore;
        
        // After the move, the turn switches
        const isWhiteToMoveAfter = !isWhiteToMoveBefore;
        const isBlackToMoveAfter = !isWhiteToMoveAfter;
        
        console.log(`[GameReview] Move ${moveNumber}: Before move - ${isWhiteToMoveBefore ? 'White' : 'Black'} to move, After move - ${isWhiteToMoveAfter ? 'White' : 'Black'} to move`);
        
        // Step 1: Analyze position before move to get best move and its evaluation
        // Stockfish returns eval from the side to move's perspective
        const bestMoveResult = await engine.analyzePosition(movesUpToBefore, { 
          movetime: movetime 
        });
        const bestMove = bestMoveResult.bestMove;
        // CRITICAL FIX: Normalize evalBestAfter to White's perspective
        // This eval is AFTER the best move, so it's from the NEW side to move's perspective
        const evalBestAfterRaw = bestMoveResult.evaluation;
        const evalBestAfter = normalizeToWhitePerspective(evalBestAfterRaw, isWhiteToMoveAfter);
        const pvBest = bestMoveResult.pv || [];

        // Step 2: Get evaluation of position before move (for comparison)
        // Use a very quick shallow search
        const beforeEvalResult = await engine.analyzePosition(movesUpToBefore, { 
          movetime: 300 // Very quick eval
        });
        // CRITICAL FIX: Normalize evalBefore to White's perspective
        const evalBeforeRaw = beforeEvalResult.evaluation;
        const evalBefore = normalizeToWhitePerspective(evalBeforeRaw, isWhiteToMoveBefore);

        // Step 3: Apply played move and get evaluation after
        const movesAfterPlayed = [...movesUpToBefore, playedMove];
        const evalAfterResult = await engine.analyzePosition(movesAfterPlayed, { 
          movetime: movetime 
        });
        // CRITICAL FIX: Normalize evalAfter to White's perspective
        // This eval is AFTER the played move, so it's from the NEW side to move's perspective
        const evalAfterRaw = evalAfterResult.evaluation;
        const evalAfter = normalizeToWhitePerspective(evalAfterRaw, isWhiteToMoveAfter);

        // Log raw and normalized evaluations for debugging
        console.log(`[GameReview] Move ${moveNumber} evaluations (normalized to White perspective):`);
        console.log(`  - Before: ${classifier.formatEvaluation(evalBefore)} (raw: ${classifier.formatEvaluation(evalBeforeRaw)}, ${isWhiteToMoveBefore ? 'White' : 'Black'} to move)`);
        console.log(`  - Best after: ${classifier.formatEvaluation(evalBestAfter)} (raw: ${classifier.formatEvaluation(evalBestAfterRaw)}, ${isWhiteToMoveAfter ? 'White' : 'Black'} to move)`);
        console.log(`  - Played after: ${classifier.formatEvaluation(evalAfter)} (raw: ${classifier.formatEvaluation(evalAfterRaw)}, ${isWhiteToMoveAfter ? 'White' : 'Black'} to move)`);

        // Step 4: Calculate centipawn loss
        // Now all evaluations are from White's perspective, so calculation is correct
        // Loss = how much worse the played move is compared to best move
        // For the player making the move: if they're White, positive eval is good; if Black, negative eval is good
        // But we normalized to White's perspective, so:
        // - For White moves: positive eval = good, negative = bad
        // - For Black moves: after normalization, positive eval = good for White (bad for Black), negative = bad for White (good for Black)
        // So we need to calculate loss from the MOVING PLAYER's perspective
        
        // Determine if this is a White or Black move
        const isWhiteMove = isWhiteToMoveBefore;
        
        // Calculate loss from the moving player's perspective
        const centipawnLoss = classifier.calculateCentipawnLoss(
          evalBestAfter, 
          evalAfter, 
          isWhiteMove
        );

        console.log(`[GameReview] Move ${moveNumber} centipawn loss: ${centipawnLoss}cp (${isWhiteMove ? 'White' : 'Black'} move)`);

        // Step 5: Detect missed mate
        // Compare: did best move have mate that played move doesn't?
        // All evaluations are normalized to White's perspective
        const missedMate = classifier.detectMissedMate(evalBefore, evalBestAfter, evalAfter, isWhiteMove);

        // Step 6: Detect tactical swing
        // Large change in evaluation from before move to after move
        // All evaluations are normalized to White's perspective
        const tacticalSwing = classifier.detectTacticalSwing(evalBefore, evalAfter);

        // Step 7: Classify move (check if it's the best move)
        const isBestMove = bestMove === playedMove || centipawnLoss < 1; // Allow tiny rounding differences
        const isBookMove = moveNumber <= 10 && centipawnLoss <= 5; // Opening moves within 5cp might be book moves
        
        // Check if player had a mate opportunity before the move
        let hadMate = false;
        if (isWhiteMove) {
          hadMate = isMateScore(evalBefore) && evalBefore.mate > 0;
        } else {
          hadMate = isMateScore(evalBefore) && evalBefore.mate < 0;
        }
        
        const label = classifier.classifyMove(centipawnLoss, {
          hadMate,
          missedMate,
          isBestMove,
          isBookMove,
        });

        console.log(`[GameReview] Move ${moveNumber} classification: ${label} (loss: ${centipawnLoss}cp, best: ${bestMove}, played: ${playedMove})`);

        return {
          moveNumber,
          playedMove,
          bestMove: bestMove || null,
          evalBefore: classifier.formatEvaluation(evalBefore),
          evalAfter: classifier.formatEvaluation(evalAfter),
          evalBestAfter: classifier.formatEvaluation(evalBestAfter),
          centipawnLoss: Math.round(centipawnLoss),
          label,
          pv: pvBest.slice(0, 5), // First 5 moves of principal variation
          missedMate,
          tacticalSwing,
          depth: evalAfterResult.depth || depth,
          isBestMove,
          isBookMove,
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
 * Analyze entire game
 * @param {string[]} moves - Array of UCI moves
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>} - Complete review
 */
async function analyzeGame(moves, options = {}) {
  if (!moves || moves.length === 0) {
    throw new Error("No moves provided for analysis");
  }

  const { depth = 15, movetime = 1500 } = options; // Balanced defaults
  const analyzedMoves = [];

  // Use ALL moves - no artificial limits
  // The moves array already contains all moves from the game
  const totalMoves = moves.length;

  console.log(`[GameReview] Analyzing ${totalMoves} moves with movetime=${movetime}ms`);

  // Analyze each move sequentially
  for (let i = 0; i < totalMoves; i++) {
    const moveNumber = i + 1;
    const movesUpToBefore = moves.slice(0, i);
    const playedMove = moves[i];

    console.log(`[GameReview] Analyzing move ${moveNumber}/${totalMoves}: ${playedMove}`);

    try {
      const moveAnalysis = await analyzeMove(
        movesUpToBefore,
        playedMove,
        moveNumber,
        { depth, movetime }
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
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  console.log(`[GameReview] Completed analysis of ${analyzedMoves.length} moves`);

  // Add suggestions/comments to each move
  const movesWithSuggestions = analyzedMoves.map((move, index) => {
    if (move.error) {
      return {
        ...move,
        comment: `Move analysis failed: ${move.error}`,
        tip: null,
      };
    }

    const suggestion = moveSuggestions.generateComprehensiveMoveSuggestion(
      move,
      index,
      analyzedMoves
    );

    return {
      ...move,
      comment: suggestion.comment,
      tip: suggestion.tip,
    };
  });

  return movesWithSuggestions;
}

/**
 * Generate summary statistics
 * @param {Array} analyzedMoves - Array of move analysis results
 * @returns {Object} - Summary statistics
 */
function generateSummary(analyzedMoves) {
  const validMoves = analyzedMoves.filter(m => !m.error);
  
  if (validMoves.length === 0) {
    return {
      totalMoves: analyzedMoves.length,
      accuracy: 0,
      averageCentipawnLoss: 0,
      blunders: 0,
      mistakes: 0,
      inaccuracies: 0,
      goodMoves: 0,
      missedMates: 0,
      tacticalSwings: 0,
    };
  }

  // Count move classifications (Chess.com style)
  const brilliants = validMoves.filter(m => m.label === "brilliant").length;
  const greats = validMoves.filter(m => m.label === "great").length;
  const bests = validMoves.filter(m => m.label === "best").length;
  const excellents = validMoves.filter(m => m.label === "excellent").length;
  const goods = validMoves.filter(m => m.label === "good").length;
  const books = validMoves.filter(m => m.label === "book").length;
  const blunders = validMoves.filter(m => m.label === "blunder").length;
  const mistakes = validMoves.filter(m => m.label === "mistake").length;
  const inaccuracies = validMoves.filter(m => m.label === "inaccuracy").length;
  const missedMates = validMoves.filter(m => m.missedMate).length;
  const tacticalSwings = validMoves.filter(m => m.tacticalSwing).length;
  
  // Legacy: goodMoves includes all positive labels
  const goodMoves = brilliants + greats + bests + excellents + goods + books;

  const totalCentipawnLoss = validMoves.reduce((sum, m) => sum + (m.centipawnLoss || 0), 0);
  const averageCentipawnLoss = totalCentipawnLoss / validMoves.length;

  // Calculate accuracy (inverse of average centipawn loss, normalized)
  // Perfect play = 100%, each 10 centipawns = 1% loss
  const accuracy = Math.max(0, Math.min(100, 100 - (averageCentipawnLoss / 10)));

  return {
    totalMoves: analyzedMoves.length,
    accuracy: Math.round(accuracy * 10) / 10,
    averageCentipawnLoss: Math.round(averageCentipawnLoss),
    // Chess.com style counts
    brilliants,
    greats,
    bests,
    excellents,
    goods,
    books,
    // Error counts
    blunders,
    mistakes,
    inaccuracies,
    // Legacy
    goodMoves,
    missedMates,
    tacticalSwings,
    bestMove: validMoves.reduce((best, m) => 
      (m.centipawnLoss || 0) < (best.centipawnLoss || Infinity) ? m : best,
      validMoves[0]
    ),
    worstMove: validMoves.reduce((worst, m) => 
      (m.centipawnLoss || 0) > (worst.centipawnLoss || 0) ? m : worst,
      validMoves[0]
    ),
  };
}

/**
 * Detect opening from first moves
 * @param {string[]} moves - First few moves
 * @returns {Object} - Opening information
 */
function detectOpening(moves) {
  // Simplified opening detection
  // In production, you'd use an ECO database
  
  if (moves.length === 0) return { name: "Unknown", eco: null };

  const firstMove = moves[0]?.toLowerCase();
  
  // Basic opening detection
  if (firstMove === "e2e4") {
    if (moves.length > 1 && moves[1]?.toLowerCase() === "e7e5") {
      if (moves.length > 2 && moves[2]?.toLowerCase() === "g1f3") {
        return { name: "King's Knight Opening", eco: "C20" };
      }
      return { name: "King's Pawn Game", eco: "C20" };
    }
    if (moves.length > 1 && moves[1]?.toLowerCase() === "c7c5") {
      return { name: "Sicilian Defense", eco: "B20" };
    }
    return { name: "King's Pawn Opening", eco: "B00" };
  }
  
  if (firstMove === "d2d4") {
    return { name: "Queen's Pawn Opening", eco: "D00" };
  }
  
  if (firstMove === "c2c4") {
    return { name: "English Opening", eco: "A10" };
  }

  return { name: "Unknown", eco: null };
}

/**
 * Detect endgame phase
 * @param {string[]} moves - All moves
 * @param {Object} finalEvaluation - Final position evaluation
 * @returns {Object} - Endgame information
 */
function detectEndgame(moves, finalEvaluation) {
  // Simple heuristic: endgame starts around move 30-40
  // Or when material is reduced (would need position analysis)
  
  const moveCount = moves.length;
  const isEndgame = moveCount > 30;

  return {
    phase: isEndgame ? "endgame" : moveCount > 15 ? "middlegame" : "opening",
    moveCount,
    finalEvaluation: classifier.formatEvaluation(finalEvaluation),
  };
}

module.exports = {
  analyzeMove,
  analyzeGame,
  generateSummary,
  detectOpening,
  detectEndgame,
};

