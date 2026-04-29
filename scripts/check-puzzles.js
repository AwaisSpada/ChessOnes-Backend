require("dotenv").config();
const mongoose = require("mongoose");
const Puzzle = require("../models/Puzzle");

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/chessones")
  .then(async () => {
    console.log("✅ Connected to MongoDB");
    
    const count = await Puzzle.countDocuments();
    console.log(`\n📊 Total puzzles in database: ${count}`);
    
    if (count > 0) {
      const sample = await Puzzle.findOne().select("puzzleId fen rating themes");
      console.log("\n📝 Sample puzzle:");
      console.log(JSON.stringify(sample, null, 2));
      
      const avgRating = await Puzzle.aggregate([
        { $group: { _id: null, avgRating: { $avg: "$rating" } } },
      ]);
      if (avgRating[0]) {
        console.log(`\n📈 Average rating: ${Math.round(avgRating[0].avgRating)}`);
      }
    } else {
      console.log("\n⚠️  Database is empty. Please run the import script:");
      console.log("   node scripts/import-puzzles.js");
    }
    
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });




