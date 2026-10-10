/** Port of mobile `src/bot/BotMistakeGenerator.ts` */

const cpScore = (line) =>
  line.mate != null ? (line.mate > 0 ? 100000 : -100000) : line.centipawns;

const cpGap = (a, b) => cpScore(a) - cpScore(b);

const maxAcceptableGap = (rating, rank) => {
  if (rating >= 2400) return rank === 2 ? 12 : 0;
  if (rating >= 2200) return rank === 2 ? 22 : 0;
  if (rating >= 2000) return rank === 2 ? 40 : 70;
  if (rating >= 1700) return rank === 2 ? 55 : 100;
  if (rating >= 1400) return rank === 2 ? 90 : 150;
  if (rating >= 1000) return rank === 2 ? 160 : 280;
  return rank === 2 ? 320 : 520;
};

const mistakeChance = (profile, complexity, clockMs) => {
  if (profile.rating >= 2200) return 0;

  const base =
    profile.personality.mistakeFrequency * 0.42 +
    profile.personality.blunderFrequency * 0.14;
  const tacticalLoad = complexity * 0.28;
  const timePressure = clockMs < 30000 ? 0.12 : clockMs < 60000 ? 0.06 : 0;

  let cap = 0.28;
  let ratingScale = 0.85;
  if (profile.rating < 900) {
    cap = 0.62;
    ratingScale = 1;
  } else if (profile.rating < 1200) {
    cap = 0.48;
    ratingScale = 0.92;
  } else if (profile.rating < 1500) {
    cap = 0.36;
    ratingScale = 0.7;
  } else if (profile.rating >= 1800) {
    ratingScale = 0.32;
  } else if (profile.rating >= 1500) {
    ratingScale = 0.45;
  }

  return Math.min(cap, (base + tacticalLoad + timePressure) * ratingScale);
};

const blunderChance = (profile, complexity, clockMs) => {
  if (profile.rating >= 1800) return 0;
  if (profile.rating >= 1600) {
    return Math.min(0.06, profile.personality.blunderFrequency * 0.12);
  }

  let chance = profile.personality.blunderFrequency * 0.35;
  if (complexity > 0.55) chance += 0.06;
  if (clockMs < 30000) chance += 0.08;
  if (profile.rating >= 1200) chance *= 0.55;
  if (profile.rating < 900) return Math.min(0.32, chance);
  if (profile.rating < 1200) return Math.min(0.22, chance);
  return Math.min(0.14, chance);
};

const protectedAdvantageCp = (rating, phase) => {
  if (rating <= 900) return phase === "endgame" ? 280 : 380;
  if (rating <= 1400) return phase === "endgame" ? 180 : 260;
  return phase === "endgame" ? 100 : 150;
};

function applyMistakeLayer(selected, lines, profile, context) {
  const ordered = [...lines].filter((l) => l.uci).sort((a, b) => a.rank - b.rank);
  if (ordered.length < 2 || !selected.uci) return selected;

  if (profile.rating >= 2200) return selected;

  const top = ordered[0];
  if (top.mate != null) return selected;
  const protectAt = protectedAdvantageCp(profile.rating, context.phase);
  if (top.centipawns >= protectAt) return selected;

  const complexity = Math.min(
    1,
    context.legalMoveCount / 40 +
      (context.inCheck ? 0.28 : 0) +
      (context.phase === "middlegame" ? 0.12 : 0)
  );

  if (Math.random() >= mistakeChance(profile, complexity, context.botClockMs)) {
    return selected;
  }

  const second = ordered[1];
  const third = ordered[2];
  const gap12 = cpGap(ordered[0], second);

  if (
    third &&
    profile.rating < 1400 &&
    blunderChance(profile, complexity, context.botClockMs) > Math.random() &&
    gap12 < maxAcceptableGap(profile.rating, 2)
  ) {
    const gap13 = cpGap(ordered[0], third);
    if (gap13 <= maxAcceptableGap(profile.rating, 3) && gap13 > 60) {
      return { uci: third.uci, rank: third.rank };
    }
  }

  if (gap12 <= maxAcceptableGap(profile.rating, 2)) {
    if (profile.rating >= 1700 && gap12 > 35) return selected;
    if (profile.personality.tacticalStrength < 0.55 || profile.rating < 1800) {
      return { uci: second.uci, rank: second.rank };
    }
    if (gap12 < 50 && Math.random() < 0.35) {
      return { uci: second.uci, rank: second.rank };
    }
  }

  return selected;
}

module.exports = {
  applyMistakeLayer,
};
