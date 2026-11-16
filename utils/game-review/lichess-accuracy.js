/**
 * Faithful port of Lichess computer-analysis judgement + accuracy.
 *
 * Sources (lichess-org):
 * - scalachess core/src/main/scala/eval.scala (WinPercent, Cp.CEILING=1000)
 * - lila modules/analyse/src/main/Advice.scala (CpAdvice + MateAdvice)
 * - lila modules/analyse/src/main/AccuracyPercent.scala
 * - lila modules/analyse/src/main/AccuracyCP.scala (ACPL = ceiled consecutive eval diffs)
 * - lila modules/common/src/main/Maths.scala (harmonicMean, weightedMean, stdev)
 */

const CP_CEILING = 1000;
const WIN_CHANCE_MULTIPLIER = -0.00368208; // lila PR #11148
const JUDGEMENTS = [
  [0.3, "blunder"],
  [0.2, "mistake"],
  [0.1, "inaccuracy"],
];
/** Extra glyphs only after Lichess Advice is null. Exclusive of 0.10 inaccuracy. */
const EXCELLENT_DELTA_MIN = 0.005;
const EXCELLENT_DELTA_MAX = 0.1;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function squeeze(n, lo, hi) {
  return clamp(n, lo, hi);
}

/** Stockfish STM eval → White-POV { cp? , mate? }. ply 0 = White to move. */
function stmToWhite(evaluation, ply) {
  if (!evaluation) return null;
  const stmWhite = ply % 2 === 0;
  if (typeof evaluation.mate === "number") {
    // mate 0 = side to move is mated (fishnet Score::from_outcome)
    if (evaluation.mate === 0) {
      return stmWhite ? { mate: 0 } : { mate: 1 };
    }
    const mate = stmWhite ? evaluation.mate : -evaluation.mate;
    return { mate };
  }
  if (typeof evaluation.cp === "number") {
    const cp = stmWhite ? evaluation.cp : -evaluation.cp;
    return { cp };
  }
  return null;
}

/** Lichess Eval.forceAsCp: mate → ±CEILING (White POV). */
function forceAsCp(whiteEval) {
  if (!whiteEval) return null;
  if (typeof whiteEval.mate === "number") {
    if (whiteEval.mate === 0) return -CP_CEILING;
    return whiteEval.mate > 0 ? CP_CEILING : -CP_CEILING;
  }
  if (typeof whiteEval.cp === "number") return whiteEval.cp;
  return null;
}

/** Lichess Eval.Cp.ceiled — clamp ±1000 before ACPL diffs. */
function ceilCp(cp) {
  if (cp == null || Number.isNaN(cp)) return null;
  return clamp(cp, -CP_CEILING, CP_CEILING);
}

/**
 * AccuracyCP.diffsList — one Optional cpl per that color's move.
 * Starting color sees infosWithInitial; the other color starts at analysis.infos
 * (drop the initial eval). grouped(2); incomplete pair dropped; missing eval → null.
 *
 * White: max(0, ceil(s1) - ceil(s2)); Black: max(0, ceil(s2) - ceil(s1)).
 */
function accuracyCpDiffs(startColor, color, whiteCps) {
  if (!Array.isArray(whiteCps) || whiteCps.length < 2) return [];
  const startWhite = startColor !== "black";
  const colorWhite = color !== "black";
  const evals = colorWhite === startWhite ? whiteCps : whiteCps.slice(1);
  const diffs = [];
  for (let i = 0; i + 1 < evals.length; i += 2) {
    const s1 = ceilCp(evals[i]);
    const s2 = ceilCp(evals[i + 1]);
    if (s1 == null || s2 == null) {
      diffs.push(null);
      continue;
    }
    const sign = colorWhite ? -1 : 1;
    diffs.push(Math.max(0, (s2 - s1) * sign));
  }
  return diffs;
}

/**
 * AccuracyCP.mean — arithmetic mean of defined diffs, Math.round to Int.
 * @returns {{ white: number|null, black: number|null }}
 */
function accuracyCpMean(startColor, whiteCps) {
  const meanOf = (color) => {
    const defined = accuracyCpDiffs(startColor, color, whiteCps).filter((d) => d != null);
    if (!defined.length) return null;
    return Math.round(defined.reduce((s, v) => s + v, 0) / defined.length);
  };
  return { white: meanOf("white"), black: meanOf("black") };
}

