const express = require("express");
const mongoose = require("mongoose");
const { body, validationResult } = require("express-validator");
const Game = require("../models/Game");
const Bot = require("../models/Bot");
const User = require("../models/User");
const auth = require("../middleware/auth");
const requirePoliciesAccepted = require("../middleware/requirePoliciesAccepted");
const { applyFischerIncrementToMover } = require("../utils/clockIncrement");

const router = express.Router();

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

// @route   POST /api/bot-games/create
// @desc    Create a new bot game
// @access  Private
router.post(
  "/create",
  [
    auth,
    requirePoliciesAccepted,
    body("botId").optional().isMongoId(),
    body("customBot").optional().isObject(),
    body("customBot.elo").optional().isInt({ min: 300, max: 3000 }),
    body("customBot.skillLevel").optional().isInt({ min: 0, max: 20 }),
    body("customBot.depth").optional().isInt({ min: 0, max: 20 }),
    body("customBot.movetime").optional().isInt({ min: 50, max: 5000 }),
    body("timeControl").isObject(),
    // Allow 0ms for untimed bot games
    body("timeControl.initial").isInt({ min: 0 }),
    body("timeControl.increment").optional().isInt({ min: 0 }),
    body("color").isIn(["white", "black"]),
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

      const { botId, customBot, timeControl, color } = req.body;

      if (!botId && !customBot) {
        return res.status(400).json({
          success: false,
          message: "Either botId or customBot configuration is required",
        });
      }

      let bot = null;
      let customBotProfile = null;
      let customBotConfig = null;

      if (botId) {
        // Verify bot exists and is enabled
        bot = await Bot.findById(botId);
        if (!bot || !bot.enabled) {
          return res.status(404).json({
            success: false,
            message: "Bot not found or disabled",
          });
        }
      } else {
        const customElo =
          typeof customBot.elo === "number" ? customBot.elo : 1500;
        customBotProfile = {
          name: "Custom Bot",
          photoUrl: "/assets/mascot-bot.png",
          subtitle: "User configured",
          description: "Custom Stockfish parameters selected by player.",
          elo: customElo,
        };
        customBotConfig = {
          elo: customElo,
          skillLevel:
            typeof customBot.skillLevel === "number"
              ? customBot.skillLevel
              : null,
          depth: typeof customBot.depth === "number" ? customBot.depth : null,
          movetime:
            typeof customBot.movetime === "number" ? customBot.movetime : null,
        };
      }

      // Determine player sides
      const userSide = color;
      const botSide = color === "white" ? "black" : "white";

      // Generate unique game ID
      const gameId = Math.random().toString(36).substr(2, 9);

      // Create game - set players object properly for both white and black
      const gameData = {
        gameId: gameId,
        type: "bot",
        players: {
          white: userSide === "white" ? req.user._id : null,
          black: userSide === "black" ? req.user._id : null,
        },
        bot: bot ? bot._id : null,
        botSide: botSide,
        botDifficulty: bot ? bot.difficulty : "medium",
        customBot: customBotProfile,
        customBotConfig: customBotConfig,
        timeControl: {
          initial: timeControl.initial,
          increment: timeControl.increment || 0,
        },
        timeRemaining: {
          white: timeControl.initial,
          black: timeControl.initial,
        },
        currentTurn: "white", // Always start with white
        status: "active",
      };

      const { setGameCategory } = require("../services/ratingEngine");
      
      const game = new Game(gameData);
      // Set category based on time control
      setGameCategory(game);
      await game.save();

      // Update user status
      await User.findByIdAndUpdate(req.user._id, { status: "in-game" });

      res.status(201).json({
        success: true,
        message: "Bot game created successfully",
        data: {
          gameId: game.gameId,
          game: {
            ...game.toObject(),
            bot: bot
              ? {
                  id: bot._id,
                  key: bot.key,
                  name: bot.name,
                  photoUrl: bot.photoUrl,
                  difficulty: bot.difficulty,
                  elo: bot.elo,
                  subtitle: bot.subtitle,
                  description: bot.description,
                }
              : customBotProfile,
            customBotConfig: customBotConfig,
          },
        },
      });

      // If bot plays as white, trigger bot's first move immediately
      if (botSide === "white") {
        setImmediate(async () => {
          try {
            const { getBestMove } = require("../utils/stockfish");
            const io = req.app.get("io");

            console.log("[BOT] Triggering first bot move for game:", gameId);

            // Reload game to get latest state
            const currentGame = await Game.findOne({ gameId: gameId }).populate(
              "bot"
            );
            if (!currentGame || currentGame.status !== "active") {
              console.log(
                "[BOT] Game not found or not active for first bot move"
              );
              return;
            }

            if (
              currentGame.currentTurn !== "white" ||
              currentGame.botSide !== "white"
            ) {
              console.log("[BOT] Not bot's turn for first move");
              return;
            }

            const botForMove = currentGame.bot
              ? await Bot.findById(currentGame.bot)
              : null;
            const botStrength = currentGame.customBotConfig || null;
            const effectiveElo = botForMove
              ? botForMove.elo
              : botStrength?.elo || currentGame.customBot?.elo || 1500;

            if (currentGame.bot && !botForMove) {
              console.log("[BOT] Bot document not found");
              return;
            }

            console.log("[BOT] Computing first bot move. ELO:", effectiveElo);

            // Note: Artificial thinking delay is now handled inherently by getBestMove!
            const startTime = Date.now();

            const preBotClockMs = currentGame.timeRemaining?.white;

            // Get bot's move
            const {
              getAllLegalMoves,
              isKingInCheck,
            } = require("../utils/chess-engine");
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
                "white",
                currentGame.moves,
                effectiveElo,
                !isUntimed &&
                  currentGame.timeRemaining &&
                  typeof currentGame.timeRemaining.white === "number"
                  ? currentGame.timeRemaining.white
                  : null,
                engineClockConfig
              );

              const elapsed = Date.now() - startTime;
              // Deduct elapsed engine+artificial thinking time from bot's clock
              if (
                currentGame.timeRemaining &&
                typeof currentGame.timeRemaining.white === "number"
              ) {
                currentGame.timeRemaining.white = Math.max(
                  0,
                  currentGame.timeRemaining.white - elapsed
                );
              }
            } catch (error) {
              // If getBestMove throws "No legal moves available", check for checkmate/stalemate
              if (
                error.message &&
                error.message.includes("No legal moves available")
              ) {
                console.log(
                  "[BOT] No legal moves - checking for checkmate/stalemate"
                );
                const botIsWhite = true; // Bot is playing white in this case
                const botInCheck = isKingInCheck(currentGame.board, botIsWhite);
                const legalMoves = getAllLegalMoves(
                  currentGame.board,
                  botIsWhite
                );
                if (legalMoves.length === 0) {
                  // Game is over - checkmate or stalemate
                  currentGame.status = "completed";
                  if (botInCheck) {
                    currentGame.result = {
                      winner: "black",
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
                  
                  io.to(gameId).emit("game-ended", {
                    gameId: gameId,
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

            // Apply bot move
            const botBoard = [...currentGame.board];
            const movingPiece = botBoard[botMoveIndices.from];
            const capturedPiece = botBoard[botMoveIndices.to];

            // Check if this is castling (king moves 2 squares horizontally)
            const fromFile = botMoveIndices.from % 8;
            const toFile = botMoveIndices.to % 8;
            const fromRank = Math.floor(botMoveIndices.from / 8);
            const isCastling =
              movingPiece &&
              movingPiece.toLowerCase() === "k" && // It's a king
              Math.abs(toFile - fromFile) === 2; // King moves exactly 2 squares horizontally

            // Check for pawn promotion (needed for notation later)
            const toRow = Math.floor(botMoveIndices.to / 8);
            const isPawnPromotion =
              movingPiece &&
              movingPiece.toLowerCase() === "p" && // It's a pawn
              ((movingPiece === movingPiece.toUpperCase() && toRow === 0) || // White pawn to rank 8
                (movingPiece === movingPiece.toLowerCase() && toRow === 7)); // Black pawn to rank 1

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
                const botIsWhite = currentGame.botSide === "white";
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

            const pieceLetter = botBoard[botMoveIndices.to];
            const botMove = {
              from: botMoveIndices.from,
              to: botMoveIndices.to,
              piece: pieceLetter,
              captured: capturedPiece || null,
              notation: `${pieceLetter}${String.fromCharCode(
                97 + (botMoveIndices.to % 8)
              )}${8 - Math.floor(botMoveIndices.to / 8)}${
                isPawnPromotion ? "=" + pieceLetter.toUpperCase() : ""
              }`,
              ...calculateMoveTime({
                previousClockMs: preBotClockMs,
                updatedClockMs: currentGame.timeRemaining?.white,
                previousMoveTimestamp:
                  currentGame.moves && currentGame.moves.length > 0
                    ? currentGame.moves[currentGame.moves.length - 1]?.timestamp
                    : null,
                gameCreatedAt: currentGame.createdAt,
              }),
              timestamp: new Date(),
            };

            currentGame.board = botBoard;
            currentGame.moves.push(botMove);
            applyFischerIncrementToMover(currentGame, "white");
            currentGame.currentTurn = "black";

            await currentGame.save();

            console.log("[BOT] Emitting first bot move:", botMove);

            // Emit bot move
            io.to(gameId).emit("move-made", {
              gameId: gameId,
              move: botMove,
              board: botBoard,
              currentTurn: "black",
              timeRemaining: currentGame.timeRemaining,
            });
          } catch (error) {
            console.error("First bot move error:", error);
          }
        });
      }
    } catch (error) {
      console.error("Create bot game error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

const MOBILE_ID_TO_BOT_KEY = {
  pawnish: "pawnish",
  blunderbot: "blunderbot",
  "knighty-knight": "knight_knight",
  "casual-castle": "casual_castle",
  "steady-eddie": "steady_eddie",
  "tactical-tina": "tactical_tina",
  "gambit-ghost": "gambit_ghost",
  "the-defender": "the_defender",
  "coach-carbon": "coach_carbon",
  "professor-sly": "professor_sly",
  maximus: "maximus",
  "fort-knox": "fort_knox",
  octave: "octave",
  nebula: "nebula",
  "the-singularity": "the_singularity",
};

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

async function resolveBotForImport({ botId, botKey }) {
  if (botId && mongoose.Types.ObjectId.isValid(botId)) {
    const byId = await Bot.findById(botId);
    if (byId) return byId;
  }
  const raw = String(botKey || botId || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const mapped = MOBILE_ID_TO_BOT_KEY[raw] || raw.replace(/-/g, "_");
  return (
    (await Bot.findOne({ key: mapped })) ||
    (await Bot.findOne({ key: raw })) ||
    (await Bot.findOne({ key: raw.replace(/_/g, "-") }))
  );
}

// @route   POST /api/bot-games/import
// @desc    Import a completed on-device bot game (moves already played locally)
// @access  Private
router.post(
  "/import",
  [
    auth,
    requirePoliciesAccepted,
    body("clientGameId").isString().isLength({ min: 8, max: 120 }),
    body("botKey").optional().isString(),
    body("botId").optional(),
    body("color").isIn(["white", "black"]),
    body("uciMoves").isArray({ min: 1 }),
    body("uciMoves.*").isString(),
    body("result.winner").isIn(["white", "black", "draw"]),
    body("result.reason").isString(),
    body("timeControl.initial").isInt({ min: 0 }),
    body("timeControl.increment").optional().isInt({ min: 0 }),
    body("timeRemaining.white").optional().isInt({ min: 0 }),
    body("timeRemaining.black").optional().isInt({ min: 0 }),
    body("playedOffline").optional().isBoolean(),
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
        botKey,
        botId,
        color,
        uciMoves,
        result,
        timeControl,
        timeRemaining,
        playedOffline,
      } = req.body;

      const existing = await Game.findOne({ clientGameId });
      if (existing) {
        const userId = req.user._id.toString();
        const owns =
          existing.players?.white?.toString() === userId ||
          existing.players?.black?.toString() === userId;
        if (!owns) {
          return res.status(409).json({
            success: false,
            message: "clientGameId already used",
          });
        }
        return res.status(200).json({
          success: true,
          message: "Bot game already imported",
          data: {
            gameId: existing.gameId,
            alreadyImported: true,
          },
        });
      }

      const bot = await resolveBotForImport({ botId, botKey });
      if (!bot || !bot.enabled) {
        return res.status(404).json({
          success: false,
          message: "Bot not found or disabled",
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
          message: "Need at least 2 plies to import a bot game",
        });
      }

      const userSide = color;
      const botSide = color === "white" ? "black" : "white";
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
        type: "bot",
        isRated: false,
        clientGameId,
        clientPlayed: true,
        players: {
          white: userSide === "white" ? req.user._id : null,
          black: userSide === "black" ? req.user._id : null,
        },
        bot: bot._id,
        botSide,
        botDifficulty: bot.difficulty,
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
        console.error("[bot-games/import] review trigger failed:", reviewErr);
      }

      return res.status(201).json({
        success: true,
        message: playedOffline
          ? "Offline bot game synced"
          : "Bot game imported",
        data: {
          gameId: game.gameId,
          alreadyImported: false,
          bot: {
            id: bot._id,
            key: bot.key,
            name: bot.name,
            elo: bot.elo,
          },
        },
      });
    } catch (error) {
      console.error("Import bot game error:", error);
      if (error && error.code === 11000) {
        const again = await Game.findOne({
          clientGameId: req.body?.clientGameId,
        });
        if (again) {
          return res.status(200).json({
            success: true,
            message: "Bot game already imported",
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
