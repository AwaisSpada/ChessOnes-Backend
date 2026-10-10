/** Port of mobile `src/bot/BotProfile.ts` */

const { getBotById, getBotByElo, tierFromElo, normalizeBotId } = require("./botsCatalog");
const { buildBotPersonality } = require("./personality");

function toBotProfile(bot) {
  return {
    ...bot,
    personality: buildBotPersonality(bot),
  };
}

/**
 * Resolve a BotProfile from optional bot key / elo (custom bots included).
 */
function resolveBotProfile({ botKey, botName, elo } = {}) {
  const catalog = botKey ? getBotById(botKey) : null;
  if (catalog) {
    const rating = typeof elo === "number" ? elo : catalog.rating;
    return toBotProfile({
      ...catalog,
      rating,
      tier: tierFromElo(rating),
    });
  }

  const nearest = getBotByElo(typeof elo === "number" ? elo : 1500);
  const rating = typeof elo === "number" ? Math.round(elo) : nearest.rating;
  return toBotProfile({
    id: normalizeBotId(botKey) || nearest.id,
    name: botName || nearest.name || "Bot",
    rating,
    tier: tierFromElo(rating),
  });
}

module.exports = {
  toBotProfile,
  resolveBotProfile,
};
