/**
 * Phase 4 live:move WebSocket pipeline.
 *
 * Client ACK timeout (documentation — not a wire field):
 *   ackTimeoutMs = clamp(round(2.5 * ewmaRttMs), 1500, 8000)
 * Retry the SAME requestId after timeout; do not mint a new id for transport retries.
 */

const {
  LIVE_WS_MOVES,
  LIVE_MEMORY_SNAPSHOT,
} = require("./flags");
const LiveGameManager = require("./LiveGameManager");
const PersistenceQueue = require("./PersistenceQueue");
const MoveProcessor = require("./MoveProcessor");
const liveGameEnd = require("./liveGameEnd");

const RECOVERABLE = {
  NOT_YOUR_TURN: false,
  ILLEGAL_MOVE: false,
  STALE_PLY: true,
  STALE_SYNC: true,
  STALE_SEQUENCE: true,
  DUPLICATE: false,
  GAME_NOT_ACTIVE: false,
  TIMEOUT: false,
  UNAUTHORIZED: true,
  RATE_LIMITED: true,
  FLAG_OFF: true,
  INVALID_PAYLOAD: false,
  SERVER_ERROR: true,
};

function nowMs() {
  return Date.now();
}

function buildServerSync(live, reason) {
  const snap = live.snapshot(nowMs());
  const serverEventId = live.nextServerEventId();
  return {
    gameId: live.gameId,
    reason: reason || "explicit",
    serverEventId,
    syncVersion: snap.syncVersion,
    serverPly: snap.ply,
    ply: snap.ply,
    serverNow: snap.serverNow,
    board: live.board,
    moves: live.moves,
    currentTurn: live.currentTurn,
    status: live.status,
    result: live.result,
    timeRemaining: snap.timeRemaining,
    clockStartedAt: live.clockStartedAt,
    timeControl: live.timeControl,
    turnStartedAt:
      live.moves?.length > 0
        ? (() => {
            const ts = live.moves[live.moves.length - 1]?.timestamp;
            return ts instanceof Date ? ts.toISOString() : ts || null;
          })()
        : null,
  };
}

function emitReject(socket, live, fields) {
  const serverEventId =
    fields.serverEventId ||
    (live && typeof live.nextServerEventId === "function"
      ? live.nextServerEventId()
      : `reject:${nowMs()}`);
  const code = fields.code || "SERVER_ERROR";
  const payload = {
    requestId: fields.requestId,
    gameId: fields.gameId,
    ok: false,
    code,
    message: fields.message || code,
    recoverable:
      typeof fields.recoverable === "boolean"
        ? fields.recoverable
        : RECOVERABLE[code] !== false,
    serverEventId,
    syncVersion: fields.syncVersion ?? (live ? live.syncVersion : 0),
    serverPly: fields.serverPly ?? (live ? live.ply : 0),
    serverNow: fields.serverNow ?? nowMs(),
    needSync: Boolean(fields.needSync),
  };
  socket.emit("moveRejected", payload);
  if (fields.needSync && live) {
    socket.emit("serverSync", buildServerSync(live, "reject"));
  }
  return payload;
}

function playerColorForUser(live, userId) {
  const uid = String(userId);
  if (live.players?.white && String(live.players.white) === uid) return "white";
  if (live.players?.black && String(live.players.black) === uid) return "black";
  return null;
}

function mapOutcomeToRejectCode(outcome) {
  const msg = outcome?.body?.message || "";
  if (outcome?.kind === "timeout" || outcome?.httpBody?.code === "TIMEOUT") {
    return "TIMEOUT";
  }
  if (/not your turn/i.test(msg)) return "NOT_YOUR_TURN";
  if (/not active/i.test(msg)) return "GAME_NOT_ACTIVE";
  if (/illegal|invalid move|no piece|opponent/i.test(msg)) return "ILLEGAL_MOVE";
  return "ILLEGAL_MOVE";
}

/**
 * Handle socket `live:move`.
 */
