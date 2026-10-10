/** Port of mobile `src/bot/BotMoveSelector.ts` */

const MULTIPV_WEIGHTS = {
  beginner: [0.42, 0.36, 0.22],
  clubLow: [0.62, 0.28, 0.1],
  club: [0.88, 0.1, 0.02],
  strong: [0.96, 0.035, 0.005],
  high: [0.985, 0.015, 0],
  elite: [0.995, 0.005, 0],
};

const weightSetForRating = (rating) => {
  if (rating <= 799) return MULTIPV_WEIGHTS.beginner;
  if (rating <= 1199) return MULTIPV_WEIGHTS.clubLow;
  if (rating <= 1599) return MULTIPV_WEIGHTS.club;
  if (rating <= 1899) return MULTIPV_WEIGHTS.strong;
  if (rating <= 2199) return MULTIPV_WEIGHTS.high;
  return MULTIPV_WEIGHTS.elite;
};

const lineCp = (line) =>
  line.mate != null ? (line.mate > 0 ? 100000 : -100000) : line.centipawns;

const isSpicePosition = (top) => {
  if (!top) return false;
  if (top.mate != null) return false;
  return Math.abs(top.centipawns) < 90;
};

const scoreLine = (line, profile, spiceAllowed) => {
  const cp = lineCp(line);
  let score = cp;
  if (!spiceAllowed) return score;

  if (profile.personality.aggression > 0.6 && cp > 0) {
    score += profile.personality.aggression * 40;
  }
  if (profile.personality.positionalStrength > 0.6 && Math.abs(cp) < 120) {
    score += profile.personality.positionalStrength * 25;
  }
  if (profile.personality.sacrificeTendency > 0.65 && cp < 0 && cp > -160) {
    score += profile.personality.sacrificeTendency * 30;
  }
  if (profile.personality.pieceActivity > 0.6) {
    score += profile.personality.pieceActivity * 10;
  }
  return score;
};

function selectEngineMove(lines, profile, options = {}) {
  const ordered = [...lines]
    .filter((line) => line.uci)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);

  if (ordered.length === 0) {
    return { uci: "", rank: 1 };
  }

  if (options.killerInstinct) {
    return { uci: ordered[0].uci, rank: ordered[0].rank };
  }

  const spiceAllowed = isSpicePosition(ordered[0]);
  const weights = weightSetForRating(profile.rating);
  const styleNoise = spiceAllowed ? profile.personality.randomness * 0.03 : 0;
  const adjusted = weights.map((w, i) => {
    const line = ordered[i];
    if (!line) return 0;
    const styleBoost = spiceAllowed ? scoreLine(line, profile, true) / 10000 : 0;
    return Math.max(0, w + styleBoost + styleNoise * 0.02);
  });

  const total = adjusted.reduce((sum, w) => sum + w, 0) || 1;
  const r = Math.random() * total;
  let acc = 0;
  for (let i = 0; i < ordered.length; i++) {
    acc += adjusted[i] || 0;
    if (r <= acc) {
      return { uci: ordered[i].uci, rank: ordered[i].rank };
    }
  }

  return { uci: ordered[0].uci, rank: ordered[0].rank };
}

function shouldUseKillerInstinct(lines, phase, rating = 2000) {
  const top = lines[0];
  if (!top) return false;
  if (top.mate != null) return true;

  const topCp = Math.abs(top.centipawns);

  let convertCp = 220;
  let endgameCp = 140;
  let uniqueGap = 140;
  if (rating <= 900) {
    convertCp = 480;
    endgameCp = 380;
    uniqueGap = 300;
  } else if (rating <= 1400) {
    convertCp = 360;
    endgameCp = 280;
    uniqueGap = 220;
  }

  if (topCp >= convertCp) return true;
  if (phase === "endgame" && topCp >= endgameCp) return true;

  const second = lines[1];
  if (second && top.uci) {
    const topScore = lineCp(top);
    const secondScore = lineCp(second);
    if (Math.abs(topScore - secondScore) >= uniqueGap) return true;
  }

  return false;
}

module.exports = {
  selectEngineMove,
  shouldUseKillerInstinct,
};
