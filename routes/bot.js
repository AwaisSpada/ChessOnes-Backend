const express = require("express");
const { body, validationResult } = require("express-validator");
const Game = require("../models/Game");
const auth = require("../middleware/auth");
const requirePoliciesAccepted = require("../middleware/requirePoliciesAccepted");

const router = express.Router();
const HINT_CACHE_TTL_MS = 30000;
const HINT_STALE_TTL_MS = 180000;
const HINT_ENGINE_TIMEOUT_MS = 700;
const HINT_FALLBACK_TIMEOUT_MS = 1300;
const hintCache = new Map();

function getHintCacheKey(board, currentTurn, moveHistory) {
  const movesLen = Array.isArray(moveHistory) ? moveHistory.length : 0;
  return `${currentTurn}|${movesLen}|${JSON.stringify(board)}`;
}

// Simple chess bot logic
class ChessBot {
  constructor(difficulty = "medium") {
    this.difficulty = difficulty;
    this.depth = difficulty === "easy" ? 1 : difficulty === "medium" ? 2 : 3;
  }

  // Get all possible moves for a piece
  getPossibleMoves(board, position, piece) {
    const moves = [];
    const row = Math.floor(position / 8);
    const col = position % 8;
    const isWhite = piece === piece.toUpperCase();

    switch (piece.toLowerCase()) {
      case "p": // Pawn
        const direction = isWhite ? -1 : 1;
        const startRow = isWhite ? 6 : 1;

        // Forward move
        const oneStep = position + direction * 8;
        if (oneStep >= 0 && oneStep < 64 && !board[oneStep]) {
          moves.push(oneStep);

          // Two steps from starting position
          if (row === startRow) {
            const twoSteps = position + direction * 16;
            if (twoSteps >= 0 && twoSteps < 64 && !board[twoSteps]) {
              moves.push(twoSteps);
            }
          }
        }

        // Diagonal captures
        const captureLeft = position + direction * 8 - 1;
        const captureRight = position + direction * 8 + 1;

        if (
          captureLeft >= 0 &&
          captureLeft < 64 &&
          col > 0 &&
          board[captureLeft] &&
          (board[captureLeft].toUpperCase() === board[captureLeft]) !== isWhite
        ) {
          moves.push(captureLeft);
        }

        if (
          captureRight >= 0 &&
          captureRight < 64 &&
          col < 7 &&
          board[captureRight] &&
          (board[captureRight].toUpperCase() === board[captureRight]) !==
            isWhite
        ) {
          moves.push(captureRight);
        }
        break;

      case "r": // Rook
        // Horizontal and vertical moves
        const directions = [-8, 8, -1, 1];
        for (const dir of directions) {
          for (let i = 1; i < 8; i++) {
            const newPos = position + dir * i;

            // Check bounds
            if (newPos < 0 || newPos >= 64) break;
            if (dir === -1 && newPos % 8 === 7) break;
            if (dir === 1 && newPos % 8 === 0) break;

            if (!board[newPos]) {
              moves.push(newPos);
            } else {
              if ((board[newPos].toUpperCase() === board[newPos]) !== isWhite) {
                moves.push(newPos);
              }
              break;
            }
          }
        }
        break;

      case "n": // Knight
        const knightMoves = [-17, -15, -10, -6, 6, 10, 15, 17];
        for (const move of knightMoves) {
          const newPos = position + move;
          if (newPos >= 0 && newPos < 64) {
            const newRow = Math.floor(newPos / 8);
            const newCol = newPos % 8;

            if (Math.abs(newRow - row) <= 2 && Math.abs(newCol - col) <= 2) {
              if (
                !board[newPos] ||
                (board[newPos].toUpperCase() === board[newPos]) !== isWhite
              ) {
                moves.push(newPos);
              }
            }
          }
        }
        break;

      // Add other pieces (bishop, queen, king) as needed
      default:
        break;
    }

    return moves;
  }

  // Get all possible moves for the bot
  getAllPossibleMoves(board, isWhite) {
    const moves = [];

    for (let i = 0; i < 64; i++) {
      const piece = board[i];
      if (piece && (piece.toUpperCase() === piece) === isWhite) {
        const pieceMoves = this.getPossibleMoves(board, i, piece);
        for (const move of pieceMoves) {
          moves.push({ from: i, to: move, piece });
        }
      }
    }

    return moves;
  }

  // Simple evaluation function
  evaluateBoard(board) {
    const pieceValues = {
      p: 1,
      n: 3,
      b: 3,
      r: 5,
      q: 9,
      k: 100,
      P: -1,
      N: -3,
      B: -3,
      R: -5,
      Q: -9,
      K: -100,
    };

    let score = 0;
    for (const piece of board) {
      if (piece) {
        score += pieceValues[piece] || 0;
      }
    }

    return score;
  }

