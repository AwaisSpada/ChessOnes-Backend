/**
 * Quick Review Generator
 * 
 * Generates a quick review using LITE engine (depth 8-10, 500ms per move).
 * Used for immediate display while full review generates in background.
 */

const { generateGameReview } = require("./index-v2");

/**
 * Generate quick review using LITE engine
 * @param {string[]} moves - Array of UCI moves
 * @returns {Promise<Object>} - Quick review object (same structure as full review)
 */
async function generateQuickReview(moves, options = {}) {
  const { depth = 12, movetime = 500 } = options;
  try {
    console.log(`[QuickReview] Starting quick review generation with LITE engine`);
    console.log(`[QuickReview] Moves: ${moves.length}, Depth: ${depth}, Movetime: ${movetime}ms`);
    
    // ✅ SAFEGUARD: Wrap in timeout to prevent hanging (max 60 seconds for quick review)
    const quickReviewPromise = generateGameReview({
      moves,
      depth,
      movetime,
      engineType: 'lite', // Use LITE engine
    });
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Quick review generation timeout (60s)")), 60000);
    });
    
    const review = await Promise.race([quickReviewPromise, timeoutPromise]);
    
    // Mark review as quick review in metadata
    review.overview.quickReview = true;
    review.overview.reviewType = 'lite';
    
    console.log(`[QuickReview] ✅ Quick review generated successfully`);
    return review;
  } catch (error) {
    // ✅ SAFEGUARD: Log error but don't crash - return minimal review structure
    console.error(`[QuickReview] ❌ Error generating quick review:`, error.message);
    console.error(`[QuickReview] Stack:`, error.stack);
    
    // Return minimal review structure so frontend doesn't crash
    // This ensures reviewData is never null
    return {
      overview: {
        totalMoves: moves.length,
        analyzedMoves: 0,
        accuracy: 0,
        quality: "unknown",
        dateAnalyzed: new Date().toISOString(),
        quickReview: true,
        reviewType: 'lite',
        error: error.message,
      },
      moves: moves.map((move, index) => ({
        moveNumber: Math.floor(index / 2) + 1,
        playedMove: move,
        player: index % 2 === 0 ? "white" : "black",
        error: "Quick review generation failed",
        label: "unknown",
      })),
      summary: {
        accuracy: 0,
        totalMoves: moves.length,
      },
      opening: { name: "Unknown", accuracy: 0 },
      endgame: { name: "Unknown", accuracy: 0 },
      suggestions: ["Quick review generation failed. Full review is generating in background."],
      players: {
        white: { accuracy: 0, totalMoves: 0 },
        black: { accuracy: 0, totalMoves: 0 },
      },
      evaluationGraph: new Array(moves.length + 1).fill(0),
    };
  }
}

module.exports = {
  generateQuickReview,
};

