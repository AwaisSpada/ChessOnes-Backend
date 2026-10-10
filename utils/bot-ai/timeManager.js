/** Port of mobile `src/bot/BotTimeManager.ts` (chess.js for recapture / captures). */

const { Chess } = require("chess.js");

const randBetween = (min, max) => Math.round(min + Math.random() * (max - min));

const jitterInRange = (min, max, context) => {
  const span = Math.max(0, max - min);
  const positionBias =
    ((context.moveNumber * 37 + context.legalMoveCount * 19 + context.pieceCount * 11) %
      100) /
    100;
  const blend = positionBias * 0.35 + Math.random() * 0.65;
  return Math.round(min + blend * span);
};

const hasRecapture = (context) => {
  if (!context.lastMoveUci || !context.lastMoveWasCapture) return false;
  try {
    const chess = new Chess(context.fen);
    const captureSquare = context.lastMoveUci.slice(2, 4);
    return chess
      .moves({ verbose: true })
      .some((move) => move.to === captureSquare && move.captured);
  } catch {
    return false;
  }
};

const countCaptureMoves = (context) => {
  try {
    const chess = new Chess(context.fen);
    return chess.moves({ verbose: true }).filter((move) => move.captured).length;
  } catch {
    return 0;
  }
};

const estimateComplexity = (profile, context) => {
  const captureMoves = countCaptureMoves(context);
  let score = 0;
  score += Math.min(0.35, context.legalMoveCount / 48);
  if (context.inCheck) score += 0.22;
  if (captureMoves >= 2) score += 0.12;
  if (captureMoves >= 4) score += 0.1;
  if (context.phase === "middlegame") score += 0.08;
  if (context.phase === "endgame" && context.pieceCount <= 8) score += 0.06;
  if (context.legalMoveCount >= 32) score += 0.14;
  if (profile.personality.tacticalStrength > 0.7 && context.legalMoveCount >= 24) {
    score += 0.05;
  }
  return { score: Math.min(1, score), captureMoves };
};

const baseRangeForKind = (kind) => {
  switch (kind) {
    case "forced":
      return [50, 120];
    case "recapture":
      return [80, 200];
    case "opening":
      return [100, 250];
    case "obvious":
      return [150, 350];
    case "normal":
      return [300, 900];
    case "complicated":
      return [800, 1800];
    case "critical":
      return [1500, 2500];
    default:
      return [300, 900];
  }
};

const classifyMoveContext = (profile, context) => {
  if (context.legalMoveCount <= 1) return "forced";
  if (hasRecapture(context)) return "recapture";
  if (context.moveNumber <= 10 && context.phase === "opening") return "opening";

  const { score, captureMoves } = estimateComplexity(profile, context);

  if (context.inCheck && context.legalMoveCount <= 4 && captureMoves <= 2) {
    return "obvious";
  }
  if (
    !context.inCheck &&
    context.legalMoveCount <= 6 &&
    captureMoves <= 1 &&
    score < 0.28
  ) {
    return "obvious";
  }
  if (
    context.inCheck ||
    context.legalMoveCount >= 38 ||
    (score >= 0.78 && profile.rating >= 1600)
  ) {
    return "critical";
  }
  if (score >= 0.42 || context.legalMoveCount >= 26 || captureMoves >= 3) {
    return "complicated";
  }
  return "normal";
};

const timeTroubleCap = (clockMs, baseCap) => {
  if (clockMs <= 0) return baseCap;
  if (clockMs < 10000) return Math.min(baseCap, 120);
  if (clockMs < 20000) return Math.min(baseCap, 220);
  if (clockMs < 30000) return Math.min(baseCap, 350);
  if (clockMs < 60000) return Math.min(baseCap, Math.round(baseCap * 0.55));
  return baseCap;
};

const ratingSpeedBoost = (rating, kind) => {
  if (rating < 1800) return 1;
  if (kind === "complicated" || kind === "critical") {
    if (rating >= 2400) return 0.82;
    if (rating >= 2200) return 0.88;
    return 0.94;
  }
  if (rating >= 2400) return 0.62;
  if (rating >= 2200) return 0.72;
  if (rating >= 2000) return 0.82;
  return 0.92;
};

function buildThinkPlan(profile, context) {
  const kind = classifyMoveContext(profile, context);
  const [minMs, maxMs] = baseRangeForKind(kind);

  let maxThinkMs = jitterInRange(minMs, maxMs, context);
  maxThinkMs = Math.round(maxThinkMs * ratingSpeedBoost(profile.rating, kind));
  maxThinkMs = timeTroubleCap(context.botClockMs, maxThinkMs);
  maxThinkMs = Math.max(40, Math.min(maxThinkMs, Math.max(60, context.botClockMs - 40)));

  return { kind, maxThinkMs };
}

function bookMoveDelayMs() {
  return randBetween(80, 180);
}

function capEngineMovetime(plan, engineCapMs, clockMs) {
  const clockFractionCap =
    clockMs > 0
      ? Math.max(500, Math.min(Math.round(clockMs * 0.1), 5000))
      : engineCapMs;

  if (plan.kind === "critical" || plan.kind === "complicated") {
    return Math.min(engineCapMs, clockFractionCap);
  }

  if (clockMs > 0 && clockMs < 45000) {
    return Math.min(engineCapMs, clockFractionCap, Math.max(150, plan.maxThinkMs));
  }

  return Math.min(engineCapMs, clockFractionCap);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildThinkPlan,
  bookMoveDelayMs,
  capEngineMovetime,
  sleep,
};
