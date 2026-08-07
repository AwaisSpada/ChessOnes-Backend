/**
 * Phase 2 MoveProcessor — applies a player move to a duck-typed game state.
 * Reuses chess-engine + ClockAuthority (sole chess-time calculator).
 * No Socket/Mongo/ratings I/O — caller handles emit / persist / end hooks.
 */

const {
  isMoveLegal,
  isKingInCheck,
  isCheckmate,
  isStalemate,
  isInsufficientMaterial,
} = require("../../utils/chess-engine");
const ClockAuthority = require("./ClockAuthority");

function calculateMoveTime({
  previousClockMs,
  updatedClockMs,
  previousMoveTimestamp,
  gameCreatedAt,
}) {
  let moveTimeMs = null;
  if (
    typeof previousClockMs === "number" &&
    typeof updatedClockMs === "number" &&
    Number.isFinite(previousClockMs) &&
    Number.isFinite(updatedClockMs)
  ) {
    moveTimeMs = Math.max(0, previousClockMs - updatedClockMs);
  }

  if (moveTimeMs === null || moveTimeMs === 0) {
    const referenceTs = previousMoveTimestamp || gameCreatedAt;
    if (referenceTs) {
      const delta = Date.now() - new Date(referenceTs).getTime();
      if (Number.isFinite(delta) && delta > 0) {
        moveTimeMs = delta;
      }
    }
  }

  if (moveTimeMs === null || !Number.isFinite(moveTimeMs)) {
    return { moveTimeMs: null, moveTimeSeconds: null };
  }

  const clamped = Math.max(0, Math.round(moveTimeMs));
  return {
    moveTimeMs: clamped,
    moveTimeSeconds: Number((clamped / 1000).toFixed(2)),
  };
}

/**
 * @param {object} game mutable duck-typed game (LiveGame plain fields or mongoose-like)
 * @param {object} cmd { from, to, piece, captured?, notation?, playerColor }
 * @returns {object} outcome
 */
