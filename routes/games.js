const express = require("express");
const { body, validationResult } = require("express-validator");
const Game = require("../models/Game");
const User = require("../models/User");
const Stats = require("../models/Stats");
const auth = require("../middleware/auth");
const requirePoliciesAccepted = require("../middleware/requirePoliciesAccepted");
const {
  isMoveLegal,
  isKingInCheck,
  isCheckmate,
  isStalemate,
  isInsufficientMaterial,
  getAllLegalMoves,
} = require("../utils/chess-engine");

const router = express.Router();

// Evaluation history storage per game (for smoothing and momentum tracking)
const gameEvaluationHistory = new Map(); // gameId -> { previousEval, previousSign, confirmCount, wasInCheck, checkEscapeConfirmCount, pendingEvaluation, kingUnderAttackCounter, unchangedEvalCount }

// Material calculation removed - using pure Stockfish evaluation only

/**
 * Detect if a king is in danger (check or exposed to enemy queen/rook)
 * @param {Array} board - Board array (64 squares)
 * @param {boolean} isWhiteKing - True if checking white king, false for black king
 * @param {boolean} isInCheck - Whether the king is currently in check
 * @returns {boolean} - True if king is in danger
 */
function isKingInDanger(board, isWhiteKing, isInCheck) {
  if (!board || board.length !== 64) return false;
  
  // If in check, definitely in danger
  if (isInCheck) return true;
  
  // Find king position
  const kingPiece = isWhiteKing ? 'K' : 'k';
  let kingIndex = -1;
  for (let i = 0; i < 64; i++) {
    if (board[i] === kingPiece) {
      kingIndex = i;
      break;
    }
  }
  
  if (kingIndex === -1) return false; // King not found (shouldn't happen)
  
  const kingRow = Math.floor(kingIndex / 8);
  const kingCol = kingIndex % 8;
  
  // Check for enemy queen or rook in close proximity (within 2 squares)
  const enemyQueen = isWhiteKing ? 'q' : 'Q';
  const enemyRook = isWhiteKing ? 'r' : 'R';
  
  // Check all squares within 2 squares of the king
  for (let row = Math.max(0, kingRow - 2); row <= Math.min(7, kingRow + 2); row++) {
    for (let col = Math.max(0, kingCol - 2); col <= Math.min(7, kingCol + 2); col++) {
      const squareIndex = row * 8 + col;
      const piece = board[squareIndex];
      
      if (piece === enemyQueen || piece === enemyRook) {
        // Check if piece can attack the king (same row, column, or diagonal)
        const pieceRow = row;
        const pieceCol = col;
        const rowDiff = Math.abs(pieceRow - kingRow);
        const colDiff = Math.abs(pieceCol - kingCol);
        
        // Queen can attack if same row, column, or diagonal
        // Rook can attack if same row or column
        if (piece === enemyQueen) {
          if (rowDiff === 0 || colDiff === 0 || rowDiff === colDiff) {
            return true; // Queen can attack king
          }
        } else if (piece === enemyRook) {
          if (rowDiff === 0 || colDiff === 0) {
            return true; // Rook can attack king
          }
        }
      }
    }
  }
  
  return false;
}

/**
 * Chess.com/Lichess standard advantage bar evaluation processing
 * Converts Stockfish evaluation to White's perspective, clamps to ±800cp,
 * computes pawnEval and normalized (via sigmoid) for visual bar
 * @param {Object} rawEval - { centipawns, isMate, mateMoves }
 * @param {string} gameId - Game ID (for game status check only)
 * @param {string} gameStatus - Game status ('active', 'completed', etc.)
 * @param {string} sideToMove - 'white' or 'black' - the side to move in the position being evaluated
 * @returns {Object} - { pawnEval, normalized, isMate } - Pawn evaluation and normalized 0-100 value
 */
function processEvaluationForAdvantageBar(rawEval, gameId, gameStatus = 'active', sideToMove = 'white') {
  // 1. GAME STATUS CHECK: Freeze evaluation after game ends
  if (gameStatus !== 'active') {
    const history = gameEvaluationHistory.get(gameId);
    if (history && history.previousScore !== undefined) {
      console.log(`[AdvantageBar] 🛑 Game ended (status: ${gameStatus}), freezing at ${history.previousScore}cp`);
      return {
        score: history.previousScore,
        mate: history.previousMate || null
      };
    }
    return { score: 0, mate: null };
  }
  
  const { centipawns, isMate, mateMoves } = rawEval;
  
  // 2. Convert to White's perspective
  // Stockfish evaluates from the side to move's perspective
  let evalCpFromWhite = centipawns;
  let mateFromWhite = mateMoves;
  
  if (sideToMove === 'black') {
    evalCpFromWhite = -centipawns;
    mateFromWhite = mateMoves !== null ? -mateMoves : null;
  }
  
  // 3. MATE HANDLING: Return mate moves directly
  if (isMate && mateFromWhite !== null) {
    console.log(`[AdvantageBar] ♟️  Mate detected: ${mateFromWhite > 0 ? 'White' : 'Black'} mate in ${Math.abs(mateFromWhite)} moves`);
    return {
      score: 0, // Score is irrelevant for mate
      mate: mateFromWhite // Return mate moves directly (positive = White, negative = Black)
    };
  }
  
  // 4. Clamp centipawns to ±800cp (from White's perspective)
  const clampedCp = Math.max(-800, Math.min(800, Math.round(evalCpFromWhite)));
  
  // Update history
  if (!gameEvaluationHistory.has(gameId)) {
    gameEvaluationHistory.set(gameId, { previousScore: 0, previousMate: null });
  }
  const history = gameEvaluationHistory.get(gameId);
  history.previousScore = clampedCp;
  history.previousMate = null;
  
  console.log(`[AdvantageBar] 📊 Position evaluated (${sideToMove} to move):`);
  console.log(`[AdvantageBar]    Raw Stockfish: ${centipawns}cp (${sideToMove}'s perspective)`);
  if (sideToMove === 'black') {
    console.log(`[AdvantageBar]    🔄 Inverted: ${centipawns}cp → ${evalCpFromWhite}cp → clamped to ${clampedCp}cp (White's perspective)`);
  } else {
    console.log(`[AdvantageBar]    ✅ No inversion: ${centipawns}cp → clamped to ${clampedCp}cp (White's perspective)`);
  }
  
  return {
    score: clampedCp, // Return centipawns directly (frontend will calculate sigmoid)
    mate: null // No mate
  };
}

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

