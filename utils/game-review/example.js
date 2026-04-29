/**
 * Example Usage of Game Review Processor
 * 
 * This file demonstrates how to use the game review system.
 */

const { generateGameReview } = require("./index");

async function exampleUsage() {
  console.log("=== Game Review Processor Example ===\n");

  // Example 1: Review a game using UCI moves
  console.log("Example 1: Analyzing game with UCI moves");
  console.log("----------------------------------------");
  
  const moves = [
    "e2e4", "e7e5", "g1f3", "b8c6", "f1b5", // Ruy Lopez opening
    "a7a6", "b5a4", "b7b5", "a4b3", "d7d6",
    "c2c3", "c8g4", "d2d4", "g4f3", "d1f3",
    "e5d4", "c3d4", "c6d4", "f3d1", "d4f3",
    "d1f3", "d8f6", "f3f6", "g7f6", "e1g1",
    "f8e7", "b1d2", "e8g8", "d2f3", "e7f6",
    "f1e1", "f8e8", "f3g5", "f6g5", "c1g5",
    "f6f5", "e4f5", "e8e1", "d1e1", "g8f7",
    "g5f6", "f7g8", "f6g7", "g8f7", "g7h8",
  ];

  try {
    const review = await generateGameReview({
      moves: moves,
      depth: 12, // Lower depth for faster example
    });

    console.log(`\nReview Summary:`);
    console.log(`- Total Moves: ${review.overview.totalMoves}`);
    console.log(`- Accuracy: ${review.overview.accuracy}%`);
    console.log(`- Quality: ${review.overview.quality}`);
    console.log(`- Blunders: ${review.summary.blunders}`);
    console.log(`- Mistakes: ${review.summary.mistakes}`);
    console.log(`- Inaccuracies: ${review.summary.inaccuracies}`);
    console.log(`- Good Moves: ${review.summary.goodMoves}`);
    
    console.log(`\nOpening: ${review.opening.name} (${review.opening.eco || "N/A"})`);
    console.log(`Endgame Phase: ${review.endgame.phase}`);
    
    console.log(`\nTop Suggestions:`);
    review.suggestions.slice(0, 3).forEach((suggestion, i) => {
      console.log(`${i + 1}. [${suggestion.priority}] ${suggestion.title}`);
      console.log(`   ${suggestion.description}`);
    });

    console.log(`\nSample Moves Analysis (first 5 moves):`);
    review.moves.slice(0, 5).forEach(move => {
      console.log(`Move ${move.moveNumber}: ${move.playedMove}`);
      console.log(`  Best: ${move.bestMove || "N/A"}`);
      console.log(`  Eval: ${move.evalBefore} → ${move.evalAfter}`);
      console.log(`  Loss: ${move.centipawnLoss}cp (${move.label})`);
      if (move.missedMate) console.log(`  ⚠️  Missed mate opportunity!`);
      if (move.tacticalSwing) console.log(`  ⚡ Tactical swing detected`);
      console.log("");
    });

  } catch (error) {
    console.error("Error generating review:", error.message);
  }

  // Example 2: Review using PGN
  console.log("\n\nExample 2: Analyzing game with PGN");
  console.log("----------------------------------------");
  
  const pgn = `
    1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7
    6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7
  `;

  try {
    const reviewFromPGN = await generateGameReview({
      optionalPgn: pgn,
      depth: 10, // Lower depth for PGN example
    });

    console.log(`\nReview from PGN:`);
    console.log(`- Moves analyzed: ${reviewFromPGN.overview.totalMoves}`);
    console.log(`- Accuracy: ${reviewFromPGN.overview.accuracy}%`);
    
  } catch (error) {
    console.error("Error generating review from PGN:", error.message);
    console.log("Note: PGN parsing may need SAN->UCI conversion");
  }

  // Cleanup
  const { cleanup } = require("./index");
  cleanup();
  console.log("\n\nExample complete!");
}

// Run example if called directly
if (require.main === module) {
  exampleUsage().catch(console.error);
}

module.exports = { exampleUsage };


