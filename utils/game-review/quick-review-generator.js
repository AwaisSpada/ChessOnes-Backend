/**
 * Quick Review Generator
 * 
 * Generates a quick review using LITE engine (default depth 12, 600ms per move).
 * Used for immediate display while full review generates in background.
 */

const { generateGameReview } = require("./index-v2");

/**
 * Generate quick review using LITE engine
 * @param {string[]} moves - Array of UCI moves
 * @returns {Promise<Object>} - Quick review object (same structure as full review)
 */
async function generateQuickReview(moves, options = {}) {
  const { depth = 12, movetime = 600 } = options;
  try {
    console.log(`[QuickReview] Starting quick review generation with LITE engine`);
    console.log(`[QuickReview] Moves: ${moves.length}, Depth: ${depth}, Movetime: ${movetime}ms`);
    
    // ✅ SAFEGUARD: Dynamic timeout based on game length with a 60s floor.
    const timeout = Math.max(60000, moves.length * 2000 + 10000);

    const quickReviewPromise = generateGameReview({
      moves,
      depth,
      movetime,
      engineType: 'lite', // Use LITE engine
    });
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Review generation timeout (${timeout / 1000}s)`)), timeout);
    });
    
    const review = await Promise.race([quickReviewPromise, timeoutPromise]);
    
    // Mark review as quick review in metadata
    review.overview.quickReview = true;
    review.overview.reviewType = 'lite';
    
    console.log(`[QuickReview] ✅ Quick review generated successfully`);
    return review;
  } catch (error) {
    // Never persist a "completed" stub with analyzedMoves: 0 — that makes GET return 200
    // while the UI looks empty. Callers mark the review failed / keep pending instead.
    console.error(`[QuickReview] ❌ Error generating quick review:`, error.message);
    console.error(`[QuickReview] Stack:`, error.stack);
    throw error;
  }
}

module.exports = {
  generateQuickReview,
};