  // Get best move using minimax
  getBestMove(board, isWhite = false) {
    const moves = this.getAllPossibleMoves(board, isWhite);

    if (moves.length === 0) return null;

    // For easy difficulty, just return a random move
    if (this.difficulty === "easy") {
      return moves[Math.floor(Math.random() * moves.length)];
    }

    // For medium/hard, use simple evaluation
    let bestMove = moves[0];
    let bestScore = isWhite
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;

    for (const move of moves) {
      const newBoard = [...board];
      newBoard[move.to] = newBoard[move.from];
      newBoard[move.from] = null;

      const score = this.evaluateBoard(newBoard);

      if (isWhite && score > bestScore) {
        bestScore = score;
        bestMove = move;
      } else if (!isWhite && score < bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }

    return bestMove;
  }
}

// @route   POST /api/bot/move
// @desc    Get bot move
// @access  Private
router.post(
  "/move",
  [
    auth,
    requirePoliciesAccepted,
    body("gameId").notEmpty(),
    body("board").isArray(),
    body("difficulty").optional().isIn(["easy", "medium", "hard"]),
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

      const { gameId, board, difficulty = "medium" } = req.body;

      // Verify game exists and user is playing against bot
      const game = await Game.findOne({ gameId });
      if (!game || game.type !== "bot") {
        return res.status(400).json({
          success: false,
          message: "Invalid bot game",
        });
      }

      // Create bot instance
      const bot = new ChessBot(difficulty);

      // Get bot move (bot plays as black)
      const botMove = bot.getBestMove(board, false);

      if (!botMove) {
        return res.status(400).json({
          success: false,
          message: "No valid moves available",
        });
      }

      // Add some delay for realism
      const delay =
        difficulty === "easy" ? 500 : difficulty === "medium" ? 1000 : 1500;

      setTimeout(() => {
        res.json({
          success: true,
          data: {
            move: botMove,
            thinking_time: delay,
          },
        });
      }, delay);
    } catch (error) {
      console.error("Bot move error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   GET /api/bot/analyze
// @desc    Analyze position
// @access  Private
router.get("/analyze", auth, requirePoliciesAccepted, async (req, res) => {
  try {
    const { board, difficulty = "medium" } = req.query;

    if (!board) {
      return res.status(400).json({
        success: false,
        message: "Board position required",
      });
    }

    const parsedBoard = JSON.parse(board);
    const bot = new ChessBot(difficulty);

    const whiteMoves = bot.getAllPossibleMoves(parsedBoard, true);
    const blackMoves = bot.getAllPossibleMoves(parsedBoard, false);
    const evaluation = bot.evaluateBoard(parsedBoard);

    res.json({
      success: true,
      data: {
        evaluation,
        whiteMoves: whiteMoves.length,
        blackMoves: blackMoves.length,
        bestMoveWhite: bot.getBestMove(parsedBoard, true),
        bestMoveBlack: bot.getBestMove(parsedBoard, false),
      },
    });
  } catch (error) {
    console.error("Analyze position error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// @route   POST /api/bot/hint
// @desc    Get hint move from Stockfish
// @access  Private
router.post("/hint", auth, requirePoliciesAccepted, async (req, res) => {
  try {
    const { board, currentTurn, moveHistory = [] } = req.body;

    if (!board || !Array.isArray(board) || board.length !== 64) {
      return res.status(400).json({
        success: false,
        message: "Valid board array (64 elements) required",
      });
    }

    if (!currentTurn || !["white", "black"].includes(currentTurn)) {
      return res.status(400).json({
        success: false,
        message: "Valid currentTurn (white/black) required",
      });
    }

    // Fast-but-authentic hint profile (keeps Stockfish quality while reducing latency)
    const hintElo = 2200;
    const hintConfig = {
      elo: hintElo,
      depth: 8,
      movetime: 140,
      disableArtificialDelay: true,
    };
    const { getBestMove, findCheckmateMove } = require("../utils/stockfish");
    const cacheKey = getHintCacheKey(board, currentTurn, moveHistory);
    const cached = hintCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({
        success: true,
        data: {
          from: cached.move.from,
          to: cached.move.to,
          cached: true,
        },
      });
    }

    // First, check if there's an immediate checkmate move available
    const checkmateMove = findCheckmateMove(board, currentTurn, moveHistory);
    if (checkmateMove) {
      console.log("[HINT] Found checkmate move, using it:", checkmateMove);
      hintCache.set(cacheKey, {
        move: { from: checkmateMove.from, to: checkmateMove.to },
        expiresAt: Date.now() + HINT_CACHE_TTL_MS,
      });
      return res.json({
        success: true,
        data: {
          from: checkmateMove.from,
          to: checkmateMove.to,
          cached: false,
          mateHint: true,
        },
      });
    }

    let bestMove = null;
    try {
      bestMove = await Promise.race([
        getBestMove(board, currentTurn, moveHistory, hintElo, null, hintConfig),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Hint engine timeout")), HINT_ENGINE_TIMEOUT_MS)
        ),
      ]);
    } catch (fastError) {
      console.warn("[HINT] Fast hint failed, trying fallback:", fastError?.message || fastError);
      try {
        // Fallback remains Stockfish-based (authentic), just with a slightly longer budget.
        bestMove = await Promise.race([
          getBestMove(board, currentTurn, moveHistory, 2200, null, {
            elo: 2200,
            depth: 9,
            movetime: 220,
            disableArtificialDelay: true,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Hint fallback timeout")), HINT_FALLBACK_TIMEOUT_MS)
          ),
        ]);
      } catch (fallbackError) {
        const stale = hintCache.get(cacheKey);
        if (stale && stale.expiresAt + HINT_STALE_TTL_MS > Date.now()) {
          return res.json({
            success: true,
            data: {
              from: stale.move.from,
              to: stale.move.to,
              cached: true,
              stale: true,
            },
          });
        }
        throw fallbackError;
      }
    }

    if (!bestMove || bestMove.from === undefined || bestMove.to === undefined) {
      return res.status(400).json({
        success: false,
        message: "Could not generate hint move",
      });
    }

    hintCache.set(cacheKey, {
      move: { from: bestMove.from, to: bestMove.to },
      expiresAt: Date.now() + HINT_CACHE_TTL_MS,
    });
    if (hintCache.size > 200) {
      const oldestKey = hintCache.keys().next().value;
      if (oldestKey) hintCache.delete(oldestKey);
    }

    res.json({
      success: true,
      data: {
        from: bestMove.from,
        to: bestMove.to,
        cached: false,
      },
    });
  } catch (error) {
    console.error("Hint error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;
