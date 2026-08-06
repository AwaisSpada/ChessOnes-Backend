/**
 * ADR-006 SocketIOTransport — behavior-identical delivery via Socket.IO.
 * Does not own legality, clocks, persist, or LiveGame mutation.
 */

class SocketIOTransport {
  /**
   * @param {import("socket.io").Server} io
   */
  constructor(io) {
    if (!io) throw new Error("SocketIOTransport requires io");
    this.io = io;
    this.kind = "socket";
  }

  emitMoveMade({ gameId, payload }) {
    if (!gameId || !payload) return;
    this.io.to(String(gameId)).emit("move-made", payload);
  }

  emitMoveAccepted({ gameId, userId, socketRef, payload }) {
    if (!payload) return;
    if (socketRef && typeof socketRef.emit === "function") {
      socketRef.emit("moveAccepted", payload);
      return;
    }
    if (userId) {
      this.io.to(`user:${String(userId)}`).emit("moveAccepted", payload);
    }
  }

  emitMoveRejected({ gameId, userId, socketRef, payload }) {
    if (!payload) return;
    if (socketRef && typeof socketRef.emit === "function") {
      socketRef.emit("moveRejected", payload);
      return;
    }
    if (userId) {
      this.io.to(`user:${String(userId)}`).emit("moveRejected", payload);
    }
  }

  emitServerSync({ gameId, userId, socketRef, payload }) {
    if (!payload) return;
    if (socketRef && typeof socketRef.emit === "function") {
      socketRef.emit("serverSync", payload);
      return;
    }
    if (userId) {
      this.io.to(`user:${String(userId)}`).emit("serverSync", payload);
    }
  }

  emitGameEnded({ gameId, payload }) {
    if (!gameId || !payload) return;
    this.io.to(String(gameId)).emit("game-ended", payload);
  }

  /**
   * Preserves existing wire: player-reconnected|player-disconnected + connection-status.
   * @param {{ gameId: string, payload: object }} args
   */
  emitConnectionStatus({ gameId, payload }) {
    if (!gameId || !payload) return;
    const room = String(gameId);
    const connected = payload.connected !== false && payload.status !== "reconnecting";
    if (connected) {
      this.io.to(room).emit("player-reconnected", {
        gameId: room,
        userId: payload.userId,
        connected: true,
      });
      this.io.to(room).emit("connection-status", {
        gameId: room,
        userId: payload.userId,
        connected: true,
        status: payload.status || "online",
      });
    } else {
      this.io.to(room).emit("player-disconnected", {
        gameId: room,
        userId: payload.userId,
        connected: false,
      });
      this.io.to(room).emit("connection-status", {
        gameId: room,
        userId: payload.userId,
        connected: false,
        status: payload.status || "reconnecting",
      });
    }
  }
}

module.exports = SocketIOTransport;