function applyPlayerMove(game, cmd) {
  const { from, to, piece, captured, notation, playerColor } = cmd;

  if (!game || game.status !== "active") {
    return {
      ok: false,
      httpStatus: 400,
      body: { success: false, message: "Game is not active" },
    };
  }

  if (game.currentTurn !== playerColor) {
    return {
      ok: false,
      httpStatus: 400,
      body: { success: false, message: "Not your turn" },
    };
  }

  ClockAuthority.ensureTimeRemaining(game);

  const lastMoveTimestamp =
    game.moves && game.moves.length > 0
      ? game.moves[game.moves.length - 1]?.timestamp
      : null;
  const previousClockMs =
    playerColor === "white"
      ? game.timeRemaining?.white
      : game.timeRemaining?.black;

  // Same as legacy: check state of mover before board mutation (friend advantage bar).
  const wasMovingSideWhite = game.currentTurn === "white";
  const wasInCheckBeforeMove = isKingInCheck(game.board, wasMovingSideWhite);

  const liveHuman = ClockAuthority.isLiveHumanGame(game);

  /** @type {null | { timedOut: boolean, elapsedMs: number, side: string, remainingMs?: number }} */
  let pendingClockCommit = null;

  if (liveHuman) {
    if (!game.clockStartedAt && (!game.moves || game.moves.length === 0)) {
      game.clockStartedAt = game.clockStartedAt || new Date();
    }
    // Compute-only — rejected moves must not mutate storedRemaining.
    const clockResult = ClockAuthority.applyServerElapsedClock(game);
    if (clockResult.timedOut) {
      // Terminal flag: commit in the same transition as status end.
      ClockAuthority.commitElapsedClock(game, clockResult);
      game.status = "completed";
      game.result = {
        winner: playerColor === "white" ? "black" : "white",
        reason: "timeout",
      };
      ClockAuthority.bumpSyncVersion(game);
      const timeoutPayload = ClockAuthority.withLiveSync(game, {
        gameId: game.gameId,
        board: game.board,
        gameEnded: true,
        result: game.result,
        timedOut: true,
      });
      return {
        ok: true,
        kind: "timeout",
        socketPayload: timeoutPayload,
        httpStatus: 400,
        httpBody: {
          success: false,
          code: "TIMEOUT",
          message: "Out of time",
          data: timeoutPayload,
        },
        needsRatings: true,
        gameEnded: true,
      };
    }
    pendingClockCommit = clockResult;
  }

  const movingPiece = game.board[from];
  if (!movingPiece) {
    return {
      ok: false,
      httpStatus: 400,
      body: { success: false, message: "No piece at source square" },
    };
  }

  const isWhiteMovingPiece = movingPiece === movingPiece.toUpperCase();
  if (
    (isWhiteMovingPiece && playerColor !== "white") ||
    (!isWhiteMovingPiece && playerColor !== "black")
  ) {
    return {
      ok: false,
      httpStatus: 400,
      body: { success: false, message: "Cannot move opponent's piece" },
    };
  }

  let promotionPiece = null;
  if (piece && typeof piece === "string") {
    const letter = piece.trim().toLowerCase();
    if (letter === "q" || letter === "r" || letter === "b" || letter === "n") {
      promotionPiece = piece;
    } else if (
      movingPiece &&
      movingPiece.toLowerCase() === "p" &&
      letter === "p"
    ) {
      promotionPiece = "q";
    }
  }
  if (!isMoveLegal(game.board, from, to, promotionPiece)) {
    return {
      ok: false,
      httpStatus: 400,
      body: {
        success: false,
        message: "Illegal move - would leave king in check or invalid move",
      },
    };
  }

  let enPassantTarget = null;
  if (game.moves.length > 0) {
    const lastMove = game.moves[game.moves.length - 1];
    const lastPiece = game.board[lastMove.to];
    if (lastPiece && lastPiece.toLowerCase() === "p") {
      const lastFromRow = Math.floor(lastMove.from / 8);
      const lastToRow = Math.floor(lastMove.to / 8);
      if (Math.abs(lastToRow - lastFromRow) === 2) {
        const midRow = (lastFromRow + lastToRow) / 2;
        enPassantTarget = midRow * 8 + (lastMove.to % 8);
      }
    }
  }

  const newBoard = [...game.board];
  const capturedPiece = newBoard[to];

  const isEnPassant =
    movingPiece &&
    movingPiece.toLowerCase() === "p" &&
    enPassantTarget !== null &&
    to === enPassantTarget &&
    Math.abs((from % 8) - (to % 8)) === 1 &&
    !capturedPiece;

  let actualCapturedPiece = capturedPiece;
  if (isEnPassant) {
    const dir = movingPiece === movingPiece.toUpperCase() ? 1 : -1;
    const capturedPawnIndex = to + dir * 8;
    actualCapturedPiece = newBoard[capturedPawnIndex];
    if (actualCapturedPiece && actualCapturedPiece.toLowerCase() === "p") {
      newBoard[capturedPawnIndex] = null;
    }
  }

  // Illegal king capture → force checkmate end (same as legacy route)
  if (capturedPiece && capturedPiece.toLowerCase() === "k") {
    const isWhiteKing = capturedPiece === "K";
    const isBlackKing = capturedPiece === "k";
    const isWhiteMoving = movingPiece === movingPiece.toUpperCase();
    const isBlackMoving = movingPiece === movingPiece.toLowerCase();
    if ((isWhiteKing && isBlackMoving) || (isBlackKing && isWhiteMoving)) {
      // Commit drain + new move timestamp in the same transition.
      if (pendingClockCommit) {
        ClockAuthority.commitElapsedClock(game, pendingClockCommit);
        pendingClockCommit = null;
      }
      const updatedClockMs =
        playerColor === "white"
          ? game.timeRemaining?.white
          : game.timeRemaining?.black;
      const moveTiming = calculateMoveTime({
        previousClockMs,
        updatedClockMs,
        previousMoveTimestamp: lastMoveTimestamp,
        gameCreatedAt: game.createdAt,
      });
      const move = {
        from,
        to,
        piece,
        captured: capturedPiece || null,
        notation:
          notation ||
          `${piece}${String.fromCharCode(97 + (to % 8))}${8 - Math.floor(to / 8)}`,
        moveTimeMs: moveTiming.moveTimeMs,
        moveTimeSeconds: moveTiming.moveTimeSeconds,
        timestamp: new Date(),
      };
      newBoard[to] = movingPiece;
      newBoard[from] = null;
      game.board = newBoard;
      if (!Array.isArray(game.moves)) game.moves = [];
      game.moves.push(move);
      ClockAuthority.applyFischerIncrementToMover(game, playerColor);
      game.status = "completed";
      game.result = {
        winner: isWhiteMoving ? "white" : "black",
        reason: "checkmate",
      };
      ClockAuthority.bumpSyncVersion(game);
      const terminalPayload = ClockAuthority.withLiveSync(game, {
        gameId: game.gameId,
        move,
        board: newBoard,
        gameEnded: true,
        isCheckmate: true,
        result: game.result,
      });
      return {
        ok: true,
        kind: "terminal",
        socketPayload: terminalPayload,
        httpStatus: 200,
        httpBody: {
          success: true,
          message: "Game ended - checkmate",
          data: {
            move,
            board: newBoard,
            currentTurn: game.currentTurn,
            timeRemaining: game.timeRemaining,
            syncVersion: terminalPayload.syncVersion,
            ply: terminalPayload.ply,
            serverNow: terminalPayload.serverNow,
            gameEnded: true,
            result: game.result,
          },
        },
        needsRatings: true,
        gameEnded: true,
        move,
        newBoard,
        wasInCheckBeforeMove,
      };
    }
  }

  if (isEnPassant) {
    newBoard[to] = movingPiece;
    newBoard[from] = null;
  } else {
    const fromFile = from % 8;
    const toFile = to % 8;
    const fromRank = Math.floor(from / 8);
    const isCastling =
      movingPiece &&
      movingPiece.toLowerCase() === "k" &&
      Math.abs(toFile - fromFile) === 2;

    if (isCastling) {
      newBoard[to] = movingPiece;
      newBoard[from] = null;
      if (toFile === 6) {
        const rookFrom = fromRank * 8 + 7;
        const rookTo = fromRank * 8 + 5;
        newBoard[rookTo] = newBoard[rookFrom];
        newBoard[rookFrom] = null;
      } else if (toFile === 2) {
        const rookFrom = fromRank * 8 + 0;
        const rookTo = fromRank * 8 + 3;
        newBoard[rookTo] = newBoard[rookFrom];
        newBoard[rookFrom] = null;
      }
    } else {
      const toRow = Math.floor(to / 8);
      const isPawnPromotion =
        movingPiece &&
        movingPiece.toLowerCase() === "p" &&
        ((movingPiece === movingPiece.toUpperCase() && toRow === 0) ||
          (movingPiece === movingPiece.toLowerCase() && toRow === 7));

      if (isPawnPromotion) {
        const raw = typeof piece === "string" ? piece.trim() : "";
        const letter = raw.toLowerCase();
        const promoLetter =
          letter === "q" || letter === "r" || letter === "b" || letter === "n"
            ? letter
            : "q";
        const promotedPiece =
          movingPiece === movingPiece.toUpperCase()
            ? promoLetter.toUpperCase()
            : promoLetter.toLowerCase();
        newBoard[to] = promotedPiece;
      } else {
        newBoard[to] = movingPiece;
      }
      newBoard[from] = null;
    }
  }

  // Commit drain + new move timestamp in the same transition.
  if (pendingClockCommit) {
    ClockAuthority.commitElapsedClock(game, pendingClockCommit);
    pendingClockCommit = null;
  }

  const updatedClockMs =
    playerColor === "white"
      ? game.timeRemaining?.white
      : game.timeRemaining?.black;
  const moveTiming = calculateMoveTime({
    previousClockMs,
    updatedClockMs,
    previousMoveTimestamp: lastMoveTimestamp,
    gameCreatedAt: game.createdAt,
  });

  const move = {
    from,
    to,
    piece,
    captured: captured || actualCapturedPiece || null,
    notation:
      notation ||
      `${piece}${String.fromCharCode(97 + (to % 8))}${8 - Math.floor(to / 8)}`,
    moveTimeMs: moveTiming.moveTimeMs,
    moveTimeSeconds: moveTiming.moveTimeSeconds,
    timestamp: new Date(),
  };

  game.board = newBoard;
  if (!Array.isArray(game.moves)) game.moves = [];
  game.moves.push(move);
  ClockAuthority.applyFischerIncrementToMover(game, playerColor);
  const nextTurn = game.currentTurn === "white" ? "black" : "white";
  game.currentTurn = nextTurn;

  const positionHash = JSON.stringify(newBoard) + "|" + nextTurn;
  if (!game.positionHistory) game.positionHistory = [];
  game.positionHistory.push(positionHash);
  const positionCount = game.positionHistory.filter(
    (pos) => pos === positionHash
  ).length;
  const isThreefoldRepetition = positionCount >= 3;

  const isNextTurnWhite = nextTurn === "white";
  const isInCheck = isKingInCheck(newBoard, isNextTurnWhite);
  const isCheckmateState =
    isInCheck && isCheckmate(newBoard, isNextTurnWhite);
  const isStalemateState =
    !isInCheck && isStalemate(newBoard, isNextTurnWhite);
  const isInsufficientMaterialState = isInsufficientMaterial(newBoard);

  if (
    isCheckmateState ||
    isStalemateState ||
    isThreefoldRepetition ||
    isInsufficientMaterialState
  ) {
    game.status = "completed";
    if (isCheckmateState) {
      game.result = {
        winner: isNextTurnWhite ? "black" : "white",
        reason: "checkmate",
      };
    } else if (isThreefoldRepetition) {
      game.result = { winner: "draw", reason: "threefold-repetition" };
    } else if (isInsufficientMaterialState) {
      game.result = { winner: "draw", reason: "insufficient-material" };
    } else {
      game.result = { winner: "draw", reason: "stalemate" };
    }
    ClockAuthority.bumpSyncVersion(game);
    const terminalMoveData = ClockAuthority.withLiveSync(game, {
      gameId: game.gameId,
      move,
      board: newBoard,
      isInCheck,
      isCheckmate: isCheckmateState,
      isStalemate: isStalemateState,
      isThreefoldRepetition,
      isInsufficientMaterial: isInsufficientMaterialState,
      gameEnded: true,
      result: game.result,
    });
    return {
      ok: true,
      kind: "terminal",
      socketPayload: terminalMoveData,
      httpStatus: 200,
      httpBody: {
        success: true,
        message: "Move made and game ended",
        data: {
          move,
          board: newBoard,
          currentTurn: game.currentTurn,
          timeRemaining: game.timeRemaining,
          syncVersion: terminalMoveData.syncVersion,
          ply: terminalMoveData.ply,
          serverNow: terminalMoveData.serverNow,
          gameStatus: game.status,
          gameEnded: true,
          isCheckmate: isCheckmateState,
          isStalemate: isStalemateState,
          isThreefoldRepetition,
          isInsufficientMaterial: isInsufficientMaterialState,
          result: game.result,
        },
      },
      needsRatings: true,
      gameEnded: true,
      move,
      newBoard,
      isInCheck,
      isCheckmateState,
      isStalemateState,
      isThreefoldRepetition,
      isInsufficientMaterialState,
      wasInCheckBeforeMove,
    };
  }

  ClockAuthority.bumpSyncVersion(game);
  const moveData = ClockAuthority.withLiveSync(game, {
    gameId: game.gameId,
    move,
    board: newBoard,
    isInCheck,
    isCheckmate: isCheckmateState,
    isStalemate: isStalemateState,
    isThreefoldRepetition,
    isInsufficientMaterial: isInsufficientMaterialState,
    turnStartedAt:
      move?.timestamp instanceof Date
        ? move.timestamp.toISOString()
        : move?.timestamp || null,
  });

  return {
    ok: true,
    kind: "active",
    socketPayload: moveData,
    httpStatus: 200,
    httpBody: {
      success: true,
      message: "Move made successfully",
      data: {
        move,
        board: newBoard,
        currentTurn: game.currentTurn,
        timeRemaining: game.timeRemaining,
        syncVersion: moveData.syncVersion,
        ply: moveData.ply,
        serverNow: moveData.serverNow,
        turnStartedAt:
          move?.timestamp instanceof Date
            ? move.timestamp.toISOString()
            : move?.timestamp || null,
        isInCheck,
        isCheckmate: isCheckmateState,
        isStalemate: isStalemateState,
        isThreefoldRepetition,
        isInsufficientMaterial: isInsufficientMaterialState,
        gameEnded: false,
        result: null,
        advantageScore: 0,
      },
    },
    needsRatings: false,
    gameEnded: false,
    move,
    newBoard,
    isInCheck,
    isCheckmateState,
    isStalemateState,
    isThreefoldRepetition,
    isInsufficientMaterialState,
    wasInCheckBeforeMove,
  };
}

module.exports = {
  applyPlayerMove,
  calculateMoveTime,
};
