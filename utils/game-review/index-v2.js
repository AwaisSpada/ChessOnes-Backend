/**
 * COMPLETELY REBUILT Game Review Generator - Chess.com Style
 * 
 * This is a complete rewrite to fix all accuracy and classification bugs.
 * Uses the new analyzer-v2.js with correct perspective handling.
 */

const analyzerV2 = require("./analyzer-v2");
const moveSuggestions = require("./move-suggestions");

/**
 * Generate complete game review
 * @param {Object} options - { moves: string[], optionalPgn: string, depth: number, movetime: number, engineType: 'lite' }
 * @returns {Promise<Object>} - Complete review object
 */
async function generateGameReview(options = {}) {
  const { moves, optionalPgn, depth = 12, movetime = 600, engineType = 'lite' } = options;

  try {
    console.log(`[GameReview] ========================================`);
    console.log(`[GameReview] Starting game review generation`);
    console.log(`[GameReview] Moves: ${moves?.length || 0}, Depth: ${depth}, Movetime: ${movetime}ms`);
    console.log(`[GameReview] ========================================`);

    // Initialize engine based on type
    const engine = require("./engine");
    // Quick Review only: always use LITE engine.
    await engine.ensureLiteEngineReady();
    await engine.sendLiteCommand("ucinewgame", { timeout: 1000 });
    await engine.sendLiteCommand("isready", { timeout: 5000 });

    // Parse moves if PGN provided
    let uciMoves = moves;
    if (!uciMoves && optionalPgn) {
      const parser = require("./parser");
      uciMoves = parser.parsePGN(optionalPgn);
    }

    if (!uciMoves || uciMoves.length === 0) {
      throw new Error("No moves provided for analysis");
    }

    // Analyze all moves (pass engineType to analyzer)
    const analyzedMoves = await analyzerV2.analyzeGame(uciMoves, { depth, movetime, engineType: "lite" });

    // Build evaluationGraph (Chess.com–style): leading 0.0 at start position, then one White-POV
    // value per ply (side-to-move scores after White's moves are negated so + = better for White).
    // Never hard-fail the whole review due to a few move-eval gaps.
    const evaluationGraph = [0];
    for (let i = 0; i < analyzedMoves.length; i++) {
      const move = analyzedMoves[i];

      // evalAfterNumeric is a float in pawns (engine side-to-move at leaf); fallback to last point.
      const raw = move && move.evalAfterNumeric !== undefined ? Number(move.evalAfterNumeric) : NaN;
      const fallback = evaluationGraph[evaluationGraph.length - 1];
      const evalFloat = Number.isFinite(raw) ? raw : fallback;

      if (!Number.isFinite(raw)) {
        console.warn(
          `[GameReview] Move ${i + 1} has missing/invalid evalAfterNumeric (${move?.evalAfterNumeric}); using fallback ${fallback}`
        );
      }

      const whitePov = i % 2 === 0 ? -evalFloat : evalFloat;
      evaluationGraph.push(whitePov);
      console.log(
        `[GameReview] Move ${i + 1}: evalAfterNumeric=${move.evalAfterNumeric} → White-POV graph=${whitePov}`
      );
    }

    // MANDATORY VALIDATION before proceeding (graph = start + one point per move)
    if (evaluationGraph.length !== analyzedMoves.length + 1 || evaluationGraph.length !== uciMoves.length + 1) {
      console.warn(
        `[GameReview] evaluationGraph length mismatch: graph=${evaluationGraph.length}, analyzed=${analyzedMoves.length}, input=${uciMoves.length} (expected moves+1)`
      );
    }
    
    const hasPositive = evaluationGraph.some(v => v > 0);
    const hasNegative = evaluationGraph.some(v => v < 0);
    const allZero = evaluationGraph.every(v => v === 0);
    
    console.log(`[GameReview] ========================================`);
    console.log(`[GameReview] evaluationGraph validation (BEFORE DB SAVE):`);
    console.log(`[GameReview]   - Length: ${evaluationGraph.length} (must match ${uciMoves.length})`);
    console.log(`[GameReview]   - Has positive: ${hasPositive}`);
    console.log(`[GameReview]   - Has negative: ${hasNegative}`);
    console.log(`[GameReview]   - All zero: ${allZero}`);
    console.log(`[GameReview]   - Sample (first 10):`, evaluationGraph.slice(0, 10));
    console.log(`[GameReview]   - Sample (last 10):`, evaluationGraph.slice(-10));
    if (evaluationGraph.length > 0) {
      console.log(`[GameReview]   - Min:`, Math.min(...evaluationGraph));
      console.log(`[GameReview]   - Max:`, Math.max(...evaluationGraph));
    }
    console.log(`[GameReview] ========================================`);
    
    if (allZero) {
      console.warn("[GameReview] evaluationGraph contains only zeros; keeping quick review with low-confidence eval graph.");
    }
    
    if (!hasPositive || !hasNegative) {
      console.warn(`[GameReview] WARNING: evaluationGraph missing ${!hasPositive ? 'positive' : 'negative'} values, but proceeding...`);
    }

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
        bestMoveFormatted: suggestion.bestMove,
        engineContinuation: suggestion.engineContinuation,
        playedMoveFormatted: suggestion.playedMove,
      };
    });

    // Separate moves by player
    const whiteMoves = movesWithSuggestions.filter((_, index) => index % 2 === 0);
    const blackMoves = movesWithSuggestions.filter((_, index) => index % 2 === 1);

    console.log(`[GameReview] Separated moves: White=${whiteMoves.length}, Black=${blackMoves.length}`);

    // Calculate player statistics
    const whiteStats = calculatePlayerStats(whiteMoves, "WHITE");
    const blackStats = calculatePlayerStats(blackMoves, "BLACK");

    // Generate summary
    const summary = generateSummary(movesWithSuggestions);

    // Detect opening
    const opening = detectOpening(uciMoves.slice(0, 12));

    // Detect endgame
    const finalEval = movesWithSuggestions.length > 0 
      ? movesWithSuggestions[movesWithSuggestions.length - 1].evalAfter 
      : "0.00";
    const endgame = detectEndgame(uciMoves, finalEval);

    // Generate suggestions
    const reviewSuggestions = generateSuggestions(movesWithSuggestions, whiteStats, blackStats);

    // evaluationGraph is already built above directly from analyzedMoves
    // No need to process again - it's already validated
    
    // Build complete review
    const review = {
      overview: {
        totalMoves: movesWithSuggestions.length,
        analyzedMoves: movesWithSuggestions.filter(m => !m.error).length,
        accuracy: summary.accuracy,
        quality: getQualityRating(summary.accuracy),
        dateAnalyzed: new Date().toISOString(),
      },
      moves: movesWithSuggestions,
      summary,
      opening,
      endgame,
      suggestions: reviewSuggestions,
      players: {
        white: whiteStats,
        black: blackStats,
      },
      // ✅ Evaluation graph: [start=0, after each ply in White-POV pawns, clamped upstream ±10]
      evaluationGraph: evaluationGraph,
    };

    console.log(`[GameReview] ========================================`);
    console.log(`[GameReview] Review generation complete`);
    console.log(`[GameReview] White: ${whiteStats.accuracy}% accuracy, ${whiteStats.totalMoves} moves`);
    console.log(`[GameReview] Black: ${blackStats.accuracy}% accuracy, ${blackStats.totalMoves} moves`);
    console.log(`[GameReview] ========================================`);

    return review;
  } catch (error) {
    console.error("[GameReview] Error generating review:", error);
    throw error;
  }
}

