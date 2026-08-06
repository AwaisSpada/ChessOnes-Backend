/**
 * ADR-007 Projection — Domain Events → public transport DTOs → GameTransport.
 * Never mutates LiveGame.
 */

const { getGameTransport } = require("../transport");

function safeTransport() {
  try {
    return getGameTransport();
  } catch (err) {
    console.error("[Projection] GameTransport missing:", err?.message || err);
    return null;
  }
}

function projectMoveApplied(event) {
  const t = safeTransport();
  if (!t) return;
  const p = event.payload || {};
  const gameId = event.gameId;
  if (p.moveMade) {
    t.emitMoveMade({ gameId, payload: p.moveMade });
  }
  if (p.moveAccepted) {
    t.emitMoveAccepted({
      gameId,
      userId: p.userId,
      socketRef: p.socketRef,
      payload: p.moveAccepted,
    });
  }
}

function projectMoveRejected(event) {
  const t = safeTransport();
  if (!t) return;
  const p = event.payload || {};
  if (p.moveRejected) {
    t.emitMoveRejected({
      gameId: event.gameId,
      userId: p.userId,
      socketRef: p.socketRef,
      payload: p.moveRejected,
    });
  }
  if (p.serverSync) {
    t.emitServerSync({
      gameId: event.gameId,
      userId: p.userId,
      socketRef: p.socketRef,
      payload: p.serverSync,
    });
  }
}

function projectGameEnded(event) {
  const t = safeTransport();
  if (!t) return;
  const p = event.payload || {};
  if (p.moveMade) {
    t.emitMoveMade({ gameId: event.gameId, payload: p.moveMade });
  }
  if (p.gameEnded) {
    t.emitGameEnded({ gameId: event.gameId, payload: p.gameEnded });
  }
}

function projectTimeoutOrAbandon(event) {
  projectGameEnded(event);
}

function projectServerSync(event) {
  const t = safeTransport();
  if (!t) return;
  const p = event.payload || {};
  if (p.serverSync) {
    t.emitServerSync({
      gameId: event.gameId,
      userId: p.userId,
      socketRef: p.socketRef,
      payload: p.serverSync,
    });
  }
}

function projectPlayerConnection(event) {
  const t = safeTransport();
  if (!t) return;
  const p = event.payload || {};
  t.emitConnectionStatus({
    gameId: event.gameId,
    payload: {
      userId: p.userId,
      connected: event.eventType === "PLAYER_RECONNECTED",
      status:
        event.eventType === "PLAYER_RECONNECTED" ? "online" : "reconnecting",
    },
  });
}

module.exports = {
  projectMoveApplied,
  projectMoveRejected,
  projectGameEnded,
  projectTimeoutOrAbandon,
  projectServerSync,
  projectPlayerConnection,
};
