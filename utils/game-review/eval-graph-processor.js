/**
 * Evaluation Graph Processor
 * 
 * Processes evaluation data for graph display:
 * - Clamps values to [-10, +10] pawns
 * - Converts mate scores to ±10
 * - Ensures consistency (only uses FULL engine evalAfter)
 * - No recalculation during replay
 */

/**
 * Process evaluation for graph display
 * 
 * SAFEGUARD: Only processes evalAfter from FULL engine data.
 * Mate scores are converted to ±10 (maximum display value).
 * Regular evaluations are clamped to [-10, +10] pawns.
 * 
 * @param {Object|string} evaluation - Evaluation from FULL engine { cp: number } or { mate: number } OR formatted string like "+0.50" or "M3"
 * @returns {number} - Clamped evaluation in pawns (-10 to +10)
 */
function processEvaluationForGraph(evaluation) {
  // MANDATORY DEBUG: Log what we receive
  console.log("[EvalGraphProcessor] processEvaluationForGraph input:", evaluation, "type:", typeof evaluation);
  
  if (!evaluation) {
    console.warn("[EvalGraphProcessor] Empty evaluation, returning 0");
    return 0;
  }
  
  // If it's a string (formatted like "+0.50" or "-1.20" or "M3"), parse it
  if (typeof evaluation === 'string') {
    console.log("[EvalGraphProcessor] Parsing formatted string:", evaluation);
    
    // Check for mate notation (M3, -M5, etc.)
    const mateMatch = evaluation.match(/^-?M(\d+)$/);
    if (mateMatch) {
      const mateMoves = parseInt(mateMatch[1], 10);
      const isPositive = !evaluation.startsWith('-');
      console.log("[EvalGraphProcessor] Mate detected:", mateMoves, "positive:", isPositive);
      return isPositive ? 10 : -10;
    }
    
    // Parse numeric string like "+0.50" or "-1.20"
    const numericValue = parseFloat(evaluation);
    if (isNaN(numericValue)) {
      console.error("[EvalGraphProcessor] Failed to parse string as number:", evaluation);
      return 0;
    }
    
    // String is already in pawns, just clamp it
    const clamped = Math.max(-10, Math.min(10, numericValue));
    console.log("[EvalGraphProcessor] Parsed value:", numericValue, "clamped:", clamped);
    return clamped;
  }
  
  // Handle object format { cp: number } or { mate: number }
  if (typeof evaluation === 'object') {
    console.log("[EvalGraphProcessor] Processing object, keys:", Object.keys(evaluation));
    
    // Handle mate scores - convert to maximum display value
    if (evaluation.mate !== undefined) {
      // Mate = maximum advantage
      // Positive mate (mate for White) = +10
      // Negative mate (mate for Black) = -10
      const result = evaluation.mate > 0 ? 10 : -10;
      console.log("[EvalGraphProcessor] Mate value:", evaluation.mate, "result:", result);
      return result;
    }
    
    // Convert centipawns to pawns and clamp to [-10, +10]
    if (evaluation.cp !== undefined) {
      const pawns = evaluation.cp / 100;
      const clamped = Math.max(-10, Math.min(10, pawns));
      console.log("[EvalGraphProcessor] CP value:", evaluation.cp, "pawns:", pawns, "clamped:", clamped);
      return clamped;
    }
    
    console.error("[EvalGraphProcessor] Object has neither cp nor mate:", evaluation);
    return 0;
  }
  
  console.error("[EvalGraphProcessor] Unknown evaluation format:", evaluation, "type:", typeof evaluation);
  return 0;
}

/**
 * Process move evaluations for evaluation graph
 * 
 * Processes all move evaluations in a review to create graph data.
 * Only uses evalAfter from FULL engine (stored in review data).
 * 
 * @param {Array} moves - Array of move analysis objects from FULL engine
 * @returns {Array<number>} - Array of evaluation values for graph (pawns, clamped to [-10, +10])
 */
