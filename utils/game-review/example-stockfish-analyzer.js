/**
 * Example usage of analyzeMovesWithStockfish
 * 
 * This demonstrates how to use the analyzeMovesWithStockfish function
 * with proper error handling.
 */

const { analyzeMovesWithStockfish } = require("./stockfish-analyzer");
const { cleanup } = require("./engine");

async function exampleUsage() {
  // Example game moves in UCI format
  const moves = [
    "e2e4",  // 1. e4
    "e7e5",  // 1... e5
    "g1f3",  // 2. Nf3
    "b8c6",  // 2... Nc6
    "f1b5",  // 3. Bb5 (Ruy Lopez)
    "a7a6",  // 3... a6
  ];

  try {
    console.log("Starting Stockfish analysis...");
    console.log(`Analyzing ${moves.length} moves...\n`);

    // Analyze with depth 15
    const results = await analyzeMovesWithStockfish(moves, {
      depth: 15,
      movetime: null, // Use depth instead of movetime
      multiPV: 1,
      timeoutPerMove: 10000, // 10 seconds per move max
    });

    console.log("Analysis complete!\n");
    console.log("Results:");
    console.log("=".repeat(80));

    // Display results
    results.forEach((result) => {
      console.log(`\nMove ${result.moveNumber}: ${result.playedMove}`);
      console.log(`  Best Move: ${result.bestMove || "N/A"}`);
      console.log(`  Evaluation Before: ${result.evalBefore} cp`);
      console.log(`  Evaluation After: ${result.evalAfter} cp`);
      console.log(`  Best Move Eval: ${result.evalBestAfter} cp`);
      console.log(`  Centipawn Loss: ${result.centipawnLoss}`);
      console.log(`  Label: ${result.label.toUpperCase()}`);
      console.log(`  Principal Variation: ${result.pv || "N/A"}`);
      
      if (result.error) {
        console.log(`  ⚠️  Error: ${result.error}`);
      }
    });

    console.log("\n" + "=".repeat(80));
    
    // Summary statistics
    const goodMoves = results.filter(r => r.label === "good").length;
    const inaccuracies = results.filter(r => r.label === "inaccuracy").length;
    const mistakes = results.filter(r => r.label === "mistake").length;
    const blunders = results.filter(r => r.label === "blunder").length;
    const timeouts = results.filter(r => r.label === "timeout").length;

    console.log("\nSummary:");
    console.log(`  Good moves: ${goodMoves}`);
    console.log(`  Inaccuracies: ${inaccuracies}`);
    console.log(`  Mistakes: ${mistakes}`);
    console.log(`  Blunders: ${blunders}`);
    if (timeouts > 0) {
      console.log(`  ⚠️  Timeouts: ${timeouts}`);
    }

    const avgLoss = results.reduce((sum, r) => sum + r.centipawnLoss, 0) / results.length;
    console.log(`  Average centipawn loss: ${avgLoss.toFixed(1)}`);

  } catch (error) {
    console.error("Fatal error during analysis:", error);
    console.error("Stack:", error.stack);
  } finally {
    // Cleanup engine when done
    cleanup();
    console.log("\nEngine cleaned up.");
  }
}

// Example with movetime instead of depth (faster but less accurate)
async function exampleWithMovetime() {
  const moves = ["e2e4", "e7e5", "g1f3"];

  try {
    console.log("\n\nExample with movetime (faster analysis):");
    const results = await analyzeMovesWithStockfish(moves, {
      depth: null,
      movetime: 2000, // 2 seconds per position
      timeoutPerMove: 5000,
    });

    results.forEach((result) => {
      console.log(`Move ${result.moveNumber}: ${result.playedMove} - ${result.label}`);
    });
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    cleanup();
  }
}

// Example with error handling for individual moves
async function exampleWithErrorHandling() {
  const moves = ["e2e4", "e7e5", "invalidmove", "g1f3"]; // Invalid move will cause error

  try {
    const results = await analyzeMovesWithStockfish(moves, {
      depth: 10,
      timeoutPerMove: 5000,
    });

    // Check for errors in results
    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
      console.log("\n⚠️  Some moves failed to analyze:");
      errors.forEach(r => {
        console.log(`  Move ${r.moveNumber}: ${r.error}`);
      });
    }

    // Process successful results
    const successful = results.filter(r => !r.error);
    console.log(`\nSuccessfully analyzed ${successful.length} out of ${results.length} moves`);
  } catch (error) {
    console.error("Fatal error:", error.message);
  } finally {
    cleanup();
  }
}

// Run examples if this file is executed directly
if (require.main === module) {
  (async () => {
    await exampleUsage();
    // Uncomment to run other examples:
    // await exampleWithMovetime();
    // await exampleWithErrorHandling();
  })();
}

module.exports = {
  exampleUsage,
  exampleWithMovetime,
  exampleWithErrorHandling,
};


