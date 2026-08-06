/**
 * Live human games (matchmaking / friends / arena) — server clock + sync metadata.
 * Bot games intentionally keep the older client-driven clock path.
 */

function isLiveHumanGame(game) {
  if (!game) return false;
  return game.type === "multiplayer" || game.type === "friend";
}

function ensureTimeRemaining(game, fallbackMs = 600000) {
  if (
    !game.timeRemaining ||
    typeof game.timeRemaining.white !== "number" ||
    typeof game.timeRemaining.black !== "number"
  ) {
    game.timeRemaining = {
      white:
        typeof game.timeRemaining?.white === "number"
          ? game.timeRemaining.white
          : fallbackMs,
      black:
        typeof game.timeRemaining?.black === "number"
          ? game.timeRemaining.black
          : fallbackMs,
    };
  }
  return game.timeRemaining;
}

function getLastClockAnchorMs(game) {
  if (game.moves && game.moves.length > 0) {
    const lastMove = game.moves[game.moves.length - 1];
    if (lastMove?.timestamp) {
      return new Date(lastMove.timestamp).getTime();
    }
  }
  if (game.clockStartedAt) {
    return new Date(game.clockStartedAt).getTime();
  }
  return null;
}

/**
 * Effective clocks for GET / snapshot (does not mutate DB doc permanently).
 * Clocks only drain after the game has started (has moves) or clockStartedAt is set.
 */
function getEffectiveTimeRemaining(game, now = Date.now()) {
  ensureTimeRemaining(game);
  const effective = {
    white: game.timeRemaining.white,
    black: game.timeRemaining.black,
  };

  if (game.status !== "active") return effective;

  const gameHasStarted =
    (game.moves && game.moves.length > 0) || Boolean(game.clockStartedAt);
  if (!gameHasStarted) return effective;

  const anchor = getLastClockAnchorMs(game);
  if (!anchor) return effective;

  const elapsed = Math.max(0, now - anchor);
  if (game.currentTurn === "white") {
    effective.white = Math.max(0, effective.white - elapsed);
  } else if (game.currentTurn === "black") {
    effective.black = Math.max(0, effective.black - elapsed);
  }
  return effective;
}

/**
 * Mutate game.timeRemaining by deducting elapsed for the side to move.
 * Call BEFORE applying a live human move. Returns timeout info.
 */
function applyServerElapsedClock(game, now = Date.now()) {
  ensureTimeRemaining(game);

  const initial = game.timeControl?.initial;
  const untimed = typeof initial === "number" && initial <= 0;
  if (untimed) {
    return { timedOut: false, elapsedMs: 0, side: game.currentTurn };
  }

  const gameHasStarted =
    (game.moves && game.moves.length > 0) || Boolean(game.clockStartedAt);
  if (!gameHasStarted) {
    return { timedOut: false, elapsedMs: 0, side: game.currentTurn };
  }

  const anchor = getLastClockAnchorMs(game);
  if (!anchor) {
    return { timedOut: false, elapsedMs: 0, side: game.currentTurn };
  }

  const side = game.currentTurn;
  const elapsedMs = Math.max(0, now - anchor);
  const before = game.timeRemaining[side];
  game.timeRemaining[side] = Math.max(0, before - elapsedMs);

  return {
    timedOut: game.timeRemaining[side] <= 0,
    elapsedMs,
    side,
    remainingMs: game.timeRemaining[side],
  };
}

function bumpSyncVersion(game) {
  const cur = typeof game.syncVersion === "number" ? game.syncVersion : 0;
  game.syncVersion = cur + 1;
  return game.syncVersion;
}

function getPly(game) {
  return Array.isArray(game.moves) ? game.moves.length : 0;
}

/**
 * Fields every live client must use for sync (move-made, GET, snapshot).
 */
function buildLiveSyncFields(game, overrides = {}) {
  const now = Date.now();
  const timeRemaining =
    overrides.timeRemaining ||
    (game.status === "active"
      ? getEffectiveTimeRemaining(game, now)
      : {
          white: game.timeRemaining?.white,
          black: game.timeRemaining?.black,
        });

  return {
    syncVersion:
      typeof game.syncVersion === "number" ? game.syncVersion : 0,
    ply: getPly(game),
    serverNow: now,
    currentTurn: game.currentTurn,
    timeRemaining: {
      white: timeRemaining?.white,
      black: timeRemaining?.black,
    },
    status: game.status,
  };
}

function withLiveSync(game, payload = {}, overrides = {}) {
  return {
    ...payload,
    ...buildLiveSyncFields(game, overrides),
  };
}

module.exports = {
  isLiveHumanGame,
  ensureTimeRemaining,
  getEffectiveTimeRemaining,
  applyServerElapsedClock,
  bumpSyncVersion,
  getPly,
  buildLiveSyncFields,
  withLiveSync,
};
