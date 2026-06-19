const CustomArena = require("../models/CustomArena");

/**
 * Arena participants may watch live games in their arena (friend games are
 * otherwise player-only on GET /api/games/:gameId).
 */
async function canUserSpectateArenaGame(userId, gameId) {
  if (!userId || !gameId) return false;

  const arena = await CustomArena.findOne({
    status: { $in: ["live", "ended"] },
    participantUserIds: userId,
    activePairings: {
      $elemMatch: {
        gameId: String(gameId),
        status: { $in: ["active", "completed"] },
      },
    },
  }).select("_id");

  return !!arena;
}

module.exports = { canUserSpectateArenaGame };