/** Per-ply Lichess cpl from consecutive White-POV forceAsCp values. */
function plyCentipawnLoss(whiteCpBefore, whiteCpAfter, isWhiteMove) {
  const s1 = ceilCp(whiteCpBefore);
  const s2 = ceilCp(whiteCpAfter);
  if (s1 == null || s2 == null) return null;
  const sign = isWhiteMove ? -1 : 1;
  return Math.max(0, (s2 - s1) * sign);
}

/** [-1, +1] — Advice.scala WinPercent.winningChances (raw cp, not ceiled). */
function winningChances(cp) {
  const raw = 2 / (1 + Math.exp(WIN_CHANCE_MULTIPLIER * cp)) - 1;
  return clamp(raw, -1, 1);
}

/** [0, 100] — WinPercent.fromCentiPawns (ceiled ±1000). */
function winPercentFromCentiPawns(cp) {
  const ceiled = clamp(cp, -CP_CEILING, CP_CEILING);
  return 50 + 50 * winningChances(ceiled);
}

function winPercentFromWhiteEval(whiteEval) {
  const cp = forceAsCp(whiteEval);
  if (cp == null) return null;
  return winPercentFromCentiPawns(cp);
}

/**
 * AccuracyPercent.fromWinPercents
 * +1 uncertainty bonus is in source, not the public docs formula.
 */
function accuracyFromWinPercents(before, after) {
  if (after >= before) return 100;
  const winDiff = before - after;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) + -3.166924740191411;
  return clamp(raw + 1, 0, 100);
}

