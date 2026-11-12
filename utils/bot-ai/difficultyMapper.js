/** Port of mobile `src/bot/BotDifficultyMapper.ts` */

const clampElo = (elo) => Math.max(500, Math.min(2800, Math.round(elo)));

/** Pawnish → Eddie: Chess.com-style club-weak, not Skill-0 Stockfish. */
const WEAK_CLUB_MAX_ELO = 1250;
/** Stockfish 19 UCI_Elo floor. At/above this, LimitStrength + UCI_Elo is the handicap. */
const UCI_ELO_MIN = 1320;
/** Tina starts at 4 lac; each catalog step +1 lac. */
const UCI_ELO_NODES = 400000;

function limitStrengthNodes(elo) {
  const siteElo = clampElo(elo);
  if (siteElo < 1550) return 400000;
  if (siteElo < 1700) return 500000;
  if (siteElo < 1900) return 600000;
  if (siteElo < 2100) return 700000;
  if (siteElo < 2300) return 800000;
  if (siteElo < 2450) return 900000;
  if (siteElo < 2600) return 1000000;
  if (siteElo < 2750) return 1100000;
  if (siteElo < 2800) return 1200000;
  return 1300000;
}

function isWeakClubBot(elo) {
  return clampElo(elo) <= WEAK_CLUB_MAX_ELO;
}

function weakClubSearch(siteElo) {
  const { getWeakClubPlayConfig } = require("./weakClubPlay");
  const play = getWeakClubPlayConfig(siteElo);
  return {
    skillLevel: play.skill,
    depth: 0,
    nodes: play.nodes,
    movetime: 0,
    multipv: play.multipv,
  };
}

function mapRatingToStockfishConfig(elo, timeRemainingMs = null) {
  const siteElo = clampElo(elo);
  const weak = isWeakClubBot(siteElo);
  const engineElo = weak ? siteElo : Math.max(UCI_ELO_MIN, siteElo);
  let skillLevel = Math.round(((siteElo - 500) / 2300) * 20);
  skillLevel = Math.max(0, Math.min(20, skillLevel));

  let depth;
  let movetime;
  let nodes;
  let multipv = siteElo >= UCI_ELO_MIN ? 1 : 3;

  if (weak) {
    const w = weakClubSearch(siteElo);
    skillLevel = w.skillLevel;
    depth = w.depth;
    nodes = w.nodes;
    movetime = w.movetime;
    multipv = w.multipv;
  } else if (siteElo >= UCI_ELO_MIN) {
    depth = 0;
    movetime = 0;
    nodes = limitStrengthNodes(siteElo);
  } else {
    if (siteElo <= 600) depth = 2;
    else if (siteElo <= 800) depth = 3;
    else if (siteElo <= 1000) depth = 4;
    else if (siteElo <= 1150) depth = 5;
    else if (siteElo < UCI_ELO_MIN) depth = 6;
    else if (siteElo < 1600) depth = Math.floor(siteElo / 100) - 1;
    else if (siteElo < 2000) depth = Math.floor(siteElo / 100);
    else depth = Math.floor(siteElo / 100) + 1;
    depth = Math.max(2, Math.min(28, depth));

    if (siteElo < 1600) movetime = 2400;
    else if (siteElo < 1900) movetime = 2800;
    else if (siteElo < 2200) movetime = 3200;
    else movetime = 4000;

    if (siteElo < 1600) nodes = 400000;
    else if (siteElo < 1900) nodes = 650000;
    else if (siteElo < 2200) nodes = 900000;
    else if (siteElo < 2500) nodes = 1200000;
    else nodes = 1800000;
  }

  if (!weak && siteElo < UCI_ELO_MIN && typeof timeRemainingMs === "number" && timeRemainingMs > 0) {
    const reserve = Math.max(50, Math.min(800, Math.floor(timeRemainingMs * 0.04)));
    const maxThinkBudget = Math.max(80, timeRemainingMs - reserve);
    movetime = Math.min(movetime, maxThinkBudget);
    if (timeRemainingMs < 30000) {
      nodes = Math.max(40000, Math.round(nodes * 0.35));
      depth = Math.max(2, depth - 3);
    } else if (timeRemainingMs < 60000) {
      nodes = Math.max(60000, Math.round(nodes * 0.55));
      depth = Math.max(3, depth - 2);
    }
  }

  return { siteElo, engineElo, skillLevel, depth, movetime, nodes, multipv };
}

function pieceCountFromFen(fen) {
  const board = (fen.split(" ")[0] || "");
  return board.replace(/[^prnbqkPRNBQK]/g, "").length;
}

function detectGamePhase(fen) {
  const pieceCount = pieceCountFromFen(fen);
  if (pieceCount >= 26) return "opening";
  if (pieceCount <= 10) return "endgame";
  return "middlegame";
}

function endgameSearchBoost(baseDepth, baseMovetime, phase, pieceCount, endgameStrength) {
  if (phase !== "endgame" && pieceCount > 10) {
    return { depth: baseDepth, movetime: baseMovetime };
  }
  const boost = 1 + endgameStrength * 0.2;
  return {
    depth: Math.min(40, Math.round(baseDepth + Math.round(boost))),
    movetime: baseMovetime,
  };
}

module.exports = {
  mapRatingToStockfishConfig,
  pieceCountFromFen,
  detectGamePhase,
  endgameSearchBoost,
  isWeakClubBot,
  WEAK_CLUB_MAX_ELO,
  UCI_ELO_MIN,
  UCI_ELO_NODES,
  limitStrengthNodes,
};
