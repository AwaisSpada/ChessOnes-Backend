/**
 * Live-migration feature flags.
 * Phase 0–4 as before.
 * ADR-006/007: LIVE_DOMAIN_EVENTS, LIVE_TRANSPORT.
 */

function parseEnvFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/**
 * ADR-003 production arming: memory snapshots + server timeouts ON by default
 * when NODE_ENV=production. Explicit env still wins (true/false). Keep
 * LIVE_WS_MOVES / LIVE_HTTP_VIA_MANAGER off unless rolled out separately.
 */
const isProductionEnv = String(process.env.NODE_ENV || "")
  .trim()
  .toLowerCase() === "production";

/** @type {boolean} Phase 1 — memory snapshots / hydration reads */
const LIVE_MEMORY_SNAPSHOT = parseEnvFlag(
  "LIVE_MEMORY_SNAPSHOT",
  isProductionEnv
);

/** @type {boolean} Phase 2 — HTTP moves via LiveGame actor */
const LIVE_HTTP_VIA_MANAGER = parseEnvFlag("LIVE_HTTP_VIA_MANAGER", false);

/** @type {boolean} Phase 3 — server TimeoutManager flag/abandon */
const LIVE_SERVER_TIMEOUTS = parseEnvFlag(
  "LIVE_SERVER_TIMEOUTS",
  isProductionEnv
);

/** @type {boolean} Phase 4 — authenticated live:move WebSocket commands */
const LIVE_WS_MOVES = parseEnvFlag("LIVE_WS_MOVES", false);

/**
 * ADR-007 — Domain Events bus sole path for live emit/persist/schedule.
 * Default OFF: GameTransport + direct PersistenceQueue / ClockScheduler (ADR-006).
 */
const LIVE_DOMAIN_EVENTS = parseEnvFlag("LIVE_DOMAIN_EVENTS", false);

/**
 * ADR-006 — transport implementation: socket | testing
 * redis deferred (Phase 6).
 */
function parseTransportMode() {
  const raw = String(process.env.LIVE_TRANSPORT || "socket")
    .trim()
    .toLowerCase();
  if (raw === "testing" || raw === "test") return "testing";
  if (raw === "redis") {
    console.warn(
      "[live] LIVE_TRANSPORT=redis not implemented; falling back to socket"
    );
    return "socket";
  }
  return "socket";
}

const LIVE_TRANSPORT = parseTransportMode();

function isLiveFlagEnabled(name) {
  switch (name) {
    case "LIVE_MEMORY_SNAPSHOT":
      return LIVE_MEMORY_SNAPSHOT;
    case "LIVE_HTTP_VIA_MANAGER":
      return LIVE_HTTP_VIA_MANAGER;
    case "LIVE_SERVER_TIMEOUTS":
      return LIVE_SERVER_TIMEOUTS;
    case "LIVE_WS_MOVES":
      return LIVE_WS_MOVES;
    case "LIVE_DOMAIN_EVENTS":
      return LIVE_DOMAIN_EVENTS;
    default:
      return false;
  }
}

module.exports = {
  LIVE_MEMORY_SNAPSHOT,
  LIVE_HTTP_VIA_MANAGER,
  LIVE_SERVER_TIMEOUTS,
  LIVE_WS_MOVES,
  LIVE_DOMAIN_EVENTS,
  LIVE_TRANSPORT,
  isLiveFlagEnabled,
  parseEnvFlag,
};
