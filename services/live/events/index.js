/**
 * ADR-007 publish helpers + boot.
 */

const { LIVE_DOMAIN_EVENTS } = require("../flags");
const { bus, publish } = require("./EventBus");
const { createDomainEvent, EVENT_TYPE, ORIGIN } = require("./DomainEvent");
const { registerLiveSubscribers } = require("./subscribers");
const DirtyGame = require("./DirtyGame");

let subscribersRegistered = false;

function initLiveDomainEvents() {
  if (!LIVE_DOMAIN_EVENTS) return { enabled: false };
  if (!subscribersRegistered) {
    registerLiveSubscribers();
    subscribersRegistered = true;
  }
  return { enabled: true };
}

function isDomainEventsEnabled() {
  return LIVE_DOMAIN_EVENTS;
}

/**
 * @param {object} fields createDomainEvent fields
 */
async function publishEvent(fields) {
  const event = createDomainEvent(fields);
  await publish(event);
  return event;
}

async function publishMoveApplied({
  live,
  origin,
  moveMade,
  moveAccepted,
  userId,
  socketRef,
  requestId,
}) {
  return publishEvent({
    eventType: EVENT_TYPE.MOVE_APPLIED,
    gameId: live.gameId,
    syncVersion: live.syncVersion,
    serverEventId: moveMade?.serverEventId || moveAccepted?.serverEventId || "",
    origin,
    payload: {
      requestId,
      userId,
      socketRef,
      moveMade,
      moveAccepted,
      gameEnded: Boolean(live.status !== "active" || live.result),
      result: live.result || null,
      currentTurn: live.currentTurn,
      ply: live.ply,
    },
  });
}

async function publishMoveRejected({
  live,
  gameId,
  origin,
  moveRejected,
  serverSync,
  userId,
  socketRef,
}) {
  return publishEvent({
    eventType: EVENT_TYPE.MOVE_REJECTED,
    gameId: gameId || live?.gameId || "unknown",
    syncVersion: live?.syncVersion ?? moveRejected?.syncVersion ?? 0,
    serverEventId: moveRejected?.serverEventId || "",
    origin,
    payload: {
      userId,
      socketRef,
      moveRejected,
      serverSync,
    },
  });
}

async function publishTimeoutOccurred({ live, origin, moveMade, gameEnded }) {
  return publishEvent({
    eventType: EVENT_TYPE.TIMEOUT_OCCURRED,
    gameId: live.gameId,
    syncVersion: live.syncVersion,
    serverEventId: moveMade?.serverEventId || gameEnded?.serverEventId || "",
    origin: origin || ORIGIN.Timeout,
    payload: {
      moveMade,
      gameEnded,
      result: live.result,
      loser: live.result?.winner === "white" ? "black" : "white",
      winner: live.result?.winner,
    },
  });
}

async function publishAbandonOccurred({ live, origin, moveMade, gameEnded }) {
  return publishEvent({
    eventType: EVENT_TYPE.ABANDON_OCCURRED,
    gameId: live.gameId,
    syncVersion: live.syncVersion,
    serverEventId: moveMade?.serverEventId || gameEnded?.serverEventId || "",
    origin: origin || ORIGIN.Abandon,
    payload: {
      moveMade,
      gameEnded,
      result: live.result,
      kind: live.result?.reason || "first-move-abandon",
    },
  });
}

async function publishGameEnded({ live, origin, moveMade, gameEnded }) {
  return publishEvent({
    eventType: EVENT_TYPE.GAME_ENDED,
    gameId: live.gameId,
    syncVersion: live.syncVersion,
    serverEventId: gameEnded?.serverEventId || moveMade?.serverEventId || "",
    origin,
    payload: {
      moveMade,
      gameEnded,
      result: live.result,
    },
  });
}

async function publishServerSyncSent({
  live,
  gameId,
  origin,
  serverSync,
  userId,
  socketRef,
}) {
  return publishEvent({
    eventType: EVENT_TYPE.SERVER_SYNC_SENT,
    gameId: gameId || live?.gameId,
    syncVersion: live?.syncVersion ?? serverSync?.syncVersion ?? 0,
    serverEventId: serverSync?.serverEventId || "",
    origin: origin || ORIGIN.WS,
    payload: { serverSync, userId, socketRef },
  });
}

async function publishPlayerConnection({
  gameId,
  userId,
  connected,
  origin,
}) {
  return publishEvent({
    eventType: connected
      ? EVENT_TYPE.PLAYER_RECONNECTED
      : EVENT_TYPE.PLAYER_DISCONNECTED,
    gameId,
    syncVersion: 0,
    origin: origin || ORIGIN.Reconnect,
    payload: { userId, connected },
  });
}

module.exports = {
  initLiveDomainEvents,
  isDomainEventsEnabled,
  publishEvent,
  publishMoveApplied,
  publishMoveRejected,
  publishTimeoutOccurred,
  publishAbandonOccurred,
  publishGameEnded,
  publishServerSyncSent,
  publishPlayerConnection,
  bus,
  EVENT_TYPE,
  ORIGIN,
  DirtyGame,
  createDomainEvent,
};
