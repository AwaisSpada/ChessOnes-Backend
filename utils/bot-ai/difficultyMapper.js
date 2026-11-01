/** Port of mobile `src/bot/BotDifficultyMapper.ts` */

const clampElo = (elo) => Math.max(500, Math.min(2800, Math.round(elo)));

/** Pawnish → Eddie: Chess.com-style club-weak, not Skill-0 Stockfish. */
const WEAK_CLUB_MAX_ELO = 1250;

function isWeakClubBot(elo) {
  return clampElo(elo) <= WEAK_CLUB_MAX_ELO;
}

function weakClubSearch(siteElo) {
  if (siteElo <= 500) {
    return { skillLevel: 0, depth: 1, nodes: 400, movetime: 120 };
  }
  if (siteElo <= 750) {
    return { skillLevel: 0, depth: 1, nodes: 800, movetime: 150 };
  }
  if (siteElo <= 900) {
    return { skillLevel: 1, depth: 2, nodes: 1500, movetime: 180 };
  }
  if (siteElo <= 1100) {
    return { skillLevel: 2, depth: 2, nodes: 4000, movetime: 250 };
  }
  return { skillLevel: 3, depth: 3, nodes: 10000, movetime: 400 };
}

function mapRatingToStockfishConfig(elo, timeRemainingMs = null) {
  const siteElo = clampElo(elo);
  const weak = isWeakClubBot(siteElo);
  const engineElo = weak ? siteElo : Math.max(1320, siteElo);
  let skillLevel = Math.round(((siteElo - 500) / 2300) * 20);
  skillLevel = Math.max(0, Math.min(20, skillLevel));

  let depth;
  let movetime;
  let nodes;

  if (weak) {
    const w = weakClubSearch(siteElo);
    skillLevel = w.skillLevel;
    depth = w.depth;
    nodes = w.nodes;
    movetime = w.movetime;
  } else {
    if (siteElo <= 600) depth = 2;
    else if (siteElo <= 800) depth = 3;
    else if (siteElo <= 1000) depth = 4;
    else if (siteElo <= 1150) depth = 5;
    else if (siteElo < 1320) depth = 6;
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

  if (typeof timeRemainingMs === "number" && timeRemainingMs > 0) {
    const reserve = Math.max(50, Math.min(800, Math.floor(timeRemainingMs * 0.04)));
    const maxThinkBudget = Math.max(80, timeRemainingMs - reserve);
    movetime = Math.min(movetime, maxThinkBudget);
    if (weak) {
      if (timeRemainingMs < 30000) {
        nodes = Math.max(200, Math.round(nodes * 0.5));
        depth = Math.max(1, depth - 1);
      }
    } else if (timeRemainingMs < 30000) {
      nodes = Math.max(40000, Math.round(nodes * 0.35));
      depth = Math.max(2, depth - 3);
    } else if (timeRemainingMs < 60000) {
      nodes = Math.max(60000, Math.round(nodes * 0.55));
      depth = Math.max(3, depth - 2);
    }
  }

  return { siteElo, engineElo, skillLevel, depth, movetime, nodes };
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
};