async function handleLiveMove(socket, raw, io) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const gameId = payload.gameId ? String(payload.gameId) : null;
  const requestId = payload.requestId != null ? String(payload.requestId) : null;
  const userId = socket.data?.userId;

  if (!LIVE_WS_MOVES) {
    return emitReject(socket, null, {
      requestId,
      gameId,
      code: "FLAG_OFF",
      message: "WebSocket moves disabled; use HTTP POST /move",
      recoverable: true,
      needSync: false,
    });
  }

  if (!userId) {
    return emitReject(socket, null, {
      requestId,
      gameId,
      code: "UNAUTHORIZED",
      message: "Socket not registered",
      recoverable: true,
    });
  }

  if (!LIVE_MEMORY_SNAPSHOT) {
    return emitReject(socket, null, {
      requestId,
      gameId,
      code: "FLAG_OFF",
      message: "LIVE_MEMORY_SNAPSHOT required for live:move",
      recoverable: true,
    });
  }

  if (
    !gameId ||
    !requestId ||
    typeof payload.clientPly !== "number" ||
    typeof payload.clientSequence !== "number" ||
    typeof payload.from !== "number" ||
    typeof payload.to !== "number" ||
    typeof payload.piece !== "string"
  ) {
    return emitReject(socket, null, {
      requestId,
      gameId,
      code: "INVALID_PAYLOAD",
      message:
        "live:move requires gameId, requestId, clientPly, clientSequence, from, to, piece",
      recoverable: false,
    });
  }

  let live = await LiveGameManager.getOrHydrate(gameId);
  if (!live) {
    return emitReject(socket, null, {
      requestId,
      gameId,
      code: "GAME_NOT_ACTIVE",
      message: "Game not found or not live-human active",
      recoverable: false,
    });
  }

  const color = playerColorForUser(live, userId);
  if (!color) {
    return emitReject(socket, live, {
      requestId,
      gameId,
      code: "UNAUTHORIZED",
      message: "You are not a player in this game",
      recoverable: false,
      syncVersion: live.syncVersion,
      serverPly: live.ply,
    });
  }

  return live.runSerialized(async () => {
    const serverNow = nowMs();

    const prior = live.getRequestOutcome(requestId);
    if (prior) {
      if (prior.kind === "accepted" && prior.payload) {
        const replay = {
          ...prior.payload,
          serverEventId: live.nextServerEventId(),
        };
        socket.emit("moveAccepted", replay);
        return replay;
      }
      if (prior.kind === "rejected" && prior.payload) {
        const replay = {
          ...prior.payload,
          serverEventId: live.nextServerEventId(),
          recoverable: false,
          code: prior.payload.code || "DUPLICATE",
        };
        socket.emit("moveRejected", replay);
        return replay;
      }
    }

    if (live.status !== "active") {
      const rejected = emitReject(socket, live, {
        requestId,
        gameId,
        code: "GAME_NOT_ACTIVE",
        message: "Game is not active",
        syncVersion: live.syncVersion,
        serverPly: live.ply,
        serverNow,
        needSync: true,
      });
      live.rememberRequestOutcome(requestId, {
        kind: "rejected",
        payload: rejected,
      });
      return rejected;
    }

    const lastSeq = live.getLastClientSequence(userId);
    if (lastSeq != null && payload.clientSequence <= lastSeq) {
      const rejected = emitReject(socket, live, {
        requestId,
        gameId,
        code: "STALE_SEQUENCE",
        message: "clientSequence must increase for new requestIds",
        syncVersion: live.syncVersion,
        serverPly: live.ply,
        serverNow,
        needSync: true,
        recoverable: true,
      });
      live.rememberRequestOutcome(requestId, {
        kind: "rejected",
        payload: rejected,
      });
      return rejected;
    }

    const serverPly = Array.isArray(live.moves) ? live.moves.length : 0;
    if (payload.clientPly !== serverPly) {
      const rejected = emitReject(socket, live, {
        requestId,
        gameId,
        code: "STALE_PLY",
        message: `clientPly ${payload.clientPly} !== serverPly ${serverPly}`,
        syncVersion: live.syncVersion,
        serverPly,
        serverNow,
        needSync: true,
        recoverable: true,
      });
      live.rememberRequestOutcome(requestId, {
        kind: "rejected",
        payload: rejected,
      });
      return rejected;
    }

    if (
      typeof payload.baseSyncVersion === "number" &&
      payload.baseSyncVersion > live.syncVersion
    ) {
      const rejected = emitReject(socket, live, {
        requestId,
        gameId,
        code: "STALE_SYNC",
        message: "Client baseSyncVersion ahead of server",
        syncVersion: live.syncVersion,
        serverPly,
        serverNow,
        needSync: true,
        recoverable: true,
      });
      live.rememberRequestOutcome(requestId, {
        kind: "rejected",
        payload: rejected,
      });
      return rejected;
    }

    const state = live._asMutableGameState();
    const outcome = MoveProcessor.applyPlayerMove(state, {
      from: payload.from,
      to: payload.to,
      piece: payload.piece,
      captured: payload.captured,
      notation: payload.notation,
      playerColor: color,
    });
    live.ply = Array.isArray(live.moves) ? live.moves.length : 0;
    live.updatedAtMs = Date.now();

    if (!outcome.ok) {
      const code = mapOutcomeToRejectCode(outcome);
      const rejected = emitReject(socket, live, {
        requestId,
        gameId,
        code,
        message: outcome.body?.message || code,
        syncVersion: live.syncVersion,
        serverPly: live.ply,
        serverNow: nowMs(),
        needSync: code === "GAME_NOT_ACTIVE" || code === "TIMEOUT",
        recoverable: RECOVERABLE[code],
      });
      live.rememberRequestOutcome(requestId, {
        kind: "rejected",
        payload: rejected,
      });
      if (outcome.kind === "timeout" && outcome.socketPayload) {
        const serverEventId = live.nextServerEventId();
        io.to(gameId).emit("move-made", {
          ...outcome.socketPayload,
          serverEventId,
          requestId,
        });
        live.rescheduleClocks();
        PersistenceQueue.enqueueLiveGamePersist(live).catch(() => {});
        void liveGameEnd.notifyCompletedLiveGame(live, io);
      }
      return rejected;
    }

    // Timeout-on-move returns ok:true with kind timeout in MoveProcessor
    if (outcome.kind === "timeout") {
      const serverEventId = live.nextServerEventId();
      const roomPayload = {
        ...outcome.socketPayload,
        serverEventId,
        requestId,
      };
      io.to(gameId).emit("move-made", roomPayload);
      const rejected = emitReject(socket, live, {
        requestId,
        gameId,
        code: "TIMEOUT",
        message: outcome.httpBody?.message || "Out of time",
        syncVersion: live.syncVersion,
        serverPly: live.ply,
        serverNow: roomPayload.serverNow || nowMs(),
        needSync: true,
        recoverable: false,
        serverEventId,
      });
      live.rememberRequestOutcome(requestId, {
        kind: "rejected",
        payload: rejected,
      });
      live.setLastClientSequence(userId, payload.clientSequence);
      PersistenceQueue.enqueueLiveGamePersist(live).catch(() => {});
      live.rescheduleClocks();
      void liveGameEnd.notifyCompletedLiveGame(live, io);
      return rejected;
    }

    live.setLastClientSequence(userId, payload.clientSequence);

    const serverEventId = live.nextServerEventId();
    const socketPayload = {
      ...outcome.socketPayload,
      serverEventId,
      requestId,
    };

    io.to(gameId).emit("move-made", socketPayload);

    const accept = {
      requestId,
      gameId,
      ok: true,
      serverEventId,
      syncVersion: live.syncVersion,
      serverPly: live.ply,
      serverNow: socketPayload.serverNow || nowMs(),
      move: outcome.move,
      timeRemaining: socketPayload.timeRemaining || live.timeRemaining,
      currentTurn: live.currentTurn,
      turnStartedAt:
        outcome.httpBody?.data?.turnStartedAt ||
        socketPayload.turnStartedAt ||
        null,
      gameEnded: Boolean(outcome.gameEnded),
      result: live.result || null,
      board: live.board,
    };

    socket.emit("moveAccepted", accept);
    live.rememberRequestOutcome(requestId, {
      kind: "accepted",
      payload: accept,
    });

    PersistenceQueue.enqueueLiveGamePersist(live).catch((err) => {
      console.error(
        `[live:move] persist failed game=${gameId}:`,
        err?.message || err
      );
    });
    live.rescheduleClocks();

    if (outcome.gameEnded && live.result) {
      void liveGameEnd.notifyCompletedLiveGame(live, io);
    }

    return accept;
  });
}

function handleServerSyncRequest(socket, raw) {
  const gameId = raw?.gameId ? String(raw.gameId) : null;
  if (!gameId) return;
  void (async () => {
    let live = LiveGameManager.get(gameId);
    if (!live && LIVE_MEMORY_SNAPSHOT) {
      live = await LiveGameManager.getOrHydrate(gameId);
    }
    if (!live) {
      socket.emit("serverSync", {
        gameId,
        reason: "miss",
        serverEventId: `miss:${nowMs()}`,
        syncVersion: 0,
        serverPly: 0,
        needHydrate: true,
      });
      return;
    }
    socket.emit("serverSync", buildServerSync(live, raw?.reason || "explicit"));
    live.rescheduleClocks();
  })();
}

module.exports = {
  handleLiveMove,
  handleServerSyncRequest,
  buildServerSync,
  RECOVERABLE,
  CLIENT_ACK_TIMEOUT_DOC: {
    formula: "clamp(round(2.5 * ewmaRttMs), 1500, 8000)",
    minMs: 1500,
    maxMs: 8000,
    rttMultiplier: 2.5,
  },
};
