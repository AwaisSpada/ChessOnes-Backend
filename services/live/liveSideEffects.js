/**
 * Live side-effects facade (ADR-006 + ADR-007).
 *
 * LIVE_DOMAIN_EVENTS OFF: GameTransport + PersistenceQueue + ClockScheduler directly.
 * LIVE_DOMAIN_EVENTS ON: publish Domain Events → Projection → Persist → Schedule.
 *
 * Never mutates LiveGame from this module except via caller-owned live.rescheduleClocks
 * on the flag-off path (scheduler only — same as today).
 */

const { LIVE_DOMAIN_EVENTS } = require("./flags");
const PersistenceQueue = require("./PersistenceQueue");
const {
  getGameTransport,
  tryGetGameTransport,
} = require("./transport");
const events = require("./events");
const DirtyGame = require("./events/DirtyGame");

function transportOrNull() {
  return tryGetGameTransport();
}

async function persistLive(live) {
  if (!live?.gameId) return;
  try {
    await PersistenceQueue.enqueueLiveGamePersist(live);
    DirtyGame.clear(live.gameId);
  } catch (err) {
    DirtyGame.mark(live.gameId, {
      syncVersion: live.syncVersion,
      error: err,
    });
    console.error(
      `[live] PersistenceQueue failed game=${live.gameId}:`,
      err?.message || err
    );
  }
}

/**
 * After a successful move apply (active or terminal-by-move).
 */
async function afterMoveApplied({
  live,
  origin,
  moveMade,
  moveAccepted,
  userId,
  socketRef,
  requestId,
  persist = true,
  reschedule = true,
}) {
  if (LIVE_DOMAIN_EVENTS) {
    await events.publishMoveApplied({
      live,
      origin,
      moveMade,
      moveAccepted,
      userId,
      socketRef,
      requestId,
    });
    return;
  }

  const t = getGameTransport();
  if (moveMade) {
    const userIds = [];
    if (live?.players?.white != null) userIds.push(String(live.players.white));
    if (live?.players?.black != null) userIds.push(String(live.players.black));
    t.emitMoveMade({ gameId: live.gameId, payload: moveMade, userIds });
  }
  if (moveAccepted) {
    t.emitMoveAccepted({
      gameId: live.gameId,
      userId,
      socketRef,
      payload: moveAccepted,
    });
  }
  if (persist) void persistLive(live);
  if (reschedule && typeof live.rescheduleClocks === "function") {
    live.rescheduleClocks();
  }
}

/**
 * Move rejected (WS). Optionally include serverSync.
 */
async function afterMoveRejected({
  live,
  gameId,
  origin,
  moveRejected,
  serverSync,
  userId,
  socketRef,
}) {
  if (LIVE_DOMAIN_EVENTS) {
    await events.publishMoveRejected({
      live,
      gameId,
      origin,
      moveRejected,
      serverSync,
      userId,
      socketRef,
    });
    return;
  }

  const t = getGameTransport();
  if (moveRejected) {
    t.emitMoveRejected({
      gameId: gameId || live?.gameId,
      userId,
      socketRef,
      payload: moveRejected,
    });
  }
  if (serverSync) {
    t.emitServerSync({
      gameId: gameId || live?.gameId,
      userId,
      socketRef,
      payload: serverSync,
    });
  }
}

/**
 * Server flag / abandon terminal (after live already mutated + ratings attached).
 */
async function afterServerTerminal({
  live,
  origin,
  kind, // 'timeout' | 'abandon' | 'ended'
  moveMade,
  gameEnded,
  persist = true,
}) {
  if (LIVE_DOMAIN_EVENTS) {
    // Single domain event carries both public DTOs (avoid double Projection emit).
    if (kind === "abandon") {
      await events.publishAbandonOccurred({ live, origin, moveMade, gameEnded });
    } else {
      await events.publishTimeoutOccurred({ live, origin, moveMade, gameEnded });
    }
    return;
  }

  const t = getGameTransport();
  if (moveMade) {
    const userIds = [];
    if (live?.players?.white != null) userIds.push(String(live.players.white));
    if (live?.players?.black != null) userIds.push(String(live.players.black));
    t.emitMoveMade({ gameId: live.gameId, payload: moveMade, userIds });
  }
  if (gameEnded) t.emitGameEnded({ gameId: live.gameId, payload: gameEnded });
  if (persist) void persistLive(live);
}

/**
 * Checkmate / resign notify game-ended only (persist already enqueued by move path).
 */
async function afterGameEndedNotify({ live, origin, gameEnded, persist = false }) {
  if (LIVE_DOMAIN_EVENTS) {
    await events.publishGameEnded({
      live,
      origin,
      moveMade: null,
      gameEnded,
    });
    return;
  }
  const t = getGameTransport();
  if (gameEnded) t.emitGameEnded({ gameId: live.gameId, payload: gameEnded });
  if (persist) void persistLive(live);
}

async function afterServerSync({
  live,
  gameId,
  origin,
  serverSync,
  userId,
  socketRef,
  reschedule = false,
}) {
  if (LIVE_DOMAIN_EVENTS) {
    await events.publishServerSyncSent({
      live,
      gameId,
      origin,
      serverSync,
      userId,
      socketRef,
    });
    return;
  }
  const t = getGameTransport();
  t.emitServerSync({
    gameId: gameId || live?.gameId,
    userId,
    socketRef,
    payload: serverSync,
  });
  if (reschedule && live && typeof live.rescheduleClocks === "function") {
    live.rescheduleClocks();
  }
}

async function afterPlayerConnection({ gameId, userId, connected, origin }) {
  if (LIVE_DOMAIN_EVENTS) {
    await events.publishPlayerConnection({
      gameId,
      userId,
      connected,
      origin,
    });
    return;
  }
  const t = transportOrNull();
  if (!t) return;
  t.emitConnectionStatus({
    gameId,
    payload: {
      userId,
      connected,
      status: connected ? "online" : "reconnecting",
    },
  });
}

module.exports = {
  afterMoveApplied,
  afterMoveRejected,
  afterServerTerminal,
  afterGameEndedNotify,
  afterServerSync,
  afterPlayerConnection,
  persistLive,
};
