/**
 * Import Puzzle Rush pool from Lichess-style CSV.
 *
 * Usage:
 *   node scripts/import-puzzle-rush.js [/path/to/puzzle_rush_pool.csv]
 *
 * Env:
 *   MONGODB_URI   – required (or .env)
 *   IMPORT_LIMIT  – optional cap (default: no limit)
 *
 * Default file: ../data/puzzle_rush_pool.csv or ~/Downloads/puzzle_rush_pool.csv
 */
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { createReadStream } = require("fs");
const { parse } = require("csv-parse");
const PuzzleRushPuzzle = require("../models/PuzzleRushPuzzle");

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
const IMPORT_LIMIT = process.env.IMPORT_LIMIT
  ? parseInt(process.env.IMPORT_LIMIT, 10)
  : Infinity;

function resolveCsvPath() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const candidates = [
    path.join(__dirname, "../data/puzzle_rush_pool.csv"),
    path.join(process.env.HOME || "", "Downloads/puzzle_rush_pool.csv"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

console.log("🔌 Connecting to MongoDB:", mongoUri.replace(/\/\/.*@/, "//***:***@"));
mongoose
  .connect(mongoUri)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    return importRushPool();
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });

async function importRushPool() {
  const csvFilePath = resolveCsvPath();
  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ CSV not found: ${csvFilePath}`);
    console.error("   Pass path: node scripts/import-puzzle-rush.js /path/to/puzzle_rush_pool.csv");
    process.exit(1);
  }

  console.log(`📖 Streaming: ${csvFilePath}`);
  console.log(
    `📌 Import limit: ${Number.isFinite(IMPORT_LIMIT) ? IMPORT_LIMIT : "none (full file)"}`
  );

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let totalProcessed = 0;
  const batchSize = 2000;
  let batch = [];
  let processingPromise = Promise.resolve();
  let streamEnded = false;

  const parser = parse({
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const processBatch = async (currentBatch) => {
    try {
      if (imported >= IMPORT_LIMIT) return;

      const remaining = IMPORT_LIMIT - imported;
      const batchToProcess =
        remaining < currentBatch.length
          ? currentBatch.slice(0, remaining)
          : currentBatch;
      if (batchToProcess.length === 0) return;

      const operations = batchToProcess.map((puzzle) => ({
        updateOne: {
          filter: { puzzleId: puzzle.puzzleId },
          update: { $set: puzzle },
          upsert: true,
        },
      }));

      const result = await PuzzleRushPuzzle.bulkWrite(operations, {
        ordered: false,
      });
      imported += result.upsertedCount + result.modifiedCount;
      skipped += Math.max(0, result.matchedCount - result.modifiedCount);
      totalProcessed += batchToProcess.length;

      if (totalProcessed % 10000 === 0 || totalProcessed < 5000) {
        console.log(
          `⏳ Progress: ${totalProcessed} processed, ${imported} upserted/updated`
        );
      }

      if (imported >= IMPORT_LIMIT && !streamEnded) {
        console.log(`\n✅ Reached import limit of ${IMPORT_LIMIT}`);
        streamEnded = true;
        stream.destroy();
      }
    } catch (error) {
      console.error(`Error inserting batch:`, error.message);
      errors += currentBatch.length;
    }
  };

  const stream = createReadStream(csvFilePath)
    .pipe(parser)
    .on("data", (record) => {
      if (imported >= IMPORT_LIMIT || streamEnded) return;

      try {
        const fen = String(record.FEN || record.fen || "").trim();
        const moves = String(record.Moves || record.moves || "").trim();
        const puzzleId = String(record.PuzzleId || record.puzzleId || "").trim();
        if (!fen || !moves || !puzzleId) {
          errors++;
          return;
        }

        const themes = record.Themes
          ? String(record.Themes)
              .split(/[\s,]+/)
              .map((t) => t.trim())
              .filter(Boolean)
          : [];

        const openingTags = record.OpeningTags
          ? String(record.OpeningTags)
              .split(/[\s,]+/)
              .map((t) => t.trim())
              .filter(Boolean)
          : [];

        batch.push({
          puzzleId,
          fen,
          moves,
          rating: parseInt(record.Rating, 10) || 1500,
          ratingDeviation: parseInt(record.RatingDeviation, 10) || 0,
          popularity: parseInt(record.Popularity, 10) || 0,
          nbPlays: parseInt(record.NbPlays, 10) || 0,
          themes,
          category: String(record.Category || "").trim(),
          gameUrl: String(record.GameUrl || "").trim(),
          openingTags,
        });

        if (batch.length >= batchSize) {
          const currentBatch = [...batch];
          batch = [];
          processingPromise = processingPromise.then(() =>
            processBatch(currentBatch)
          );
        }
      } catch (error) {
        console.error(`Error processing row:`, error.message);
        errors++;
      }
    })
    .on("end", async () => {
      streamEnded = true;
      await processingPromise;
      if (batch.length > 0 && imported < IMPORT_LIMIT) {
        await processBatch(batch);
      }

      const total = await PuzzleRushPuzzle.countDocuments();
      console.log("\n✅ Puzzle Rush import completed!");
      console.log(`   - Imported/Updated: ${imported}`);
      console.log(`   - Skipped (unchanged): ${skipped}`);
      console.log(`   - Errors: ${errors}`);
      console.log(`   - Total in rush pool: ${total}`);
      process.exit(0);
    })
    .on("error", (error) => {
      console.error("❌ Stream error:", error);
      process.exit(1);
    });
}
