/** Port of mobile `src/bot/BotPersonality.ts` */

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const ratingNorm = (rating) => clamp01((rating - 500) / 2300);

const TIER_BASE = {
  beginner: {
    aggression: 0.35,
    tacticalStrength: 0.2,
    positionalStrength: 0.25,
    sacrificeTendency: 0.15,
    randomness: 0.62,
    openingPreference: "balanced",
    endgameStrength: 0.2,
    preferredThinkSpeed: 0.75,
    mistakeFrequency: 0.82,
    blunderFrequency: 0.52,
    pieceActivity: 0.35,
  },
  intermediate: {
    aggression: 0.5,
    tacticalStrength: 0.48,
    positionalStrength: 0.45,
    sacrificeTendency: 0.3,
    randomness: 0.4,
    openingPreference: "balanced",
    endgameStrength: 0.45,
    preferredThinkSpeed: 0.55,
    mistakeFrequency: 0.48,
    blunderFrequency: 0.26,
    pieceActivity: 0.5,
  },
  advanced: {
    aggression: 0.55,
    tacticalStrength: 0.68,
    positionalStrength: 0.62,
    sacrificeTendency: 0.35,
    randomness: 0.24,
    openingPreference: "d4",
    endgameStrength: 0.62,
    preferredThinkSpeed: 0.42,
    mistakeFrequency: 0.22,
    blunderFrequency: 0.1,
    pieceActivity: 0.58,
  },
  master: {
    aggression: 0.62,
    tacticalStrength: 0.82,
    positionalStrength: 0.78,
    sacrificeTendency: 0.42,
    randomness: 0.14,
    openingPreference: "e4",
    endgameStrength: 0.82,
    preferredThinkSpeed: 0.32,
    mistakeFrequency: 0.1,
    blunderFrequency: 0.04,
    pieceActivity: 0.68,
  },
  boss: {
    aggression: 0.7,
    tacticalStrength: 0.95,
    positionalStrength: 0.92,
    sacrificeTendency: 0.5,
    randomness: 0.06,
    openingPreference: "e4",
    endgameStrength: 0.95,
    preferredThinkSpeed: 0.22,
    mistakeFrequency: 0.03,
    blunderFrequency: 0.01,
    pieceActivity: 0.75,
  },
};

const BOT_OVERRIDES = {
  pawnish: {
    aggression: 0.42,
    randomness: 0.68,
    mistakeFrequency: 0.85,
    blunderFrequency: 0.55,
    openingPreference: "irregular",
  },
  blunderbot: {
    aggression: 0.55,
    randomness: 0.72,
    mistakeFrequency: 0.8,
    blunderFrequency: 0.62,
    preferredThinkSpeed: 0.85,
  },
  "knighty-knight": {
    pieceActivity: 0.82,
    openingPreference: "nf3",
    aggression: 0.48,
  },
  "casual-castle": {
    aggression: 0.28,
    positionalStrength: 0.55,
    sacrificeTendency: 0.1,
    preferredThinkSpeed: 0.65,
  },
  "steady-eddie": {
    positionalStrength: 0.72,
    aggression: 0.38,
    sacrificeTendency: 0.12,
  },
  "tactical-tina": {
    tacticalStrength: 0.78,
    aggression: 0.72,
    sacrificeTendency: 0.45,
    mistakeFrequency: 0.28,
  },
  "gambit-ghost": {
    aggression: 0.88,
    sacrificeTendency: 0.92,
    randomness: 0.48,
    openingPreference: "irregular",
  },
  "the-defender": {
    aggression: 0.25,
    positionalStrength: 0.85,
    sacrificeTendency: 0.08,
    openingPreference: "d4",
  },
  "coach-carbon": {
    positionalStrength: 0.8,
    tacticalStrength: 0.7,
    mistakeFrequency: 0.18,
  },
  "professor-sly": {
    endgameStrength: 0.92,
    positionalStrength: 0.88,
    aggression: 0.35,
    preferredThinkSpeed: 0.48,
  },
  maximus: {
    randomness: 0.12,
    mistakeFrequency: 0.06,
    tacticalStrength: 0.9,
  },
  "fort-knox": {
    aggression: 0.2,
    positionalStrength: 0.9,
    sacrificeTendency: 0.05,
  },
  octave: {
    tacticalStrength: 0.93,
    positionalStrength: 0.86,
    randomness: 0.18,
  },
  nebula: {
    tacticalStrength: 0.98,
    positionalStrength: 0.96,
    randomness: 0.04,
    mistakeFrequency: 0.02,
  },
  "the-singularity": {
    tacticalStrength: 1,
    positionalStrength: 1,
    endgameStrength: 1,
    randomness: 0.02,
    mistakeFrequency: 0.01,
    blunderFrequency: 0.005,
  },
};

const mergePersonality = (base, patch) => ({ ...base, ...patch });

const scaleByRating = (personality, rating) => {
  const t = ratingNorm(rating);
  return {
    ...personality,
    tacticalStrength: clamp01(personality.tacticalStrength * 0.65 + t * 0.35),
    positionalStrength: clamp01(personality.positionalStrength * 0.65 + t * 0.35),
    endgameStrength: clamp01(personality.endgameStrength * 0.6 + t * 0.4),
    mistakeFrequency: clamp01(personality.mistakeFrequency * (1.25 - t * 0.75)),
    blunderFrequency: clamp01(personality.blunderFrequency * (1.35 - t * 0.85)),
    randomness: clamp01(personality.randomness * (1.1 - t * 0.55)),
  };
};

function buildBotPersonality(bot) {
  const base = TIER_BASE[bot.tier] || TIER_BASE.intermediate;
  const overrides = BOT_OVERRIDES[bot.id] || {};
  return scaleByRating(mergePersonality(base, overrides), bot.rating);
}

function personalityOpeningWeight(preference, openingTag) {
  if (preference === "balanced") return 1;
  if (preference === openingTag) return 1.45;
  if (preference === "irregular" && openingTag === "irregular") return 1.35;
  if (openingTag === "balanced") return 0.9;
  return 0.55;
}

module.exports = {
  buildBotPersonality,
  personalityOpeningWeight,
};
