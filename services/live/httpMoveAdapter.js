/**
 * Phase 2 HTTP move adapter — thin entry when LIVE_HTTP_VIA_MANAGER is on.
 * Live-human only. Bot / flag-off stay on legacy routes/games.js handler.
 *
 * Flow: Load LiveGame → applyMove → (ratings if terminal) → Emit → Return → Persist.
 * Emit via GameTransport (ADR-006) or Domain Events (ADR-007).
 */

const Game = require("../../models/Game");
const ClockManager = require("./ClockManager");
const LiveGameManager = require("./LiveGameManager");
const {
  LIVE_HTTP_VIA_MANAGER,
  LIVE_MEMORY_SNAPSHOT,
} = require("./flags");
const { ORIGIN } = require("./events/DomainEvent");
const liveSideEffects = require("./liveSideEffects");

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

    const gameEndedPayload = {
      gameId: live.gameId,
      result: live.result,
      ...(ratingChanges ? { ratingChanges } : {}),
      ...(socketPayload?.serverEventId
        ? { serverEventId: socketPayload.serverEventId }
        : {}),
    };

    await liveSideEffects.afterMoveApplied({
      live,
      origin: ORIGIN.HTTP,
      moveMade: socketPayload,
      persist: false,
      reschedule: true,
    });
    await liveSideEffects.afterGameEndedNotify({
      live,
      origin: ORIGIN.HTTP,
      gameEnded: gameEndedPayload,
      persist: false,
    });

    res.status(outcome.httpStatus || 200).json(outcome.httpBody);

    void liveSideEffects.persistLive(live).then(() => {
      hooks.scheduleGameCompletionSideEffects(live.gameId, live.result, io, {
        skipRatings: true,
      });
    });

    return true;
  }

  if (outcome.socketPayload) {
    await liveSideEffects.afterMoveApplied({
      live,
      origin: ORIGIN.HTTP,
      moveMade: outcome.socketPayload,
      persist: true,
      reschedule: true,
    });
  } else {
    void liveSideEffects.persistLive(live);
    live.rescheduleClocks();
  }

  res.status(outcome.httpStatus || 200).json(outcome.httpBody);

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
