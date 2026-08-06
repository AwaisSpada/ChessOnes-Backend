/**
 * Live-migration feature flags.
 * Phase 0: defined, default OFF.
 * Phase 1: LIVE_MEMORY_SNAPSHOT gates in-memory snapshot reads + post-move RAM sync.
 * Phase 2: LIVE_HTTP_VIA_MANAGER gates HTTP /move via LiveGame + MoveProcessor.
 * Phase 3: LIVE_SERVER_TIMEOUTS arms ClockScheduler (requires LIVE_MEMORY_SNAPSHOT).
 * Phase 4: LIVE_WS_MOVES enables live:move / moveAccepted / moveRejected.
 */

function parseEnvFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/** @type {boolean} Phase 1 — memory snapshots / hydration reads */
const LIVE_MEMORY_SNAPSHOT = parseEnvFlag("LIVE_MEMORY_SNAPSHOT", false);

/** @type {boolean} Phase 2 — HTTP moves via LiveGame actor */
const LIVE_HTTP_VIA_MANAGER = parseEnvFlag("LIVE_HTTP_VIA_MANAGER", false);

/** @type {boolean} Phase 3 — server TimeoutManager flag/abandon */
const LIVE_SERVER_TIMEOUTS = parseEnvFlag("LIVE_SERVER_TIMEOUTS", false);

/** @type {boolean} Phase 4 — authenticated live:move WebSocket commands */
const LIVE_WS_MOVES = parseEnvFlag("LIVE_WS_MOVES", false);

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
    default:
      return false;
  }
}

module.exports = {
  LIVE_MEMORY_SNAPSHOT,
  LIVE_HTTP_VIA_MANAGER,
  LIVE_SERVER_TIMEOUTS,
  LIVE_WS_MOVES,
  isLiveFlagEnabled,
  parseEnvFlag,
};
