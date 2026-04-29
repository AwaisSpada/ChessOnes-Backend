/**
 * Replay Evaluation Service
 * 
 * Uses LITE engine for quick evaluations during replay navigation.
 * Results are NOT persisted - this is UX-only for live replay features.
 * 
 * Configuration:
 * - Depth: 8-10 (default 8)
 * - Movetime: 500ms
 * - Uses Stockfish 17.1 (same binary as FULL, different process)
 */

const engine = require("./engine");

/**
 * Get quick evaluation for a position during replay
 * @param {string[]} moves - Array of UCI moves up to current position
 * @param {Object} options - { depth: number (8-10, default 8), movetime: number (default 500) }
 * @returns {Promise<Object>} - { bestMove, evalAfter, evaluation, pv, arrow }
 */
async function getReplayEvaluation(moves = [], options = {}) {
  // LITE engine configuration: depth 8-10, movetime 500ms
  const { depth = 8, movetime = 500 } = options;
  
  try {
    // Ensure LITE engine is ready (separate process from FULL engine)
    await engine.ensureLiteEngineReady();
    
    // Analyze current position to get best move and evaluation
    // analyzePositionLite will clamp depth to 8-10 and use movetime 500ms
    const result = await engine.analyzePositionLite(moves, { 
      depth, // Will be clamped to 8-10 in analyzePositionLite
      movetime 
    });
    
    // Get evaluation after the best move (for arrow suggestion)
    let evalAfter = result.evaluation;
    if (result.bestMove && result.pv && result.pv.length > 0) {
      // The evaluation in result is already after the best move (from principal variation)
      evalAfter = result.evaluation;
    }
    
    // Extract arrow data (from/to squares from bestMove)
    let arrow = null;
    if (result.bestMove && result.bestMove.length >= 4) {
      arrow = {
        from: result.bestMove.substring(0, 2), // e.g., "e2"
        to: result.bestMove.substring(2, 4),   // e.g., "e4"
      };
    }
    
    return {
      bestMove: result.bestMove,
      evalAfter: evalAfter, // Evaluation after best move
      evaluation: evalAfter, // Alias for backwards compatibility
      pv: result.pv || [],
      depth: result.depth || depth,
      arrow: arrow, // Arrow suggestion for frontend
      // Format evaluation for display
      evaluationText: formatEvaluation(evalAfter),
      engineType: "LITE",
      persistent: false, // ✅ SAFEGUARD: Never persisted
    };
  } catch (error) {
    console.error(`[ReplayEval] Error getting replay evaluation:`, error);
    return {
      bestMove: null,
      evalAfter: { cp: 0 },
      evaluation: { cp: 0 },
      pv: [],
      depth: 0,
      arrow: null,
      evaluationText: "0.00",
      engineType: "LITE",
      persistent: false,
      error: error.message,
    };
  }
}

/**
 * Format evaluation for display
 * @param {Object} evaluation - { cp: number } or { mate: number }
 * @returns {string} - Formatted evaluation string
 */
function formatEvaluation(evaluation) {
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
 * Get best move suggestion for replay position
 * @param {string[]} moves - Array of UCI moves up to current position
 * @returns {Promise<string|null>} - Best move in UCI format or null
 */
async function getBestMoveSuggestion(moves = []) {
  try {
    const result = await engine.analyzePositionLite(moves, { depth: 10, movetime: 500 });
    return result.bestMove;
  } catch (error) {
    console.error(`[ReplayEval] Error getting best move suggestion:`, error);
    return null;
  }
}

module.exports = {
  getReplayEvaluation,
  getBestMoveSuggestion,
  formatEvaluation,
};