// @route   POST /api/games/create
// @desc    Create a new game
// @access  Private
router.post(
  "/create",
  [
    auth,
    requirePoliciesAccepted,
    body("type").isIn(["bot", "multiplayer", "friend"]),
    body("botDifficulty").optional().isIn(["easy", "medium", "hard"]),
    body("timeControl").optional().isObject(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { type, botDifficulty, timeControl, opponentId } = req.body;

      const { setGameCategory } = require("../services/ratingEngine");
      
      const gameData = {
        type,
        players: {
          white: req.user._id,
        },
        timeControl: timeControl || { initial: 600000, increment: 0 },
      };

      if (type === "bot") {
        gameData.botDifficulty = botDifficulty || "medium";
        gameData.players.black = null; // Bot doesn't need a user ID
      } else if (type === "friend" && opponentId) {
        gameData.players.black = opponentId;
      }

      const game = new Game(gameData);
      // Set category based on time control
      setGameCategory(game);
      await game.save();

      // Update user status
      req.user.status = "in-game";
      await req.user.save();

      res.status(201).json({
        success: true,
        message: "Game created successfully",
        data: { game },
      });
    } catch (error) {
      console.error("Create game error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   GET /api/games/:gameId
// @desc    Get game by ID
// @access  Private
router.get("/:gameId", auth, async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.gameId })
      .populate(
        "players.white",
        "username fullName avatar country rating ratings isDeleted"
      )
      .populate(
        "players.black",
        "username fullName avatar country rating ratings isDeleted"
      )
      .populate("bot", "key name photoUrl difficulty elo subtitle description");

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    // Check if user is part of this game
    // For bot games, players.white or players.black might be null (bot doesn't have user ID)
    const isPlayer =
      (game.players.white &&
        game.players.white._id &&
        game.players.white._id.equals(req.user._id)) ||
      (game.players.black &&
        game.players.black._id &&
        game.players.black._id.equals(req.user._id));

    if (!isPlayer && game.type !== "multiplayer") {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    // Compute effective timeRemaining based on last update so timers stay correct on reload
    // Only subtract elapsed time if the game has actually started (has moves)
    let effectiveTimeRemaining = { ...game.timeRemaining?.toObject?.() } || {
      white: game.timeRemaining?.white,
      black: game.timeRemaining?.black,
    };

    // Only calculate elapsed time if game has started (has moves)
    const gameHasStarted = game.moves && game.moves.length > 0;

    if (game.status === "active" && effectiveTimeRemaining && gameHasStarted) {
      const now = Date.now();

      // Use the last move's timestamp if available, otherwise use updatedAt
      // This ensures we calculate elapsed time from when the last move was made, not when the game was last saved
      let lastMoveTime = now;
      if (game.moves && game.moves.length > 0) {
        const lastMove = game.moves[game.moves.length - 1];
        if (lastMove.timestamp) {
          lastMoveTime = new Date(lastMove.timestamp).getTime();
        } else if (game.updatedAt) {
          // Fallback to updatedAt if move doesn't have timestamp
          lastMoveTime = game.updatedAt.getTime();
        }
      } else if (game.updatedAt) {
        lastMoveTime = game.updatedAt.getTime();
      }

      const elapsed = Math.max(0, now - lastMoveTime);

      if (
        game.currentTurn === "white" &&
        typeof effectiveTimeRemaining.white === "number"
      ) {
        effectiveTimeRemaining.white = Math.max(
          0,
          effectiveTimeRemaining.white - elapsed
        );
      } else if (
        game.currentTurn === "black" &&
        typeof effectiveTimeRemaining.black === "number"
      ) {
        effectiveTimeRemaining.black = Math.max(
          0,
          effectiveTimeRemaining.black - elapsed
        );
      }
    }

    res.json({
      success: true,
      data: {
        game: { ...game.toObject(), timeRemaining: effectiveTimeRemaining },
      },
    });
  } catch (error) {
    console.error("Get game error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/games/:gameId/move
// @desc    Make a move in the game
// @access  Private
router.post(
  "/:gameId/move",
  [
    auth,
    requirePoliciesAccepted,
    body("from").isInt({ min: 0, max: 63 }),
    body("to").isInt({ min: 0, max: 63 }),
    body("piece").isString(),
    body("notation").optional().isString(),
    body("timeRemaining").optional().isObject(),
    body("inCheck").optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Invalid move data",
          errors: errors.array(),
        });
      }

      const { from, to, piece, captured, notation, timeRemaining, inCheck } =
        req.body;
      const game = await Game.findOne({ gameId: req.params.gameId });

      if (!game) {
        return res.status(404).json({
          success: false,
          message: "Game not found",
        });
      }

      if (game.status !== "active") {
        return res.status(400).json({
          success: false,
          message: "Game is not active",
        });
      }

      // Check if it's the player's turn
      // For bot games, players.white or players.black might be null
      const isWhitePlayer =
        game.players.white && game.players.white.equals(req.user._id);
      const isBlackPlayer =
        game.players.black && game.players.black.equals(req.user._id);

      if (!isWhitePlayer && !isBlackPlayer) {
        return res.status(403).json({
          success: false,
          message: "You are not a player in this game",
        });
      }

      const playerColor = isWhitePlayer ? "white" : "black";
      if (game.currentTurn !== playerColor) {
        return res.status(400).json({
          success: false,
          message: "Not your turn",
        });
      }

      // Harden clock object for older/edge game docs so pre-move payloads never crash this route.
      if (
        !game.timeRemaining ||
        typeof game.timeRemaining.white !== "number" ||
        typeof game.timeRemaining.black !== "number"
      ) {
        game.timeRemaining = {
          white:
            typeof game.timeRemaining?.white === "number"
              ? game.timeRemaining.white
              : typeof timeRemaining?.white === "number"
                ? timeRemaining.white
                : 600000,
          black:
            typeof game.timeRemaining?.black === "number"
              ? game.timeRemaining.black
              : typeof timeRemaining?.black === "number"
                ? timeRemaining.black
                : 600000,
        };
      }

      const lastMoveTimestamp =
        game.moves && game.moves.length > 0
          ? game.moves[game.moves.length - 1]?.timestamp
          : null;
      const previousClockMs =
        playerColor === "white" ? game.timeRemaining?.white : game.timeRemaining?.black;

      // Optionally sync clock from client (for reconnect resilience)
      if (timeRemaining && typeof timeRemaining === "object") {
        if (typeof timeRemaining.white === "number") {
          game.timeRemaining.white = timeRemaining.white;
        }
        if (typeof timeRemaining.black === "number") {
          game.timeRemaining.black = timeRemaining.black;
        }
      }

      // Validate move legality before applying
      const movingPiece = game.board[from];
      if (!movingPiece) {
        return res.status(400).json({
          success: false,
          message: "No piece at source square",
        });
      }

      const isWhiteMoving = movingPiece === movingPiece.toUpperCase();
      if (
        (isWhiteMoving && playerColor !== "white") ||
        (!isWhiteMoving && playerColor !== "black")
      ) {
        return res.status(400).json({
          success: false,
          message: "Cannot move opponent's piece",
        });
      }

      // Check if move is legal (doesn't leave own king in check)
      const promotionPiece =
        piece && piece !== movingPiece.toLowerCase() ? piece : null;
      if (!isMoveLegal(game.board, from, to, promotionPiece)) {
        return res.status(400).json({
          success: false,
          message: "Illegal move - would leave king in check or invalid move",
        });
      }

      // Calculate en passant target from last move (if it was a two-square pawn move)
      let enPassantTarget = null;
      if (game.moves.length > 0) {
        const lastMove = game.moves[game.moves.length - 1];
        const lastPiece = game.board[lastMove.to];
        if (lastPiece && lastPiece.toLowerCase() === "p") {
          const lastFromRow = Math.floor(lastMove.from / 8);
          const lastToRow = Math.floor(lastMove.to / 8);
          if (Math.abs(lastToRow - lastFromRow) === 2) {
            // Last move was a two-square pawn move - set en passant target
            const midRow = (lastFromRow + lastToRow) / 2;
            enPassantTarget = midRow * 8 + (lastMove.to % 8);
          }
        }
      }

      // Update board
      const newBoard = [...game.board];
      const capturedPiece = newBoard[to];

      // Check if this is an en passant capture
      const isEnPassant =
        movingPiece &&
        movingPiece.toLowerCase() === "p" && // It's a pawn
        enPassantTarget !== null && // There's an en passant target
        to === enPassantTarget && // Moving to the en passant target square
        Math.abs((from % 8) - (to % 8)) === 1 && // Moving diagonally (one file over)
        !capturedPiece; // The target square is empty (en passant square is behind the captured pawn)

      let actualCapturedPiece = capturedPiece;
      if (isEnPassant) {
        // For en passant, the captured pawn is on the same file as 'to', but on the rank behind it
        // For white: captured pawn is one rank behind (to + 8, since ranks increase downward)
        // For black: captured pawn is one rank ahead (to - 8, since ranks decrease upward)
        const isWhiteMoving = movingPiece === movingPiece.toUpperCase();
        const dir = isWhiteMoving ? 1 : -1;
        const capturedPawnIndex = to + dir * 8;
        actualCapturedPiece = newBoard[capturedPawnIndex];

        // Remove the captured pawn from the board
        if (actualCapturedPiece && actualCapturedPiece.toLowerCase() === "p") {
          newBoard[capturedPawnIndex] = null;
        }
      }

      // NEVER allow capturing the opponent's king - game should end in checkmate before this
      // If somehow this happens, end the game immediately
      if (capturedPiece && capturedPiece.toLowerCase() === "k") {
        const isWhiteKing = capturedPiece === "K";
        const isBlackKing = capturedPiece === "k";
        const isWhiteMoving =
          movingPiece && movingPiece === movingPiece.toUpperCase();
        const isBlackMoving =
          movingPiece && movingPiece === movingPiece.toLowerCase();

        // Check if we're capturing the opponent's king
        if ((isWhiteKing && isBlackMoving) || (isBlackKing && isWhiteMoving)) {
          const updatedClockMs =
            playerColor === "white" ? game.timeRemaining?.white : game.timeRemaining?.black;
          const moveTiming = calculateMoveTime({
            previousClockMs,
            updatedClockMs,
            previousMoveTimestamp: lastMoveTimestamp,
            gameCreatedAt: game.createdAt,
          });

          // Create move record first
          const move = {
            from,
            to,
            piece,
            captured: capturedPiece || null,
            notation:
              notation ||
              `${piece}${String.fromCharCode(97 + (to % 8))}${
                8 - Math.floor(to / 8)
              }`,
            moveTimeMs: moveTiming.moveTimeMs,
            moveTimeSeconds: moveTiming.moveTimeSeconds,
            timestamp: new Date(),
          };

          // Apply the move to the board
          newBoard[to] = movingPiece;
          newBoard[from] = null;

          // End the game immediately
          game.board = newBoard;
          game.moves.push(move);
          game.status = "completed";
          // Clean up evaluation history when game ends
          gameEvaluationHistory.delete(req.params.gameId);
          game.result = {
            winner: isWhiteMoving ? "white" : "black",
            reason: "checkmate",
          };
          await game.save();

          // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
          // COPY EXACT FLOW FROM /end ENDPOINT (timeout handler) - DO NOT CHANGE
          try {
            const { triggerReviewGeneration } = require("../utils/game-review/game-completion-hook");
            triggerReviewGeneration(game.gameId);
          } catch (error) {
            // Don't fail game completion if review hook fails
            console.error(`[GameReview] Error triggering review generation hook:`, error);
          }

          // Reload game to ensure all fields (including category) are present
          const gameForRating = await Game.findOne({ gameId: req.params.gameId })
            .populate("players.white players.black");
          
          // Ensure category is set
          if (!gameForRating.category && gameForRating.timeControl) {
            const { setGameCategory } = require("../services/ratingEngine");
            setGameCategory(gameForRating);
            await gameForRating.save();
          }

          // Update player stats (WITH category for badge tracking)
          const Stats = require("../models/Stats");
          const gameTime = Date.now() - gameForRating.createdAt.getTime();
          const gameCategory = gameForRating.category;

          if (gameForRating.players.white) {
            const whiteStats = await Stats.findOne({ user: gameForRating.players.white._id });
            if (whiteStats) {
              const whiteResult = game.result.winner === "white" ? "win" : game.result.winner === "black" ? "loss" : "draw";
              await whiteStats.updateAfterGame(gameForRating.type, whiteResult, gameTime, gameCategory);
            }
          }

          if (gameForRating.players.black && gameForRating.type !== "bot") {
            const blackStats = await Stats.findOne({ user: gameForRating.players.black._id });
            if (blackStats) {
              const blackResult = game.result.winner === "black" ? "win" : game.result.winner === "white" ? "loss" : "draw";
              await blackStats.updateAfterGame(gameForRating.type, blackResult, gameTime, gameCategory);
            }
          }

          // For bot games, update stats for the human player
          if (gameForRating.type === "bot") {
            const userId = gameForRating.players.white?._id || gameForRating.players.black?._id;
            if (userId) {
              const userStats = await Stats.findOne({ user: userId });
              if (userStats) {
                const userResult = (gameForRating.players.white && game.result.winner === "white") || 
                                 (gameForRating.players.black && game.result.winner === "black") 
                                 ? "win" : game.result.winner === "draw" ? "draw" : "loss";
                await userStats.updateAfterGame(gameForRating.type, userResult, gameTime, gameCategory);
              }
            }
          }

          // Update Glicko-2 ratings for invitation/friend games
          const { updateGameRatings } = require("../services/updateGameRatings");
          const io = req.app.get("io");
          await updateGameRatings(gameForRating, io);

          // Check badges for ALL game types
          try {
            const { checkAndAwardBadges } = require("../services/achievementService");
            if (gameForRating.type === "bot") {
              const userId = gameForRating.players.white?._id || gameForRating.players.black?._id;
              if (userId) {
                await checkAndAwardBadges(userId.toString(), gameForRating.gameId, io);
              }
            } else {
              if (gameForRating.players.white) {
                await checkAndAwardBadges(gameForRating.players.white._id.toString(), gameForRating.gameId, io);
              }
              if (gameForRating.players.black) {
                await checkAndAwardBadges(gameForRating.players.black._id.toString(), gameForRating.gameId, io);
              }
            }
          } catch (badgeError) {
            console.error("[Game End] Error checking badges:", badgeError);
          }

          // Emit game ended event
          req.app.get("io").to(req.params.gameId).emit("game-ended", {
            gameId: req.params.gameId,
            result: game.result,
          });

          // Also emit the move
          req.app.get("io").to(req.params.gameId).emit("move-made", {
            gameId: req.params.gameId,
            move,
            board: newBoard,
            currentTurn: game.currentTurn,
            timeRemaining: game.timeRemaining,
          });

          return res.json({
            success: true,
            message: "Game ended - checkmate",
            data: {
              move,
              board: newBoard,
              currentTurn: game.currentTurn,
              timeRemaining: game.timeRemaining,
              gameEnded: true,
              result: game.result,
            },
          });
        }
      }

      // Handle en passant capture first (before regular move logic)
      if (isEnPassant) {
        // Move the pawn to the en passant square
        newBoard[to] = movingPiece;
        newBoard[from] = null;
        // The captured pawn was already removed above
      } else {
        // Check if this is castling (king moves 2 squares horizontally)
        const fromFile = from % 8;
        const toFile = to % 8;
        const fromRank = Math.floor(from / 8);
        const isCastling =
          movingPiece &&
          movingPiece.toLowerCase() === "k" && // It's a king
          Math.abs(toFile - fromFile) === 2; // King moves exactly 2 squares horizontally

        if (isCastling) {
          // Handle castling - move both king and rook
          newBoard[to] = movingPiece;
          newBoard[from] = null;

          // King-side castling (king moves to g-file, rook moves from h-file to f-file)
          if (toFile === 6) {
            const rookFrom = fromRank * 8 + 7; // h-file
            const rookTo = fromRank * 8 + 5; // f-file
            newBoard[rookTo] = newBoard[rookFrom];
            newBoard[rookFrom] = null;
          }
          // Queen-side castling (king moves to c-file, rook moves from a-file to d-file)
          else if (toFile === 2) {
            const rookFrom = fromRank * 8 + 0; // a-file
            const rookTo = fromRank * 8 + 3; // d-file
            newBoard[rookTo] = newBoard[rookFrom];
            newBoard[rookFrom] = null;
          }
        } else {
          // Check if this is a pawn promotion
          const toRow = Math.floor(to / 8);
          const isPawnPromotion =
            movingPiece &&
            movingPiece.toLowerCase() === "p" && // It's a pawn
            ((movingPiece === movingPiece.toUpperCase() && toRow === 0) || // White pawn to rank 8
              (movingPiece === movingPiece.toLowerCase() && toRow === 7)); // Black pawn to rank 1

          if (isPawnPromotion && piece) {
            // This is a promotion - use the piece parameter (Q, R, B, N)
            // Preserve the color: uppercase for white, lowercase for black
            const promotedPiece =
              movingPiece === movingPiece.toUpperCase()
                ? piece.toUpperCase()
                : piece.toLowerCase();
            newBoard[to] = promotedPiece;
          } else {
            // Regular move - just move the piece
            newBoard[to] = movingPiece;
          }
          newBoard[from] = null;
        }
      }

      // Check state BEFORE the move (for the side making the move)
      // This must be checked before board is updated
      const wasMovingSideWhite = game.currentTurn === "white";
      const wasInCheckBeforeMove = isKingInCheck(game.board, wasMovingSideWhite);
      
      const updatedClockMs =
        playerColor === "white" ? game.timeRemaining?.white : game.timeRemaining?.black;
      const moveTiming = calculateMoveTime({
        previousClockMs,
        updatedClockMs,
        previousMoveTimestamp: lastMoveTimestamp,
        gameCreatedAt: game.createdAt,
      });

      // Add move to history (include timestamp so we can derive clock usage)
      const move = {
        from,
        to,
        piece,
        captured: captured || actualCapturedPiece || null,
        notation:
          notation ||
          `${piece}${String.fromCharCode(97 + (to % 8))}${
            8 - Math.floor(to / 8)
          }`,
        moveTimeMs: moveTiming.moveTimeMs,
        moveTimeSeconds: moveTiming.moveTimeSeconds,
        timestamp: new Date(),
      };

      game.board = newBoard;
      game.moves.push(move);
      const nextTurn = game.currentTurn === "white" ? "black" : "white";
      game.currentTurn = nextTurn;

      // Check for threefold repetition
      // Create position hash: board + current turn (castling and en passant would be ideal but simplified for now)
      const positionHash = JSON.stringify(newBoard) + "|" + nextTurn;

      // Initialize positionHistory if it doesn't exist
      if (!game.positionHistory) {
        game.positionHistory = [];
      }

      // Add current position to history
      game.positionHistory.push(positionHash);

      // Check if this position has occurred 3 times
      const positionCount = game.positionHistory.filter(
        (pos) => pos === positionHash
      ).length;
      const isThreefoldRepetition = positionCount >= 3;
      
      // Check game state after move
      const isNextTurnWhite = nextTurn === "white";
      const isInCheck = isKingInCheck(newBoard, isNextTurnWhite);
      const isCheckmateState =
        isInCheck && isCheckmate(newBoard, isNextTurnWhite);
      const isStalemateState =
        !isInCheck && isStalemate(newBoard, isNextTurnWhite);
      const isInsufficientMaterialState = isInsufficientMaterial(newBoard);

      // If checkmate, stalemate, threefold repetition, or insufficient material, end the game
      if (
        isCheckmateState ||
        isStalemateState ||
        isThreefoldRepetition ||
        isInsufficientMaterialState
      ) {
          game.status = "completed";
          // Clean up evaluation history when game ends
          gameEvaluationHistory.delete(req.params.gameId);
          if (isCheckmateState) {
          game.result = {
            winner: isNextTurnWhite ? "black" : "white",
            reason: "checkmate",
          };
        } else if (isThreefoldRepetition) {
          game.result = {
            winner: "draw",
            reason: "threefold-repetition",
          };
        } else if (isInsufficientMaterialState) {
          game.result = {
            winner: "draw",
            reason: "insufficient-material",
          };
        } else {
          game.result = {
            winner: "draw",
            reason: "stalemate",
          };
        }
        
        await game.save();
        
        // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
        try {
          const { triggerReviewGeneration } = require("../utils/game-review/game-completion-hook");
          triggerReviewGeneration(game.gameId);
        } catch (error) {
          console.error(`[GameReview] Error triggering review generation hook:`, error);
        }
        
        // Reload game to ensure all fields (including category) are present
        const gameForRating = await Game.findOne({ gameId: req.params.gameId })
          .populate("players.white players.black");
        
        // Ensure category is set
        if (!gameForRating.category && gameForRating.timeControl) {
          const { setGameCategory } = require("../services/ratingEngine");
          setGameCategory(gameForRating);
          await gameForRating.save();
        }

        // Update player stats (WITH category for badge tracking)
        const Stats = require("../models/Stats");
        const gameTime = Date.now() - gameForRating.createdAt.getTime();
        const gameCategory = gameForRating.category;

        if (gameForRating.players.white) {
          const whiteStats = await Stats.findOne({ user: gameForRating.players.white._id });
          if (whiteStats) {
            const whiteResult = game.result.winner === "white" ? "win" : game.result.winner === "black" ? "loss" : "draw";
            await whiteStats.updateAfterGame(gameForRating.type, whiteResult, gameTime, gameCategory);
          }
        }

        if (gameForRating.players.black && gameForRating.type !== "bot") {
          const blackStats = await Stats.findOne({ user: gameForRating.players.black._id });
          if (blackStats) {
            const blackResult = game.result.winner === "black" ? "win" : game.result.winner === "white" ? "loss" : "draw";
            await blackStats.updateAfterGame(gameForRating.type, blackResult, gameTime, gameCategory);
          }
        }

        // For bot games, update stats for the human player
        if (gameForRating.type === "bot") {
          const userId = gameForRating.players.white?._id || gameForRating.players.black?._id;
          if (userId) {
            const userStats = await Stats.findOne({ user: userId });
            if (userStats) {
              const userResult = (gameForRating.players.white && game.result.winner === "white") || 
                               (gameForRating.players.black && game.result.winner === "black") 
                               ? "win" : game.result.winner === "draw" ? "draw" : "loss";
              await userStats.updateAfterGame(gameForRating.type, userResult, gameTime, gameCategory);
            }
          }
        }
        
        // Update Glicko-2 ratings for invitation/friend games
        const { updateGameRatings } = require("../services/updateGameRatings");
        const io = req.app.get("io");
        await updateGameRatings(gameForRating, io);

        // Check badges for ALL game types
        try {
          const { checkAndAwardBadges } = require("../services/achievementService");
          if (gameForRating.type === "bot") {
            const userId = gameForRating.players.white?._id || gameForRating.players.black?._id;
            if (userId) {
              await checkAndAwardBadges(userId.toString(), gameForRating.gameId, io);
            }
          } else {
            if (gameForRating.players.white) {
              await checkAndAwardBadges(gameForRating.players.white._id.toString(), gameForRating.gameId, io);
            }
            if (gameForRating.players.black) {
              await checkAndAwardBadges(gameForRating.players.black._id.toString(), gameForRating.gameId, io);
            }
          }
        } catch (badgeError) {
          console.error("[Game End] Error checking badges:", badgeError);
        }
        
        // Emit game ended event
        req.app.get("io").to(req.params.gameId).emit("game-ended", {
          gameId: req.params.gameId,
          result: game.result,
        });
        
        // Return early since game is completed
        return res.json({
          success: true,
          message: "Move made and game ended",
          data: {
            move,
            board: newBoard,
            gameStatus: game.status,
            result: game.result,
          },
        });
      }

      await game.save();

      // Emit move to other players via Socket.IO
      const moveData = {
        gameId: req.params.gameId,
        move,
        board: newBoard,
        currentTurn: game.currentTurn,
        timeRemaining: game.timeRemaining,
        isInCheck,
        isCheckmate: isCheckmateState,
        isStalemate: isStalemateState,
        isThreefoldRepetition: isThreefoldRepetition,
        isInsufficientMaterial: isInsufficientMaterialState,
      };

      if (game.status === "completed") {
        req.app.get("io").to(req.params.gameId).emit("game-ended", {
          gameId: req.params.gameId,
          result: game.result,
        });
      }

      req.app.get("io").to(req.params.gameId).emit("move-made", moveData);

      // Calculate advantage score for advantage bar (async, non-blocking)
      let advantageScore = 0;
      if ((game.type === "bot" || game.type === "friend") && game.status === "active") {
        // Get evaluation asynchronously - don't block response
        const { getPositionEvaluation, boardToFEN } = require("../utils/stockfish");
        const fen = boardToFEN(newBoard, nextTurn, game.moves);
        
        // CRITICAL: Capture game status before async operations
        const currentGameStatus = game.status;
        
        const playerWhoJustMoved = game.currentTurn === "white" ? "black" : "white"; // The player who just made the move
        console.log(`[AdvantageBar] 🎯 Player move made - Game: ${req.params.gameId}, Type: ${game.type}`);
        console.log(`[AdvantageBar]    Move details:`);
        console.log(`[AdvantageBar]      - Player who just moved: ${playerWhoJustMoved.toUpperCase()}`);
        console.log(`[AdvantageBar]      - Current turn (after move): ${game.currentTurn}`);
        console.log(`[AdvantageBar]      - Next turn (who will move): ${nextTurn.toUpperCase()}`);
        console.log(`[AdvantageBar]      - Move number: ${game.moves?.length || 0}`);
        console.log(`[AdvantageBar]    FEN: ${fen} (${nextTurn} to move)`);
        console.log(`[AdvantageBar]    ⚠️  Evaluating from ${nextTurn}'s perspective (who will move next), then converting to White's perspective`);
        console.log(`[AdvantageBar]    Requesting evaluation...`);
        
        // Track check state for evaluation filtering
        const wasInCheckBefore = wasInCheckBeforeMove;
        const isNowInCheck = isInCheck;
        
        // Optional stabilization: Delay evaluation by ~300ms after check resolution
        const evaluationDelay = wasInCheckBefore && !isNowInCheck ? 300 : 0;
        
        setTimeout(() => {
          // Check game status again inside setTimeout (game may have ended)
          Game.findOne({ gameId: req.params.gameId })
            .then((currentGame) => {
              const gameStatus = currentGame ? currentGame.status : currentGameStatus;
              
              // CRITICAL: Check game status before evaluation - ignore late async results
              if (gameStatus !== 'active') {
                console.log(`[AdvantageBar] 🛑 Game ended (status: ${gameStatus}), ignoring late evaluation result`);
                return;
              }
              
              return getPositionEvaluation(fen)
                .then((rawEval) => {
                  // Double-check game status after async evaluation completes
                  return Game.findOne({ gameId: req.params.gameId })
                    .then((finalGameCheck) => {
                      const finalGameStatus = finalGameCheck ? finalGameCheck.status : gameStatus;
                      
                      // Ignore late async eval results if game has ended
                      if (finalGameStatus !== 'active') {
                        console.log(`[AdvantageBar] 🛑 Game ended during evaluation (status: ${finalGameStatus}), ignoring result`);
                        return;
                      }
                      
                      // DEBUG: Log raw evaluation from Stockfish
                      console.log(`[AdvantageBar] 📊 Raw Stockfish evaluation (after player move):`);
                      console.log(`[AdvantageBar]    Raw centipawns: ${rawEval.centipawns}cp`);
                      console.log(`[AdvantageBar]    Is mate: ${rawEval.isMate}`);
                      console.log(`[AdvantageBar]    Mate moves: ${rawEval.mateMoves}`);
                      console.log(`[AdvantageBar]    Side to move: ${nextTurn}`);
                      console.log(`[AdvantageBar]    ⚠️  Stockfish evaluated from ${nextTurn}'s perspective`);
                      console.log(`[AdvantageBar]    📝 Interpretation: ${rawEval.centipawns > 0 ? `Positive eval = ${nextTurn} has advantage` : rawEval.centipawns < 0 ? `Negative eval = ${nextTurn === 'white' ? 'Black' : 'White'} has advantage` : 'Equal position'}`);
                      
                      // Post-process evaluation - pure engine evaluation only
                      // CRITICAL: Pass sideToMove to ensure evaluation is always from White's perspective
                      const processedEval = processEvaluationForAdvantageBar(
                        rawEval, 
                        req.params.gameId, 
                        finalGameStatus,
                        nextTurn // sideToMove - the side to move in the position
                      );
                  
                      // Emit evaluation via WebSocket for real-time update
                      const evalDisplay = processedEval.mate !== null
                        ? `Mate ${processedEval.mate > 0 ? 'White' : 'Black'} in ${Math.abs(processedEval.mate)}` 
                        : `${processedEval.score}cp (${(processedEval.score / 100).toFixed(1)} pawns)`;
                      console.log(`[AdvantageBar] 📡 Emitting advantage-score event to game ${req.params.gameId}: ${evalDisplay}`);
                      console.log(`[AdvantageBar]    Processed eval details:`, {
                        score: processedEval.score,
                        mate: processedEval.mate
                      });
                      req.app.get("io").to(req.params.gameId).emit("advantage-score", {
                        gameId: req.params.gameId,
                        score: processedEval.score,
                        mate: processedEval.mate,
                      });
                    });
                })
                .catch((err) => {
                  console.error(`[AdvantageBar] ❌ Evaluation failed for game ${req.params.gameId}:`, err.message);
                });
            })
            .catch((err) => {
              console.error(`[AdvantageBar] ❌ Failed to check game status for ${req.params.gameId}:`, err.message);
            });
        }, evaluationDelay);
      }

      res.json({
        success: true,
        message: "Move made successfully",
        data: {
          move,
          board: newBoard,
          currentTurn: game.currentTurn,
          timeRemaining: game.timeRemaining,
          isInCheck,
          isCheckmate: isCheckmateState,
          isStalemate: isStalemateState,
          isThreefoldRepetition: isThreefoldRepetition,
          isInsufficientMaterial: isInsufficientMaterialState,
          gameEnded: game.status === "completed",
          result: game.result || null,
          advantageScore, // Will be 0 initially, updated via WebSocket
        },
      });

      // If this is a bot game and it's now the bot's turn, trigger bot move
      if (
        game.type === "bot" &&
        (game.bot || game.customBotConfig) &&
        game.botSide === game.currentTurn
      ) {
        // Trigger bot move asynchronously (don't block the response)
        setImmediate(async () => {
          try {
            const Bot = require("../models/Bot");
            const { getBestMove } = require("../utils/stockfish");
            const io = req.app.get("io");

            console.log(
              "[BOT] Attempting bot move for game:",
              req.params.gameId
            );

            // Reload game to get latest state
            const currentGame = await Game.findOne({
              gameId: req.params.gameId,
            }).populate("bot");
            if (!currentGame) {
              console.log(
                "[BOT] Game not found for bot move:",
                req.params.gameId
              );
              return;
            }
            if (currentGame.status !== "active") {
              console.log(
                "[BOT] Game is not active, status:",
                currentGame.status
              );
              return;
            }
            if (currentGame.currentTurn !== currentGame.botSide) {
              console.log(
                "[BOT] Not bot's turn anymore. currentTurn:",
                currentGame.currentTurn,
                "botSide:",
                currentGame.botSide
              );
              return; // Game ended or not bot's turn anymore
            }

            const bot = currentGame.bot
              ? await Bot.findById(currentGame.bot)
              : null;
            const botStrength = currentGame.customBotConfig || null;
            const effectiveElo = bot
              ? bot.elo
              : botStrength?.elo || currentGame.customBot?.elo || 1500;

            if (currentGame.bot && !bot) {
              console.log(
                "[BOT] Bot document not found for id:",
                currentGame.bot
              );
              return;
            }

            console.log(
              "[BOT] Computing bot move. ELO:",
              effectiveElo,
              "difficulty:",
              bot ? bot.difficulty : "custom",
              "side:",
              currentGame.botSide
            );

            // Check if bot is in check
            const botIsWhite = currentGame.botSide === "white";
            const botInCheck = isKingInCheck(currentGame.board, botIsWhite);

            if (botInCheck) {
              console.log("[BOT] Bot is in check, prioritizing escape moves");
            }

            // Get bot's move (currently using fallback engine)
            // If in check, Stockfish should prioritize moves that escape check
            let botMoveIndices;
            try {
              const isUntimed =
                currentGame.category === "un-timed" ||
                !currentGame.timeControl ||
                currentGame.timeControl.initial <= 0;
              const whiteTime =
                !isUntimed &&
                currentGame.timeRemaining &&
                typeof currentGame.timeRemaining.white === "number"
                  ? currentGame.timeRemaining.white
                  : null;
              const blackTime =
                !isUntimed &&
                currentGame.timeRemaining &&
                typeof currentGame.timeRemaining.black === "number"
                  ? currentGame.timeRemaining.black
                  : null;
              const normalizedIncRaw =
                currentGame.timeControl &&
                typeof currentGame.timeControl.increment === "number"
                  ? currentGame.timeControl.increment
                  : 0;
              // Support both second-based and millisecond-based increment storage.
              const incrementMs =
                normalizedIncRaw > 0 && normalizedIncRaw <= 60
                  ? normalizedIncRaw * 1000
                  : normalizedIncRaw;
              const engineClockConfig = isUntimed
                ? botStrength
                : {
                    ...(botStrength || {}),
                    whiteTime,
                    blackTime,
                    whiteInc: incrementMs,
                    blackInc: incrementMs,
                    incrementMs,
                  };
              botMoveIndices = await getBestMove(
                currentGame.board,
                currentGame.currentTurn,
                currentGame.moves,
                effectiveElo,
                isUntimed && !currentGame.timeRemaining
                  ? null
                  : currentGame.timeRemaining &&
                      typeof currentGame.timeRemaining[currentGame.botSide] ===
                        "number"
                    ? currentGame.timeRemaining[currentGame.botSide]
                    : null,
                engineClockConfig
              );
            } catch (error) {
              // If getBestMove throws "No legal moves available", check for checkmate/stalemate
              if (
                error.message &&
                error.message.includes("No legal moves available")
              ) {
                console.log(
                  "[BOT] No legal moves - checking for checkmate/stalemate"
                );
                const legalMoves = getAllLegalMoves(
                  currentGame.board,
                  botIsWhite
                );
                if (legalMoves.length === 0) {
                  // Game is over - checkmate or stalemate
                  currentGame.status = "completed";
                  if (botInCheck) {
                    currentGame.result = {
                      winner: botIsWhite ? "black" : "white",
                      reason: "checkmate",
                    };
                  } else {
                    currentGame.result = {
                      winner: "draw",
                      reason: "stalemate",
                    };
                  }
                  await currentGame.save();
                  
                  // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
                  // COPY EXACT FLOW FROM /end ENDPOINT (timeout handler) - DO NOT CHANGE
                  try {
                    const { triggerReviewGeneration } = require("../utils/game-review/game-completion-hook");
                    triggerReviewGeneration(currentGame.gameId);
                  } catch (error) {
                    // Don't fail game completion if review hook fails
                    console.error(`[GameReview] Error triggering review generation hook:`, error);
                  }
                  
                  io.to(req.params.gameId).emit("game-ended", {
                    gameId: req.params.gameId,
                    result: currentGame.result,
                  });
                  return;
                }
              }
              // Re-throw if it's a different error
              throw error;
            }

            if (
              !botMoveIndices ||
              typeof botMoveIndices.from !== "number" ||
              typeof botMoveIndices.to !== "number"
            ) {
              console.log(
                "[BOT] getBestMove returned invalid result:",
                botMoveIndices
              );
              return;
            }

            // Validate bot move is legal; if not, choose a sensible fallback, not just the first move
            if (
              !isMoveLegal(
                currentGame.board,
                botMoveIndices.from,
                botMoveIndices.to
              )
            ) {
              console.log(
                "[BOT] Invalid move from Stockfish, searching for best legal fallback"
              );

              // Use all legal moves and pick the one with best material evaluation
              const legalMoves = getAllLegalMoves(
                currentGame.board,
                botIsWhite
              );
              if (legalMoves.length === 0) {
                // Checkmate or stalemate
                currentGame.status = "completed";
                if (botInCheck) {
                  currentGame.result = {
                    winner: botIsWhite ? "black" : "white",
                    reason: "checkmate",
                  };
                } else {
                  currentGame.result = {
                    winner: "draw",
                    reason: "stalemate",
                  };
                }
                await currentGame.save();
                
                // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
                // COPY EXACT FLOW FROM /end ENDPOINT (timeout handler) - DO NOT CHANGE
                try {
                  const { triggerReviewGeneration } = require("../utils/game-review/game-completion-hook");
                  triggerReviewGeneration(currentGame.gameId);
                } catch (error) {
                  // Don't fail game completion if review hook fails
                  console.error(`[GameReview] Error triggering review generation hook:`, error);
                }
                
                io.to(req.params.gameId).emit("game-ended", {
                  gameId: req.params.gameId,
                  result: currentGame.result,
                });
                return;
              }

              // Simple material evaluation: positive = good for white, negative = good for black
              const pieceValues = {
                p: 100,
                n: 300,
                b: 300,
                r: 500,
                q: 900,
                k: 0,
              };
              const evaluateBoardMaterial = (board) => {
                let score = 0;
                for (const sq of board) {
                  if (!sq) continue;
                  const v = pieceValues[sq.toLowerCase()] || 0;
                  score += sq === sq.toUpperCase() ? v : -v;
                }
                return score;
              };

              let bestMove = legalMoves[0];
              let bestScore = botIsWhite ? -Infinity : Infinity;

              for (const move of legalMoves) {
                const tempBoard = [...currentGame.board];
                const moving = tempBoard[move.from];
                tempBoard[move.to] = moving;
                tempBoard[move.from] = null;

                const score = evaluateBoardMaterial(tempBoard);
                if (
                  (botIsWhite && score > bestScore) ||
                  (!botIsWhite && score < bestScore)
                ) {
                  bestScore = score;
                  bestMove = move;
                }
              }

              botMoveIndices.from = bestMove.from;
              botMoveIndices.to = bestMove.to;
            }

            // Calculate en passant target from last move (if it was a two-square pawn move)
            let botEnPassantTarget = null;
            if (currentGame.moves.length > 0) {
              const lastMove = currentGame.moves[currentGame.moves.length - 1];
              const lastPiece = currentGame.board[lastMove.to];
              if (lastPiece && lastPiece.toLowerCase() === "p") {
                const lastFromRow = Math.floor(lastMove.from / 8);
                const lastToRow = Math.floor(lastMove.to / 8);
                if (Math.abs(lastToRow - lastFromRow) === 2) {
                  // Last move was a two-square pawn move - set en passant target
                  const midRow = (lastFromRow + lastToRow) / 2;
                  botEnPassantTarget = midRow * 8 + (lastMove.to % 8);
                }
              }
            }

            // Apply bot move
            const botBoard = [...currentGame.board];
            const movingPiece = botBoard[botMoveIndices.from];
            const capturedPiece = botBoard[botMoveIndices.to];

            // Check if this is an en passant capture
            const isBotEnPassant =
              movingPiece &&
              movingPiece.toLowerCase() === "p" && // It's a pawn
              botEnPassantTarget !== null && // There's an en passant target
              botMoveIndices.to === botEnPassantTarget && // Moving to the en passant target square
              Math.abs((botMoveIndices.from % 8) - (botMoveIndices.to % 8)) ===
                1 && // Moving diagonally (one file over)
              !capturedPiece; // The target square is empty (en passant square is behind the captured pawn)

            let botActualCapturedPiece = capturedPiece;
            if (isBotEnPassant) {
              // For en passant, the captured pawn is on the same file as 'to', but on the rank behind it
              const botIsWhite = currentGame.botSide === "white";
              const dir = botIsWhite ? 1 : -1;
              const capturedPawnIndex = botMoveIndices.to + dir * 8;
              botActualCapturedPiece = botBoard[capturedPawnIndex];

              // Remove the captured pawn from the board
              if (
                botActualCapturedPiece &&
                botActualCapturedPiece.toLowerCase() === "p"
              ) {
                botBoard[capturedPawnIndex] = null;
              }
            }

            // Check for pawn promotion (needed for notation later) - declare globally
            const toRow = Math.floor(botMoveIndices.to / 8);
            const isPawnPromotion =
              movingPiece &&
              movingPiece.toLowerCase() === "p" && // It's a pawn
              ((movingPiece === movingPiece.toUpperCase() && toRow === 0) || // White pawn to rank 8
                (movingPiece === movingPiece.toLowerCase() && toRow === 7)); // Black pawn to rank 1

            // Handle en passant capture first (before regular move logic)
            if (isBotEnPassant) {
              // Move the pawn to the en passant square
              botBoard[botMoveIndices.to] = movingPiece;
              botBoard[botMoveIndices.from] = null;
              // The captured pawn was already removed above
            } else {
              // Check if this is castling (king moves 2 squares horizontally)
              const fromFile = botMoveIndices.from % 8;
              const toFile = botMoveIndices.to % 8;
              const fromRank = Math.floor(botMoveIndices.from / 8);
              const isCastling =
                movingPiece &&
                movingPiece.toLowerCase() === "k" && // It's a king
                Math.abs(toFile - fromFile) === 2; // King moves exactly 2 squares horizontally

              if (isCastling) {
                // Handle castling - move both king and rook
                botBoard[botMoveIndices.to] = movingPiece;
                botBoard[botMoveIndices.from] = null;

                // King-side castling (king moves to g-file, rook moves from h-file to f-file)
                if (toFile === 6) {
                  const rookFrom = fromRank * 8 + 7; // h-file
                  const rookTo = fromRank * 8 + 5; // f-file
                  botBoard[rookTo] = botBoard[rookFrom];
                  botBoard[rookFrom] = null;
                }
                // Queen-side castling (king moves to c-file, rook moves from a-file to d-file)
                else if (toFile === 2) {
                  const rookFrom = fromRank * 8 + 0; // a-file
                  const rookTo = fromRank * 8 + 3; // d-file
                  botBoard[rookTo] = botBoard[rookFrom];
                  botBoard[rookFrom] = null;
                }
              } else {
                if (isPawnPromotion) {
                  // Use promotion from Stockfish if provided, otherwise default to queen
                  const promotionType = botMoveIndices.promotion || "queen";
                  const promotionMap = {
                    queen: botIsWhite ? "Q" : "q",
                    rook: botIsWhite ? "R" : "r",
                    bishop: botIsWhite ? "B" : "b",
                    knight: botIsWhite ? "N" : "n",
                  };
                  const promotedPiece =
                    promotionMap[promotionType] || promotionMap.queen;
                  botBoard[botMoveIndices.to] = promotedPiece;
                } else {
                  // Regular move - just move the piece
                  botBoard[botMoveIndices.to] = movingPiece;
                }
                botBoard[botMoveIndices.from] = null;
              }
            }

            const pieceLetter = botBoard[botMoveIndices.to];
            const botMove = {
              from: botMoveIndices.from,
              to: botMoveIndices.to,
              piece: pieceLetter,
              captured: botActualCapturedPiece || null,
              notation: `${pieceLetter}${String.fromCharCode(
                97 + (botMoveIndices.to % 8)
              )}${8 - Math.floor(botMoveIndices.to / 8)}${
                isPawnPromotion ? "=" + pieceLetter.toUpperCase() : ""
              }`,
              ...calculateMoveTime({
                previousClockMs:
                  currentGame.currentTurn === "white"
                    ? currentGame.timeRemaining?.white
                    : currentGame.timeRemaining?.black,
                updatedClockMs:
                  currentGame.currentTurn === "white"
                    ? currentGame.timeRemaining?.white
                    : currentGame.timeRemaining?.black,
                previousMoveTimestamp:
                  currentGame.moves && currentGame.moves.length > 0
                    ? currentGame.moves[currentGame.moves.length - 1]?.timestamp
                    : null,
                gameCreatedAt: currentGame.createdAt,
              }),
              timestamp: new Date(),
            };

            // Update clocks for bot thinking time
            const preBotClockMs =
              currentGame.currentTurn === "white"
                ? currentGame.timeRemaining?.white
                : currentGame.timeRemaining?.black;

            if (
              currentGame.timeRemaining &&
              typeof currentGame.timeRemaining.white === "number" &&
              typeof currentGame.timeRemaining.black === "number"
            ) {
              const now = Date.now();

              // Last move should be the human move that just triggered the bot turn
              let lastMoveTime = currentGame.updatedAt
                ? currentGame.updatedAt.getTime()
                : now;
              if (currentGame.moves && currentGame.moves.length > 0) {
                const lastMove =
                  currentGame.moves[currentGame.moves.length - 1];
                if (lastMove.timestamp) {
                  lastMoveTime = new Date(lastMove.timestamp).getTime();
                }
              }

              const elapsed = Math.max(0, now - lastMoveTime);

              if (currentGame.currentTurn === "white") {
                currentGame.timeRemaining.white = Math.max(
                  0,
                  currentGame.timeRemaining.white - elapsed
                );
              } else if (currentGame.currentTurn === "black") {
                currentGame.timeRemaining.black = Math.max(
                  0,
                  currentGame.timeRemaining.black - elapsed
                );
              }
            }

            const postBotClockMs =
              currentGame.currentTurn === "white"
                ? currentGame.timeRemaining?.white
                : currentGame.timeRemaining?.black;
            const botMoveTiming = calculateMoveTime({
              previousClockMs: preBotClockMs,
              updatedClockMs: postBotClockMs,
              previousMoveTimestamp:
                currentGame.moves && currentGame.moves.length > 0
                  ? currentGame.moves[currentGame.moves.length - 1]?.timestamp
                  : null,
              gameCreatedAt: currentGame.createdAt,
            });
            botMove.moveTimeMs = botMoveTiming.moveTimeMs;
            botMove.moveTimeSeconds = botMoveTiming.moveTimeSeconds;

            // Check state BEFORE the bot move (for the bot side)
            // Must check before board is updated
            const botWasInCheckBeforeMove = isKingInCheck(currentGame.board, botIsWhite);
            
            currentGame.board = botBoard;
            currentGame.moves.push(botMove);
            const nextTurn =
              currentGame.currentTurn === "white" ? "black" : "white";
            currentGame.currentTurn = nextTurn;

            // Check for threefold repetition
            const positionHash = JSON.stringify(botBoard) + "|" + nextTurn;

            // Initialize positionHistory if it doesn't exist
            if (!currentGame.positionHistory) {
              currentGame.positionHistory = [];
            }

            // Add current position to history
            currentGame.positionHistory.push(positionHash);

            // Check if this position has occurred 3 times
            const positionCount = currentGame.positionHistory.filter(
              (pos) => pos === positionHash
            ).length;
            const isThreefoldRepetition = positionCount >= 3;

            // Check game state after bot move
            const isNextTurnWhite = nextTurn === "white";
            const isInCheck = isKingInCheck(botBoard, isNextTurnWhite);
            const isCheckmateState =
              isInCheck && isCheckmate(botBoard, isNextTurnWhite);
            const isStalemateState =
              !isInCheck && isStalemate(botBoard, isNextTurnWhite);
            const isInsufficientMaterialState =
              isInsufficientMaterial(botBoard);

            // If checkmate, stalemate, threefold repetition, or insufficient material, end the game
            if (
              isCheckmateState ||
              isStalemateState ||
              isThreefoldRepetition ||
              isInsufficientMaterialState
            ) {
              currentGame.status = "completed";
              // Clean up evaluation history when game ends
              gameEvaluationHistory.delete(req.params.gameId);
              if (isCheckmateState) {
                currentGame.result = {
                  winner: isNextTurnWhite ? "black" : "white",
                  reason: "checkmate",
                };
              } else if (isThreefoldRepetition) {
                currentGame.result = {
                  winner: "draw",
                  reason: "threefold-repetition",
                };
              } else if (isInsufficientMaterialState) {
                currentGame.result = {
                  winner: "draw",
                  reason: "insufficient-material",
                };
              } else {
                currentGame.result = {
                  winner: "draw",
                  reason: "stalemate",
                };
              }
            }

            await currentGame.save();

            // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
            // COPY EXACT FLOW FROM /end ENDPOINT (timeout handler) - DO NOT CHANGE
            try {
              const { triggerReviewGeneration } = require("../utils/game-review/game-completion-hook");
              triggerReviewGeneration(currentGame.gameId);
            } catch (error) {
              // Don't fail game completion if review hook fails
              console.error(`[GameReview] Error triggering review generation hook:`, error);
            }

            console.log("[BOT] Emitting bot move:", botMove);

            // Emit bot move
            const botMoveData = {
              gameId: req.params.gameId,
              move: botMove,
              board: botBoard,
              currentTurn: currentGame.currentTurn,
              timeRemaining: currentGame.timeRemaining,
              isInCheck,
              isCheckmate: isCheckmateState,
              isStalemate: isStalemateState,
              isThreefoldRepetition: isThreefoldRepetition,
              isInsufficientMaterial: isInsufficientMaterialState,
              gameEnded: currentGame.status === "completed",
              result: currentGame.result || null,
            };

            if (currentGame.status === "completed") {
              io.to(req.params.gameId).emit("game-ended", {
                gameId: req.params.gameId,
                result: currentGame.result,
              });
            }

            io.to(req.params.gameId).emit("move-made", botMoveData);

            // Calculate advantage score for advantage bar after bot move (async, non-blocking)
            if (currentGame.status === "active") {
              const { getPositionEvaluation, boardToFEN } = require("../utils/stockfish");
              const fen = boardToFEN(botBoard, nextTurn, currentGame.moves);
              
              // CRITICAL: Capture game status before async operations
              const botGameStatus = currentGame.status;
              
              const botWhoJustMoved = currentGame.currentTurn === "white" ? "black" : "white"; // The bot who just made the move
              console.log(`[AdvantageBar] 🤖 Bot move made - Game: ${req.params.gameId}`);
              console.log(`[AdvantageBar]    Move details:`);
              console.log(`[AdvantageBar]      - Bot who just moved: ${botWhoJustMoved.toUpperCase()} (bot)`);
              console.log(`[AdvantageBar]      - Current turn (after move): ${currentGame.currentTurn}`);
              console.log(`[AdvantageBar]      - Next turn (who will move): ${nextTurn.toUpperCase()}`);
              console.log(`[AdvantageBar]      - Move number: ${currentGame.moves?.length || 0}`);
              console.log(`[AdvantageBar]    FEN: ${fen} (${nextTurn} to move)`);
              console.log(`[AdvantageBar]    ⚠️  Evaluating from ${nextTurn}'s perspective (who will move next), then converting to White's perspective`);
              console.log(`[AdvantageBar]    Requesting evaluation...`);
              
              // Track check state for evaluation filtering
              const botWasInCheckBefore = botWasInCheckBeforeMove;
              const botIsNowInCheck = isInCheck;
              
              // Optional stabilization: Delay evaluation by ~300ms after check resolution
              const evaluationDelay = botWasInCheckBefore && !botIsNowInCheck ? 300 : 0;
              
              setTimeout(() => {
                // Check game status again inside setTimeout (game may have ended)
                Game.findOne({ gameId: req.params.gameId })
                  .then((updatedGame) => {
                    const gameStatus = updatedGame ? updatedGame.status : botGameStatus;
                    
                    // CRITICAL: Check game status before evaluation - ignore late async results
                    if (gameStatus !== 'active') {
                      console.log(`[AdvantageBar] 🛑 Game ended (status: ${gameStatus}), ignoring late evaluation result`);
                      return;
                    }
                    
                    return getPositionEvaluation(fen)
                      .then((rawEval) => {
                        // Double-check game status after async evaluation completes
                        return Game.findOne({ gameId: req.params.gameId })
                          .then((finalGameCheck) => {
                            const finalGameStatus = finalGameCheck ? finalGameCheck.status : gameStatus;
                            
                            // Ignore late async eval results if game has ended
                            if (finalGameStatus !== 'active') {
                              console.log(`[AdvantageBar] 🛑 Game ended during evaluation (status: ${finalGameStatus}), ignoring result`);
                              return;
                            }
                            
                            // DEBUG: Log raw evaluation from Stockfish
                            console.log(`[AdvantageBar] 📊 Raw Stockfish evaluation (after bot move):`);
                            console.log(`[AdvantageBar]    Raw centipawns: ${rawEval.centipawns}cp`);
                            console.log(`[AdvantageBar]    Is mate: ${rawEval.isMate}`);
                            console.log(`[AdvantageBar]    Mate moves: ${rawEval.mateMoves}`);
                            console.log(`[AdvantageBar]    Side to move: ${nextTurn}`);
                            console.log(`[AdvantageBar]    ⚠️  Stockfish evaluated from ${nextTurn}'s perspective`);
                            console.log(`[AdvantageBar]    📝 Interpretation: ${rawEval.centipawns > 0 ? `Positive eval = ${nextTurn} has advantage` : rawEval.centipawns < 0 ? `Negative eval = ${nextTurn === 'white' ? 'Black' : 'White'} has advantage` : 'Equal position'}`);
                            
                            // Post-process evaluation - pure engine evaluation only
                            // CRITICAL: Pass sideToMove to ensure evaluation is always from White's perspective
                            const processedEval = processEvaluationForAdvantageBar(
                              rawEval, 
                              req.params.gameId, 
                              finalGameStatus,
                              nextTurn // sideToMove - the side to move in the position
                            );
                            
                            // Emit evaluation via WebSocket for real-time update
                            const evalDisplay = processedEval.mate !== null
                              ? `Mate ${processedEval.mate > 0 ? 'White' : 'Black'} in ${Math.abs(processedEval.mate)}` 
                              : `${processedEval.score}cp (${(processedEval.score / 100).toFixed(1)} pawns)`;
                            console.log(`[AdvantageBar] 📡 Emitting advantage-score event to game ${req.params.gameId}: ${evalDisplay}`);
                            console.log(`[AdvantageBar]    Processed eval details:`, {
                              score: processedEval.score,
                              mate: processedEval.mate
                            });
                            io.to(req.params.gameId).emit("advantage-score", {
                              gameId: req.params.gameId,
                              score: processedEval.score,
                              mate: processedEval.mate,
                            });
                          });
                      })
                      .catch((err) => {
                        console.error(`[AdvantageBar] ❌ Evaluation failed after bot move for game ${req.params.gameId}:`, err.message);
                      });
                  })
                  .catch((err) => {
                    console.error(`[AdvantageBar] ❌ Failed to check game status for ${req.params.gameId}:`, err.message);
                  });
              }, evaluationDelay);
            }
          } catch (error) {
            console.error("Bot move error:", error);
          }
        });
      }
    } catch (error) {
      console.error("Make move error:", {
        gameId: req.params.gameId,
        userId: req.user?._id?.toString?.() || null,
        body: req.body,
        message: error?.message,
        stack: error?.stack,
      });
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   POST /api/games/:gameId/join
// @desc    Join a multiplayer game
// @access  Private
router.post("/:gameId/join", auth, requirePoliciesAccepted, async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.gameId });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    if (game.type !== "multiplayer") {
      return res.status(400).json({
        success: false,
        message: "This is not a multiplayer game",
      });
    }

    if (game.players.black) {
      return res.status(400).json({
        success: false,
        message: "Game is already full",
      });
    }

    if (game.players.white.equals(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: "You cannot join your own game",
      });
    }

    game.players.black = req.user._id;
    await game.save();

    // Update user status
    req.user.status = "in-game";
    await req.user.save();

    // Populate player data
    await game.populate(
      "players.white players.black",
      "username fullName avatar rating country"
    );

    // Notify other players
    req.app
      .get("io")
      .to(req.params.gameId)
      .emit("player-joined", {
        gameId: req.params.gameId,
        userId: req.user._id.toString(),
        player: {
          id: req.user._id,
          username: req.user.username,
          fullName: req.user.fullName,
          avatar: req.user.avatar,
          rating: req.user.rating,
          country: req.user.country || "",
        },
      });

    res.json({
      success: true,
      message: "Joined game successfully",
      data: { game },
    });
  } catch (error) {
    console.error("Join game error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/games/:gameId/end
// @desc    End a game
// @access  Private
router.post(
  "/:gameId/end",
  [
    auth,
    requirePoliciesAccepted,
    body("result").isObject(),
    body("result.winner").optional().isIn(["white", "black", "draw"]),
    body("result.reason").isIn([
      "checkmate",
      "stalemate",
      "resignation",
      "timeout",
      "draw-agreement",
      "draw-by-agreement",
      "insufficient-material",
    ]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { result } = req.body;
      const game = await Game.findOne({ gameId: req.params.gameId }).populate(
        "players.white players.black"
      );

      if (!game) {
        return res.status(404).json({
          success: false,
          message: "Game not found",
        });
      }

      // If category is missing, set it based on timeControl (for older games or migration)
      if (!game.category && game.timeControl) {
        const { setGameCategory } = require("../services/ratingEngine");
        setGameCategory(game);
        await game.save();
        console.log(`[Rating] Set missing category for game ${game.gameId}: ${game.category}`);
      }

      if (game.status !== "active") {
        return res.status(400).json({
          success: false,
          message: "Game is already ended",
        });
      }

      // Check if user is part of this game
      // For bot games, players.white or players.black might be null
      const isPlayer =
        (game.players.white &&
          game.players.white._id &&
          game.players.white._id.equals(req.user._id)) ||
        (game.players.black &&
          game.players.black._id &&
          game.players.black._id.equals(req.user._id));

      if (!isPlayer) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      // Update game
      game.status = "completed";
      // Clean up evaluation history when game ends
      gameEvaluationHistory.delete(req.params.gameId);
      game.result = result;
      await game.save();

      // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
      try {
        const { triggerReviewGeneration } = require("../utils/game-review/game-completion-hook");
        triggerReviewGeneration(game.gameId);
      } catch (error) {
        // Don't fail game completion if review hook fails
        console.error(`[GameReview] Error triggering review generation hook:`, error);
      }

      // Reload game to ensure all fields (including category) are present
      const gameForRating = await Game.findOne({ gameId: req.params.gameId })
        .populate("players.white players.black");
      
      // Ensure category is set
      if (!gameForRating.category && gameForRating.timeControl) {
        const { setGameCategory } = require("../services/ratingEngine");
        setGameCategory(gameForRating);
        await gameForRating.save();
        console.log(`[Rating] Set missing category for game ${gameForRating.gameId}: ${gameForRating.category}`);
      }

      // Update player stats (WITH category for badge tracking)
      const gameTime = Date.now() - gameForRating.createdAt.getTime();
      const gameCategory = gameForRating.category; // bullet, blitz, or rapid

      if (gameForRating.players.white) {
        const whiteStats = await Stats.findOne({
          user: gameForRating.players.white._id,
        });
        if (whiteStats) {
          const whiteResult =
            result.winner === "white"
              ? "win"
              : result.winner === "black"
              ? "loss"
              : "draw";
          // Pass category to track category-specific stats for badges
          await whiteStats.updateAfterGame(gameForRating.type, whiteResult, gameTime, gameCategory);
          console.log(`[Game End] Updated white player stats with category: ${gameCategory}`);
        }
      }

      if (gameForRating.players.black && gameForRating.type !== "bot") {
        const blackStats = await Stats.findOne({
          user: gameForRating.players.black._id,
        });
        if (blackStats) {
          const blackResult =
            result.winner === "black"
              ? "win"
              : result.winner === "white"
              ? "loss"
              : "draw";
          // Pass category to track category-specific stats for badges
          await blackStats.updateAfterGame(gameForRating.type, blackResult, gameTime, gameCategory);
          console.log(`[Game End] Updated black player stats with category: ${gameCategory}`);
        }
      }

      // For bot games, also update stats for the user (bot games only have one human player)
      if (gameForRating.type === "bot" && gameForRating.players.white) {
        const userStats = await Stats.findOne({
          user: gameForRating.players.white._id,
        });
        if (userStats) {
          const userResult =
            result.winner === "white"
              ? "win"
              : result.winner === "black"
              ? "loss"
              : "draw";
          await userStats.updateAfterGame(gameForRating.type, userResult, gameTime, gameCategory);
          console.log(`[Game End] Updated bot game user stats with category: ${gameCategory}`);
        }
      } else if (gameForRating.type === "bot" && gameForRating.players.black) {
        const userStats = await Stats.findOne({
          user: gameForRating.players.black._id,
        });
        if (userStats) {
          const userResult =
            result.winner === "black"
              ? "win"
              : result.winner === "white"
              ? "loss"
              : "draw";
          await userStats.updateAfterGame(gameForRating.type, userResult, gameTime, gameCategory);
          console.log(`[Game End] Updated bot game user stats with category: ${gameCategory}`);
        }
      }

      // Update Glicko-2 ratings using reusable function (only for multiplayer games)
      const { updateGameRatings } = require("../services/updateGameRatings");
      const io = req.app.get("io");
      await updateGameRatings(gameForRating, io);

      // Check badges for ALL game types (including bot games)
      // This ensures badges are awarded regardless of game type
      try {
        const { checkAndAwardBadges } = require("../services/achievementService");
        
        // For bot games, check badges for the human player
        if (gameForRating.type === "bot") {
          const userId = gameForRating.players.white?._id || gameForRating.players.black?._id;
          if (userId) {
            console.log(`[Game End] 🎖️ Checking badges for bot game user: ${userId}`);
            await checkAndAwardBadges(userId.toString(), gameForRating.gameId, io);
          }
        } else {
          // For multiplayer games, check badges for both players
          if (gameForRating.players.white) {
            console.log(`[Game End] 🎖️ Checking badges for white player: ${gameForRating.players.white._id}`);
            await checkAndAwardBadges(gameForRating.players.white._id.toString(), gameForRating.gameId, io);
          }
          if (gameForRating.players.black) {
            console.log(`[Game End] 🎖️ Checking badges for black player: ${gameForRating.players.black._id}`);
            await checkAndAwardBadges(gameForRating.players.black._id.toString(), gameForRating.gameId, io);
          }
        }
      } catch (badgeError) {
        console.error("[Game End] Error checking badges:", badgeError);
      }

      // Update player status
      if (game.players.white) {
        await User.findByIdAndUpdate(game.players.white._id, {
          status: "online",
        });
      }
      if (game.players.black && game.type !== "bot") {
        await User.findByIdAndUpdate(game.players.black._id, {
          status: "online",
        });
      }

      // Notify players
      req.app.get("io").to(req.params.gameId).emit("game-ended", {
        gameId: req.params.gameId,
        result,
      });

      res.json({
        success: true,
        message: "Game ended successfully",
        data: { game },
      });
    } catch (error) {
      console.error("End game error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   POST /api/games/:gameId/undo
// @desc    Undo the last move(s) in the game
// @access  Private
router.post("/:gameId/undo", auth, requirePoliciesAccepted, async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.gameId });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    if (game.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Game is not active",
      });
    }

    // Check if user is part of this game
    const isWhitePlayer =
      game.players.white && game.players.white.equals(req.user._id);
    const isBlackPlayer =
      game.players.black && game.players.black.equals(req.user._id);

    if (!isWhitePlayer && !isBlackPlayer) {
      return res.status(403).json({
        success: false,
        message: "You are not a player in this game",
      });
    }

    // Check if it's the player's turn (can only undo on your turn)
    const playerColor = isWhitePlayer ? "white" : "black";
    if (game.currentTurn !== playerColor) {
      return res.status(400).json({
        success: false,
        message: "Can only undo on your turn",
      });
    }

    // For bot games, undo both user's move and bot's move (2 moves)
    // For multiplayer games, undo only the last move (1 move)
    const movesToUndo = game.type === "bot" ? 2 : 1;

    if (!game.moves || game.moves.length < movesToUndo) {
      return res.status(400).json({
        success: false,
        message: "Not enough moves to undo",
      });
    }

    // Remove the last move(s) from history
    const removedMoves = game.moves.splice(-movesToUndo);

    // Reconstruct board and positionHistory from remaining moves
    // Start with initial board
    const initialBoard = Array(64).fill(null);
    // Set up initial position
    const initialPieces = [
      "r",
      "n",
      "b",
      "q",
      "k",
      "b",
      "n",
      "r", // rank 8 (black)
      "p",
      "p",
      "p",
      "p",
      "p",
      "p",
      "p",
      "p", // rank 7 (black)
      ...Array(32).fill(null), // ranks 6-3 (empty)
      "P",
      "P",
      "P",
      "P",
      "P",
      "P",
      "P",
      "P", // rank 2 (white)
      "R",
      "N",
      "B",
      "Q",
      "K",
      "B",
      "N",
      "R", // rank 1 (white)
    ];

    let reconstructedBoard = [...initialPieces];
    game.positionHistory = [];
    let currentTurn = "white"; // Game starts with white to move

    // Add initial position to history
    const initialPositionHash =
      JSON.stringify(reconstructedBoard) + "|" + currentTurn;
    game.positionHistory.push(initialPositionHash);

    // Apply all remaining moves to reconstruct board and positionHistory
    for (const move of game.moves) {
      const { from, to, piece, captured } = move;
      const movingPiece = reconstructedBoard[from];

      if (movingPiece) {
        // Handle castling
        if (
          movingPiece.toLowerCase() === "k" &&
          Math.abs((to % 8) - (from % 8)) === 2
        ) {
          const fromCol = from % 8;
          const toCol = to % 8;
          const row = Math.floor(from / 8);

          reconstructedBoard[to] = movingPiece;
          reconstructedBoard[from] = null;

          // Move rook
          if (toCol === 6) {
            // King-side castling
            reconstructedBoard[row * 8 + 5] = reconstructedBoard[row * 8 + 7];
            reconstructedBoard[row * 8 + 7] = null;
          } else if (toCol === 2) {
            // Queen-side castling
            reconstructedBoard[row * 8 + 3] = reconstructedBoard[row * 8 + 0];
            reconstructedBoard[row * 8 + 0] = null;
          }
        } else {
          // Regular move
          reconstructedBoard[to] = movingPiece;
          reconstructedBoard[from] = null;
        }
      }

      // Switch turn after each move
      currentTurn = currentTurn === "white" ? "black" : "white";

      // Add position hash after this move
      const positionHash =
        JSON.stringify(reconstructedBoard) + "|" + currentTurn;
      game.positionHistory.push(positionHash);
    }

    // Update board and current turn
    game.board = reconstructedBoard;

    // Set current turn back to the player who made the move that was undone
    // If we undid 2 moves (bot game), turn goes back to the user
    // If we undid 1 move (multiplayer), turn goes back to the opponent
    if (movesToUndo === 2) {
      // Bot game: undid user move + bot move, so it's user's turn again
      game.currentTurn = playerColor;
    } else {
      // Multiplayer: undid one move, so it's opponent's turn
      game.currentTurn = playerColor === "white" ? "black" : "white";
    }

    await game.save();

    // Emit undo event to other players
    req.app.get("io").to(req.params.gameId).emit("move-undone", {
      gameId: req.params.gameId,
      board: game.board,
      currentTurn: game.currentTurn,
      movesRemoved: movesToUndo,
    });

    // Trigger evaluation for advantage bar after undo
    // This ensures the bar shows the correct evaluation for the position we undid to
    setImmediate(async () => {
      try {
        const { getPositionEvaluation, boardToFEN } = require("../utils/stockfish");
        const currentGame = await Game.findOne({ gameId: req.params.gameId });
        
        if (!currentGame || currentGame.status !== 'active') {
          return; // Game ended or not found, skip evaluation
        }
        
        const fen = boardToFEN(currentGame.board, currentGame.currentTurn, currentGame.moves || []);
        const rawEval = await getPositionEvaluation(fen);
        
        const processedEval = processEvaluationForAdvantageBar(
          rawEval,
          req.params.gameId,
          currentGame.status,
          currentGame.currentTurn
        );
        
        const evalDisplay = processedEval.isMate
          ? `Mate (${processedEval.pawnEval > 0 ? 'White' : 'Black'})` 
          : `${processedEval.pawnEval.toFixed(2)} pawns (${processedEval.normalized.toFixed(1)}%)`;
        console.log(`[AdvantageBar] 📡 Emitting advantage-score after undo to game ${req.params.gameId}: ${evalDisplay}`);
        
        req.app.get("io").to(req.params.gameId).emit("advantage-score", {
          gameId: req.params.gameId,
          score: processedEval.score,
          mate: processedEval.mate,
        });
      } catch (err) {
        console.error(`[AdvantageBar] ❌ Evaluation failed after undo for game ${req.params.gameId}:`, err.message);
      }
    });

    res.json({
      success: true,
      message: "Move(s) undone successfully",
      data: {
        board: game.board,
        currentTurn: game.currentTurn,
        movesRemoved: movesToUndo,
      },
    });
  } catch (error) {
    console.error("Undo move error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/games/:gameId/draw-request
// @desc    Create a draw request
// @access  Private
router.post(
  "/:gameId/draw-request",
  auth,
  requirePoliciesAccepted,
  async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.gameId });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    if (game.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Game is not active",
      });
    }

    // Check if user is part of this game
    const isWhitePlayer =
      game.players.white &&
      game.players.white.toString() === req.user._id.toString();
    const isBlackPlayer =
      game.players.black &&
      game.players.black.toString() === req.user._id.toString();

    if (!isWhitePlayer && !isBlackPlayer) {
      return res.status(403).json({
        success: false,
        message: "You are not a player in this game",
      });
    }

    const playerColor = isWhitePlayer ? "white" : "black";

    // Check if there's already a pending draw request
    if (game.drawRequest && game.drawRequest.from) {
      return res.status(400).json({
        success: false,
        message: "There is already a pending draw request",
      });
    }

    // Create draw request
    game.drawRequest = {
      from: playerColor,
      timestamp: new Date(),
    };
    await game.save();

    // Emit draw request to all players in the game room via WebSocket
    const io = req.app.get("io");
    io.to(req.params.gameId).emit("draw-request", {
      gameId: req.params.gameId,
      from: playerColor,
    });

    console.log(
      `[draw-request] Player ${playerColor} created draw request in game ${req.params.gameId}`
    );

    res.json({
      success: true,
      message: "Draw request sent",
      data: {
        drawRequest: game.drawRequest,
      },
    });
  } catch (error) {
    console.error("Draw request error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
  }
);

// @route   POST /api/games/:gameId/draw-accept
// @desc    Accept a draw request
// @access  Private
router.post(
  "/:gameId/draw-accept",
  auth,
  requirePoliciesAccepted,
  async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.gameId });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    if (game.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Game is not active",
      });
    }

    // Check if user is part of this game
    const isWhitePlayer =
      game.players.white &&
      game.players.white.toString() === req.user._id.toString();
    const isBlackPlayer =
      game.players.black &&
      game.players.black.toString() === req.user._id.toString();

    if (!isWhitePlayer && !isBlackPlayer) {
      return res.status(403).json({
        success: false,
        message: "You are not a player in this game",
      });
    }

    const playerColor = isWhitePlayer ? "white" : "black";

    // Check if there's a pending draw request from the opponent
    if (!game.drawRequest || !game.drawRequest.from) {
      return res.status(400).json({
        success: false,
        message: "No pending draw request",
      });
    }

    if (game.drawRequest.from === playerColor) {
      return res.status(400).json({
        success: false,
        message: "You cannot accept your own draw request",
      });
    }

    // End game as draw
    game.status = "completed";
    // Clean up evaluation history when game ends
    gameEvaluationHistory.delete(req.params.gameId);
    game.result = {
      winner: "draw",
      reason: "draw-by-agreement",
    };
    game.drawRequest = { from: null, timestamp: null };
    await game.save();

    // Update Glicko-2 ratings
    const { updateGameRatings } = require("../services/updateGameRatings");
    const io = req.app.get("io");
    await updateGameRatings(game, io);

    // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
    // COPY EXACT FLOW FROM /end ENDPOINT (timeout handler) - DO NOT CHANGE
    try {
      const { triggerReviewGeneration } = require("../utils/game-review/game-completion-hook");
      triggerReviewGeneration(game.gameId);
    } catch (error) {
      // Don't fail game completion if review hook fails
      console.error(`[GameReview] Error triggering review generation hook:`, error);
    }

    // Update player stats
    const gameTime = Date.now() - game.createdAt.getTime();

    if (game.players.white) {
      const whiteStats = await Stats.findOne({
        user: game.players.white._id,
      });
      if (whiteStats) {
        await whiteStats.updateAfterGame(game.type, "draw", gameTime);
      }
    }

    if (game.players.black && game.type !== "bot") {
      const blackStats = await Stats.findOne({
        user: game.players.black._id,
      });
      if (blackStats) {
        await blackStats.updateAfterGame(game.type, "draw", gameTime);
      }
    }

    // Update player status
    if (game.players.white) {
      await User.findByIdAndUpdate(game.players.white._id, {
        status: "online",
      });
    }
    if (game.players.black && game.type !== "bot") {
      await User.findByIdAndUpdate(game.players.black._id, {
        status: "online",
      });
    }

    // Emit draw accepted and game ended events via WebSocket
    // (io is already declared above for rating updates)
    io.to(req.params.gameId).emit("draw-accepted", {
      gameId: req.params.gameId,
    });
    io.to(req.params.gameId).emit("game-ended", {
      gameId: req.params.gameId,
      result: game.result,
    });

    console.log(
      `[draw-accept] Player ${playerColor} accepted draw request in game ${req.params.gameId}`
    );

    res.json({
      success: true,
      message: "Draw request accepted",
      data: { game },
    });
  } catch (error) {
    console.error("Draw accept error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
  }
);

