/**
 * Game Completion Hook Service
 * 
 * Review generation:
 * 1. Quick review (LITE engine, depth 12, 600ms) - saved immediately for frontend
 * 
 * Runs asynchronously to ensure failures do NOT affect live game completion.
 * This is a read-only operation that does not modify game state.
 */

const { generateQuickReview } = require("./quick-review-generator");
const { Chess } = require("chess.js");
const { storeReview, markReviewPending, markReviewFailed, getReview } = require("./review-storage");
const Game = require("../../models/Game");

/**
 * Convert game moves from database format to UCI format.
 * Uses orientation + side-to-move candidate scoring and never throws on invalid moves.
 */
function convertGameMovesToUCI(moves, context = {}) {
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

  // Orientation-agnostic conversion: try canonical indices first, then flipped indices.
  const buildCandidate = (flip = false) =>
    moves.map((move) => {
      const from = flip ? 63 - move.from : move.from;
      const to = flip ? 63 - move.to : move.to;
      return `${idxToSq(from)}${idxToSq(to)}${extractPromotion(move)}`;
    });

  const buildInitialFen = (turn) => {
    if (context.initialFen && typeof context.initialFen === "string") {
      return context.initialFen;
    }
    return `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR ${turn} KQkq - 0 1`;
  };

  const scoreCandidate = (uciMoves, turn) => {
    const chess = new Chess(buildInitialFen(turn));
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

  const inferStartTurn = () => {
    if (context.startTurn === "white" || context.startTurn === "black") {
      return context.startTurn;
    }
    if (context.currentTurn === "white" || context.currentTurn === "black") {
      // After N plies, currentTurn = startTurn when N is even, otherwise opposite.
      return moves.length % 2 === 0
        ? context.currentTurn
        : context.currentTurn === "white"
        ? "black"
        : "white";
    }
    return "white";
  };

  const inferredTurn = inferStartTurn();
  const turnCandidates = Array.from(new Set([inferredTurn, "white", "black"]));

  const scored = [];
  for (const turn of turnCandidates) {
    const n = scoreCandidate(normal, turn);
    scored.push({ mode: "normal", turn, moves: normal, ...n });
    const f = scoreCandidate(flipped, turn);
    scored.push({ mode: "flipped", turn, moves: flipped, ...f });
  }

  scored.sort((a, b) => b.legalCount - a.legalCount);
  const best = scored[0] || { mode: "normal", turn: inferredTurn, moves: normal, legalCount: 0 };
  const chosen = best.moves;
  const conversionMode = `${best.mode}:${best.turn}`;
  const legalReplayCount = best.legalCount;
  const normalInferred = scored.find((s) => s.mode === "normal" && s.turn === inferredTurn);
  const flippedInferred = scored.find((s) => s.mode === "flipped" && s.turn === inferredTurn);

  console.log(
    `[GameCompletionHook] UCI conversion metrics: conversionMode=${conversionMode}, inferredStartTurn=${inferredTurn}, normalLegalReplayCount=${normalInferred?.legalCount ?? 0}, flippedLegalReplayCount=${flippedInferred?.legalCount ?? 0}, legalReplayCount=${legalReplayCount}, totalMoves=${moves.length}${best.invalidMove ? `, firstInvalidMove=${best.invalidMove}` : ""}`
  );

  return chosen;
}

/**
 * Trigger review generation for a completed game
 * This runs asynchronously and does not block game completion
 * @param {string} gameId - Game ID
 */
async function triggerReviewGeneration(gameId) {
  // Run asynchronously - don't block
  setImmediate(async () => {
    try {
      console.log(`[GameCompletionHook] Triggering review generation for game ${gameId}`);
      
      // Completed/pending should not be regenerated. Failed can be retried.
      const existingReview = await getReview(gameId);
      if (existingReview?.status === "completed" || existingReview?.status === "pending") {
        console.log(
          `[GameCompletionHook] Review already ${existingReview.status} for game ${gameId}, skipping hook generation`
        );
        return;
      }
      
      // Load game
      const game = await Game.findOne({ gameId })
        .populate("players.white players.black", "username fullName avatar rating")
        .populate("bot", "name photoUrl difficulty elo");
      
      if (!game) {
        console.error(`[GameCompletionHook] Game not found: ${gameId}`);
        await markReviewFailed(gameId, "Game not found");
        return;
      }
      
      // Verify game is completed
      if (game.status !== "completed") {
        console.warn(`[GameCompletionHook] Game ${gameId} is not completed (status: ${game.status}), skipping review`);
        return;
      }
      
      // Check if game has moves
      if (!game.moves || game.moves.length === 0) {
        console.warn(`[GameCompletionHook] Game ${gameId} has no moves, skipping review`);
        await markReviewFailed(gameId, "Game has no moves");
        return;
      }
      
      // Convert moves to UCI
      const uciMoves = convertGameMovesToUCI(game.moves, {
        currentTurn: game.currentTurn,
        initialFen: game.initialFen || game.startingFen || game.fen,
      });
      
      if (uciMoves.length === 0) {
        console.error(`[GameCompletionHook] Could not convert moves for game ${gameId}`);
        await markReviewFailed(gameId, "Could not convert moves to UCI format");
        return;
      }
      
      console.log(`[GameCompletionHook] Starting review generation (quick review only) for game ${gameId} with ${uciMoves.length} moves`);
      
      // ========================================
      // STAGE 1: Quick Review (LITE engine)
      // ========================================
      // ✅ CRITICAL: Mark as pending FIRST to ensure review document exists
      try {
        await markReviewPending(gameId);
      } catch (markPendingError) {
        console.error(`[GameCompletionHook] Failed to mark review as pending:`, markPendingError.message);
        // If we can't mark as pending, check if review already exists
        const existingReview = await require("./review-storage").getReview(gameId);
        if (!existingReview) {
          // Can't create review document, abort
          console.error(`[GameCompletionHook] Cannot create review document, aborting review generation for game ${gameId}`);
          return;
        }
      }
      
      try {
        console.log(`[GameCompletionHook] Stage 1: Generating quick review with LITE engine...`);
        
        // ✅ SAFEGUARD: Generate quick review with error handling (never crash backend)
        // generateQuickReview throws on failure so we never persist an empty "completed" stub
        const quickReview = await generateQuickReview(uciMoves);
        
        // ✅ SAFEGUARD: Ensure reviewData is never null
        if (!quickReview || quickReview === null) {
          throw new Error("Quick review generation returned null");
        }
        
        // Store quick review immediately (status will be updated to "completed" by storeReview)
        // This allows frontend to fetch it right away
        try {
          await storeReview(gameId, quickReview, {
            depth: 12,
            movetime: 600,
            engineType: "LITE",
          });
          console.log(`[GameCompletionHook] ✅ Stage 1 complete: Quick review saved (status: completed) for game ${gameId}`);
        } catch (storeError) {
          // ✅ CRITICAL: If storeReview fails, throw to trigger outer catch block
          console.error(`[GameCompletionHook] ❌ CRITICAL: Failed to store quick review:`, storeError.message);
          throw new Error(`Failed to store quick review: ${storeError.message}`);
        }
      } catch (quickError) {
        // ✅ CRITICAL: Log error and mark as failed - MUST update status from "pending"
        console.error(`[GameCompletionHook] ❌ Stage 1 failed (quick review):`, quickError.message);
        console.error(`[GameCompletionHook] Stack:`, quickError.stack);
        
        // ✅ CRITICAL: ALWAYS mark as failed to transition from "pending" state
        // This ensures review never stays stuck in "pending"
        try {
          await markReviewFailed(gameId, `Quick review failed: ${quickError.message}`);
          console.log(`[GameCompletionHook] ✅ Stage 1 marked as failed for game ${gameId}`);
        } catch (markError) {
          console.error(`[GameCompletionHook] ❌ CRITICAL: Failed to mark review as failed:`, markError.message);
          // Even if marking as failed fails, continue to full review attempt
          // Full review stage will handle status update
        }
      }
      
      // ========================================
      // STAGE 2: Full Review (FULL engine) - DISABLED
      // ========================================
      // Full review generation is disabled - using quick review only
      // Quick review is sufficient and provides good analysis quality
      console.log(`[GameCompletionHook] Stage 2: Skipped (full review disabled - using quick review only)`);
      
    } catch (error) {
      // ✅ CRITICAL: Top-level error handler - ensures review status is ALWAYS updated
      console.error(`[GameCompletionHook] ❌ CRITICAL: Error in review generation process for game ${gameId}:`, error);
      console.error(`[GameCompletionHook] Stack:`, error.stack);
      
      // ✅ CRITICAL: ALWAYS mark as failed to ensure review never stays in "pending"
      try {
        await markReviewFailed(gameId, error.message || "Unknown error during review generation");
        console.log(`[GameCompletionHook] ✅ Review marked as failed due to top-level error for game ${gameId}`);
      } catch (markError) {
        console.error(`[GameCompletionHook] ❌ CRITICAL: Failed to mark review as failed in top-level handler:`, markError.message);
        // At this point, we've done everything we can - log and continue
      }
      // Don't throw - this is async and should not affect game completion
    }
  });
}

module.exports = {
  triggerReviewGeneration,
};

