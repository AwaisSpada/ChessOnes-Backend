/**
 * Review Storage Service
 * 
 * Handles storing and retrieving game reviews.
 * Reviews are immutable once generated.
 */

const Review = require("../../models/Review");
const Game = require("../../models/Game");

/**
 * Store a generated review
 * 
 * SAFEGUARD: Review is generated ONCE per game and never recomputed.
 * Only allows overwrite if status is "pending" or "failed".
 * Completed reviews are immutable.
 * 
 * @param {string} gameId - Game ID
 * @param {Object} reviewData - Complete review data
 * @param {Object} engineConfig - Engine configuration used (MUST be FULL engine)
 * @returns {Promise<Review>} - Saved review document
 */
async function storeReview(gameId, reviewData, engineConfig = { depth: 18, movetime: 2000 }) {
  try {
    // ✅ SAFEGUARD: reviewData must always be present
    if (!reviewData || reviewData === null) {
      throw new Error("reviewData is required and cannot be null");
    }
    
    // Determine engine type (default to FULL if not specified)
    const engineType = engineConfig.engineType || "FULL";
    const isFullEngine = engineType === "FULL";
    const isLiteEngine = engineType === "LITE";
    
    // ✅ SAFEGUARD: Check if review already exists and is completed (FULL engine only)
    const existingReview = await Review.findOne({ gameId });
    if (existingReview && existingReview.status === "completed" && isFullEngine) {
      // FULL engine review already exists and is complete - NEVER overwrite (immutability safeguard)
      console.log(`[ReviewStorage] ⚠️ SAFEGUARD: Full review already exists and is completed for game ${gameId}. Cannot overwrite.`);
      throw new Error(`Review already exists and is completed. Cannot overwrite immutable review.`);
    }
    
    // If review exists, check transition rules
    if (existingReview) {
      const existingEngineType = existingReview.engineConfig?.engineType || "FULL";
      
      // FULL engine can always overwrite LITE engine reviews
      if (isFullEngine && existingEngineType === "LITE") {
        console.log(`[ReviewStorage] ✅ Full review overwriting LITE review for game ${gameId}`);
        existingReview.reviewData = reviewData;
        existingReview.engineConfig = { ...engineConfig, engineType: "FULL" };
        existingReview.status = "completed";
        existingReview.error = null;
        existingReview.generatedAt = new Date();
        await existingReview.save();
        console.log(`[ReviewStorage] ✅ Review updated from LITE to FULL (completed) for game ${gameId}`);
        return existingReview;
      }
      
      // If review is pending or failed, update it
      if (existingReview.status === "pending" || existingReview.status === "failed") {
        existingReview.reviewData = reviewData;
        existingReview.engineConfig = { ...engineConfig, engineType: engineType };
        // Both LITE and FULL reviews are marked as "completed" when they have reviewData
        // This allows frontend to display them immediately
        existingReview.status = "completed";
        existingReview.error = null;
        existingReview.generatedAt = new Date(); // Set generatedAt for both LITE and FULL
        await existingReview.save();
        console.log(`[ReviewStorage] ✅ Review updated to completed for game ${gameId} (${engineType})`);
        return existingReview;
      }
      
      // If existing is completed FULL and we're trying to store LITE, skip (don't overwrite)
      if (existingReview.status === "completed" && existingEngineType === "FULL" && isLiteEngine) {
        console.log(`[ReviewStorage] ⚠️ Skipping LITE review - FULL review already exists for game ${gameId}`);
        return existingReview;
      }
    }

    // Get game document for reference
    const game = await Game.findOne({ gameId });
    if (!game) {
      throw new Error(`Game not found: ${gameId}`);
    }

    // Create new review
    // Both LITE and FULL reviews are marked as "completed" when they have reviewData
    // This allows frontend to display them immediately
    const review = new Review({
      gameId,
      game: game._id,
      reviewData, // ✅ SAFEGUARD: Always present, validated above
      engineConfig: {
        ...engineConfig,
        engineType: engineType,
      },
      status: "completed", // Both LITE and FULL are completed when they have data
      generatedAt: new Date(), // Set for both LITE and FULL
    });

    await review.save();
    console.log(`[ReviewStorage] ✅ Review stored for game ${gameId} (${engineType} engine, status: completed)`);
    return review;
  } catch (error) {
    // If error is our safeguard (review already exists), re-throw it
    if (error.message && error.message.includes("already exists and is completed")) {
      throw error;
    }
    console.error(`[ReviewStorage] Error storing review for game ${gameId}:`, error);
    throw error;
  }
}