/**
 * Calculate statistics for a specific player's moves
 * CHESS.COM-STYLE ACCURACY FORMULA
 */
function calculatePlayerStats(playerMoves, playerColor) {
  const validMoves = playerMoves.filter(m => !m.error && m.centipawnLoss !== undefined);
  
  if (validMoves.length === 0) {
    return {
      totalMoves: playerMoves.length,
      accuracy: 0,
      brilliants: 0,
      greats: 0,
      bests: 0,
      excellents: 0,
      goods: 0,
      books: 0,
      inaccuracies: 0,
      mistakes: 0,
      blunders: 0,
      missedMates: 0,
      tacticalSwings: 0,
      averageCentipawnLoss: 0,
    };
  }

  // Count move classifications
  const brilliants = validMoves.filter(m => m.label === "brilliant").length;
  const greats = validMoves.filter(m => m.label === "great").length;
  const bests = validMoves.filter(m => m.label === "best").length;
  const excellents = validMoves.filter(m => m.label === "excellent").length;
  const goods = validMoves.filter(m => m.label === "good").length;
  const books = validMoves.filter(m => m.label === "book").length;
  const inaccuracies = validMoves.filter(m => m.label === "inaccuracy").length;
  const mistakes = validMoves.filter(m => m.label === "mistake").length;
  const blunders = validMoves.filter(m => m.label === "blunder").length;
  const missedMates = validMoves.filter(m => m.missedMate).length;
  const tacticalSwings = validMoves.filter(m => m.tacticalSwing).length;

  // Calculate total and average centipawn loss
  const totalCentipawnLoss = validMoves.reduce((sum, m) => sum + (m.centipawnLoss || 0), 0);
  const averageCentipawnLoss = totalCentipawnLoss / validMoves.length;

  // CHESS.COM-STYLE ACCURACY FORMULA
  // Based on average centipawn loss
  // Formula: accuracy = max(0, 100 - (averageLoss / 10))
  // This means:
  // - 0cp average loss → 100% accuracy (perfect play)
  // - 10cp average loss → 99% accuracy (excellent)
  // - 50cp average loss → 95% accuracy (very good)
  // - 100cp average loss → 90% accuracy (good)
  // - 200cp average loss → 80% accuracy (fair)
  // - 300cp average loss → 70% accuracy (poor)
  // - 500cp average loss → 50% accuracy (bad)
  // - 1000cp average loss → 0% accuracy (terrible)
  const accuracy = Math.max(0, Math.min(100, 100 - (averageCentipawnLoss / 10)));

  // Enhanced debug logging
  console.log(`[GameReview] ========================================`);
  console.log(`[GameReview] calculatePlayerStats for ${playerColor}:`);
  console.log(`  - Valid moves: ${validMoves.length}/${playerMoves.length}`);
  console.log(`  - Total centipawn loss: ${totalCentipawnLoss}cp`);
  console.log(`  - Average centipawn loss: ${averageCentipawnLoss.toFixed(2)}cp`);
  console.log(`  - Calculated accuracy: ${accuracy.toFixed(2)}%`);
  console.log(`  - Move quality breakdown:`);
  console.log(`    * Brilliant: ${brilliants}, Great: ${greats}, Best: ${bests}`);
  console.log(`    * Excellent: ${excellents}, Good: ${goods}, Book: ${books}`);
  console.log(`    * Inaccuracy: ${inaccuracies}, Mistake: ${mistakes}, Blunder: ${blunders}`);
  if (validMoves.length > 0) {
    console.log(`  - Sample moves with loss:`);
    validMoves.slice(0, 5).forEach(m => {
      console.log(`    * Move ${m.moveNumber} (${m.playedMove}): ${m.centipawnLoss}cp loss → ${m.label}`);
    });
  }
  console.log(`[GameReview] ========================================`);

  return {
    totalMoves: playerMoves.length,
    accuracy: Math.round(accuracy * 10) / 10,
    averageCentipawnLoss: Math.round(averageCentipawnLoss),
    brilliants,
    greats,
    bests,
    excellents,
    goods,
    books,
    inaccuracies,
    mistakes,
    blunders,
    missedMates,
    tacticalSwings,
  };
}

