/**
 * Quick Review Generator
 * 
 * Generates a quick review using LITE engine (default depth 12, 600ms per move).
 * Used for immediate display while full review generates in background.
 */

const { generateGameReview } = require("./index-v2");

/** Max wall-clock wait for one full quick-review run (prevents extreme plies from blocking the worker for hours). */
const QUICK_REVIEW_TIMEOUT_MAX_MS = 60 * 60 * 1000; // 1 hour

/**
 * Wall-clock cap for `generateGameReview`.
 * Scales with ply count and engine settings (movetime / depth). The analyzer runs several LITE
 * searches per half-move, so per-ply budget is a multiple of `movetime`, not 2s flat.
 * @param {number} moveCount
 * @param {{ movetime?: number; depth?: number }} [options]
 * @returns {number}
 */
function computeQuickReviewTimeoutMs(moveCount, options = {}) {
  const n = typeof moveCount === "number" && moveCount > 0 ? moveCount : 0;
  const movetime = Math.max(300, Math.min(8000, Number(options.movetime) || 600));
  const depth = Math.max(6, Math.min(20, Number(options.depth) || 12));
  // Analyzer can perform multiple engine calls per ply (before/after + alternatives),
  // so budget must be materially higher than raw movetime.
  const analyzerCallsPerPly = 8;
  const depthBoost = 1 + Math.max(0, depth - 12) * 0.08;
  const perPlyMs = movetime * analyzerCallsPerPly * depthBoost + 1000;
  const slackMs = 60000;
  const minMs = 120000;
  const raw = n * perPlyMs + slackMs;
  return Math.min(QUICK_REVIEW_TIMEOUT_MAX_MS, Math.max(minMs, raw));
}

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
    
    const timeout = computeQuickReviewTimeoutMs(moves.length, { movetime, depth });
    console.log(
      `[QuickReview] Full-run timeout cap: ${timeout}ms (${(timeout / 1000).toFixed(0)}s) — scaled by moves×movetime×depth (cap ${QUICK_REVIEW_TIMEOUT_MAX_MS / 60000}min)`
    );

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
  computeQuickReviewTimeoutMs,
};

