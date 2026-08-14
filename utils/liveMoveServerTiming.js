/**
 * TEMPORARY diagnostic only — remove after latency measurement.
 * Does not change move / clock / network behavior.
 *
 * Grep: [live-move-server-timing]
 *
 * requestId: prefers body.requestId, then x-request-id /
 * x-live-move-request-id. Falls back to srv-… only when neither is present.
 */

function hrMs(diffNs) {
  return Math.round(Number(diffNs) / 1e4) / 100; // 2 decimal ms
}

function firstNonEmptyString(...candidates) {
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s.length > 0) return s;
  }
  return null;
}

/**
 * Resolve client correlation id from HTTP move request.
 * Express lowercases header names; also accept common aliases.
 * @returns {{ requestId: string|null, source: string }}
 */
function resolveIncomingRequestIdDetailed(req) {
  const body = req && req.body && typeof req.body === "object" ? req.body : null;
  const headers = (req && req.headers) || {};

  const bodyId = firstNonEmptyString(
    body && body.requestId,
    body && body.request_id,
    body && body.clientRequestId
  );
  if (bodyId) {
    return { requestId: bodyId, source: "body.requestId" };
  }

  const headerId = firstNonEmptyString(
    headers["x-request-id"],
    headers["x-live-move-request-id"],
    headers["x-correlation-id"]
  );
  if (headerId) {
    return { requestId: headerId, source: "header" };
  }

  return { requestId: null, source: "none" };
}

function resolveIncomingRequestId(req) {
  return resolveIncomingRequestIdDetailed(req).requestId;
}

/**
 * @param {{ gameId?: string, requestId?: string|null, userId?: string|null, requestIdSource?: string }} opts
 */
function createLiveMoveServerTiming(opts = {}) {
  const startHr = process.hrtime.bigint();
  let prevHr = startHr;
  let gameId = opts.gameId != null ? String(opts.gameId) : null;
  let requestIdSource = opts.requestIdSource || "none";
  let requestId =
    opts.requestId != null && String(opts.requestId).trim().length > 0
      ? String(opts.requestId).trim()
      : null;
  if (!requestId) {
    requestId = `srv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    requestIdSource = "server_generated";
  }
  let userId = opts.userId != null ? String(opts.userId) : null;

  /** @type {Record<string, bigint>} */
  const stageHr = { REQUEST_RECEIVED: startHr };

  function mark(stage, extra = {}) {
    const nowHr = process.hrtime.bigint();
    const elapsedMsFromRequestStart = hrMs(nowHr - startHr);
    const elapsedMsFromPreviousStage = hrMs(nowHr - prevHr);
    prevHr = nowHr;
    stageHr[stage] = nowHr;

    const payload = {
      stage,
      gameId,
      requestId,
      requestIdSource,
      userId,
      t: Date.now(),
      elapsedMsFromRequestStart,
      elapsedMsFromPreviousStage,
      ...extra,
    };
    console.log("[live-move-server-timing]", JSON.stringify(payload));
    return payload;
  }

  function markSpan(label, fromStage, toStage, extra = {}) {
    const from = stageHr[fromStage];
    const to = stageHr[toStage];
    if (from == null || to == null) return null;
    const payload = {
      stage: label,
      gameId,
      requestId,
      requestIdSource,
      userId,
      t: Date.now(),
      fromStage,
      toStage,
      elapsedMs: hrMs(to - from),
      elapsedMsFromRequestStart: hrMs(to - startHr),
      ...extra,
    };
    console.log("[live-move-server-timing]", JSON.stringify(payload));
    return payload;
  }

  return {
    get requestId() {
      return requestId;
    },
    get requestIdSource() {
      return requestIdSource;
    },
    mark,
    markSpan,
    setGameId(id) {
      if (id != null) gameId = String(id);
    },
    setRequestId(id, source = "updated") {
      if (id != null && String(id).trim().length > 0) {
        requestId = String(id).trim();
        requestIdSource = source;
      }
    },
    /**
     * Re-read body/headers and overwrite srv-… fallback if client id is present.
     * Safe to call multiple times; never clears a real client id.
     */
    adoptIncomingRequestId(req) {
      const resolved = resolveIncomingRequestIdDetailed(req);
      if (!resolved.requestId) return false;
      const wasServer =
        requestIdSource === "server_generated" ||
        requestIdSource === "none" ||
        String(requestId || "").startsWith("srv-");
      if (!wasServer && requestId === resolved.requestId) return false;
      if (!wasServer && requestId && requestId !== resolved.requestId) {
        // Keep the first real client id.
        return false;
      }
      requestId = resolved.requestId;
      requestIdSource = resolved.source;
      return true;
    },
    setUserId(id) {
      if (id != null) userId = String(id);
    },
  };
}

module.exports = {
  createLiveMoveServerTiming,
  resolveIncomingRequestId,
  resolveIncomingRequestIdDetailed,
};
