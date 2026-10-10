/**
 * Mobile roster ids + ratings/tiers (src/constants/bots.ts).
 * Backend DB keys may use underscores; normalize via normalizeBotId.
 */

const BOTS = [
  { id: "pawnish", name: "Pawnish", rating: 500, tier: "beginner" },
  { id: "blunderbot", name: "Blunderbot", rating: 750, tier: "beginner" },
  { id: "knighty-knight", name: "Knighty Knight", rating: 900, tier: "beginner" },
  { id: "casual-castle", name: "Casual Castle", rating: 1100, tier: "intermediate" },
  { id: "steady-eddie", name: "Steady Eddie", rating: 1250, tier: "intermediate" },
  { id: "tactical-tina", name: "Tactical Tina", rating: 1400, tier: "intermediate" },
  { id: "gambit-ghost", name: "Gambit Ghost", rating: 1550, tier: "intermediate" },
  { id: "the-defender", name: "The Defender", rating: 1700, tier: "advanced" },
  { id: "coach-carbon", name: "Coach Carbon", rating: 1900, tier: "advanced" },
  { id: "professor-sly", name: "Professor Sly", rating: 2100, tier: "advanced" },
  { id: "maximus", name: "Maximus", rating: 2300, tier: "master" },
  { id: "fort-knox", name: "Fort Knox", rating: 2450, tier: "master" },
  { id: "octave", name: "Octave", rating: 2600, tier: "master" },
  { id: "nebula", name: "Nebula", rating: 2750, tier: "boss" },
  { id: "the-singularity", name: "The Singularity", rating: 2800, tier: "boss" },
];

const KEY_ALIASES = {
  knight_knight: "knighty-knight",
  knighty_knight: "knighty-knight",
  casual_castle: "casual-castle",
  steady_eddie: "steady-eddie",
  tactical_tina: "tactical-tina",
  gambit_ghost: "gambit-ghost",
  the_defender: "the-defender",
  coach_carbon: "coach-carbon",
  professor_sly: "professor-sly",
  fort_knox: "fort-knox",
  the_singularity: "the-singularity",
};

function normalizeBotId(raw) {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim().toLowerCase();
  if (KEY_ALIASES[trimmed]) return KEY_ALIASES[trimmed];
  return trimmed.replace(/_/g, "-");
}

function tierFromElo(elo) {
  if (elo <= 900) return "beginner";
  if (elo <= 1550) return "intermediate";
  if (elo <= 2100) return "advanced";
  if (elo <= 2600) return "master";
  return "boss";
}

function getBotById(id) {
  const nid = normalizeBotId(id);
  return BOTS.find((b) => b.id === nid) || null;
}

function getBotByElo(elo) {
  const target = typeof elo === "number" ? elo : 1500;
  let best = BOTS[0];
  let bestDist = Infinity;
  for (const bot of BOTS) {
    const d = Math.abs(bot.rating - target);
    if (d < bestDist) {
      best = bot;
      bestDist = d;
    }
  }
  return best;
}

module.exports = {
  BOTS,
  normalizeBotId,
  tierFromElo,
  getBotById,
  getBotByElo,
};
