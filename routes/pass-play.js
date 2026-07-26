const express = require("express");
const { body, validationResult } = require("express-validator");
const Game = require("../models/Game");
const auth = require("../middleware/auth");
const requirePoliciesAccepted = require("../middleware/requirePoliciesAccepted");

const router = express.Router();

function algebraicToIndex(sq) {
  const file = sq.charCodeAt(0) - 97;
  const rank = Number.parseInt(sq[1], 10);
  if (file < 0 || file > 7 || !Number.isFinite(rank) || rank < 1 || rank > 8) {
    return null;
  }
  const row = 8 - rank;
  return row * 8 + file;
}

function chessBoardToGameArray(chess) {
  return chess.board().flatMap((rank) =>
    rank.map((sq) => {
      if (!sq) return null;
      return sq.color === "w" ? sq.type.toUpperCase() : sq.type;
    })
  );
}

function mapImportReason(reason) {
  const r = String(reason || "").toLowerCase();
  if (r === "agreement" || r === "draw-by-agreement") return "draw-agreement";
  const allowed = new Set([
    "checkmate",
    "stalemate",
    "resignation",
    "timeout",
    "draw-agreement",
    "draw-by-agreement",
    "disconnect",
    "threefold-repetition",
    "insufficient-material",
    "first-move-abandon",
  ]);
  return allowed.has(r) ? r : "resignation";
}

// @route   POST /api/pass-play/import
// @desc    Import a completed on-device pass-and-play game for cloud review
// @access  Private
router.post(
  "/import",
  [
    auth,
    requirePoliciesAccepted,
    body("clientGameId").isString().isLength({ min: 8, max: 120 }),
    body("uciMoves").isArray({ min: 1 }),
    body("uciMoves.*").isString(),
    body("result.winner").isIn(["white", "black", "draw"]),
    body("result.reason").isString(),
    body("whiteName").optional().isString().isLength({ max: 80 }),
    body("blackName").optional().isString().isLength({ max: 80 }),
    body("timeControl.initial").optional().isInt({ min: 0 }),
    body("timeControl.increment").optional().isInt({ min: 0 }),
    body("timeRemaining.white").optional().isInt({ min: 0 }),
    body("timeRemaining.black").optional().isInt({ min: 0 }),
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

      const {
        clientGameId,
        uciMoves,
        result,
        whiteName,
        blackName,
        timeControl = {},
        timeRemaining = {},
      } = req.body;

      const existing = await Game.findOne({ clientGameId });
      if (existing) {
        return res.status(200).json({
          success: true,
          message: "Pass-and-play game already imported",
          data: { gameId: existing.gameId, alreadyImported: true },
        });
      }

      const { Chess } = require("chess.js");
      const chess = new Chess();
      const moves = [];

      for (const rawUci of uciMoves) {
        const uci = String(rawUci || "")
          .trim()
          .toLowerCase();
        if (uci.length < 4) {
          return res.status(400).json({
            success: false,
            message: `Invalid UCI move: ${rawUci}`,
          });
        }
        const fromSq = uci.slice(0, 2);
        const toSq = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci[4] : undefined;
        const from = algebraicToIndex(fromSq);
        const to = algebraicToIndex(toSq);
        if (from == null || to == null) {
          return res.status(400).json({
            success: false,
            message: `Invalid squares in UCI: ${uci}`,
          });
        }

        let moved;
        try {
          moved = chess.move({
            from: fromSq,
            to: toSq,
            promotion: promotion || undefined,
          });
        } catch {
          moved = null;
        }
        if (!moved) {
          return res.status(400).json({
            success: false,
            message: `Illegal move in sequence: ${uci}`,
          });
        }

        const pieceChar =
          moved.color === "w"
            ? moved.piece.toUpperCase()
            : moved.piece.toLowerCase();
        moves.push({
          from,
          to,
          piece: promotion ? `${pieceChar}${promotion}` : pieceChar,
          captured: moved.captured
            ? moved.color === "w"
              ? moved.captured.toLowerCase()
              : moved.captured.toUpperCase()
            : undefined,
          notation: moved.san,
          timestamp: new Date(),
        });
      }

      if (moves.length < 2) {
        return res.status(400).json({
          success: false,
          message: "Need at least 2 plies to import a pass-and-play game",
        });
      }

      const gameId = Math.random().toString(36).substr(2, 9);
      const initialMs = Number(timeControl.initial) || 0;
      const incrementMs = Number(timeControl.increment) || 0;
      const whiteRemain =
        typeof timeRemaining?.white === "number"
          ? timeRemaining.white
          : initialMs;
      const blackRemain =
        typeof timeRemaining?.black === "number"
          ? timeRemaining.black
          : initialMs;

      const { setGameCategory } = require("../services/ratingEngine");

      const game = new Game({
        gameId,
        type: "friend",
        isRated: false,
        clientGameId,
        clientPlayed: true,
        players: {
          // Owner of the device session — required for review access.
          white: req.user._id,
          black: null,
        },
        passPlay: {
          whiteName: String(whiteName || "White").slice(0, 80),
          blackName: String(blackName || "Black").slice(0, 80),
        },
        board: chessBoardToGameArray(chess),
        moves,
        currentTurn: chess.turn() === "w" ? "white" : "black",
        status: "completed",
        result: {
          winner: result.winner,
          reason: mapImportReason(result.reason),
        },
        timeControl: {
          initial: initialMs,
          increment: incrementMs,
        },
        timeRemaining: {
          white: Math.max(0, whiteRemain),
          black: Math.max(0, blackRemain),
        },
      });
      setGameCategory(game);
      await game.save();

      try {
        const {
          triggerReviewGeneration,
        } = require("../utils/game-review/game-completion-hook");
        triggerReviewGeneration(game.gameId);
      } catch (reviewErr) {
        console.error("[pass-play/import] review trigger failed:", reviewErr);
      }

      return res.status(201).json({
        success: true,
        message: "Pass-and-play game imported",
        data: {
          gameId: game.gameId,
          alreadyImported: false,
        },
      });
    } catch (error) {
      console.error("Import pass-play game error:", error);
      if (error && error.code === 11000) {
        const again = await Game.findOne({
          clientGameId: req.body?.clientGameId,
        });
        if (again) {
          return res.status(200).json({
            success: true,
            message: "Pass-and-play game already imported",
            data: { gameId: again.gameId, alreadyImported: true },
          });
        }
      }
      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

module.exports = router;
