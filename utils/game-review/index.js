/**
 * Game Review Processor - Main Entry Point
 * 
 * Complete game review system using Stockfish for position evaluation.
 * 
 * Usage:
 *   const { generateGameReview } = require('./utils/game-review');
 *   const review = await generateGameReview({
 *     moves: ['e2e4', 'e7e5', 'g1f3', ...],
 *     // OR
 *     optionalPgn: '1. e4 e5 2. Nf3 ...'
 *   });
 */

// Use the new v2 implementation with correct perspective handling
const indexV2 = require("./index-v2");

// Keep old imports for backward compatibility
const parser = require("./parser");
const analyzer = require("./analyzer");
const suggestions = require("./suggestions");
const engine = require("./engine");

/**
 * Generate complete game review
 * @param {Object} options - { moves?: string[], optionalPgn?: string, depth?: number, movetime?: number }
 * @returns {Promise<Object>} - Complete review object
 */
// Delegate to new implementation
async function generateGameReview(options = {}) {
  return indexV2.generateGameReview(options);
}

// Keep old function for reference (will be removed)
async function generateGameReview_OLD(options = {}) {
  // Use balanced defaults for good analysis without being too slow
  const { moves, optionalPgn, depth = 15, movetime = 1500 } = options;

  try {
    // Initialize engine (only once, reuse for all positions)
    await engine.ensureEngineReady();
    
    // Send ucinewgame once at the start (not before every position)
    // This resets the engine's internal state for a new game
    try {
      console.log("[GameReview] Sending ucinewgame to reset engine state");
      await engine.sendCommand("ucinewgame", { timeout: 5000 });
      await engine.sendCommand("isready", { timeout: 5000 });
      console.log("[GameReview] Engine ready for analysis");
    } catch (err) {
      console.warn("[GameReview] Warning: ucinewgame/isready failed, continuing anyway:", err.message);
      // Continue anyway - the engine might still work
    }

    // Parse moves from PGN if needed
    let uciMoves = moves;
    if (!uciMoves && optionalPgn) {
      const parsedMoves = parser.parsePGN(optionalPgn);
      // Note: parsed moves may be in SAN format
      // For now, we'll assume they're UCI or need conversion
      // In production, you'd want proper SAN->UCI conversion
      uciMoves = parsedMoves;
    }

    if (!uciMoves || uciMoves.length === 0) {
      throw new Error("No moves provided. Provide either 'moves' array or 'optionalPgn' string.");
    }

    // Normalize moves
    uciMoves = uciMoves.map(m => parser.normalizeMove(m)).filter(Boolean);

    console.log(`[GameReview] Starting analysis of ${uciMoves.length} moves`);
    console.log(`[GameReview] Moves to analyze:`, uciMoves.slice(0, 5).join(", "), uciMoves.length > 5 ? "..." : "");

    // Analyze all moves
    const analyzedMoves = await analyzer.analyzeGame(uciMoves, { depth, movetime });

    // Generate summary
    const summary = analyzer.generateSummary(analyzedMoves);

    // Detect opening (first 10 moves)
    const openingMoves = uciMoves.slice(0, 10);
    const opening = analyzer.detectOpening(openingMoves);

    // Detect endgame
    // Get final position evaluation
    let finalEvaluation = { cp: 0 };
    try {
      const finalResult = await engine.analyzePosition(uciMoves, { depth: 10 });
      finalEvaluation = finalResult.evaluation;
    } catch (err) {
      console.warn("[GameReview] Could not get final evaluation:", err.message);
    }

    const endgame = analyzer.detectEndgame(uciMoves, finalEvaluation);

    // Generate suggestions
    const reviewData = {
      moves: analyzedMoves,
      summary,
      opening,
      endgame,
    };
    const reviewSuggestions = suggestions.generateSuggestions(reviewData);

    // Build overview
    // Only count moves that were successfully analyzed (not errors/timeouts)
    const successfullyAnalyzedMoves = analyzedMoves.filter(m => !m.error && m.label !== "timeout" && m.label !== "unknown");
    
    const overview = {
      totalMoves: analyzedMoves.length, // Total moves in the game
      analyzedMoves: successfullyAnalyzedMoves.length, // Successfully analyzed moves
      accuracy: summary.accuracy,
      quality: getQualityRating(summary.accuracy),
      dateAnalyzed: new Date().toISOString(),
    };
    
    console.log(`[GameReview] Overview: ${overview.totalMoves} total moves, ${overview.analyzedMoves} successfully analyzed`);

    // Separate moves by player (white = even indices, black = odd indices)
    const whiteMoves = analyzedMoves.filter((_, index) => index % 2 === 0);
    const blackMoves = analyzedMoves.filter((_, index) => index % 2 === 1);

    // Calculate statistics for each player (INDEPENDENTLY)
    console.log(`[GameReview] ========================================`);
    console.log(`[GameReview] Calculating WHITE player stats...`);
    const whiteStats = calculatePlayerStats(whiteMoves, "WHITE");
    console.log(`[GameReview] ========================================`);
    console.log(`[GameReview] Calculating BLACK player stats...`);
    const blackStats = calculatePlayerStats(blackMoves, "BLACK");
    console.log(`[GameReview] ========================================`);

    // Log move assignment for debugging
    console.log(`[GameReview] Move assignment: White moves: ${whiteMoves.length}, Black moves: ${blackMoves.length}`);
    console.log(`[GameReview] White moves sample:`, whiteMoves.slice(0, 3).map(m => `${m.moveNumber}:${m.playedMove}(${m.label})`).join(", "));
    console.log(`[GameReview] Black moves sample:`, blackMoves.slice(0, 3).map(m => `${m.moveNumber}:${m.playedMove}(${m.label})`).join(", "));

    // Build complete review
    const review = {
      overview,
      moves: analyzedMoves,
      summary,
      opening,
      endgame,
      suggestions: reviewSuggestions,
      // Player comparison data
      players: {
        white: whiteStats,
        black: blackStats,
      },
    };

    console.log(`[GameReview] Analysis complete. Accuracy: ${summary.accuracy}%`);
    console.log(`[GameReview] White: ${whiteStats.accuracy}% accuracy (${whiteStats.totalMoves} moves), Black: ${blackStats.accuracy}% accuracy (${blackStats.totalMoves} moves)`);
    console.log(`[GameReview] White stats:`, {
      brilliants: whiteStats.brilliants,
      greats: whiteStats.greats,
      bests: whiteStats.bests,
      excellents: whiteStats.excellents,
      goods: whiteStats.goods,
      books: whiteStats.books,
      inaccuracies: whiteStats.inaccuracies,
      mistakes: whiteStats.mistakes,
      blunders: whiteStats.blunders,
    });
    console.log(`[GameReview] Black stats:`, {
      brilliants: blackStats.brilliants,
      greats: blackStats.greats,
      bests: blackStats.bests,
      excellents: blackStats.excellents,
      goods: blackStats.goods,
      books: blackStats.books,
      inaccuracies: blackStats.inaccuracies,
      mistakes: blackStats.mistakes,
      blunders: blackStats.blunders,
    });

    return review;
  } catch (error) {
    console.error("[GameReview] Error generating review:", error);
    throw error;
  }
}

