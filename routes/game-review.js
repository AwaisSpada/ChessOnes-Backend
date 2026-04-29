/**
 * Game Review API Routes
 * 
 * POST /api/game-review/:gameId
 *   - Generates quick game review using LITE Stockfish engine if not exists
 *   - Stores review in Review model
 * 
 * GET /api/game-review/:gameId
 *   - Returns stored review JSON from Review model
 * 
 * GET /api/game-review/:gameId/replay-eval
 *   - Uses LITE engine for quick replay-time evaluation (UX-only, not persisted)
 */

const express = require("express");
const auth = require("../middleware/auth");
const Game = require("../models/Game");
const { Chess } = require("chess.js");
const path = require("path");
const fs = require("fs");
const { generateQuickReview } = require("../utils/game-review/quick-review-generator");
const { 
  storeReview, 
  getReview, 
  markReviewPending, 
  markReviewFailed,
  hasCompletedReview,
  hasReview
} = require("../utils/game-review/review-storage");
const { getReplayEvaluation } = require("../utils/game-review/replay-eval");

const router = express.Router();
const reviewJobsInProgress = new Set();

async function runQuickReviewInBackground(gameId) {
  if (reviewJobsInProgress.has(gameId)) {
    return;
  }
  reviewJobsInProgress.add(gameId);
  console.log(`[GameReview] Background quick review started for game ${gameId}`);

  setImmediate(async () => {
    try {
      // Stockfish path preflight audit for background task context.
      const stockfishDir = path.join(__dirname, "..", "stockfish");
      const isWindows = process.platform === "win32";
      const candidatePath = isWindows
        ? path.join(stockfishDir, "Windows", "stockfish-windows-x86-64-avx2.exe")
        : path.join(stockfishDir, "Linux", "stockfish-ubuntu-x86-64-avx2");
      const stockfishPathExists = fs.existsSync(candidatePath);
      if (!stockfishPathExists) {
        console.warn(`[GameReview] Stockfish candidate path missing: ${candidatePath}`);
      }

      const engine = require("../utils/game-review/engine");
      await engine.ensureLiteEngineReady();

      const game = await Game.findOne({ gameId })
        .populate("players.white players.black", "username fullName avatar rating isDeleted")
        .populate("bot", "name photoUrl difficulty elo");

      if (!game) {
        await markReviewFailed(gameId, "Game not found");
        return;
      }
      if (game.status !== "completed") {
        await markReviewFailed(gameId, `Game status is ${game.status}, expected completed`);
        return;
      }
      if (!game.moves || game.moves.length === 0) {
        await markReviewFailed(gameId, "Game has no moves to review");
        return;
      }

      const uciMoves = convertGameMovesToUCI(game.moves);
      if (uciMoves.length === 0) {
        await markReviewFailed(gameId, "Could not convert game moves to UCI format");
        return;
      }
      const reviewPromise = generateQuickReview(uciMoves, {
        depth: 12,
        movetime: 500,
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Quick review timeout after 60s")), 60000)
      );
      const review = await Promise.race([reviewPromise, timeoutPromise]);

      if (!review) {
        throw new Error("Quick review generation returned empty response");
      }
      attachMoveTimingsToReview(review, game);
      await storeReview(gameId, review, {
        depth: 12,
        movetime: 500,
        engineType: "LITE",
      });
      console.log(`[GameReview] Background quick review completed for game ${gameId}`);
    } catch (error) {
      console.error(`[GameReview] Background quick review failed for game ${gameId}:`, error);
      await markReviewFailed(gameId, error.message || "Unknown background generation error");
    } finally {
      reviewJobsInProgress.delete(gameId);
    }
  });
}

/**
 * Convert game moves from database format to UCI format
 * @param {Array} moves - Moves from database
 * @returns {string[]} - Array of UCI moves
 */
function convertGameMovesToUCI(moves) {
  if (!moves || !Array.isArray(moves)) {
    return [];
  }
  const files = "abcdefgh";
  const ranks = "12345678";

  const idxToSq = (idx) => {
    const file = idx % 8;
    const rank = 7 - Math.floor(idx / 8);
    return `${files[file]}${ranks[rank]}`;
  };

  const extractPromotion = (move) => {
    if (typeof move?.notation === "string") {
      const match = move.notation.match(/=([QRBNqrbn])/);
      if (match) return match[1].toLowerCase();
    }
    if (typeof move?.piece === "string" && move.piece.length > 1) {
      const promo = move.piece[move.piece.length - 1];
      if ("qrbnQRBN".includes(promo)) return promo.toLowerCase();
    }
    return "";
  };

  const buildCandidate = (flip = false) =>
    moves.map((move) => {
      const from = flip ? 63 - move.from : move.from;
      const to = flip ? 63 - move.to : move.to;
      return `${idxToSq(from)}${idxToSq(to)}${extractPromotion(move)}`;
    });

  const scoreCandidate = (uciMoves) => {
    const chess = new Chess();
    let legalCount = 0;
    let invalidMove = null;
    for (const uci of uciMoves) {
      try {
        const mv = chess.move(uci, { sloppy: true });
        if (!mv) {
          invalidMove = uci;
          break;
        }
        legalCount += 1;
      } catch (_err) {
        invalidMove = uci;
        break;
      }
    }
    return { legalCount, invalidMove };
  };

  const normal = buildCandidate(false);
  const flipped = buildCandidate(true);
  const normalScoreResult = scoreCandidate(normal);
  const flippedScoreResult = scoreCandidate(flipped);
  const normalScore = normalScoreResult.legalCount;
  const flippedScore = flippedScoreResult.legalCount;
  const useFlipped = flippedScore > normalScore;
  const chosen = useFlipped ? flipped : normal;
  const conversionMode = useFlipped ? "flipped" : "normal";
  const legalReplayCount = useFlipped ? flippedScore : normalScore;

  console.log(
    `[GameReviewAPI] UCI conversion metrics: conversionMode=${conversionMode}, normalLegalReplayCount=${normalScore}, flippedLegalReplayCount=${flippedScore}, legalReplayCount=${legalReplayCount}, totalMoves=${moves.length}${(useFlipped ? flippedScoreResult.invalidMove : normalScoreResult.invalidMove) ? `, firstInvalidMove=${useFlipped ? flippedScoreResult.invalidMove : normalScoreResult.invalidMove}` : ""}`
  );

  return chosen;
}

/**
 * Copy per-move clock timing from Game.moves onto review.moves (same index order as UCI list).
 */
function attachMoveTimingsToReview(review, game) {
  if (!review || !Array.isArray(review.moves) || !game?.moves?.length) {
    return review;
  }
  review.moves = review.moves.map((rm, i) => {
    const gm = game.moves[i];
    if (!gm) return rm;
    const next = { ...rm };
    if (typeof gm.moveTimeMs === "number") next.moveTimeMs = gm.moveTimeMs;
    if (typeof gm.moveTimeSeconds === "number") next.moveTimeSeconds = gm.moveTimeSeconds;
    return next;
  });
  return review;
}

/**
 * Add game metadata and player mapping to review
 */
function enrichReviewWithGameData(review, game, userId) {
  // Determine which player is the user and which is the bot/opponent
  const isUserWhite = game.players.white && game.players.white._id && game.players.white._id.equals(userId);
  const isUserBlack = game.players.black && game.players.black._id && game.players.black._id.equals(userId);
  
  let userSide, botSide;
  if (game.type === "bot" && game.botSide) {
    botSide = game.botSide;
    userSide = botSide === "white" ? "black" : "white";
  } else if (isUserWhite) {
    userSide = "white";
    botSide = "black";
  } else if (isUserBlack) {
    userSide = "black";
    botSide = "white";
  } else {
    if (game.botSide) {
      botSide = game.botSide;
      userSide = botSide === "white" ? "black" : "white";
    } else {
      userSide = "white";
      botSide = "black";
    }
  }
  
  const userPlayer = userSide === "white" ? game.players.white : (userSide === "black" ? game.players.black : null);
  
  let opponentInfo = null;
  if (game.type === "bot" && game.bot) {
    opponentInfo = {
      id: game.bot._id,
      username: game.bot.name,
      name: game.bot.name,
      avatar: game.bot.photoUrl,
      rating: game.bot.elo,
      isBot: true,
    };
  } else {
    const opponentPlayer = userSide === "white" ? game.players.black : game.players.white;
    if (opponentPlayer) {
      opponentInfo = {
        id: opponentPlayer._id,
        username: opponentPlayer.isDeleted ? "Closed Account" : opponentPlayer.username,
        name: opponentPlayer.isDeleted ? "Closed Account" : (opponentPlayer.fullName || opponentPlayer.username),
        avatar: opponentPlayer.avatar,
        rating: opponentPlayer.rating,
        isBot: false,
        isDeleted: opponentPlayer.isDeleted || false,
      };
    }
  }
  
  // Map player stats correctly
  let userStats, botStats;
  if (userSide === "white") {
    userStats = review.players.white;
    botStats = review.players.black;
  } else if (userSide === "black") {
    userStats = review.players.black;
    botStats = review.players.white;
  } else {
    userStats = review.players.white;
    botStats = review.players.black;
  }
  
  // Add game metadata
  review.game = {
    gameId: game.gameId,
    type: game.type,
    status: game.status,
    result: game.result,
    createdAt: game.createdAt,
    userSide: userSide,
    botSide: botSide,
    players: {
      white: game.players.white ? {
        id: game.players.white._id,
        username: game.players.white.isDeleted ? "Closed Account" : game.players.white.username,
        name: game.players.white.isDeleted ? "Closed Account" : (game.players.white.fullName || game.players.white.username),
        avatar: game.players.white.avatar,
        rating: game.players.white.rating,
        isDeleted: game.players.white.isDeleted || false,
      } : (game.botSide === "white" && game.bot ? {
        id: game.bot._id,
        username: game.bot.name,
        name: game.bot.name,
        avatar: game.bot.photoUrl,
        rating: game.bot.elo,
        isBot: true,
      } : null),
      black: game.players.black ? {
        id: game.players.black._id,
        username: game.players.black.isDeleted ? "Closed Account" : game.players.black.username,
        name: game.players.black.isDeleted ? "Closed Account" : (game.players.black.fullName || game.players.black.username),
        avatar: game.players.black.avatar,
        rating: game.players.black.rating,
        isDeleted: game.players.black.isDeleted || false,
      } : (game.botSide === "black" && game.bot ? {
        id: game.bot._id,
        username: game.bot.name,
        name: game.bot.name,
        avatar: game.bot.photoUrl,
        rating: game.bot.elo,
        isBot: true,
      } : null),
    },
    user: userPlayer ? {
      id: userPlayer._id,
      username: userPlayer.isDeleted ? "Closed Account" : userPlayer.username,
      name: userPlayer.isDeleted ? "Closed Account" : (userPlayer.fullName || userPlayer.username),
      avatar: userPlayer.avatar,
      rating: userPlayer.rating,
      isDeleted: userPlayer.isDeleted || false,
    } : null,
    opponent: opponentInfo,
  };
  
  // Add correctly mapped player stats
  review.players = {
    white: review.players.white,
    black: review.players.black,
    user: userStats,
    bot: botStats,
  };

  attachMoveTimingsToReview(review, game);

  return review;
}

/**
 * POST /api/game-review/:gameId
 * Generate game review for a completed game (if not already exists)
 */
router.post("/:gameId", auth, async (req, res) => {
  try {
    const { gameId } = req.params;
    
    console.log(`[GameReview] POST request for gameId: ${gameId}, user: ${req.user._id}`);
    
    // ✅ CRITICAL: Check if review already exists (any status)
    const existingReview = await getReview(gameId);
    
    // If review exists and is completed, return it immediately - NEVER regenerate
    if (existingReview && existingReview.status === "completed") {
      console.log(`[GameReview] ✅ SAFEGUARD: Review already exists and is completed for game ${gameId}. Returning stored review.`);
      
      // Load game for metadata
      const game = await Game.findOne({ gameId })
        .populate("players.white players.black", "username fullName avatar rating isDeleted")
        .populate("bot", "name photoUrl difficulty elo");
      
      if (!game) {
        return res.status(404).json({
          success: false,
          message: "Game not found",
        });
      }
      
      // Enrich with game data
      const enrichedReview = enrichReviewWithGameData(
        existingReview.reviewData,
        game,
        req.user._id
      );
      
      return res.json({
        success: true,
        message: "Review retrieved successfully",
        data: { review: enrichedReview },
      });
    }
    
    // ✅ CRITICAL: If review is pending, return "in_progress" - NEVER start new generation
    if (existingReview && existingReview.status === "pending") {
      console.log(`[GameReview] ✅ SAFEGUARD: Review is already being generated (status: pending) for game ${gameId}. Returning in_progress.`);
      
      return res.status(202).json({
        success: false,
        message: "Review is being generated. Please wait and use GET to fetch it when ready.",
        status: "in_progress",
      });
    }
    
    // Failed reviews are eligible for retry.
    if (existingReview && existingReview.status === "failed") {
      console.log(`[GameReview] Review exists with failed status for game ${gameId}. Allowing retry.`);
    }
    
    // Find game with bot info
    const game = await Game.findOne({ gameId })
      .populate("players.white players.black", "username fullName avatar rating")
      .populate("bot", "name photoUrl difficulty elo");

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found in database",
      });
    }

    console.log(`[GameReview] Game found: type=${game.type}, moves=${game.moves?.length || 0}, status=${game.status}`);

    // Check if user is part of this game
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
        message: "You can only review your own games",
      });
    }

    // Check if game has moves
    if (!game.moves || game.moves.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Game has no moves to review",
      });
    }

    // CRITICAL: Verify game is completed before reviewing
    if (game.status !== "completed") {
      console.warn(`[GameReview] WARNING: Game status is "${game.status}", not "completed". Review may be incomplete.`);
      return res.status(400).json({
        success: false,
        message: "Game must be completed before review can be generated",
      });
    }
    
    // Mark as in_progress and kick background worker, then return quickly.
    await markReviewPending(gameId);
    runQuickReviewInBackground(gameId);

    return res.status(202).json({
      success: true,
      status: "in_progress",
      message: "Review is being generated",
    });
  } catch (error) {
    console.error(`[GameReview] Error starting review generation:`, error);
    
    await markReviewFailed(req.params.gameId, error.message || "Unknown error");
    
    res.status(500).json({
      success: false,
      message: error.message || "Failed to generate game review",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

/**
 * GET /api/game-review/:gameId
 * Retrieve stored review JSON
 */
router.get("/:gameId", auth, async (req, res) => {
  try {
    const { gameId } = req.params;
    
    console.log(`[GameReview] GET request for gameId: ${gameId}, user: ${req.user._id}`);
    
    // Get stored review with timeout protection
    let reviewDoc;
    try {
      const getReviewPromise = getReview(gameId);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Database query timeout")), 10000)
      );
      reviewDoc = await Promise.race([getReviewPromise, timeoutPromise]);
    } catch (dbError) {
      console.error(`[GameReview] Database error getting review:`, dbError);
      return res.status(500).json({
        success: false,
        message: "Database error while retrieving review",
        error: process.env.NODE_ENV === "development" ? dbError.message : undefined,
      });
    }
    
    // If no review document exists, return 404
    if (!reviewDoc) {
      return res.status(404).json({
        success: false,
        message: "Review not found. Use POST to generate a review.",
      });
    }
    
    // ✅ If review is pending but has no reviewData, it's still generating (quick review not ready yet)
    // Return proper status code (202 Accepted) and message
    if (reviewDoc.status === "pending" && !reviewDoc.reviewData) {
      return res.status(202).json({
        success: false,
        message: "Review is being generated. Please wait and try again later.",
        status: "in_progress",
      });
    }
    
    // ✅ If review exists but has no reviewData (and not pending), it's invalid
    // This should not happen, but handle gracefully
    if (!reviewDoc.reviewData) {
      return res.status(404).json({
        success: false,
        message: "Review not found. Use POST to generate a review.",
      });
    }
    
    // ✅ Allow returning pending reviews that HAVE reviewData.
    
    // Load game for metadata with timeout protection
    let game;
    try {
      const findGamePromise = Game.findOne({ gameId })
        .populate("players.white players.black", "username fullName avatar rating isDeleted")
        .populate("bot", "name photoUrl difficulty elo");
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Database query timeout")), 10000)
      );
      game = await Promise.race([findGamePromise, timeoutPromise]);
    } catch (dbError) {
      console.error(`[GameReview] Database error loading game:`, dbError);
      return res.status(500).json({
        success: false,
        message: "Database error while loading game",
        error: process.env.NODE_ENV === "development" ? dbError.message : undefined,
      });
    }
    
    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }
    
    // Check if user is part of this game
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
        message: "You can only review your own games",
      });
    }
    
    // Enrich with game data
    const enrichedReview = enrichReviewWithGameData(
      reviewDoc.reviewData,
      game,
      req.user._id
    );
    
    // Add metadata about review type
    enrichedReview.reviewMetadata = {
      status: reviewDoc.status,
      engineType: reviewDoc.engineConfig?.engineType || "LITE",
      isQuickReview: reviewDoc.engineConfig?.engineType === "LITE",
      generatedAt: reviewDoc.generatedAt,
    };
    
    res.json({
      success: true,
      message: "Quick review retrieved successfully",
      data: { 
        review: enrichedReview,
        generatedAt: reviewDoc.generatedAt,
        engineConfig: reviewDoc.engineConfig,
        status: reviewDoc.status,
      },
    });
  } catch (error) {
    console.error(`[GameReview] Error retrieving review:`, error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to retrieve game review",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

/**
 * GET /api/game-review/:gameId/replay-eval
 * Get quick evaluation for replay navigation (uses LITE engine, not persisted)
 * 
 * ✅ SAFEGUARD: LITE engine results are NEVER persisted.
 * This endpoint is UX-only for real-time replay features:
 * - Arrow highlights
 * - Suggestion text
 * - Hover evaluation
 * 
 * Replay display (move list, tags, eval bar) MUST use stored review data (GET /:gameId).
 */
router.get("/:gameId/replay-eval", auth, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { moves: movesParam } = req.query; // UCI moves up to current position (comma-separated)
    
    console.log(`[GameReview] Replay-eval request for gameId: ${gameId}, user: ${req.user._id}`);
    
    // Verify game exists and user has access
    const game = await Game.findOne({ gameId })
      .populate("players.white players.black", "username fullName avatar rating");
    
    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }
    
    // Check if user is part of this game
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
        message: "You can only review your own games",
      });
    }
    
    // Parse moves from query parameter (JSON string or array)
    let moves = [];
    if (movesParam) {
      if (typeof movesParam === "string") {
        try {
          // Try to parse as JSON first (frontend sends JSON string)
          moves = JSON.parse(movesParam);
          if (!Array.isArray(moves)) {
            throw new Error("Moves must be an array");
          }
        } catch (parseError) {
          // Fallback to comma-separated string
          moves = movesParam.split(",").map(m => m.trim()).filter(Boolean);
        }
      } else if (Array.isArray(movesParam)) {
        moves = movesParam;
      }
    } else {
      // If no moves provided, use all game moves (convert from database format)
      moves = convertGameMovesToUCI(game.moves || []);
    }
    
    // Validate moves are UCI format
    if (!Array.isArray(moves)) {
      return res.status(400).json({
        success: false,
        message: "Moves must be an array of UCI moves",
      });
    }
    
    // Get quick evaluation using LITE engine (depth 8-10, movetime 500ms)
    const evaluation = await getReplayEvaluation(moves, {
      depth: 8, // LITE engine uses depth 8 (can be 8-10)
      movetime: 500, // 500ms as specified
    });
    
    res.json({
      success: true,
      message: "Evaluation retrieved successfully",
      data: {
        bestMove: evaluation.bestMove,
        evalAfter: evaluation.evalAfter,
        evaluation: evaluation.evaluation, // Alias for backwards compatibility
        pv: evaluation.pv,
        arrow: evaluation.arrow, // Arrow suggestion (from/to squares)
        evaluationText: evaluation.evaluationText,
        depth: evaluation.depth,
        moves: moves.length, // Number of moves evaluated
        engineType: "LITE", // ✅ Indicate this is from LITE engine (UX-only, not persisted)
        // ✅ SAFEGUARD: Explicitly mark as non-persistent
        persistent: false,
        note: "This evaluation is for UX-only (arrows, suggestions). For stored review data, use GET /:gameId",
      },
    });
  } catch (error) {
    console.error(`[GameReview] Error getting replay evaluation:`, error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get replay evaluation",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

module.exports = router;
