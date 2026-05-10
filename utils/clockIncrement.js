/**
 * Normalize stored increment to milliseconds.
 * Older docs may store seconds (1–60); current API uses ms (e.g. 5000 for +5s).
 */
function normalizeIncrementToMs(incrementRaw) {
  if (
    typeof incrementRaw !== "number" ||
    !Number.isFinite(incrementRaw) ||
    incrementRaw <= 0
  ) {
    return 0;
  }
  return incrementRaw > 0 && incrementRaw <= 60
    ? incrementRaw * 1000
    : incrementRaw;
}

/**
 * After a legal move is recorded, add Fischer increment to the side that moved.
 * Skips untimed games (initial <= 0) and zero increment.
 */
function applyFischerIncrementToMover(game, moverColor) {
  if (!game?.timeControl || !game.timeRemaining) return;
  if (moverColor !== "white" && moverColor !== "black") return;

  const initial = game.timeControl.initial;
  if (typeof initial !== "number" || initial <= 0) return;

  const incMs = normalizeIncrementToMs(
    typeof game.timeControl.increment === "number"
      ? game.timeControl.increment
      : 0
  );
  if (incMs <= 0) return;

  const cur = game.timeRemaining[moverColor];
  if (typeof cur !== "number" || !Number.isFinite(cur)) return;

  game.timeRemaining[moverColor] = Math.max(0, cur + incMs);
}

module.exports = {
  normalizeIncrementToMs,
  applyFischerIncrementToMover,
};
