require("dotenv").config();
const mongoose = require("mongoose");
const CustomArena = require("../models/CustomArena");
const Game = require("../models/Game");
const { recordArenaResultForGame } = require("../services/customArenaEngine");

async function main() {
  const arenaId = process.argv[2];
  const gameId = process.argv[3];
  if (!arenaId || !gameId) {
    console.error("Usage: node scripts/reapply-arena-game.js <arenaId> <gameId>");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    console.error("Arena not found");
    process.exit(1);
  }

  arena.recordedGameIds = (arena.recordedGameIds || []).filter(
    (id) => String(id) !== String(gameId)
  );
  arena.markModified("recordedGameIds");
  await arena.save();

  const game = await Game.findOne({ gameId: String(gameId) });
  if (!game?.result?.winner) {
    console.error("Game not found or missing result");
    process.exit(1);
  }

  if (!game.arenaId) {
    const pairing = (arena.activePairings || []).find(
      (p) => String(p.gameId) === String(gameId)
    );
    if (pairing) {
      game.arenaId = arena._id;
      game.arenaPairingId = pairing.pairingId;
      await game.save();
    }
  }

  const outcome = await recordArenaResultForGame(gameId, game.result);
  console.log("Outcome error:", outcome.error);
  console.log(
    "Leaderboard:",
    JSON.stringify(outcome.arena?.leaderboard || [], null, 2)
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
