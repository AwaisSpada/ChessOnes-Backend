/**
 * Shared live-game terminal emit + ratings + persist (Phase 3).
 * Used by TimeoutManager (flag) and AbandonManager (first-move abandon).
 * Delivery via GameTransport / Domain Events (ADR-006/007).
 */

const ClockAuthority = require("./ClockAuthority");
const ClockScheduler = require("./ClockScheduler");
const { ORIGIN } = require("./events/DomainEvent");
const liveSideEffects = require("./liveSideEffects");

/** @type {import("socket.io").Server | null} */
let ioRef = null;

/** Optional hooks injected from routes/games.js to reuse ratings helpers. */
let endHooks = {
  applyRatingsForGameEnd: async () => null,
  emitGameEnded: async () => {},
  scheduleGameCompletionSideEffects: () => {},
};

function init(io, hooks = {}) {
  if (io) ioRef = io;
  endHooks = { ...endHooks, ...hooks };
}

function getIo() {
  return ioRef;
}

/**
 * @param {object} live LiveGame
 * @param {{ winner: string, reason: string }} result
 * @param {{ timedOut?: boolean, status?: string }} options
 */
async function finalizeServerEnd(live, result, options = {}) {
  if (!live || live.status !== "active") return false;

  const status =
    options.status ||
    (result.reason === "first-move-abandon" ? "abandoned" : "completed");

  live.status = status;
  live.result = result;
  ClockAuthority.bumpSyncVersion(live);
  live.updatedAtMs = Date.now();

  // Cancel timers immediately under mutation (before async ratings/emit).
  ClockScheduler.cancel(live.gameId);

  const io = getIo();
  let ratingChanges = null;
  const skipRatings = result.reason === "first-move-abandon";

  if (!skipRatings && typeof endHooks.applyRatingsForGameEnd === "function") {
    const gameDoc = live.toPlainGame ? live.toPlainGame() : live;
    ratingChanges = await endHooks.applyRatingsForGameEnd(
      live.gameId,
      io,
      gameDoc
    );
  }

  const socketPayload = ClockAuthority.withLiveSync(live, {
    gameId: live.gameId,
    board: live.board,
    gameEnded: true,
    result: live.result,
    timedOut: Boolean(options.timedOut),
    ratingChanges: ratingChanges || undefined,
    serverEventId:
      typeof live.nextServerEventId === "function"
        ? live.nextServerEventId()
        : undefined,
  });

  const gameEndedPayload = {
    gameId: live.gameId,
    result: live.result,
    ...(ratingChanges ? { ratingChanges } : {}),
    ...(socketPayload.serverEventId
      ? { serverEventId: socketPayload.serverEventId }
      : {}),
  };

  const kind =
    result.reason === "first-move-abandon"
      ? "abandon"
      : options.timedOut || result.reason === "timeout"
        ? "timeout"
        : "ended";

  const origin =
    kind === "abandon"
      ? ORIGIN.Abandon
      : kind === "timeout"
        ? ORIGIN.Timeout
        : ORIGIN.System;

  await liveSideEffects.afterServerTerminal({
    live,
    origin,
    kind,
    moveMade: socketPayload,
    gameEnded: gameEndedPayload,
    persist: false,
  });

  void liveSideEffects.persistLive(live).then(() => {
    if (typeof endHooks.scheduleGameCompletionSideEffects === "function") {
      endHooks.scheduleGameCompletionSideEffects(
        live.gameId,
        live.result,
        io,
        { skipRatings: true }
      );
    }
  });

  return true;
}

/**
 * Ratings + game-ended for a LiveGame already marked completed/abandoned
 * (e.g. checkmate via live:move). Does not bump syncVersion again.
 */
async function notifyCompletedLiveGame(live, io) {
  if (!live?.gameId || !live.result) return null;
  const socketIo = io || getIo();
  let ratingChanges = null;
  const skipRatings = live.result.reason === "first-move-abandon";
  if (!skipRatings && typeof endHooks.applyRatingsForGameEnd === "function") {
    const gameDoc = live.toPlainGame ? live.toPlainGame() : live;
    ratingChanges = await endHooks.applyRatingsForGameEnd(
      live.gameId,
      socketIo,
      gameDoc
    );
  }
  const serverEventId =
    typeof live.nextServerEventId === "function"
      ? live.nextServerEventId()
      : undefined;
  const payload = {
    gameId: live.gameId,
    result: live.result,
    ...(ratingChanges ? { ratingChanges } : {}),
    ...(serverEventId ? { serverEventId } : {}),
  };
  await liveSideEffects.afterGameEndedNotify({
    live,
    origin: ORIGIN.WS,
    gameEnded: payload,
    persist: false,
  });
  if (typeof endHooks.scheduleGameCompletionSideEffects === "function") {
    endHooks.scheduleGameCompletionSideEffects(
      live.gameId,
      live.result,
      socketIo,
      { skipRatings: true }
    );
  }
  return ratingChanges;
}

module.exports = {
  init,
  getIo,
  finalizeServerEnd,
  notifyCompletedLiveGame,
};
