require("dotenv").config();
const mongoose = require("mongoose");
const DailyPuzzle = require("../models/DailyPuzzle");
const DailyPuzzleAssignment = require("../models/DailyPuzzleAssignment");
const { todayDateKey } = require("../utils/daily-puzzle-dates");

mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/chessones")
  .then(async () => {
    const [total, unused, assignments] = await Promise.all([
      DailyPuzzle.countDocuments(),
      DailyPuzzle.countDocuments({ usedOnDateKey: null }),
      DailyPuzzleAssignment.countDocuments(),
    ]);
    const today = await DailyPuzzleAssignment.findOne({ dateKey: todayDateKey() }).populate(
      "puzzle"
    );

    console.log("\n📊 Daily Puzzle pool");
    console.log(`   Total in pool: ${total}`);
    console.log(`   Unused: ${unused}`);
    console.log(`   Date assignments: ${assignments}`);
    console.log(`   Today (${todayDateKey()}): ${today ? "assigned" : "not assigned"}`);
    if (today?.puzzle) {
      console.log(`   Today's sourceId: ${today.puzzle.sourceId}`);
    }

    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
