/**
 * ADR-007 DomainEvent envelope helpers.
 */

const crypto = require("crypto");

const ORIGIN = Object.freeze({
  HTTP: "HTTP",
  WS: "WS",
  Timeout: "Timeout",
  Abandon: "Abandon",
  Reconnect: "Reconnect",
  Recovery: "Recovery",
  System: "System",
});

const EVENT_TYPE = Object.freeze({
  GAME_CREATED: "GAME_CREATED",
  GAME_HYDRATED: "GAME_HYDRATED",
  GAME_STARTED: "GAME_STARTED",
  MOVE_RECEIVED: "MOVE_RECEIVED",
  MOVE_ACCEPTED: "MOVE_ACCEPTED",
  MOVE_REJECTED: "MOVE_REJECTED",
  MOVE_APPLIED: "MOVE_APPLIED",
  CLOCK_UPDATED: "CLOCK_UPDATED",
  TURN_CHANGED: "TURN_CHANGED",
  TIMEOUT_OCCURRED: "TIMEOUT_OCCURRED",
  ABANDON_OCCURRED: "ABANDON_OCCURRED",
  PLAYER_CONNECTED: "PLAYER_CONNECTED",
  PLAYER_DISCONNECTED: "PLAYER_DISCONNECTED",
  PLAYER_RECONNECTED: "PLAYER_RECONNECTED",
  GAME_ENDED: "GAME_ENDED",
  GAME_EVICTED: "GAME_EVICTED",
  SNAPSHOT_CREATED: "SNAPSHOT_CREATED",
  SERVER_SYNC_SENT: "SERVER_SYNC_SENT",
});

const ALLOWED_ORIGINS = new Set(Object.values(ORIGIN));

/**
 * @param {object} fields
 * @returns {object} DomainEvent
 */
function createDomainEvent(fields) {
  if (!fields || !fields.eventType) {
    throw new Error("createDomainEvent requires eventType");
  }
  if (!fields.gameId) {
    throw new Error("createDomainEvent requires gameId");
  }
  const origin = fields.origin || ORIGIN.System;
  if (!ALLOWED_ORIGINS.has(origin)) {
    throw new Error(`Invalid DomainEvent origin: ${origin}`);
  }
  return {
    eventId: fields.eventId || crypto.randomUUID(),
    serverEventId: fields.serverEventId != null ? String(fields.serverEventId) : "",
    gameId: String(fields.gameId),
    syncVersion:
      typeof fields.syncVersion === "number" ? fields.syncVersion : 0,
    occurredAt:
      typeof fields.occurredAt === "number" ? fields.occurredAt : Date.now(),
    eventType: fields.eventType,
    origin,
    payload: fields.payload && typeof fields.payload === "object" ? fields.payload : {},
  };
}

module.exports = {
  ORIGIN,
  EVENT_TYPE,
  ALLOWED_ORIGINS,
  createDomainEvent,
};
