require("dotenv").config();
const mongoose = require("mongoose");
const CustomArena = require("../models/CustomArena");
const { applyArenaGameResult } = require("../utils/customArenaPairing");

async function main() {
  const arenaId = process.argv[2];
  const gameId = process.argv[3];
  if (!arenaId || !gameId) {
    console.error("Usage: node scripts/fix-arena-leaderboard-game.js <arenaId> <gameId>");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    console.error("Arena not found");
    process.exit(1);
  }

  const pairing = (arena.activePairings || []).find(
    (p) => String(p.gameId) === String(gameId)
  );
  if (!pairing?.result) {
    console.error("Pairing not found or missing result for game", gameId);
    process.exit(1);
  }

  const recorded = new Set((arena.recordedGameIds || []).map(String));
  if (recorded.has(String(gameId))) {
    console.log("Game already in recordedGameIds — applying leaderboard only.");
  } else {
    recorded.add(String(gameId));
    arena.recordedGameIds = [...recorded];
  }

  arena.leaderboard = applyArenaGameResult(
    arena.leaderboard,
    String(pairing.whiteUserId),
    String(pairing.blackUserId),
    pairing.result
  );

  arena.markModified("leaderboard");
  arena.markModified("recordedGameIds");
  await arena.save();

  console.log("Fixed leaderboard for game", gameId);
  console.log(JSON.stringify(arena.leaderboard, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
