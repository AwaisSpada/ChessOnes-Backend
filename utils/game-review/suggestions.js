/**
 * Suggestions Generator Module
 * 
 * Generates actionable suggestions based on game review analysis.
 */

/**
 * Generate suggestions from review data
 * @param {Object} reviewData - Complete review object
 * @returns {Array} - Array of suggestion objects
 */
function generateSuggestions(reviewData) {
  const suggestions = [];
  const { moves = [], summary = {} } = reviewData;

  // Count move classifications
  const blunders = moves.filter(m => m.label === "blunder").length;
  const mistakes = moves.filter(m => m.label === "mistake").length;
  const inaccuracies = moves.filter(m => m.label === "inaccuracy").length;
  const missedMates = moves.filter(m => m.missedMate).length;
  const tacticalSwings = moves.filter(m => m.tacticalSwing).length;

  // Opening suggestions
  if (moves.length > 0 && moves[0].centipawnLoss >= 50) {
    suggestions.push({
      type: "opening",
      priority: "high",
      title: "Study Opening Theory",
      description: "Your opening moves show room for improvement. Consider studying common opening principles and main lines.",
      action: "Review opening books or videos for your chosen opening.",
    });
  }

  // Tactical awareness
  if (missedMates > 0) {
    suggestions.push({
      type: "tactics",
      priority: "high",
      title: "Practice Tactical Puzzles",
      description: `You missed ${missedMates} mate opportunity${missedMates > 1 ? "ies" : ""} in this game. Regular tactical training will help you spot these patterns.`,
      action: "Solve 10-20 tactical puzzles daily focusing on checkmate patterns.",
    });
  }

  if (tacticalSwings > 0) {
    suggestions.push({
      type: "tactics",
      priority: "medium",
      title: "Improve Tactical Awareness",
      description: `This game had ${tacticalSwings} significant tactical swing${tacticalSwings > 1 ? "s" : ""}. Work on calculating variations more carefully.`,
      action: "Practice calculation exercises and always look for candidate moves.",
    });
  }

  // Accuracy suggestions
  if (blunders > 0) {
    suggestions.push({
      type: "accuracy",
      priority: "high",
      title: "Reduce Blunders",
      description: `You made ${blunders} blunder${blunders > 1 ? "s" : ""} in this game. Before each move, check for checks, captures, and threats.`,
      action: "Use a pre-move checklist: 1) Is my king safe? 2) Are my pieces safe? 3) Can I improve my position?",
    });
  }

  if (mistakes > 0 && blunders === 0) {
    suggestions.push({
      type: "accuracy",
      priority: "medium",
      title: "Improve Move Quality",
      description: `You made ${mistakes} mistake${mistakes > 1 ? "s" : ""}. Focus on finding better candidate moves.`,
      action: "Spend more time analyzing candidate moves before committing.",
    });
  }

  // Time management
  if (summary.averageMoveTime && summary.averageMoveTime < 5000) {
    suggestions.push({
      type: "time",
      priority: "low",
      title: "Use Time More Effectively",
      description: "You're playing moves quickly. Use your time to calculate variations, especially in complex positions.",
      action: "Allocate more time for critical positions and tactical sequences.",
    });
  }

  // Endgame suggestions
  if (summary.endgame && summary.endgame.phase === "endgame") {
    const endgameAccuracy = summary.endgame.accuracy || 0;
    if (endgameAccuracy < 80) {
      suggestions.push({
        type: "endgame",
        priority: "medium",
        title: "Study Endgame Theory",
        description: "Your endgame play needs improvement. Endgames have clear principles and techniques.",
        action: "Study basic endgame patterns: king and pawn, rook endgames, and basic checkmates.",
      });
    }
  }

  // Pattern recognition
  const commonMistakes = findCommonMistakePatterns(moves);
  if (commonMistakes.length > 0) {
    suggestions.push({
      type: "pattern",
      priority: "medium",
      title: "Identify Recurring Patterns",
      description: `You tend to make similar mistakes. Focus on: ${commonMistakes.join(", ")}`,
      action: "Review your games to identify patterns and work on specific weaknesses.",
    });
  }

  // Overall improvement
  const accuracy = summary.accuracy || 0;
  if (accuracy < 70) {
    suggestions.push({
      type: "general",
      priority: "high",
      title: "Focus on Fundamentals",
      description: "Work on basic chess principles: piece activity, king safety, pawn structure, and tactical awareness.",
      action: "Study fundamental chess concepts and practice regularly.",
    });
  }

  return suggestions;
}

/**
 * Find common mistake patterns
 * @param {Array} moves - Array of move objects
 * @returns {Array} - Array of pattern descriptions
 */
function findCommonMistakePatterns(moves) {
  const patterns = [];
  
  // Check for pattern: mistakes in similar positions
  const mistakePositions = moves
    .filter(m => m.label === "mistake" || m.label === "blunder")
    .map(m => m.moveNumber);
  
  if (mistakePositions.length > 2) {
    // Check if mistakes cluster in opening/middlegame/endgame
    const openingMistakes = mistakePositions.filter(n => n <= 10).length;
    const middlegameMistakes = mistakePositions.filter(n => n > 10 && n <= 30).length;
    const endgameMistakes = mistakePositions.filter(n => n > 30).length;
    
    if (openingMistakes > 2) {
      patterns.push("opening mistakes");
    }
    if (middlegameMistakes > 2) {
      patterns.push("middlegame mistakes");
    }
    if (endgameMistakes > 2) {
      patterns.push("endgame mistakes");
    }
  }
  
  return patterns;
}

module.exports = {
  generateSuggestions,
};


