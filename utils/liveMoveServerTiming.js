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

  /**
   * Log when Node finishes writing the HTTP response (after RESPONSE_SENT).
   * Does not alter response body or status.
   */
  function attachResponseFinish(res) {
    if (!res || typeof res.on !== "function") return;
    if (res.__liveMoveTimingFinishBound) return;
    res.__liveMoveTimingFinishBound = true;
    res.on("finish", () => {
      mark("RESPONSE_FINISH");
      const emitStage =
        stageHr.AFTER_SOCKET_EMIT != null
          ? "AFTER_SOCKET_EMIT"
          : stageHr.MOVE_MADE_EMITTED != null
            ? "MOVE_MADE_EMITTED"
            : null;
      if (emitStage) {
        markSpan(
          "SPAN_REQUEST_TO_SOCKET_EMIT",
          "REQUEST_RECEIVED",
          emitStage
        );
      }
      if (stageHr.RESPONSE_SENT != null) {
        markSpan(
          "SPAN_REQUEST_TO_RESPONSE_SENT",
          "REQUEST_RECEIVED",
          "RESPONSE_SENT"
        );
        markSpan(
          "SPAN_RESPONSE_SENT_TO_FINISH",
          "RESPONSE_SENT",
          "RESPONSE_FINISH"
        );
      }
    });
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
    attachResponseFinish,
    setGameId(id) {
      if (id != null) gameId = String(id);
    },
    setRequestId(id, source = "updated") {
      if (id != null && String(id).trim().length > 0) {
        requestId = String(id).trim();
        requestIdSource = source;
      }
    },
    adoptIncomingRequestId(req) {
      const resolved = resolveIncomingRequestIdDetailed(req);
      if (!resolved.requestId) return false;
      const wasServer =
        requestIdSource === "server_generated" ||
        requestIdSource === "none" ||
        String(requestId || "").startsWith("srv-");
      if (!wasServer && requestId === resolved.requestId) return false;
      if (!wasServer && requestId && requestId !== resolved.requestId) {
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
