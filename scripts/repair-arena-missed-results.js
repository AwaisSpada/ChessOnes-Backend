/**
 * Re-sync completed arena games that were not applied to leaderboard.
 * Usage: node scripts/repair-arena-missed-results.js <arenaId>
 */
require("dotenv").config();
const mongoose = require("mongoose");
const CustomArena = require("../models/CustomArena");
const Game = require("../models/Game");
const { recordArenaResultForGame } = require("../services/customArenaEngine");

async function main() {
  const arenaId = process.argv[2];
  if (!arenaId) {
    console.error("Usage: node scripts/repair-arena-missed-results.js <arenaId>");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    console.error("Arena not found:", arenaId);
    process.exit(1);
  }

  const roster = (arena.participantUserIds || []).map(String);
  const recorded = new Set((arena.recordedGameIds || []).map(String));

  const pairingGameIds = (arena.activePairings || [])
    .map((p) => p.gameId)
    .filter(Boolean)
    .map(String);

  const games = await Game.find({
    gameId: { $in: pairingGameIds },
    status: "completed",
  }).sort({ updatedAt: 1 });

  let repaired = 0;
  for (const game of games) {
    const gid = String(game.gameId);
    if (recorded.has(gid)) continue;

    const white = String(game.players?.white || "");
    const black = String(game.players?.black || "");
    if (!roster.includes(white) || !roster.includes(black)) continue;
    if (!game.result?.winner) continue;

    const outcome = await recordArenaResultForGame(gid, game.result);
    if (outcome.error) {
      console.warn("Skip", gid, outcome.error);
      continue;
    }
    if (outcome.arena) {
      recorded.add(gid);
      repaired += 1;
      console.log("Repaired game", gid, "winner:", game.result.winner);
    }
  }

  const updated = await CustomArena.findById(arenaId);
  const me = (updated.leaderboard || []).find(
    (row) => String(row.username).toLowerCase() === "awaissz09"
  );
  console.log("Done. Repaired:", repaired);
  console.log("Leaderboard snapshot:", JSON.stringify(updated.leaderboard, null, 2));
  if (me) console.log("awaisZ09 row:", me);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
