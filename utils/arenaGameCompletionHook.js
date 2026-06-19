const { recordArenaResultForGame } = require("../services/customArenaEngine");
const { notifyArenaEndedIfNeeded } = require("../services/arenaNotificationService");

async function syncArenaGameCompletion(gameId, result, io = null) {
  if (!gameId || !result) return;
  if (result.reason === "first-move-abandon") return;
  try {
    const { arena, error } = await recordArenaResultForGame(gameId, result);
    if (error) {
      console.warn("[Arena] could not sync game result:", gameId, error);
      return;
    }
    if (arena?.status === "ended" && io) {
      await notifyArenaEndedIfNeeded(io, String(arena._id));
    }
  } catch (err) {
    console.error("[Arena] sync game result failed:", gameId, err);
  }
}

module.exports = { syncArenaGameCompletion };
