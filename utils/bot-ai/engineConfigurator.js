/** Port of mobile `src/bot/BotEngineConfigurator.ts` */

const {
  detectGamePhase,
  endgameSearchBoost,
  mapRatingToStockfishConfig,
  pieceCountFromFen,
  UCI_ELO_MIN,
  limitStrengthNodes,
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

  const useLimitStrength = rating >= UCI_ELO_MIN;
  const { getWeakClubPlayConfig } = require("./weakClubPlay");
  const weakPlay = weakClub ? getWeakClubPlayConfig(rating) : null;
  const multipv = useLimitStrength ? 1 : weakClub ? weakPlay.multipv : 3;
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
      depth: useLimitStrength || weakClub ? 0 : searchDepth,
      movetime: useLimitStrength || weakClub ? 0 : endgameAdjusted.movetime,
      nodes: useLimitStrength ? limitStrengthNodes(rating) : base.nodes,
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
