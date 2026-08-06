/**
 * Phase 2 HTTP move adapter — thin entry when LIVE_HTTP_VIA_MANAGER is on.
 * Live-human only. Bot / flag-off stay on legacy routes/games.js handler.
 *
 * Flow: Load LiveGame → applyMove → (ratings if terminal) → Emit → Return → Persist.
 */

const Game = require("../../models/Game");
const ClockManager = require("./ClockManager");
const LiveGameManager = require("./LiveGameManager");
const PersistenceQueue = require("./PersistenceQueue");
const {
  LIVE_HTTP_VIA_MANAGER,
  LIVE_MEMORY_SNAPSHOT,
} = require("./flags");

function playerMatches(seatId, userId) {
  if (!seatId || !userId) return false;
  return String(seatId) === String(userId);
}

function buildGameDocForRatings(live, mongo) {
  const base =
    mongo && typeof mongo.toObject === "function" ? mongo.toObject() : mongo || {};
  return {
    ...base,
    gameId: live.gameId,
    type: live.type,
    isRated: live.isRated,
    category: live.category || base.category,
    arenaId: live.arenaId || base.arenaId,
    players: base.players || {
      white: live.players.white,
      black: live.players.black,
    },
    board: live.board,
    moves: live.moves,
    positionHistory: live.positionHistory,
    currentTurn: live.currentTurn,
    status: live.status,
    result: live.result,
    timeControl: live.timeControl,
    timeRemaining: live.timeRemaining,
    clockStartedAt: live.clockStartedAt,
    syncVersion: live.syncVersion,
    createdAt: live.createdAt || base.createdAt,
  };
}

function attachRatingChanges(outcome, ratingChanges) {
  if (!ratingChanges) return outcome.socketPayload;
  if (outcome.socketPayload) {
    outcome.socketPayload = {
      ...outcome.socketPayload,
      ratingChanges,
    };
  }
  if (outcome.httpBody?.data) {
    outcome.httpBody = {
      ...outcome.httpBody,
      data: {
        ...outcome.httpBody.data,
        ratingChanges,
      },
    };
  }
  return outcome.socketPayload;
}

/**
 * @returns {Promise<boolean>} true if handled; false = caller must use legacy handler
 */
async function tryHandleHttpMove(req, res, hooks) {
  if (!LIVE_HTTP_VIA_MANAGER) return false;

  if (!LIVE_MEMORY_SNAPSHOT) {
    console.warn(
      "[live] LIVE_HTTP_VIA_MANAGER requires LIVE_MEMORY_SNAPSHOT; falling back to legacy move path"
    );
    return false;
  }

  const gameId = req.params.gameId;

  let live = await LiveGameManager.getOrHydrate(gameId);
  let mongo = null;

  if (!live) {
    mongo = await Game.findOne({ gameId });
    if (!mongo) {
      res.status(404).json({ success: false, message: "Game not found" });
      return true;
    }
    if (!ClockManager.isLiveHumanGame(mongo)) {
      // Bot / non-live: legacy handler.
      return false;
    }
    if (mongo.status !== "active") {
      res.status(400).json({ success: false, message: "Game is not active" });
      return true;
    }
    live = LiveGameManager.createFromDoc(mongo);
    if (!live) return false;
  }

  if (live.status !== "active") {
    res.status(400).json({ success: false, message: "Game is not active" });
    return true;
  }

  const userId = req.user._id;
  const isWhite = playerMatches(live.players.white, userId);
  const isBlack = playerMatches(live.players.black, userId);
  if (!isWhite && !isBlack) {
    res.status(403).json({
      success: false,
      message: "You are not a player in this game",
    });
    return true;
  }

  const playerColor = isWhite ? "white" : "black";
  const { from, to, piece, captured, notation } = req.body;

  const outcome = await live.applyMove({
    from,
    to,
    piece,
    captured,
    notation,
    playerColor,
  });

  if (!outcome.ok) {
    res.status(outcome.httpStatus || 400).json(outcome.body);
    return true;
  }

  const io = req.app.get("io");

  if (outcome.needsRatings && outcome.gameEnded) {
    if (typeof hooks.clearEvaluationHistory === "function") {
      hooks.clearEvaluationHistory(live.gameId);
    }

    if (!mongo) {
      mongo = await Game.findOne({ gameId: live.gameId });
    }
    const gameDoc = buildGameDocForRatings(live, mongo);
    const ratingChanges = await hooks.applyRatingsForGameEnd(
      live.gameId,
      io,
      gameDoc
    );
    const socketPayload = attachRatingChanges(outcome, ratingChanges);

    io.to(live.gameId).emit("move-made", socketPayload);
    await hooks.emitGameEnded(live.gameId, live.result, io, ratingChanges);

    res.status(outcome.httpStatus || 200).json(outcome.httpBody);

    void PersistenceQueue.enqueueLiveGamePersist(live)
      .catch((err) => {
        console.error(
          `[live] PersistenceQueue failed game=${live.gameId}:`,
          err?.message || err
        );
      })
      .then(() => {
        hooks.scheduleGameCompletionSideEffects(live.gameId, live.result, io, {
          skipRatings: true,
        });
      });

    // Terminal — cancel timers (finalize paths also cancel; safe no-op)
    live.rescheduleClocks();

    return true;
  }

  // Active move — emit, ACK, then ordered persist (same latency intent as legacy early ACK).
  if (outcome.socketPayload) {
    io.to(live.gameId).emit("move-made", outcome.socketPayload);
  }

  res.status(outcome.httpStatus || 200).json(outcome.httpBody);

  PersistenceQueue.enqueueLiveGamePersist(live).catch((err) => {
    console.error(
      `[live] PersistenceQueue failed game=${live.gameId}:`,
      err?.message || err
    );
  });

  live.rescheduleClocks();

  if (
    typeof hooks.scheduleAdvantageScoreAfterMove === "function" &&
    live.type === "friend" &&
    live.status === "active"
  ) {
    hooks.scheduleAdvantageScoreAfterMove({
      req,
      gameId: live.gameId,
      gameType: live.type,
      gameStatus: live.status,
      newBoard: outcome.newBoard || live.board,
      nextTurn: live.currentTurn,
      moves: live.moves,
      wasInCheckBeforeMove: outcome.wasInCheckBeforeMove,
      isInCheck: outcome.isInCheck,
    });
  }

  return true;
}

module.exports = {
  tryHandleHttpMove,
};
