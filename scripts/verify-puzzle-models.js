/**
 * Puzzle Model Sanity Check Script
 * 
 * This script verifies that the updated Puzzle and PuzzleAttempt models
 * maintain backward compatibility and work correctly with existing data.
 * 
 * Run: node scripts/verify-puzzle-models.js
 */

const mongoose = require("mongoose");
const Puzzle = require("../models/Puzzle");
const PuzzleAttempt = require("../models/PuzzleAttempt");

// Color codes for console output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

const log = {
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
};

let testsPassed = 0;
let testsFailed = 0;

/**
 * Test helper function
 */
async function test(description, testFn) {
  try {
    await testFn();
    log.success(description);
    testsPassed++;
  } catch (error) {
    log.error(`${description}: ${error.message}`);
    testsFailed++;
  }
}

/**
 * Main test suite
 */
async function runTests() {
  console.log("\n" + "=".repeat(60));
  console.log("Puzzle Model Sanity Check");
  console.log("=".repeat(60) + "\n");

  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
    log.info(`Connecting to MongoDB: ${mongoUri}`);
    await mongoose.connect(mongoUri);
    log.success("Connected to MongoDB");

    // Test 1: Verify Puzzle schema has required fields
    await test("Puzzle schema has required 'moves' field", () => {
      const schema = Puzzle.schema.obj;
      if (!schema.moves || !schema.moves.required) {
        throw new Error("moves field is not required");
      }
    });

    // Test 2: Verify Puzzle schema has new optional fields
    await test("Puzzle schema has optional 'solutionTree' field", () => {
      const schema = Puzzle.schema.obj;
      if (!schema.solutionTree) {
        throw new Error("solutionTree field is missing");
      }
      if (schema.solutionTree.required === true) {
        throw new Error("solutionTree should be optional");
      }
    });

    await test("Puzzle schema has 'popularityScore' field with default", () => {
      const schema = Puzzle.schema.obj;
      if (!schema.popularityScore) {
        throw new Error("popularityScore field is missing");
      }
      if (schema.popularityScore.default !== 0) {
        throw new Error("popularityScore default should be 0");
      }
    });

    await test("Puzzle schema has 'averageSolveTime' field with default", () => {
      const schema = Puzzle.schema.obj;
      if (!schema.averageSolveTime) {
        throw new Error("averageSolveTime field is missing");
      }
      if (schema.averageSolveTime.default !== 0) {
        throw new Error("averageSolveTime default should be 0");
      }
    });

    // Test 3: Verify PuzzleAttempt schema has required fields
    await test("PuzzleAttempt schema has required fields", () => {
      const schema = PuzzleAttempt.schema.obj;
      if (!schema.user || !schema.user.required) {
        throw new Error("user field is not required");
      }
      if (!schema.puzzle || !schema.puzzle.required) {
        throw new Error("puzzle field is not required");
      }
    });

    // Test 4: Verify PuzzleAttempt schema has new optional field
    await test("PuzzleAttempt schema has optional 'attemptHistory' field", () => {
      const schema = PuzzleAttempt.schema.obj;
      if (!schema.attemptHistory) {
        throw new Error("attemptHistory field is missing");
      }
      if (schema.attemptHistory.required === true) {
        throw new Error("attemptHistory should be optional");
      }
    });

    // Test 5: Create a puzzle without new fields (backward compatibility)
    await test("Can create puzzle without new fields", async () => {
      const testPuzzle = new Puzzle({
        puzzleId: `test-${Date.now()}`,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: "e2e4 e7e5",
        rating: 1500,
      });
      
      // Validate without saving
      const error = testPuzzle.validateSync();
      if (error) {
        throw new Error(`Validation failed: ${error.message}`);
      }
    });

    // Test 6: Create a puzzle with new fields
    await test("Can create puzzle with new fields", async () => {
      const testPuzzle = new Puzzle({
        puzzleId: `test-new-${Date.now()}`,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: "e2e4 e7e5",
        rating: 1500,
        solutionTree: [
          { move: "e2e4", reply: "e7e5" },
          { move: "d2d4", reply: "d7d5" }
        ],
        popularityScore: 100,
        averageSolveTime: 45,
      });
      
      // Validate without saving
      const error = testPuzzle.validateSync();
      if (error) {
        throw new Error(`Validation failed: ${error.message}`);
      }
    });

    // Test 7: Verify difficulty calculation still works
    await test("Difficulty calculation pre-save hook works", async () => {
      const testPuzzle = new Puzzle({
        puzzleId: `test-difficulty-${Date.now()}`,
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        moves: "e2e4 e7e5",
        rating: 1800,
      });
      
      // Trigger pre-save hook
      await testPuzzle.validate();
      
      if (testPuzzle.difficulty !== "MEDIUM") {
        throw new Error(`Expected difficulty MEDIUM for rating 1800, got ${testPuzzle.difficulty}`);
      }
    });

    // Test 8: Create puzzle attempt without new fields
    await test("Can create puzzle attempt without new fields", async () => {
      const testAttempt = new PuzzleAttempt({
        user: new mongoose.Types.ObjectId(),
        puzzle: new mongoose.Types.ObjectId(),
        solved: true,
        attempts: 1,
        timeSpent: 45,
        ratingChange: 10,
      });
      
      // Validate without saving
      const error = testAttempt.validateSync();
      if (error) {
        throw new Error(`Validation failed: ${error.message}`);
      }
    });

    // Test 9: Create puzzle attempt with new fields
    await test("Can create puzzle attempt with new fields", async () => {
      const testAttempt = new PuzzleAttempt({
        user: new mongoose.Types.ObjectId(),
        puzzle: new mongoose.Types.ObjectId(),
        solved: true,
        attempts: 2,
        timeSpent: 90,
        ratingChange: 10,
        attemptHistory: [
          {
            attemptIndex: 1,
            movesPlayed: ["e2e4", "e7e5"],
            solved: false,
            timeSpent: 45,
            usedHints: 1,
          },
          {
            attemptIndex: 2,
            movesPlayed: ["e2e4", "e7e5", "d2d4"],
            solved: true,
            timeSpent: 45,
            usedHints: 0,
          },
        ],
      });
      
      // Validate without saving
      const error = testAttempt.validateSync();
      if (error) {
        throw new Error(`Validation failed: ${error.message}`);
      }
    });

    // Test 10: Check if existing puzzles in database still work
    await test("Existing puzzles in database are still valid", async () => {
      const count = await Puzzle.countDocuments();
      log.info(`Found ${count} existing puzzles in database`);
      
      if (count > 0) {
        const sample = await Puzzle.findOne().lean();
        if (!sample.moves) {
          throw new Error("Existing puzzle missing 'moves' field");
        }
        log.info(`Sample puzzle: ${sample.puzzleId} (rating: ${sample.rating})`);
      } else {
        log.warn("No existing puzzles found in database");
      }
    });

    // Test 11: Check if existing attempts in database still work
    await test("Existing puzzle attempts in database are still valid", async () => {
      const count = await PuzzleAttempt.countDocuments();
      log.info(`Found ${count} existing puzzle attempts in database`);
      
      if (count > 0) {
        const sample = await PuzzleAttempt.findOne().lean();
        if (sample.solved === undefined) {
          throw new Error("Existing attempt missing 'solved' field");
        }
        log.info(`Sample attempt: solved=${sample.solved}, attempts=${sample.attempts}`);
      } else {
        log.warn("No existing puzzle attempts found in database");
      }
    });

    // Test 12: Verify indexes
    await test("Puzzle indexes are correct", async () => {
      const indexes = await Puzzle.collection.getIndexes();
      const indexNames = Object.keys(indexes);
      
      log.info(`Puzzle indexes: ${indexNames.join(", ")}`);
      
      // Check for required indexes
      const hasRatingIndex = indexNames.some(name => name.includes("rating"));
      const hasDifficultyIndex = indexNames.some(name => name.includes("difficulty"));
      
      if (!hasRatingIndex) {
        throw new Error("Missing rating index");
      }
      if (!hasDifficultyIndex) {
        throw new Error("Missing difficulty index");
      }
    });

    await test("PuzzleAttempt indexes are correct", async () => {
      const indexes = await PuzzleAttempt.collection.getIndexes();
      const indexNames = Object.keys(indexes);
      
      log.info(`PuzzleAttempt indexes: ${indexNames.join(", ")}`);
      
      // Check for unique compound index
      const hasUniqueIndex = indexNames.some(name => 
        name.includes("user") && name.includes("puzzle")
      );
      
      if (!hasUniqueIndex) {
        throw new Error("Missing unique compound index on user and puzzle");
      }
    });

  } catch (error) {
    log.error(`Test suite error: ${error.message}`);
    testsFailed++;
  } finally {
    // Disconnect from MongoDB
    await mongoose.disconnect();
    log.success("Disconnected from MongoDB");
  }

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("Test Summary");
  console.log("=".repeat(60));
  console.log(`${colors.green}Passed: ${testsPassed}${colors.reset}`);
  console.log(`${colors.red}Failed: ${testsFailed}${colors.reset}`);
  console.log("=".repeat(60) + "\n");

  if (testsFailed === 0) {
    log.success("All tests passed! Models are backward compatible.");
    process.exit(0);
  } else {
    log.error(`${testsFailed} test(s) failed. Please review the errors above.`);
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  log.error(`Fatal error: ${error.message}`);
  process.exit(1);
});



