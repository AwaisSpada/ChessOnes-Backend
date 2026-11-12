/**
 * Weak-club bots (≤1250): Skill 0, nodes-only, MultiPV 8→4, table dice.
 * Mate / free piece / hanging / random-legal — not the old 2nd-PV mistake layer.
 */

const { Chess } = require("chess.js");

const PRESETS = [
  { maxElo: 500, skill: 0, nodes: 2000, multipv: 8, randomLegal: 0.2, mateIn1: 0.55, takeFree: 0.65, noticeHang: 0.5 },
  { maxElo: 750, skill: 0, nodes: 3000, multipv: 7, randomLegal: 0.14, mateIn1: 0.65, takeFree: 0.75, noticeHang: 0.6 },
  { maxElo: 900, skill: 0, nodes: 5000, multipv: 6, randomLegal: 0.09, mateIn1: 0.75, takeFree: 0.85, noticeHang: 0.7 },
  { maxElo: 1100, skill: 0, nodes: 8000, multipv: 5, randomLegal: 0.05, mateIn1: 0.85, takeFree: 0.92, noticeHang: 0.8 },
  { maxElo: 1250, skill: 0, nodes: 12000, multipv: 4, randomLegal: 0.035, mateIn1: 0.9, takeFree: 0.95, noticeHang: 0.86 },
];

const LOOSE_WEIGHTS = [0.22, 0.18, 0.14, 0.12, 0.11, 0.09, 0.08, 0.06];
const TIGHT_WEIGHTS = [0.7, 0.14, 0.06, 0.04, 0.03, 0.016, 0.009, 0.005];

function getWeakClubPlayConfig(elo) {
  const rating = Math.max(500, Math.round(Number(elo) || 500));
  const preset = PRESETS.find((p) => rating <= p.maxElo) || PRESETS[PRESETS.length - 1];
  return { ...preset, rating };
}

function weakClubCandidateWeights(elo) {
  const play = getWeakClubPlayConfig(elo);
  const n = Math.max(1, Math.min(8, play.multipv || 8));
  const t = Math.max(0, Math.min(1, (Math.round(Number(elo) || 500) - 500) / 750));
  const w = LOOSE_WEIGHTS.slice(0, n).map(
    (a, i) => a + (TIGHT_WEIGHTS[i] - a) * t
  );
  const sum = w.reduce((s, x) => s + x, 0) || 1;
  return w.map((x) => x / sum);
}

function toUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function pickUci(ucis) {
  if (!ucis.length) return "";
  return ucis[Math.floor(Math.random() * ucis.length)];
}

function findMateInOne(fen) {
  const chess = new Chess(fen);
  const hits = [];
  for (const move of chess.moves({ verbose: true })) {
    const next = new Chess(fen);
    try {
      if (!next.move(move)) continue;
    } catch {
      continue;
    }
    if (next.isCheckmate()) hits.push(toUci(move));
  }
  return hits;
}

function findFreeCaptures(fen) {
  const chess = new Chess(fen);
  const them = chess.turn() === "w" ? "b" : "w";
  const hits = [];
  for (const move of chess.moves({ verbose: true })) {
    if (!move.captured) continue;
    try {
      if (!chess.isAttacked(move.to, them)) hits.push(toUci(move));
    } catch {
      // ignore
    }
  }
  return hits;
}

function findHangingSaves(fen) {
  const chess = new Chess(fen);
  const us = chess.turn();
  const them = us === "w" ? "b" : "w";
  const hanging = [];
  const squares = [];
  for (const file of "abcdefgh") {
    for (let rank = 1; rank <= 8; rank += 1) squares.push(`${file}${rank}`);
  }
  for (const sq of squares) {
    const piece = chess.get(sq);
    if (!piece || piece.color !== us || piece.type === "k") continue;
    try {
      if (chess.isAttacked(sq, them) && !chess.isAttacked(sq, us)) hanging.push(sq);
    } catch {
      // ignore
    }
  }
  if (!hanging.length) return [];
  const hangSet = new Set(hanging);
  const saves = [];
  for (const move of chess.moves({ verbose: true })) {
    if (hangSet.has(move.from)) saves.push(toUci(move));
  }
  return saves;
}

function randomLegalUci(fen, exceptUci) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length < 2) return "";
  const others = moves.filter((move) => toUci(move) !== exceptUci);
  const pool = others.length ? others : moves;
  return toUci(pool[Math.floor(Math.random() * pool.length)]);
}

/**
 * Table dice after a MultiPV-8 candidate is chosen.
 * Refused mate-in-1 is excluded from the kept candidate.
 */
function applyWeakClubBehavior(selected, fen, profile) {
  const cfg = getWeakClubPlayConfig(profile?.rating);
  let kept = selected?.uci ? { ...selected } : { uci: "", rank: 1 };

  try {
    const mates = findMateInOne(fen);
    if (mates.length) {
      if (Math.random() < cfg.mateIn1) {
        return { uci: pickUci(mates), rank: 1, reason: "mate-in-1" };
      }
      if (mates.includes(kept.uci)) kept = { uci: "", rank: 1 };
    }

    const frees = findFreeCaptures(fen);
    if (frees.length && Math.random() < cfg.takeFree) {
      return { uci: pickUci(frees), rank: 1, reason: "free-piece" };
    }

    const saves = findHangingSaves(fen);
    if (saves.length && Math.random() < cfg.noticeHang) {
      return { uci: pickUci(saves), rank: 1, reason: "save-hang" };
    }

    if (Math.random() < cfg.randomLegal) {
      const uci = randomLegalUci(fen, kept.uci);
      if (uci) return { uci, rank: 99, reason: "random-legal" };
    }
  } catch {
    return kept;
  }

  return kept;
}

module.exports = {
  PRESETS,
  getWeakClubPlayConfig,
  weakClubCandidateWeights,
  applyWeakClubBehavior,
};
