/** Port of mobile `src/bot/BotEngineConfigurator.ts` */

const {
  detectGamePhase,
  endgameSearchBoost,
  mapRatingToStockfishConfig,
  pieceCountFromFen,
} = require("./difficultyMapper");

function configureEngineForBot(profile, context, botColor) {
  const phase = detectGamePhase(context.fen);
  const pieceCount = pieceCountFromFen(context.fen);
  const base = mapRatingToStockfishConfig(profile.rating, context.botClockMs);

  const rating = profile.rating;
  const weakClub = rating <= 1250;

  const endgameAdjusted = endgameSearchBoost(
    base.depth,
    base.movetime,
    phase,
    pieceCount,
    weakClub ? 0 : profile.personality.endgameStrength
  );

  const tacticalBoost =
    weakClub || phase !== "middlegame"
      ? 0
      : profile.personality.tacticalStrength * 0.15;
  const depth = Math.min(40, Math.round(endgameAdjusted.depth + tacticalBoost * 3));

  const multipv = weakClub ? 1 : rating < 1400 ? 3 : 2;
  const useLimitStrength = rating >= 1400;
  const minDepthForMultipv = multipv > 1 ? 2 : 1;
  const searchDepth = Math.max(depth, minDepthForMultipv);

  const wtime = botColor === "white" ? context.botClockMs : context.opponentClockMs;
  const btime = botColor === "black" ? context.botClockMs : context.opponentClockMs;

  return {
    siteElo: base.siteElo,
    uci: {
      useLimitStrength,
      uciElo: base.engineElo,
      skillLevel: base.skillLevel,
      multipv,
      threads: 1,
      hashMb: 16,
    },
    search: {
      depth: searchDepth,
      movetime: endgameAdjusted.movetime,
      nodes: base.nodes,
      wtime,
      btime,
      winc: context.incrementMs,
      binc: context.incrementMs,
    },
  };
}

module.exports = {
  configureEngineForBot,
};
