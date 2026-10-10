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

  const endgameAdjusted = endgameSearchBoost(
    base.depth,
    base.movetime,
    phase,
    pieceCount,
    profile.personality.endgameStrength
  );

  const tacticalBoost =
    phase === "middlegame" ? profile.personality.tacticalStrength * 0.15 : 0;
  const depth = Math.min(40, Math.round(endgameAdjusted.depth + tacticalBoost * 3));

  const rating = profile.rating;
  const multipv = rating < 1400 ? 3 : 2;
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