/**
 * Get stored review by gameId
 * @param {string} gameId - Game ID
 * @returns {Promise<Review|null>} - Review document or null if not found
 */
async function getReview(gameId) {
  try {
    const review = await Review.findOne({ gameId }).populate("game");
    return review;
  } catch (error) {
    console.error(`[ReviewStorage] Error getting review for game ${gameId}:`, error);
    throw error;
  }
}

/**
 * Mark review as pending (when generation starts)
 * Uses findOneAndUpdate with upsert to prevent duplicate key errors in race conditions
 * @param {string} gameId - Game ID
 * @returns {Promise<Review>} - Review document
 */
async function markReviewPending(gameId) {
  try {
    // First check if review exists
    let review = await Review.findOne({ gameId });
    
    if (review) {
      // Review exists - update status to pending if not already
      if (review.status !== "pending") {
        review.status = "pending";
        review.error = null;
        await review.save();
      }
      return review;
    }
    
    // Review doesn't exist - create it
    const game = await Game.findOne({ gameId });
    if (!game) {
      throw new Error(`Game not found: ${gameId}`);
    }
    
    // Use findOneAndUpdate with upsert to atomically create - prevents duplicate key errors
    review = await Review.findOneAndUpdate(
      { gameId },
      {
        $setOnInsert: {
          gameId,
          game: game._id,
          status: "pending",
          reviewData: null,
          error: null,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );
    
    return review;
  } catch (error) {
    // If duplicate key error, another process created it - fetch existing review
    if (error.code === 11000 || error.message?.includes("duplicate key") || error.message?.includes("conflict")) {
      console.log(`[ReviewStorage] Duplicate key/conflict detected for game ${gameId}, fetching existing review`);
      const existingReview = await Review.findOne({ gameId });
      if (existingReview) {
        // Update status to pending if not already
        if (existingReview.status !== "pending") {
          existingReview.status = "pending";
          existingReview.error = null;
          await existingReview.save();
        }
        return existingReview;
      }
    }
    console.error(`[ReviewStorage] Error marking review as pending for game ${gameId}:`, error);
    throw error;
  }
}

/**
 * Mark review as failed
 * @param {string} gameId - Game ID
 * @param {string} errorMessage - Error message
 * @returns {Promise<Review>} - Review document
 */
async function markReviewFailed(gameId, errorMessage) {
  try {
    let review = await Review.findOne({ gameId });
    
    if (!review) {
      const game = await Game.findOne({ gameId });
      if (!game) {
        throw new Error(`Game not found: ${gameId}`);
      }
      
      review = new Review({
        gameId,
        game: game._id,
        status: "failed",
        error: errorMessage,
        // reviewData is optional, will be null by default
      });
    } else {
      review.status = "failed";
      review.error = errorMessage;
    }
    
    await review.save();
    return review;
  } catch (error) {
    console.error(`[ReviewStorage] Error marking review as failed for game ${gameId}:`, error);
    throw error;
  }
}

/**
 * Check if review exists and is completed
 * @param {string} gameId - Game ID
 * @returns {Promise<boolean>} - True if review exists and is completed
 */
async function hasCompletedReview(gameId) {
  try {
    const review = await Review.findOne({ gameId, status: "completed" });
    return !!review;
  } catch (error) {
    console.error(`[ReviewStorage] Error checking review for game ${gameId}:`, error);
    return false;
  }
}

/**
 * Check if review exists (any status: pending, completed, or failed)
 * @param {string} gameId - Game ID
 * @returns {Promise<boolean>} - True if review exists in any state
 */
async function hasReview(gameId) {
  try {
    const review = await Review.findOne({ gameId });
    return !!review;
  } catch (error) {
    console.error(`[ReviewStorage] Error checking if review exists for game ${gameId}:`, error);
    return false;
  }
}

module.exports = {
  storeReview,
  getReview,
  markReviewPending,
  markReviewFailed,
  hasCompletedReview,
  hasReview,
};