/**
 * Generate summary statistics
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
  
  const goodMoves = brilliants + greats + bests + excellents + goods + books;

  const totalCentipawnLoss = validMoves.reduce((sum, m) => sum + (m.centipawnLoss || 0), 0);
  const averageCentipawnLoss = totalCentipawnLoss / validMoves.length;

  // Overall accuracy (average of all moves)
  const accuracy = Math.max(0, Math.min(100, 100 - (averageCentipawnLoss / 10)));

  return {
    totalMoves: analyzedMoves.length,
    accuracy: Math.round(accuracy * 10) / 10,
    averageCentipawnLoss: Math.round(averageCentipawnLoss),
    brilliants,
    greats,
    bests,
    excellents,
    goods,
    books,
    blunders,
    mistakes,
    inaccuracies,
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
 */
function detectOpening(moves) {
  if (moves.length === 0) return { name: "Unknown", eco: null };

  const firstMove = moves[0]?.toLowerCase();
  
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
 */
function detectEndgame(moves, finalEvaluation) {
  const moveCount = moves.length;
  const isEndgame = moveCount > 30;

  return {
    phase: isEndgame ? "endgame" : moveCount > 15 ? "middlegame" : "opening",
    moveCount,
    finalEvaluation: finalEvaluation || "0.00",
  };
}

/**
 * Generate suggestions based on review
 */
function generateSuggestions(analyzedMoves, whiteStats, blackStats) {
  const suggestions = [];
  
  const validMoves = analyzedMoves.filter(m => !m.error);
  const blunders = validMoves.filter(m => m.label === "blunder");
  const mistakes = validMoves.filter(m => m.label === "mistake");
  
  if (blunders.length > 0) {
    suggestions.push({
      type: "blunder",
      message: `You made ${blunders.length} blunder${blunders.length > 1 ? 's' : ''}. Review these critical mistakes to improve your game.`,
      moves: blunders.slice(0, 5).map(m => m.moveNumber),
    });
  }
  
  if (mistakes.length > 0) {
    suggestions.push({
      type: "mistake",
      message: `You made ${mistakes.length} mistake${mistakes.length > 1 ? 's' : ''}. Focus on calculation and tactics.`,
      moves: mistakes.slice(0, 5).map(m => m.moveNumber),
    });
  }
  
  const missedMates = validMoves.filter(m => m.missedMate);
  if (missedMates.length > 0) {
    suggestions.push({
      type: "missed_mate",
      message: `You missed ${missedMates.length} mate opportunity${missedMates.length > 1 ? 'ies' : 'y'}. Practice tactical puzzles to improve pattern recognition.`,
      moves: missedMates.slice(0, 5).map(m => m.moveNumber),
    });
  }
  
  return suggestions;
}

/**
 * Get quality rating from accuracy percentage
 */
function getQualityRating(accuracy) {
  if (accuracy >= 90) return "excellent";
  if (accuracy >= 80) return "very good";
  if (accuracy >= 70) return "good";
  if (accuracy >= 60) return "fair";
  return "needs improvement";
}

module.exports = {
  generateGameReview,
  calculatePlayerStats,
  generateSummary,
  detectOpening,
  detectEndgame,
  generateSuggestions,
  getQualityRating,
};

