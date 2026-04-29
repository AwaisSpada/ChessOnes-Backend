require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { createReadStream } = require("fs");
const { parse } = require("csv-parse");
const Puzzle = require("../models/Puzzle");

// Connect to MongoDB
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
console.log("🔌 Connecting to MongoDB:", mongoUri.replace(/\/\/.*@/, "//***:***@")); // Hide credentials
mongoose
  .connect(mongoUri)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    importPuzzles();
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });

async function importPuzzles() {
  try {
    const csvFilePath = path.join(__dirname, "../data/lichess_db_puzzle.csv");
    
    console.log("📖 Reading CSV file (streaming mode)...");
    console.log("📌 Import limit: 10,000 puzzles");
    
    const IMPORT_LIMIT = 10000;
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let totalProcessed = 0;
    const batchSize = 1000;
    let batch = [];
    let processingPromise = Promise.resolve();
    let streamEnded = false;

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const processBatch = async (currentBatch) => {
      try {
        // Check if we've reached the limit
        if (imported >= IMPORT_LIMIT) {
          return;
        }

        // Limit the batch to not exceed IMPORT_LIMIT
        const remaining = IMPORT_LIMIT - imported;
        const batchToProcess = remaining < currentBatch.length 
          ? currentBatch.slice(0, remaining) 
          : currentBatch;

        if (batchToProcess.length === 0) {
          return;
        }

        const operations = batchToProcess.map((puzzle) => ({
          updateOne: {
            filter: { puzzleId: puzzle.puzzleId },
            update: { $set: puzzle },
            upsert: true,
          },
        }));

        const result = await Puzzle.bulkWrite(operations);
        imported += result.upsertedCount + result.modifiedCount;
        skipped += result.matchedCount - result.modifiedCount;
        totalProcessed += batchToProcess.length;

        if (totalProcessed % 1000 === 0) {
          console.log(`⏳ Progress: ${totalProcessed} puzzles processed, ${imported} imported`);
        }

        // Check if we've reached the limit
        if (imported >= IMPORT_LIMIT) {
          console.log(`\n✅ Reached import limit of ${IMPORT_LIMIT} puzzles`);
          if (!streamEnded) {
            streamEnded = true;
            stream.destroy(); // Stop reading the CSV
          }
        }
      } catch (error) {
        console.error(`Error inserting batch:`, error.message);
        errors += currentBatch.length;
      }
    };

    const stream = createReadStream(csvFilePath)
      .pipe(parser)
      .on("data", (record) => {
        // Stop processing if we've reached the limit
        if (imported >= IMPORT_LIMIT || streamEnded) {
          return;
        }

        try {
          // Parse themes (space-separated string)
          const themes = record.Themes
            ? record.Themes.split(" ").filter((t) => t.trim())
            : [];

          // Parse opening tags (comma-separated string)
          const openingTags = record.OpeningTags
            ? record.OpeningTags.split(",").map((t) => t.trim()).filter((t) => t)
            : [];

          const puzzle = {
            puzzleId: record.PuzzleId,
            fen: record.FEN,
            moves: record.Moves,
            rating: parseInt(record.Rating) || 1500,
            ratingDeviation: parseInt(record.RatingDeviation) || 0,
            popularity: parseInt(record.Popularity) || 0,
            nbPlays: parseInt(record.NbPlays) || 0,
            themes: themes,
            gameUrl: record.GameUrl || "",
            openingTags: openingTags,
          };

          batch.push(puzzle);

          // Process batch when it reaches batchSize
          if (batch.length >= batchSize) {
            const currentBatch = [...batch];
            batch = []; // Clear batch immediately
            
            // Chain batch processing to avoid overwhelming the database
            processingPromise = processingPromise.then(() => processBatch(currentBatch));
          }
        } catch (error) {
          console.error(`Error processing puzzle ${record.PuzzleId}:`, error.message);
          errors++;
        }
      })
      .on("end", async () => {
        streamEnded = true;
        // Wait for all batches to complete
        await processingPromise;
        
        // Process remaining batch (if we haven't reached the limit)
        if (batch.length > 0 && imported < IMPORT_LIMIT) {
          await processBatch(batch);
        }

        console.log("\n✅ Import completed!");
        console.log(`📊 Statistics:`);
        console.log(`   - Imported/Updated: ${imported}`);
        console.log(`   - Skipped (already exists): ${skipped}`);
        console.log(`   - Errors: ${errors}`);
        console.log(`   - Total processed: ${totalProcessed}`);

        // Get some stats
        const totalPuzzles = await Puzzle.countDocuments();
        const avgRating = await Puzzle.aggregate([
          { $group: { _id: null, avgRating: { $avg: "$rating" } } },
        ]);
        console.log(`\n📈 Database Stats:`);
        console.log(`   - Total puzzles in DB: ${totalPuzzles}`);
        if (avgRating[0]) {
          console.log(`   - Average rating: ${Math.round(avgRating[0].avgRating)}`);
        }

        process.exit(0);
      })
      .on("error", (error) => {
        console.error("❌ Stream error:", error);
        process.exit(1);
      });
  } catch (error) {
    console.error("❌ Import error:", error);
    process.exit(1);
  }
}

