/**
 * Phase 1–4 LiveGame — in-memory live-human game.
 * Phase 2: mutation serialization + applyMove.
 * Phase 4: requestId idempotency, clientSequence, serverEventId.
 */

const ClockAuthority = require("./ClockAuthority");
const MoveProcessor = require("./MoveProcessor");

const IDEMPOTENCY_MAX = 64;

function cloneJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function playerIdString(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  if (ref._id) return String(ref._id);
  return String(ref);
}

function LiveGame(doc) {
  /** @type {Promise<unknown>} */
  this._mutationChain = Promise.resolve();
  /** @type {number} */
  this._serverEventSeq = 0;
  /** @type {Map<string, object>} */
  this._requestOutcomes = new Map();
  /** @type {Map<string, number>} */
  this._lastClientSequence = new Map();
  this.applyAuthoritativeDoc(doc);
}

LiveGame.prototype.applyAuthoritativeDoc = function applyAuthoritativeDoc(doc) {
  if (!doc || !doc.gameId) {
    throw new Error("LiveGame requires a game document with gameId");
  }
  this.gameId = String(doc.gameId);
  this.type = doc.type;
  this.isRated = doc.isRated !== false;
  this.category = doc.category || null;
  this.arenaId = doc.arenaId || null;

  this.players = {
    white: playerIdString(doc.players?.white),
    black: playerIdString(doc.players?.black),
  };

  this.board = cloneJson(doc.board, []);
  this.moves = cloneJson(doc.moves, []);
  this.positionHistory = cloneJson(doc.positionHistory, []);
  this.currentTurn = doc.currentTurn === "black" ? "black" : "white";
  this.status = doc.status || "active";
  this.result = cloneJson(doc.result, null);

  this.timeControl = cloneJson(doc.timeControl, {
    initial: 600000,
    increment: 0,
  });
  this.timeRemaining = cloneJson(doc.timeRemaining, {
    white: this.timeControl.initial,
    black: this.timeControl.initial,
  });
  this.clockStartedAt = doc.clockStartedAt
    ? new Date(doc.clockStartedAt)
    : null;

  this.syncVersion =
    typeof doc.syncVersion === "number" && Number.isFinite(doc.syncVersion)
      ? doc.syncVersion
      : 0;
  this.ply = Array.isArray(this.moves) ? this.moves.length : 0;
  this.createdAt = doc.createdAt ? new Date(doc.createdAt) : null;

  this.updatedAtMs = Date.now();
};

