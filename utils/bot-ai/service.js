/**
 * Port of mobile `src/bot/BotAIService.ts` — decision pipeline for bot moves.
 * Engine search is injected so this stays independent of Stockfish process I/O.
 */

const { Chess } = require("chess.js");
const { configureEngineForBot } = require("./engineConfigurator");
const { applyMistakeLayer } = require("./mistakeGenerator");
const { selectEngineMove, shouldUseKillerInstinct } = require("./moveSelector");
const { tryOpeningBookMove } = require("./openingBook");
const {
  bookMoveDelayMs,
  buildThinkPlan,
  capEngineMovetime,
  sleep,
} = require("./timeManager");
const { detectGamePhase, pieceCountFromFen } = require("./difficultyMapper");

const pickFallbackMove = (fen) => {
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ verbose: true });
    if (moves.length === 0) return "";
    const move = moves[Math.floor(Math.random() * moves.length)];
    return `${move.from}${move.to}${move.promotion || ""}`;
  } catch {
    return "";
  }
};

const normalizeToLegalUci = (fen, uci) => {
  if (!uci || uci.length < 4) return "";
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ verbose: true });
    const exact = moves.find(
      (move) => `${move.from}${move.to}${move.promotion || ""}` === uci
    );
    if (exact) return uci;

    const fromTo = uci.slice(0, 4);
    const matches = moves.filter((move) => `${move.from}${move.to}` === fromTo);
    if (matches.length === 0) return "";

    const preferred =
      matches.find((move) => move.promotion === "q") ||
      matches.find((move) => !move.promotion) ||
      matches[0];
    return `${preferred.from}${preferred.to}${preferred.promotion || ""}`;
  } catch {
    return "";
  }
};

/**
 * @param {{
 *   profile: object,
 *   context: object,
 *   botColor: 'white'|'black',
 *   searchEngine: (fen: string, engineConfig: object) => Promise<{ bestMoveUci: string, lines: object[] }>,
 * }} args
 */
async function pickBotMove({ profile, context, botColor, searchEngine }) {
  const startedAt = Date.now();

  const bookMove = tryOpeningBookMove(profile, context);
  if (bookMove) {
    try {
      const chess = new Chess(context.fen);
      const isLegal = chess.moves({ verbose: true }).some((move) => {
        const uci = `${move.from}${move.to}${move.promotion || ""}`;
        return uci === bookMove;
      });
      if (isLegal) {
        await sleep(bookMoveDelayMs());
        const uci = normalizeToLegalUci(context.fen, bookMove);
        if (uci) {
          const plan = buildThinkPlan(profile, context);
          return {
            uci,
            source: "book",
            thinkPlan: plan,
            selectedRank: 1,
            elapsedMs: Date.now() - startedAt,
          };
        }
      }
    } catch {
      // fall through
    }
  }

  const thinkPlan = buildThinkPlan(profile, context);
  const engineConfig = configureEngineForBot(profile, context, botColor);
  engineConfig.search.movetime = capEngineMovetime(
    thinkPlan,
    engineConfig.search.movetime,
    context.botClockMs
  );

  let search;
  try {
    search = await searchEngine(context.fen, engineConfig);
  } catch (err) {
    const fallback = normalizeToLegalUci(context.fen, pickFallbackMove(context.fen));
    return {
      uci: fallback,
      source: "fallback",
      thinkPlan,
      selectedRank: 1,
      elapsedMs: Date.now() - startedAt,
      error: err?.message,
    };
  }

  const phase = detectGamePhase(context.fen);
  const lines = Array.isArray(search?.lines) ? search.lines : [];
  const killer = shouldUseKillerInstinct(lines, phase, profile.rating);
  let selected = selectEngineMove(lines, profile, { killerInstinct: killer });

  if (!selected.uci && search?.bestMoveUci) {
    selected = { uci: search.bestMoveUci, rank: 1 };
  }

  if (!killer) {
    selected = applyMistakeLayer(selected, lines, profile, {
      inCheck: context.inCheck,
      legalMoveCount: context.legalMoveCount,
      botClockMs: context.botClockMs,
      phase,
    });
  }

  if (!selected.uci) {
    const fallback = normalizeToLegalUci(context.fen, pickFallbackMove(context.fen));
    return {
      uci: fallback,
      source: "fallback",
      thinkPlan,
      selectedRank: 1,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const uci = normalizeToLegalUci(context.fen, selected.uci);
  if (!uci) {
    const fallback = normalizeToLegalUci(context.fen, pickFallbackMove(context.fen));
    return {
      uci: fallback,
      source: "fallback",
      thinkPlan,
      selectedRank: 1,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // Fast server engines finish early — pad toward human think plan / movetime (mobile wall-clock).
  const elapsed = Date.now() - startedAt;
  const targetMs = Math.min(
    thinkPlan.maxThinkMs,
    Math.max(80, engineConfig.search.movetime)
  );
  if (elapsed < targetMs) {
    await sleep(targetMs - elapsed);
  }

  return {
    uci,
    source: "engine",
    thinkPlan,
    selectedRank: selected.rank,
    elapsedMs: Date.now() - startedAt,
  };
}

function buildPositionContext({
  fen,
  uciHistory,
  botClockMs,
  opponentClockMs,
  incrementMs,
  lastMoveUci,
  lastMoveWasCapture,
}) {
  let legalMoveCount = 0;
  let inCheck = false;
  try {
    const chess = new Chess(fen);
    legalMoveCount = chess.moves().length;
    inCheck =
      typeof chess.isCheck === "function" ? chess.isCheck() : chess.inCheck();
  } catch {
    legalMoveCount = 0;
  }

  return {
    fen,
    phase: detectGamePhase(fen),
    pieceCount: pieceCountFromFen(fen),
    legalMoveCount,
    inCheck,
    moveNumber: uciHistory.length,
    uciHistory,
    lastMoveUci,
    lastMoveWasCapture: Boolean(lastMoveWasCapture),
    botClockMs: typeof botClockMs === "number" && botClockMs > 0 ? botClockMs : 600000,
    opponentClockMs:
      typeof opponentClockMs === "number" && opponentClockMs > 0
        ? opponentClockMs
        : 600000,
    incrementMs: typeof incrementMs === "number" ? incrementMs : 0,
  };
}

module.exports = {
  pickBotMove,
  buildPositionContext,
  normalizeToLegalUci,
};
