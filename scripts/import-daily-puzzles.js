/**
 * Import Daily Puzzle pool from Excel (.xlsx).
 *
 * Usage:
 *   node scripts/import-daily-puzzles.js [path/to/file.xlsx]
 *
 * Default file: Daily Puzzles.xlsx (project root)
 *
 * Supported column names (case-insensitive):
 *   PuzzleId / ID / sourceId
 *   FEN / fen
 *   Moves / moves
 *   Rating / rating (optional)
 *   Themes / themes (optional, space or comma separated)
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const XLSX = require("xlsx");
const DailyPuzzle = require("../models/DailyPuzzle");

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function mapRow(row, index) {
  const keys = {};
  for (const [k, v] of Object.entries(row)) {
    keys[normalizeKey(k)] = v;
  }

  const sourceId = String(
    keys.puzzleid ||
      keys.id ||
      keys.sourceid ||
      keys.puzzle_id ||
      `daily-${index + 1}`
  ).trim();

  const fen = String(keys.fen || "").trim();
  const moves = String(keys.moves || "").trim();
  const rating = parseInt(keys.rating, 10) || 1500;

  let themes = [];
  const rawThemes = keys.themes || keys.theme || "";
  if (rawThemes) {
    themes = String(rawThemes)
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  if (!fen || !moves) return null;

  return {
    sourceId,
    fen,
    moves,
    rating,
    themes,
    importOrder: index,
  };
}

async function run() {
  const fileArg = process.argv[2];
  const filePath = fileArg
    ? path.resolve(fileArg)
    : path.join(__dirname, "../Daily Puzzles.xlsx");

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    console.error('   Place your Excel file at ChessOnes-Backend/Daily Puzzles.xlsx');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("✅ Connected to MongoDB");
  console.log(`📖 Reading: ${filePath}`);

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

  const toInsert = [];
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const doc = mapRow(rows[i], i);
    if (!doc) {
      skipped++;
      continue;
    }
    toInsert.push(doc);
  }

  const BATCH = 500;
  let upserted = 0;
  let errors = 0;

  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    try {
      const result = await DailyPuzzle.bulkWrite(
        batch.map((doc) => ({
          updateOne: {
            filter: { sourceId: doc.sourceId },
            update: { $setOnInsert: doc },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      upserted += (result.upsertedCount || 0) + (result.modifiedCount || 0);
      if ((i + BATCH) % 1000 === 0 || i + BATCH >= toInsert.length) {
        console.log(`⏳ ${Math.min(i + BATCH, toInsert.length)} / ${toInsert.length} processed`);
      }
    } catch (err) {
      console.error(`Batch at ${i}:`, err.message);
      errors += batch.length;
    }
  }

  const [total, unused] = await Promise.all([
    DailyPuzzle.countDocuments(),
    DailyPuzzle.countDocuments({ usedOnDateKey: null }),
  ]);

  console.log("\n✅ Import finished");
  console.log(`   Rows processed: ${rows.length}`);
  console.log(`   Valid rows: ${toInsert.length}`);
  console.log(`   Upserted: ${upserted}`);
  console.log(`   Skipped (missing fen/moves): ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   Pool total: ${total} (${unused} unused)`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
