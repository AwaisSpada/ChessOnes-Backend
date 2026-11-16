/**
 * Review eval cache (Lichess FishnetEvalCache analogue).
 * Hit only when the stored search is at least as strong as the request.
 * Fast may reuse Standard/Maximum. Maximum never reuses Fast.
 */

const { Chess } = require("chess.js");

const MAX = 8000;
/** fenKey -> { budgetNodes, result } */
const store = new Map();

function fenKeyFromMoves(moves) {
  const board = new Chess();
  for (const uci of moves || []) {
    const played = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    if (!played) return null;
  }
  const parts = board.fen().split(" ");
  return parts.slice(0, 4).join(" ");
}

function cloneResult(result) {
  if (!result) return null;
  return JSON.parse(JSON.stringify(result));
}

function touch(key, entry) {
  store.delete(key);
  store.set(key, entry);
}

function get(moves, minNodes) {
  const key = fenKeyFromMoves(moves);
  if (!key) return null;
  const entry = store.get(key);
  if (!entry || !entry.result) return null;
  const needed = Math.max(0, Number(minNodes) || 0);
  const terminal = Boolean(entry.result.fishnetSkippedSearch);
  if (!terminal && entry.budgetNodes < needed) return null;
  touch(key, entry);
  return cloneResult(entry.result);
}

function set(moves, result, budgetNodes) {
  if (!result || result.error || !result.evaluation) return;
  if (!result.depth && !result.fishnetSkippedSearch) return;
  const key = fenKeyFromMoves(moves);
  if (!key) return;
  const budget = result.fishnetSkippedSearch
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, Number(budgetNodes) || result.nodes || 0);
  const existing = store.get(key);
  if (existing && existing.budgetNodes >= budget) {
    touch(key, existing);
    return;
  }
  touch(key, { budgetNodes: budget, result: cloneResult(result) });
  while (store.size > MAX) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

function skipIndices(allMoves, minNodes) {
  const skip = [];
  for (let ply = 0; ply <= allMoves.length; ply++) {
    if (get(allMoves.slice(0, ply), minNodes)) skip.push(ply);
  }
  return skip;
}

module.exports = { fenKeyFromMoves, get, set, skipIndices };