// Export the new v2 implementation as the main one
module.exports = {
  generateGameReview: indexV2.generateGameReview,
  calculatePlayerStats: indexV2.calculatePlayerStats,
  generateSummary: indexV2.generateSummary,
  detectOpening: indexV2.detectOpening,
  detectEndgame: indexV2.detectEndgame,
  generateSuggestions: indexV2.generateSuggestions,
  getQualityRating: indexV2.getQualityRating,
  cleanup: () => engine.cleanup(),
};

// Export sub-modules for advanced usage
module.exports.parser = parser;
module.exports.analyzer = analyzer;
module.exports.suggestions = suggestions;
module.exports.engine = engine;
module.exports.stockfishAnalyzer = require("./stockfish-analyzer");

// Keep old exports for backward compatibility
module.exports.generateGameReview_OLD = generateGameReview_OLD;

/**
 * Get quality rating from accuracy percentage
 * @param {number} accuracy - Accuracy percentage (0-100)
 * @returns {string} - Quality rating
 */
function getQualityRating(accuracy) {
  if (accuracy >= 90) return "excellent";
  if (accuracy >= 80) return "very good";
  if (accuracy >= 70) return "good";
  if (accuracy >= 60) return "fair";
  return "needs improvement";
}

/**
 * Calculate statistics for a specific player's moves
 * @param {Array} playerMoves - Moves made by the player
 * @returns {Object} - Player statistics
 */
function calculatePlayerStats(playerMoves) {
  const validMoves = playerMoves.filter(m => !m.error && m.label);
  
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
      averageCentipawnLoss: 0,
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
  const inaccuracies = validMoves.filter(m => m.label === "inaccuracy").length;
  const mistakes = validMoves.filter(m => m.label === "mistake").length;
  const blunders = validMoves.filter(m => m.label === "blunder").length;
  const missedMates = validMoves.filter(m => m.missedMate).length;
  const tacticalSwings = validMoves.filter(m => m.tacticalSwing).length;

  const totalCentipawnLoss = validMoves.reduce((sum, m) => sum + (m.centipawnLoss || 0), 0);
  const averageCentipawnLoss = totalCentipawnLoss / validMoves.length;

  // Calculate accuracy (inverse of average centipawn loss)
  // Formula based on Chess.com/Lichess: accuracy = 100 - (averageCentipawnLoss / 10)
  // This means:
  // - 0cp average loss → 100% accuracy (perfect play)
  // - 10cp average loss → 99% accuracy (excellent)
  // - 50cp average loss → 95% accuracy (very good)
  // - 100cp average loss → 90% accuracy (good)
  // - 300cp average loss → 70% accuracy (fair)
  // - 500cp average loss → 50% accuracy (poor)
  // - 1000cp average loss → 0% accuracy (terrible)
  const accuracy = Math.max(0, Math.min(100, 100 - (averageCentipawnLoss / 10)));

  // Enhanced debug logging
  console.log(`[GameReview] ========================================`);
  console.log(`[GameReview] calculatePlayerStats for ${playerMoves.length > 0 ? (playerMoves[0].moveNumber % 2 === 0 ? 'WHITE' : 'BLACK') : 'UNKNOWN'}:`);
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
 * Cleanup engine (call when done with all reviews)
 */
function cleanup() {
  engine.cleanup();
}

module.exports = {
  generateGameReview,
  cleanup,
};

// Export sub-modules for advanced usage
module.exports.parser = parser;
module.exports.analyzer = analyzer;
module.exports.suggestions = suggestions;
module.exports.engine = engine;

// Export new Stockfish analyzer
module.exports.stockfishAnalyzer = require("./stockfish-analyzer");