/** Serialize mutations — exactly one chain per LiveGame instance. */
LiveGame.prototype.runSerialized = function runSerialized(fn) {
  const run = this._mutationChain.catch(() => {}).then(fn);
  this._mutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

/** Opaque monotonic event id for protocol fan-out / acks. */
LiveGame.prototype.nextServerEventId = function nextServerEventId() {
  this._serverEventSeq += 1;
  return `${this.gameId}:${this._serverEventSeq}`;
};

LiveGame.prototype.getRequestOutcome = function getRequestOutcome(requestId) {
  if (!requestId) return null;
  return this._requestOutcomes.get(String(requestId)) || null;
};

LiveGame.prototype.rememberRequestOutcome = function rememberRequestOutcome(
  requestId,
  outcome
) {
  if (!requestId) return;
  const id = String(requestId);
  this._requestOutcomes.set(id, { ...outcome, at: Date.now() });
  while (this._requestOutcomes.size > IDEMPOTENCY_MAX) {
    const oldest = this._requestOutcomes.keys().next().value;
    this._requestOutcomes.delete(oldest);
  }
};

LiveGame.prototype.getLastClientSequence = function getLastClientSequence(
  userId
) {
  if (!userId) return null;
  const v = this._lastClientSequence.get(String(userId));
  return typeof v === "number" ? v : null;
};

LiveGame.prototype.setLastClientSequence = function setLastClientSequence(
  userId,
  seq
) {
  if (!userId || typeof seq !== "number") return;
  this._lastClientSequence.set(String(userId), seq);
};

/**
 * Mutable working view MoveProcessor can duck-type like a Game doc.
 * Writes go back onto this LiveGame when processing finishes.
 */
LiveGame.prototype._asMutableGameState = function _asMutableGameState() {
  const self = this;
  return {
    get gameId() {
      return self.gameId;
    },
    get type() {
      return self.type;
    },
    get isRated() {
      return self.isRated;
    },
    get category() {
      return self.category;
    },
    get createdAt() {
      return self.createdAt;
    },
    get board() {
      return self.board;
    },
    set board(v) {
      self.board = v;
    },
    get moves() {
      return self.moves;
    },
    set moves(v) {
      self.moves = v;
    },
    get positionHistory() {
      return self.positionHistory;
    },
    set positionHistory(v) {
      self.positionHistory = v;
    },
    get currentTurn() {
      return self.currentTurn;
    },
    set currentTurn(v) {
      self.currentTurn = v;
    },
    get status() {
      return self.status;
    },
    set status(v) {
      self.status = v;
    },
    get result() {
      return self.result;
    },
    set result(v) {
      self.result = v;
    },
    get timeControl() {
      return self.timeControl;
    },
    set timeControl(v) {
      self.timeControl = v;
    },
    get timeRemaining() {
      return self.timeRemaining;
    },
    set timeRemaining(v) {
      self.timeRemaining = v;
    },
    get clockStartedAt() {
      return self.clockStartedAt;
    },
    set clockStartedAt(v) {
      self.clockStartedAt = v;
    },
    get syncVersion() {
      return self.syncVersion;
    },
    set syncVersion(v) {
      self.syncVersion = v;
    },
  };
};

/**
 * Apply a player move through the serialization queue + MoveProcessor.
 * @param {object} cmd { from, to, piece, captured?, notation?, playerColor }
 */
LiveGame.prototype.applyMove = function applyMove(cmd) {
  return this.runSerialized(() => {
    if (this.status !== "active") {
      return {
        ok: false,
        httpStatus: 400,
        body: { success: false, message: "Game is not active" },
      };
    }
    const state = this._asMutableGameState();
    const outcome = MoveProcessor.applyPlayerMove(state, cmd);
    this.ply = Array.isArray(this.moves) ? this.moves.length : 0;
    this.updatedAtMs = Date.now();
    return outcome;
  });
};

/**
 * Set clockStartedAt once (idempotent). Used from allReady.
 * Bumps syncVersion on first set (authoritative mutation).
 */
LiveGame.prototype.startClocks = function startClocks(at = new Date()) {
  if (!this.clockStartedAt) {
    this.clockStartedAt = at instanceof Date ? at : new Date(at);
    ClockAuthority.bumpSyncVersion(this);
    this.updatedAtMs = Date.now();
  }
  return this.clockStartedAt;
};

/** After mutation: refresh absolute flag/abandon deadlines when Phase 3 armed. */
LiveGame.prototype.rescheduleClocks = function rescheduleClocks() {
  try {
    const ClockScheduler = require("./ClockScheduler");
    if (ClockScheduler.isArmed()) {
      ClockScheduler.rescheduleAll(this);
    }
  } catch (err) {
    console.warn(
      "[live] rescheduleClocks failed:",
      this.gameId,
      err?.message || err
    );
  }
};

LiveGame.prototype.toPlainGame = function toPlainGame() {
  return {
    gameId: this.gameId,
    type: this.type,
    isRated: this.isRated,
    category: this.category,
    arenaId: this.arenaId,
    players: {
      white: this.players.white,
      black: this.players.black,
    },
    board: this.board,
    moves: this.moves,
    positionHistory: this.positionHistory,
    currentTurn: this.currentTurn,
    status: this.status,
    result: this.result,
    timeControl: this.timeControl,
    timeRemaining: {
      white: this.timeRemaining?.white,
      black: this.timeRemaining?.black,
    },
    clockStartedAt: this.clockStartedAt,
    syncVersion: this.syncVersion,
    createdAt: this.createdAt,
  };
};

LiveGame.prototype.snapshot = function snapshot(now = Date.now()) {
  const plain = this.toPlainGame();
  const timeRemaining = ClockAuthority.effectiveRemaining(plain, now);
  return ClockAuthority.withLiveSync(
    plain,
    {
      gameId: this.gameId,
      board: this.board,
      moves: this.moves,
      players: this.players,
      result: this.result,
      timeControl: this.timeControl,
      type: this.type,
      category: this.category,
      isRated: this.isRated,
      clockStartedAt: this.clockStartedAt,
      currentTurn: this.currentTurn,
      status: this.status,
    },
    { timeRemaining }
  );
};

LiveGame.prototype.toAPIStateFields = function toAPIStateFields(now = Date.now()) {
  const snap = this.snapshot(now);
  return {
    board: this.board,
    moves: this.moves,
    currentTurn: this.currentTurn,
    status: this.status,
    result: this.result,
    timeControl: this.timeControl,
    timeRemaining: snap.timeRemaining,
    clockStartedAt: this.clockStartedAt,
    syncVersion: snap.syncVersion,
    ply: snap.ply,
    serverNow: snap.serverNow,
  };
};

LiveGame.fromMongoDoc = function fromMongoDoc(doc) {
  return new LiveGame(doc);
};

module.exports = LiveGame;
