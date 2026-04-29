/**
 * Move-by-Move Suggestions Generator
 * 
 * Generates contextual suggestions/comments for each move, similar to Chess.com
 */

/**
 * Convert UCI move to readable format (e.g., e2e4 -> e4)
 * @param {string} uciMove - UCI format move (e.g., "e2e4")
 * @returns {string} - Readable move (e.g., "e4")
 */
function formatMoveForDisplay(uciMove) {
  if (!uciMove || uciMove.length < 4) return uciMove;
  
  // Extract destination square (last 2 characters, or last 3 if promotion)
  if (uciMove.length === 5) {
    // Promotion move (e.g., e7e8q)
    const promotion = uciMove[4].toUpperCase();
    return `${uciMove.substring(2, 4)}=${promotion}`;
  }
  
  return uciMove.substring(2, 4);
}

/**
 * Format principal variation for display
 * @param {Array} pv - Principal variation array from Stockfish
 * @param {number} maxMoves - Maximum moves to show
 * @returns {string} - Formatted PV string
 */
function formatPrincipalVariation(pv, maxMoves = 3) {
  if (!pv || pv.length === 0) return "";
  
  const moves = pv.slice(0, maxMoves).map(m => formatMoveForDisplay(m));
  return moves.join(" ");
}

/**
 * Generate suggestion/comment for a specific move (balanced - concise but informative)
 * @param {Object} moveData - Move analysis data
 * @param {number} moveIndex - Index of move in game (0-based)
 * @param {Array} allMoves - All moves in the game
 * @returns {string} - Suggestion/comment text
 */
function generateMoveSuggestion(moveData, moveIndex, allMoves) {
  const {
    playedMove,
    bestMove,
    label,
    centipawnLoss,
    missedMate,
    tacticalSwing,
    pv,
    isWhiteMove,
  } = moveData;

  const playedMoveFormatted = formatMoveForDisplay(playedMove);
  const bestMoveFormatted = bestMove ? formatMoveForDisplay(bestMove) : null;
  const pvFormatted = formatPrincipalVariation(pv || [], 2);
  const playerName = isWhiteMove ? "White" : "Black";

  // Book move (opening theory)
  if (label === "book") {
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, a well-known opening move. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, following established opening theory.`;
  }

  // Best move
  if (label === "best") {
    return `${playerName} played ${playedMoveFormatted}, which is the engine's best move.${pvFormatted ? ` Continuation: ${pvFormatted}` : ""}`;
  }

  // Brilliant move
  if (label === "brilliant") {
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, a brilliant creative move. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, a brilliant move that maintains the advantage.`;
  }

  // Great move
  if (label === "great") {
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, a great move. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, a great move very close to the engine's best line.`;
  }

  // Excellent move
  if (label === "excellent") {
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, an excellent move. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, an excellent move that maintains a strong position.`;
  }

  // Good move
  if (label === "good") {
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, a good move. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, a good move that keeps the position balanced.`;
  }

  // Inaccuracy
  if (label === "inaccuracy") {
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, an inaccuracy. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, an inaccuracy that slightly weakens the position.`;
  }

  // Mistake
  if (label === "mistake") {
    if (missedMate && bestMove) {
      return `${playerName} played ${playedMoveFormatted}, a mistake. Missed checkmate with ${bestMoveFormatted}.`;
    }
    if (tacticalSwing && bestMove) {
      return `${playerName} played ${playedMoveFormatted}, a mistake that led to a significant change in evaluation. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, a mistake. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, a mistake that gives the opponent a better position.`;
  }

  // Blunder
  if (label === "blunder") {
    if (missedMate && bestMove) {
      return `${playerName} played ${playedMoveFormatted}, a blunder. Missed checkmate with ${bestMoveFormatted}.`;
    }
    if (bestMove && bestMove !== playedMove) {
      return `${playerName} played ${playedMoveFormatted}, a blunder. The engine suggests ${bestMoveFormatted} as the best move.`;
    }
    return `${playerName} played ${playedMoveFormatted}, a blunder that significantly damages the position.`;
  }

  // Default fallback
  if (bestMove && bestMove !== playedMove) {
    return `${playerName} played ${playedMoveFormatted}. The engine suggests ${bestMoveFormatted} as the best move.`;
  }
  return `${playerName} played ${playedMoveFormatted}.`;
}

/**
 * Generate opening-specific suggestions
 * @param {Object} moveData - Move analysis data
 * @param {number} moveIndex - Index of move in game
 * @returns {string} - Opening-specific comment
 */
function getOpeningSuggestion(moveData, moveIndex) {
  if (moveIndex >= 10) return null;

  const { label, centipawnLoss, bestMove } = moveData;

  if (label === "book" || label === "best") {
    return null; // Already handled
  }

  if (label === "inaccuracy" || label === "mistake" || label === "blunder") {
    return `In the opening, it's important to develop pieces, control the center, and ensure king safety. ${bestMove ? `Consider ${bestMove} instead.` : ""}`;
  }

  return null;
}

