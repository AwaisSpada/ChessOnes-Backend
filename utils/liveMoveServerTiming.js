/**
 * TEMPORARY diagnostic only — remove after latency measurement.
 * Does not change move / clock / network behavior.
 *
 * Enable always on this test branch (high-volume console OK for diagnosis).
 * Grep: [live-move-server-timing]
 */

function hrMs(diffNs) {
  return Math.round(Number(diffNs) / 1e4) / 100; // 2 decimal ms
}

/**
 * @param {{ gameId?: string, requestId?: string, userId?: string|null }} opts
 */
function createLiveMoveServerTiming(opts = {}) {
  const startHr = process.hrtime.bigint();
  let prevHr = startHr;
  let gameId = opts.gameId != null ? String(opts.gameId) : null;
  let requestId =
    opts.requestId != null && String(opts.requestId).length > 0
      ? String(opts.requestId)
      : `srv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
    requestId,
    mark,
    markSpan,
    setGameId(id) {
      if (id != null) gameId = String(id);
    },
    setRequestId(id) {
      if (id != null && String(id).length > 0) requestId = String(id);
    },
    setUserId(id) {
      if (id != null) userId = String(id);
    },
  };
}

function resolveIncomingRequestId(req) {
  const bodyId = req.body && req.body.requestId;
  const headerId =
    req.headers &&
    (req.headers["x-request-id"] || req.headers["x-live-move-request-id"]);
  if (bodyId != null && String(bodyId).length > 0) return String(bodyId);
  if (headerId != null && String(headerId).length > 0) return String(headerId);
  return null;
}

module.exports = {
  createLiveMoveServerTiming,
  resolveIncomingRequestId,
};