// @route   POST /api/games/:gameId/draw-decline
// @desc    Decline a draw request
// @access  Private
router.post(
  "/:gameId/draw-decline",
  auth,
  requirePoliciesAccepted,
  async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.gameId });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    if (game.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Game is not active",
      });
    }

    // Check if user is part of this game
    const isWhitePlayer =
      game.players.white &&
      game.players.white.toString() === req.user._id.toString();
    const isBlackPlayer =
      game.players.black &&
      game.players.black.toString() === req.user._id.toString();

    if (!isWhitePlayer && !isBlackPlayer) {
      return res.status(403).json({
        success: false,
        message: "You are not a player in this game",
      });
    }

    const playerColor = isWhitePlayer ? "white" : "black";

    // Check if there's a pending draw request
    if (!game.drawRequest || !game.drawRequest.from) {
      return res.status(400).json({
        success: false,
        message: "No pending draw request",
      });
    }

    // Clear draw request
    game.drawRequest = { from: null, timestamp: null };
    await game.save();

    // Emit draw declined event via WebSocket
    const io = req.app.get("io");
    io.to(req.params.gameId).emit("draw-declined", {
      gameId: req.params.gameId,
    });

    console.log(
      `[draw-decline] Player ${playerColor} declined draw request in game ${req.params.gameId}`
    );

    res.json({
      success: true,
      message: "Draw request declined",
      data: { game },
    });
  } catch (error) {
    console.error("Draw decline error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
  }
);

// @route   GET /api/games/user/:userId
// @desc    Get user's games
// @access  Private
router.get("/user/:userId", auth, async (req, res) => {
  try {
    const { status = "all", limit = 20, page = 1 } = req.query;
    const userId = req.params.userId;

    const query = {
      $or: [{ "players.white": userId }, { "players.black": userId }],
    };

    if (status !== "all") {
      query.status = status;
    }

    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 200);
    const pageNum = Math.max(Number.parseInt(page, 10) || 1, 1);

    const games = await Game.find(query)
      .populate(
        "players.white players.black",
        "username fullName avatar country rating isDeleted"
      )
      .populate("bot", "key name photoUrl difficulty elo subtitle description")
      .sort({ updatedAt: -1 })
      .limit(limitNum)
      .skip((pageNum - 1) * limitNum);

    const total = await Game.countDocuments(query);

    res.json({
      success: true,
      data: {
        games,
        pagination: {
          current: pageNum,
          total: Math.ceil(total / limitNum) || 1,
          count: games.length,
          totalGames: total,
          limit: limitNum,
        },
      },
    });
  } catch (error) {
    console.error("Get user games error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;