/**
 * Generate endgame-specific suggestions
 * @param {Object} moveData - Move analysis data
 * @param {number} moveIndex - Index of move in game
 * @param {number} totalMoves - Total moves in game
 * @returns {string} - Endgame-specific comment
 */
function getEndgameSuggestion(moveData, moveIndex, totalMoves) {
  if (moveIndex < totalMoves - 20) return null; // Not in endgame yet

  const { label, centipawnLoss, bestMove } = moveData;

  if (label === "best" || label === "excellent" || label === "great") {
    return null; // Already handled
  }

  if (label === "blunder" || label === "mistake") {
    return `In the endgame, precision is crucial. ${bestMove ? `The best move ${bestMove} would have been more accurate.` : "Calculate more carefully in endgame positions."}`;
  }

  return null;
}

/**
 * Generate tactical suggestion
 * @param {Object} moveData - Move analysis data
 * @returns {string} - Tactical comment
 */
function getTacticalSuggestion(moveData) {
  const { tacticalSwing, missedMate, label } = moveData;

  if (missedMate) {
    return "Always look for checkmate patterns! Check for back-rank mates, discovered attacks, and other tactical motifs.";
  }

  if (tacticalSwing && (label === "mistake" || label === "blunder")) {
    return "This position had tactical complications. Before moving, calculate all checks, captures, and threats (CCT).";
  }

  return null;
}

/**
 * Generate comprehensive move suggestion with Stockfish engine recommendations (balanced style)
 * @param {Object} moveData - Move analysis data
 * @param {number} moveIndex - Index of move in game (0-based)
 * @param {Array} allMoves - All moves in the game
 * @returns {Object} - { comment: string, tip: string, bestMove: string, engineContinuation: string }
 */
function generateComprehensiveMoveSuggestion(moveData, moveIndex, allMoves) {
  const baseComment = generateMoveSuggestion(moveData, moveIndex, allMoves);
  
  // Format best move and engine continuation
  const bestMoveFormatted = moveData.bestMove ? formatMoveForDisplay(moveData.bestMove) : null;
  const engineContinuation = formatPrincipalVariation(moveData.pv || [], 2);

  // Simple tip only for significant errors
  let tip = null;
  if (moveData.label === "blunder" && moveData.missedMate) {
    tip = "Always look for checkmate patterns.";
  } else if (moveData.label === "blunder" || moveData.label === "mistake") {
    tip = "Calculate variations more carefully.";
  }

  return {
    comment: baseComment.trim(),
    tip: tip,
    bestMove: bestMoveFormatted,
    engineContinuation: engineContinuation,
    playedMove: formatMoveForDisplay(moveData.playedMove),
  };
}

module.exports = {
  generateMoveSuggestion,
  generateComprehensiveMoveSuggestion,
  getOpeningSuggestion,
  getEndgameSuggestion,
  getTacticalSuggestion,
};