function playerWinPercent(whiteWinPercent, isWhiteMove) {
  if (whiteWinPercent == null) return null;
  return isWhiteMove ? whiteWinPercent : 100 - whiteWinPercent;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Population stdev (scribbr / lila Maths.standardDeviation). */
function standardDeviation(values) {
  const m = mean(values);
  if (m == null) return null;
  const variance =
    values.reduce((sum, x) => sum + (x - m) * (x - m), 0) / values.length;
  return Math.sqrt(variance);
}

/** harmonicMean: divisor floored at 1 (lila Maths.scala). */
function harmonicMean(values) {
  if (!values.length) return null;
  const denom = values.reduce((acc, v) => acc + 1 / Math.max(1, v), 0);
  if (denom === 0) return null;
  return values.length / denom;
}

function weightedMean(pairs) {
  if (!pairs.length) return null;
  let av = 0;
  let aw = 0;
  for (const [v, w] of pairs) {
    av += v * w;
    aw += w;
  }
  if (aw === 0) return null;
  return av / aw;
}

function sliding(arr, size) {
  const out = [];
  if (size <= 0) return out;
  for (let i = 0; i + size <= arr.length; i++) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function windowSequence(winPercents) {
  if (winPercents.some((w) => w == null || Number.isNaN(w))) return null;
  return winPercents;
}

/**
 * AccuracyPercent.gameAccuracy(startColor, cps: List[Option[Cp]])
 * @param {"white"|"black"} startColor
 * @param {(number|null)[]} whiteCps  N+1 White-POV centipawns (forceAsCp)
 * @returns {{ white: number|null, black: number|null }}
 */
function gameAccuracy(startColor, whiteCps) {
  const startWhite = startColor !== "black";
  const allWinPercents = whiteCps.map((cp) =>
    cp == null || Number.isNaN(cp) ? null : winPercentFromCentiPawns(cp)
  );
  const n = allWinPercents.length;
  const windowSize = squeeze(Math.trunc((n - 1) / 10), 2, 8);
  const prefixCount = Math.max(0, Math.min(windowSize, n) - 2);
  const firstWindow = allWinPercents.slice(0, windowSize);
  const windows = [
    ...Array.from({ length: prefixCount }, () => firstWindow),
    ...sliding(allWinPercents, windowSize),
  ];

  const weights = windows.map((window) => {
    const seq = windowSequence(window);
    if (!seq) return null;
    const sd = standardDeviation(seq);
    if (sd == null) return null;
    return squeeze(sd, 0.5, 12);
  });

  const pairs = [];
  const slides = sliding(allWinPercents, 2);
  const count = Math.min(slides.length, weights.length);
  for (let i = 0; i < count; i++) {
    const [prev, next] = slides[i];
    const weight = weights[i];
    const isWhiteMove = i % 2 === 0 ? startWhite : !startWhite;
    const color = isWhiteMove ? "white" : "black";
    let weighted = null;
    if (prev != null && next != null && weight != null) {
      const before = isWhiteMove ? prev : next;
      const after = isWhiteMove ? next : prev;
      const accuracy = accuracyFromWinPercents(before, after);
      weighted = [accuracy, weight];
    }
    pairs.push({ weighted, color });
  }

  const colorAccuracy = (color) => {
    const weightedPairs = pairs
      .filter((p) => p.color === color && p.weighted)
      .map((p) => p.weighted);
    const accuracies = pairs
      .filter((p) => p.color === color && p.weighted)
      .map((p) => p.weighted[0]);
    const weighted = weightedMean(weightedPairs);
    const harmonic = harmonicMean(accuracies);
    if (weighted == null || harmonic == null) return null;
    return (weighted + harmonic) / 2;
  };

  return { white: colorAccuracy("white"), black: colorAccuracy("black") };
}

const PHASE_NAMES = ["opening", "middlegame", "endgame"];

function phaseOfPly(ply, middle, end) {
  if (middle == null) return null;
  if (ply < middle) return "opening";
  if (end != null && end <= ply) return "endgame";
  return "middlegame";
}

/**
 * AccuracyPercent.phaseAccuracies(div, analysis)
 * Reuses gameAccuracy on each phase's eval slice (infosWithInitial filter).
 * @param {{ middle: number|null, end: number|null }} div
 * @param {(number|null)[]} whiteCps
 */
function phaseAccuracies(div, whiteCps) {
  const empty = { white: {}, black: {} };
  if (!div || div.middle == null || !Array.isArray(whiteCps) || whiteCps.length < 2) {
    return empty;
  }
  const n = whiteCps.length;
  const out = { white: {}, black: {} };
  for (const phase of PHASE_NAMES) {
    const slice = [];
    let firstPly = null;
    for (let ply = 0; ply < n; ply++) {
      const here = phaseOfPly(ply, div.middle, div.end);
      const next = phaseOfPly(ply + 1, div.middle, div.end);
      if (here === phase || next === phase) {
        if (firstPly == null) firstPly = ply;
        slice.push(whiteCps[ply]);
      }
    }
    if (firstPly == null || slice.length < 2) continue;
    const startColor = firstPly % 2 === 0 ? "white" : "black";
    const acc = gameAccuracy(startColor, slice);
    if (acc.white != null) out.white[phase] = Math.round(acc.white);
    if (acc.black != null) out.black[phase] = Math.round(acc.black);
  }
  return out;
}

function invertMate(mate, isBlackMove) {
  if (mate == null) return null;
  return isBlackMove ? -mate : mate;
}

function invertCp(cp, isBlackMove) {
  if (cp == null) return null;
  return isBlackMove ? -cp : cp;
}

/**
 * MateAdvice — evals are White POV (same as lila Info).
 * invertIf black → mover POV.
 */
function mateAdvice(prevWhite, nextWhite, isWhiteMove) {
  const isBlackMove = !isWhiteMove;
  const prevMate = invertMate(
    prevWhite && typeof prevWhite.mate === "number" ? prevWhite.mate : null,
    isBlackMove
  );
  const nextMate = invertMate(
    nextWhite && typeof nextWhite.mate === "number" ? nextWhite.mate : null,
    isBlackMove
  );
  const prevCp = invertCp(
    prevWhite && typeof prevWhite.cp === "number" ? prevWhite.cp : null,
    isBlackMove
  );
  const nextCp = invertCp(
    nextWhite && typeof nextWhite.cp === "number" ? nextWhite.cp : null,
    isBlackMove
  );

  let sequence = null;
  if (prevMate == null && nextMate != null && nextMate < 0) sequence = "MateCreated";
  else if (prevMate != null && prevMate > 0 && nextMate == null) sequence = "MateLost";
  else if (prevMate != null && prevMate > 0 && nextMate != null && nextMate < 0) {
    sequence = "MateLost";
  }
  if (!sequence) return null;

  const prevCpVal = prevCp == null ? 0 : prevCp;
  const nextCpVal = nextCp == null ? 0 : nextCp;

  if (sequence === "MateCreated") {
    if (prevCpVal < -999) return { judgement: "inaccuracy", sequence };
    if (prevCpVal < -700) return { judgement: "mistake", sequence };
    return { judgement: "blunder", sequence };
  }
  if (sequence === "MateLost") {
    if (nextCpVal > 999) return { judgement: "inaccuracy", sequence };
    if (nextCpVal > 700) return { judgement: "mistake", sequence };
    return { judgement: "blunder", sequence };
  }
  return null;
}

/** CpAdvice.scala — both sides must have cp (not mate-only). */
function cpAdvice(prevWhite, nextWhite, isWhiteMove) {
  const delta = moverWinChanceDelta(prevWhite, nextWhite, isWhiteMove);
  if (delta == null) return null;
  for (const [threshold, name] of JUDGEMENTS) {
    if (threshold <= delta) return name;
  }
  return null;
}

/**
 * Mover's winning-chance drop (Lichess CpAdvice Δ).
 * White: WC_before − WC_after; Black: WC_after − WC_before.
 */
function moverWinChanceDelta(prevWhite, nextWhite, isWhiteMove) {
  if (!prevWhite || typeof prevWhite.cp !== "number") return null;
  if (!nextWhite || typeof nextWhite.cp !== "number") return null;
  const prevWC = winningChances(prevWhite.cp);
  const currentWC = winningChances(nextWhite.cp);
  const delta = currentWC - prevWC;
  return isWhiteMove ? -delta : delta;
}

/**
 * Full review glyph. Lichess Advice first (inaccuracy/mistake/blunder unchanged).
 * Book (opening table) before Best — theory stays Book even if it is engine #1.
 * Then Best, then Excellent (0.005 ≤ Δ < 0.10).
 */
function qualityLabel({ judgement, isBestMove, isBookMove, delta }) {
  if (judgement === "blunder" || judgement === "mistake" || judgement === "inaccuracy") {
    return judgement;
  }
  if (isBookMove) return "book";
  if (isBestMove) return "best";
  if (delta != null && delta >= EXCELLENT_DELTA_MIN && delta < EXCELLENT_DELTA_MAX) {
    return "excellent";
  }
  return null;
}

function judgementName(judgement) {
  if (judgement === "inaccuracy") return "Inaccuracy";
  if (judgement === "mistake") return "Mistake";
  if (judgement === "blunder") return "Blunder";
  if (judgement === "excellent") return "Excellent";
  return "";
}

function evalComment(whiteEval) {
  if (!whiteEval) return "";
  if (typeof whiteEval.mate === "number") return `#${whiteEval.mate}`;
  if (typeof whiteEval.cp === "number") {
    const pawns = whiteEval.cp / 100;
    return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
  }
  return "";
}

/**
 * Advice.makeComment(withEval=true, withBestMove=true)
 * e.g. "(+0.32 → -1.14) Inaccuracy. Nf3 was best."
 */
function makeComment(advice, prevWhite, nextWhite, bestSan) {
  if (!advice || !advice.judgement) return "";
  const prevC = evalComment(prevWhite);
  const nextC = evalComment(nextWhite);
  const evalPart = prevC && nextC ? `(${prevC} → ${nextC}) ` : "";
  let body = judgementName(advice.judgement);
  if (advice.sequence === "MateCreated") body = "Checkmate is now unavoidable";
  else if (advice.sequence === "MateLost") body = "Lost forced checkmate sequence";
  let comment = `${evalPart}${body}.`;
  if (bestSan) comment += ` ${bestSan} was best.`;
  return comment;
}

/** Advice.apply = CpAdvice orElse MateAdvice */
function adviseMoveFull(prevWhite, nextWhite, isWhiteMove) {
  const cp = cpAdvice(prevWhite, nextWhite, isWhiteMove);
  if (cp) return { judgement: cp, sequence: null };
  return mateAdvice(prevWhite, nextWhite, isWhiteMove);
}

function adviseMove(prevWhite, nextWhite, isWhiteMove) {
  const full = adviseMoveFull(prevWhite, nextWhite, isWhiteMove);
  return full ? full.judgement : null;
}

function round1(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

module.exports = {
  CP_CEILING,
  stmToWhite,
  forceAsCp,
  ceilCp,
  accuracyCpDiffs,
  accuracyCpMean,
  plyCentipawnLoss,
  winningChances,
  winPercentFromCentiPawns,
  winPercentFromWhiteEval,
  accuracyFromWinPercents,
  playerWinPercent,
  gameAccuracy,
  phaseAccuracies,
  phaseOfPly,
  adviseMove,
  adviseMoveFull,
  moverWinChanceDelta,
  qualityLabel,
  EXCELLENT_DELTA_MIN,
  EXCELLENT_DELTA_MAX,
  makeComment,
  evalComment,
  round1,
};
