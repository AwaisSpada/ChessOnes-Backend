/**
 * Move Classification Module
 * 
 * Classifies moves based on centipawn loss:
 * - Inaccuracy: 60-149 centipawns
 * - Mistake: 150-299 centipawns
 * - Blunder: 300+ centipawns
 * 
 * Also detects:
 * - Missed mates
 * - Tactical swings
 */

function evalToAbsPawns(evalAfter) {
  if (typeof evalAfter === "number" && Number.isFinite(evalAfter)) {
    return Math.abs(evalAfter);
  }
  if (!evalAfter || typeof evalAfter !== "object") {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof evalAfter.mate === "number") {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof evalAfter.cp === "number" && Number.isFinite(evalAfter.cp)) {
    return Math.abs(evalAfter.cp / 100);
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Strict, gap-free classification with deterministic priority.
 * @param {number} centipawnLoss
 * @param {Object} context
 * @returns {string}
 */
function classifyMove(centipawnLoss, context = {}) {
  const {
    moveNumber = Number.POSITIVE_INFINITY,
    evalAfter = null,
    hadMate = false,
    missedMate = false,
    tacticalSwing = false,
    isCaptureMove = false,
    isSacrificeMove = false,
    isBestMove = false,
  } = context;

  const cpl = Number.isFinite(centipawnLoss) ? centipawnLoss : Number.POSITIVE_INFINITY;
  const absEvalPawns = evalToAbsPawns(evalAfter);

  if (moveNumber <= 12 && absEvalPawns <= 0.5 && cpl <= 8) {
    return "book";
  } else if (missedMate === true || (hadMate === true && cpl >= 200)) {
    return "blunder";
  } else if (
    cpl > 0 &&
    cpl <= 15 &&
    tacticalSwing === true &&
    (isCaptureMove || isSacrificeMove)
  ) {
    return "brilliant";
  } else if (isBestMove === true || cpl === 0) {
    return "best";
  } else if (cpl <= 35) {
    return "excellent";
  } else if (cpl <= 75) {
    return "good";
  } else if (cpl <= 150) {
    return "inaccuracy";
  } else if (cpl < 300) {
    return "mistake";
  } else if (cpl >= 300) {
    return "blunder";
  }

  return "blunder";
}

const CLASSIFICATION_THRESHOLDS = Object.freeze({
  BOOK: 8,
  BOOK_MAX_ABS_EVAL_CP: 50,
  BEST: 0,
  EXCELLENT_MAX_LOSS: 35,
  GOOD_MAX_LOSS: 75,
  INACCURACY: 150,
  MISTAKE: 300,
  BLUNDER: 300,
  BRILLIANT_MAX_LOSS: 15,
  TACTICAL_SWING: 200,
});

/**
 * Check if evaluation indicates a mate
 * @param {Object} evaluation - { cp: number } or { mate: number }
 * @returns {boolean} - True if mate score
 */
function isMateScore(evaluation) {
  return evaluation && typeof evaluation.mate === "number";
}

/**
 * Check if a move missed a mate opportunity
 * CRITICAL: All evaluations must be normalized to White's perspective
 * @param {Object} evalBefore - Evaluation before move (normalized to White perspective)
 * @param {Object} evalBestAfter - Best move evaluation after position (normalized to White perspective)
 * @param {Object} evalAfter - Actual move evaluation after position (normalized to White perspective)
 * @param {boolean} isWhiteMove - True if this is a White move
 * @returns {boolean} - True if mate was missed
 */
function detectMissedMate(evalBefore, evalBestAfter, evalAfter, isWhiteMove = true) {
  // For White moves: positive mate = good (mate for White)
  // For Black moves: after normalization, positive mate = mate for White (bad for Black)
  //                  negative mate = mate for Black (good for Black)
  
  let bestMateForPlayer, playedMateForPlayer;
  
  if (isWhiteMove) {
    // White move: positive mate = good
    bestMateForPlayer = isMateScore(evalBestAfter) && evalBestAfter.mate > 0 ? evalBestAfter.mate : null;
    playedMateForPlayer = isMateScore(evalAfter) && evalAfter.mate > 0 ? evalAfter.mate : null;
  } else {
    // Black move: after normalization, negative mate = good for Black
    bestMateForPlayer = isMateScore(evalBestAfter) && evalBestAfter.mate < 0 ? Math.abs(evalBestAfter.mate) : null;
    playedMateForPlayer = isMateScore(evalAfter) && evalAfter.mate < 0 ? Math.abs(evalAfter.mate) : null;
  }
  
  // If best move had mate for the player and played move doesn't
  if (bestMateForPlayer !== null && playedMateForPlayer === null) {
    return true;
  }

  // If best move had mate in fewer moves
  if (bestMateForPlayer !== null && playedMateForPlayer !== null) {
    // If best move was mate in N and played move is mate in M where M > N+1
    if (playedMateForPlayer > bestMateForPlayer + 1) {
      return true;
    }
  }

  return false;
}

/**
 * Detect tactical swings (large evaluation changes)
 * @param {Object} evalBefore - Evaluation before move
 * @param {Object} evalAfter - Evaluation after move
 * @returns {boolean} - True if swing detected
 */
function detectTacticalSwing(evalBefore, evalAfter) {
  const beforeCP = isMateScore(evalBefore) 
    ? (evalBefore.mate > 0 ? 10000 : -10000)
    : (evalBefore.cp || 0);
  
  const afterCP = isMateScore(evalAfter)
    ? (evalAfter.mate > 0 ? 10000 : -10000)
    : (evalAfter.cp || 0);

  const swing = Math.abs(afterCP - beforeCP);
  return swing >= 200;
}

/**
 * Get centipawn value from evaluation
 * @param {Object} evaluation - { cp: number } or { mate: number } (from White's perspective)
 * @returns {number} - Centipawn value (or large number for mate)
 *                     Positive = good for White, Negative = good for Black
 */
function getCentipawnValue(evaluation) {
  if (!evaluation) return 0;
  
  if (isMateScore(evaluation)) {
    // Convert mate to centipawn equivalent
    // Mate in N moves = very large advantage
    // Positive mate = mate for White, Negative mate = mate for Black
    const mateMoves = Math.abs(evaluation.mate);
    return evaluation.mate > 0 ? 10000 - mateMoves * 100 : -10000 + mateMoves * 100;
  }
  
  return evaluation.cp || 0;
}

/**
 * Calculate centipawn loss
 * CRITICAL: All evaluations are from White's perspective (Stockfish standard)
 * Positive cp = good for White, Negative cp = good for Black
 * 
 * The loss is calculated from the MOVING PLAYER's perspective:
 * - For White: higher (more positive) eval = better, so loss = bestCP - playedCP
 * - For Black: lower (more negative) eval = better, so we need to flip the calculation
 * 
 * @param {Object} evalBestAfter - Best move evaluation (from White's perspective)
 * @param {Object} evalAfter - Played move evaluation (from White's perspective)
 * @param {boolean} isWhiteMove - True if this is a White move, false if Black move
 * @returns {number} - Centipawn loss (always positive, from the moving player's perspective)
 */
function calculateCentipawnLoss(evalBestAfter, evalAfter, isWhiteMove = true) {
  const bestCP = getCentipawnValue(evalBestAfter);
  const playedCP = getCentipawnValue(evalAfter);
  
  // All evaluations are from White's perspective:
  // - Positive cp = good for White, bad for Black
  // - Negative cp = bad for White, good for Black
  
  let loss;
  if (isWhiteMove) {
    // White move: We want higher eval (more positive) = better for White
    // Example: best move gives +100cp, played move gives +50cp
    // Loss = 100 - 50 = 50cp (correct)
    loss = bestCP - playedCP;
  } else {
    // Black move: We want lower eval (more negative) = better for Black
    // From White's perspective: -150cp is better for Black than -100cp
    // Example: best move gives -150cp (very good for Black), played move gives -100cp (worse for Black)
    // For Black: -150 is better than -100, so loss = how much worse -100 is compared to -150
    // Since we're in White's perspective: -150 < -100, so loss = (-100) - (-150) = 50cp
    // But wait: if best is -150 and played is -50 (even worse), loss = (-50) - (-150) = 100cp
    // This works! More negative = better for Black, so loss = playedCP - bestCP
    loss = playedCP - bestCP;
  }
  
  // Loss is always positive (how much worse the played move is)
  // If calculation gives negative, it means played move was actually better (shouldn't happen, but clamp to 0)
  return Math.max(0, loss);
}

/**
 * Format evaluation for display
 * @param {Object} evaluation - { cp: number } or { mate: number }
 * @returns {string} - Formatted string
 */
function formatEvaluation(evaluation) {
  if (!evaluation) return "0.00";
  
  if (isMateScore(evaluation)) {
    const moves = Math.abs(evaluation.mate);
    return evaluation.mate > 0 ? `M${moves}` : `-M${moves}`;
  }
  
  const cp = evaluation.cp || 0;
  const pawns = (cp / 100).toFixed(2);
  return cp >= 0 ? `+${pawns}` : pawns;
}

module.exports = {
  classifyMove,
  CLASSIFICATION_THRESHOLDS,
  isMateScore,
  detectMissedMate,
  detectTacticalSwing,
  getCentipawnValue,
  calculateCentipawnLoss,
  formatEvaluation,
};

