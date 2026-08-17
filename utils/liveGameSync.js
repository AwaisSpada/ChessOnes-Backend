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
 * Compute elapsed drain for the side to move WITHOUT mutating storedRemaining.
 * Callers must commit via commitElapsedClock only in the same transition as a
 * new clock anchor (new move timestamp) or a terminal flag (status leaves active).
 *
 * @returns {{ timedOut: boolean, elapsedMs: number, side: string, remainingMs?: number }}
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
  const remainingMs = Math.max(0, before - elapsedMs);

  return {
    timedOut: remainingMs <= 0,
    elapsedMs,
    side,
    remainingMs,
  };
}

/**
 * Write a prior applyServerElapsedClock result into storedRemaining.
 * ONLY call when establishing a new move timestamp or ending the game on flag
 * in the same authoritative transition.
 */
function commitElapsedClock(game, clockResult) {
  if (!game || !clockResult) return;
  const side = clockResult.side;
  if (side !== "white" && side !== "black") return;
  if (typeof clockResult.remainingMs !== "number") return;
  ensureTimeRemaining(game);
  game.timeRemaining[side] = Math.max(0, clockResult.remainingMs);
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
    clockStartedAt: game.clockStartedAt || null,
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
  commitElapsedClock,
  bumpSyncVersion,
  getPly,
  buildLiveSyncFields,
  withLiveSync,
};
