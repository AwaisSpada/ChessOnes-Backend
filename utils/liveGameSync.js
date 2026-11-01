/**
 * Live human games (matchmaking / friends / arena) — server clock + sync metadata.
 * Timed bot games use the same remaining/anchor formula on move + GET; they do
 * not use LiveGame RAM or client-trusted timeRemaining.
 */

function isLiveHumanGame(game) {
  if (!game) return false;
  return game.type === "multiplayer" || game.type === "friend";
}

function isBotTimedGame(game) {
  if (!game || game.type !== "bot") return false;
  const initial = game.timeControl?.initial;
  return typeof initial === "number" && initial > 0;
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
  // Timed bot undo: remaining was restored; drain must restart from that instant.
  // Live/friend games never set clockAnchorAt — same last-move / clockStartedAt path.
  if (isBotTimedGame(game) && game.clockAnchorAt) {
    const t = new Date(game.clockAnchorAt).getTime();
    if (Number.isFinite(t)) return t;
  }
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

function thinkMsForUndoneMove(move, previousTimestamp, clockStartedAt) {
  if (
    typeof move?.moveTimeMs === "number" &&
    Number.isFinite(move.moveTimeMs) &&
    move.moveTimeMs > 0
  ) {
    return move.moveTimeMs;
  }
  const prev = previousTimestamp || clockStartedAt;
  if (!prev || !move?.timestamp) return 0;
  const delta =
    new Date(move.timestamp).getTime() - new Date(prev).getTime();
  return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

/**
 * Chess.com-style takeback clocks for timed bot games only.
 * Call AFTER splicing undone plies. Last undone ply is the opponent (undo is on user's turn).
 * Then set clockAnchorAt so GET/move do not re-drain the refunded think time.
 */
function refundBotClocksAfterTakeback(game, undoneMoves, playerColor) {
  if (!isBotTimedGame(game)) return;
  if (!Array.isArray(undoneMoves) || undoneMoves.length === 0) return;
  if (playerColor !== "white" && playerColor !== "black") return;

  ensureTimeRemaining(game);
  const { normalizeIncrementToMs } = require("./clockIncrement");
  const incMs = normalizeIncrementToMs(
    typeof game.timeControl?.increment === "number"
      ? game.timeControl.increment
      : 0
  );

  let mover = playerColor === "white" ? "black" : "white";
  for (let i = undoneMoves.length - 1; i >= 0; i--) {
    const move = undoneMoves[i];
    const prevTs =
      i > 0
        ? undoneMoves[i - 1]?.timestamp
        : game.moves && game.moves.length > 0
          ? game.moves[game.moves.length - 1]?.timestamp
          : game.clockStartedAt;
    const think = thinkMsForUndoneMove(move, prevTs, game.clockStartedAt);
    const cur = game.timeRemaining[mover];
    if (typeof cur === "number" && Number.isFinite(cur)) {
      game.timeRemaining[mover] = Math.max(0, cur - incMs + think);
    }
    mover = mover === "white" ? "black" : "white";
  }

  game.clockAnchorAt = new Date();
}

function clearBotClockAnchor(game) {
  if (!game || !isBotTimedGame(game)) return;
  if (game.clockAnchorAt) game.clockAnchorAt = null;
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
  isBotTimedGame,
  ensureTimeRemaining,
  getEffectiveTimeRemaining,
  applyServerElapsedClock,
  commitElapsedClock,
  bumpSyncVersion,
  getPly,
  buildLiveSyncFields,
  withLiveSync,
  refundBotClocksAfterTakeback,
  clearBotClockAnchor,
};