function processMoveEvaluationsForGraph(moves) {
  console.log("[EvalGraphProcessor] processMoveEvaluationsForGraph called with", moves?.length || 0, "moves");
  
  if (!moves || !Array.isArray(moves)) {
    console.warn("[EvalGraphProcessor] Invalid moves array");
    return [];
  }
  
  // MANDATORY DEBUG: Log first few moves to see structure
  console.log("[EvalGraphProcessor] Sample move 0:", JSON.stringify(moves[0], null, 2));
  console.log("[EvalGraphProcessor] Sample move 0 evalAfter:", moves[0]?.evalAfter, "type:", typeof moves[0]?.evalAfter);
  console.log("[EvalGraphProcessor] Sample move 0 evalAfterNumeric:", moves[0]?.evalAfterNumeric, "type:", typeof moves[0]?.evalAfterNumeric);
  
  // Extract evalAfterNumeric (numeric float) OR evalAfter (fallback to parse)
  // evalAfterNumeric is stored directly as numeric float (pawns, -10 to +10)
  const graphPoints = moves.map((move, index) => {
    if (!move || move.error) {
      console.warn(`[EvalGraphProcessor] Move ${index} has error or is null`);
      return null; // Return null instead of 0 to indicate missing data
    }
    
    // PREFER evalAfterNumeric (direct numeric value)
    if (move.evalAfterNumeric !== undefined && move.evalAfterNumeric !== null) {
      const numericValue = Number(move.evalAfterNumeric);
      if (!isNaN(numericValue)) {
        // Log first few values for debugging
        if (index < 5) {
          console.log(`[EvalGraphProcessor] Move ${index}: Using evalAfterNumeric=`, numericValue);
        }
        return numericValue;
      } else {
        console.error(`[EvalGraphProcessor] Move ${index}: evalAfterNumeric is NaN:`, move.evalAfterNumeric);
      }
    }
    
    // FALLBACK: Try to parse from evalAfter (formatted string or object)
    const evalAfter = move.evalAfter;
    if (evalAfter === undefined || evalAfter === null) {
      console.error(`[EvalGraphProcessor] Move ${index}: Missing both evalAfterNumeric and evalAfter!`);
      return null;
    }
    
    const processedValue = processEvaluationForGraph(evalAfter);
    
    // Log first few values for debugging
    if (index < 5) {
      console.log(`[EvalGraphProcessor] Move ${index}: Fallback to evalAfter=`, evalAfter, "processed=", processedValue);
    }
    
    return processedValue;
  });
  
  // Filter out nulls and log summary
  const validPoints = graphPoints.filter(p => p !== null && p !== undefined);
  const nullCount = graphPoints.length - validPoints.length;
  
  console.log("[EvalGraphProcessor] Processed graph points:", graphPoints.length, "valid:", validPoints.length, "null:", nullCount);
  console.log("[EvalGraphProcessor] First 5 graph points:", graphPoints.slice(0, 5));
  console.log("[EvalGraphProcessor] Last 5 graph points:", graphPoints.slice(-5));
  
  if (validPoints.length > 0) {
    const minVal = Math.min(...validPoints);
    const maxVal = Math.max(...validPoints);
    const hasPositive = validPoints.some(v => v > 0);
    const hasNegative = validPoints.some(v => v < 0);
    console.log("[EvalGraphProcessor] Min:", minVal, "Max:", maxVal, "Has positive:", hasPositive, "Has negative:", hasNegative);
    
    if (!hasPositive && !hasNegative && validPoints.every(v => v === 0)) {
      console.error("[EvalGraphProcessor] ERROR: All values are zero! Data binding issue detected.");
      throw new Error("evaluationGraph contains only zeros - check Stockfish output and evalAfterNumeric storage");
    }
  }
  
  // Return all points (including nulls to preserve array length for move indices)
  return graphPoints;
}

/**
 * Validate that evaluation graph data comes from FULL engine
 * 
 * SAFEGUARD: Ensures no LITE engine data is used for graph.
 * 
 * @param {Object} reviewData - Complete review data
 * @returns {boolean} - True if graph data is valid (from FULL engine)
 */
function validateGraphDataSource(reviewData) {
  if (!reviewData || !reviewData.moves) {
    return false;
  }
  
  // Check that all moves have evalAfter (from FULL engine)
  // If moves are missing evalAfter, they might be from LITE engine
  const allMovesHaveEval = reviewData.moves.every(move => {
    if (move.error) return true; // Error moves are OK
    return move.evalAfter !== undefined;
  });
  
  return allMovesHaveEval;
}

module.exports = {
  processEvaluationForGraph,
  processMoveEvaluationsForGraph,
  validateGraphDataSource,
};

