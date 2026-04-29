require("dotenv").config();
const mongoose = require("mongoose");
const Puzzle = require("../models/Puzzle");
const PuzzleAttempt = require("../models/PuzzleAttempt");

// Connect to MongoDB
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
console.log("🔌 Connecting to MongoDB:", mongoUri.replace(/\/\/.*@/, "//***:***@")); // Hide credentials

mongoose
  .connect(mongoUri)
  .then(async () => {
    console.log("✅ Connected to MongoDB");
    
    try {
      // Count puzzles before deletion
      const puzzleCount = await Puzzle.countDocuments();
      const attemptCount = await PuzzleAttempt.countDocuments();
      
      console.log(`\n📊 Current database state:`);
      console.log(`   Puzzles: ${puzzleCount}`);
      console.log(`   Puzzle Attempts: ${attemptCount}`);
      
      if (puzzleCount === 0 && attemptCount === 0) {
        console.log("\n✅ Database is already empty. Nothing to delete.");
        process.exit(0);
      }
      
      // Delete all puzzle attempts first (they reference puzzles)
      if (attemptCount > 0) {
        console.log("\n🗑️  Deleting puzzle attempts...");
        const deleteAttemptsResult = await PuzzleAttempt.deleteMany({});
        console.log(`   ✅ Deleted ${deleteAttemptsResult.deletedCount} puzzle attempts`);
      }
      
      // Delete all puzzles
      if (puzzleCount > 0) {
        console.log("\n🗑️  Deleting puzzles...");
        const deletePuzzlesResult = await Puzzle.deleteMany({});
        console.log(`   ✅ Deleted ${deletePuzzlesResult.deletedCount} puzzles`);
      }
      
      // Verify deletion
      const remainingPuzzles = await Puzzle.countDocuments();
      const remainingAttempts = await PuzzleAttempt.countDocuments();
      
      console.log(`\n✅ Deletion complete!`);
      console.log(`   Remaining puzzles: ${remainingPuzzles}`);
      console.log(`   Remaining attempts: ${remainingAttempts}`);
      
      process.exit(0);
    } catch (error) {
      console.error("❌ Error deleting puzzles:", error);
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });




