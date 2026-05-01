const mongoose = require("mongoose");

/**
 * Review Model - Stores immutable game review data
 * 
 * This model stores the complete analysis of a finished game.
 * Once created, reviews should not be modified (immutable).
 * One review per completed game.
 */
const reviewSchema = new mongoose.Schema(
  {
    gameId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Reference to the game (read-only reference)
    game: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Game",
      required: true,
      index: true,
    },
    // Complete review data (immutable JSON)
    // Optional - can be null during "pending" or "failed" states
    // Required when status is "completed" (validated in pre-save hook)
    reviewData: {
      type: mongoose.Schema.Types.Mixed,
      required: false, // Allow null for pending/failed states
      default: null,
      validate: {
        validator: function(value) {
          // If status is completed, reviewData must be present
          if (this.status === "completed") {
            return value !== null && value !== undefined;
          }
          // For pending/failed, reviewData can be null
          return true;
        },
        message: "reviewData is required when status is 'completed'"
      }
    },
    // Metadata
    generatedAt: {
      type: Date,
      default: Date.now,
      required: false, // Only set when review is completed
    },
    // Engine configuration used for this review
    engineConfig: {
      depth: {
        type: Number,
        default: 18,
      },
      movetime: {
        type: Number,
        default: 2000,
      },
      engineType: {
        type: String,
        enum: ["FULL", "LITE"], // Allow both FULL and LITE engines
        default: "FULL",
      },
    },
    // Status tracking
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    error: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent updates after creation (immutability)
reviewSchema.pre("save", async function (next) {
  if (this.isNew) {
    // New review - allow save (can be pending/failed without reviewData)
    return next();
  }
  
  // Get the original document to check what changed
  const Review = this.constructor;
  const originalDoc = await Review.findById(this._id);
  if (!originalDoc) {
    // Document doesn't exist yet, allow save
    return next();
  }

  // Regeneration: tear down a completed review so POST/background can run again (clear stale/corrupt payload).
  if (
    originalDoc.status === "completed" &&
    this.status === "pending" &&
    (this.reviewData === null || this.reviewData === undefined)
  ) {
    return next();
  }

  // Allow transition from pending/failed to completed (reviewData is being set for the first time)
  // This happens when: original status is "pending" or "failed", and we're setting reviewData and status to "completed"
  if ((originalDoc.status === "pending" || originalDoc.status === "failed") && 
      this.status === "completed" && 
      this.reviewData !== null && 
      (!originalDoc.reviewData || originalDoc.reviewData === null)) {
    // This is the normal transition from pending/failed to completed - allow it
    return next();
  }
  
  // If review is already completed and has reviewData, prevent changes to reviewData and other fields
  if (originalDoc.status === "completed" && originalDoc.reviewData) {
    // Check if reviewData is being modified
    if (this.isModified("reviewData") && this.reviewData !== null) {
      // Block changes to reviewData for completed reviews
      return next(new Error("Completed review data is immutable. Only status and error fields can be updated."));
    }
    
    // For completed reviews, only allow status/error updates
    const allowedUpdates = ["status", "error"];
    const modifiedPaths = this.modifiedPaths ? this.modifiedPaths() : [];
    const hasDisallowedChanges = modifiedPaths.some(
      (path) => !allowedUpdates.includes(path) && path !== "updatedAt"
    );
    
    if (hasDisallowedChanges) {
      return next(new Error("Completed review data is immutable. Only status and error fields can be updated."));
    }
  }
  
  next();
});

// Index for faster lookups
reviewSchema.index({ gameId: 1 });
reviewSchema.index({ game: 1 });
reviewSchema.index({ status: 1 });

module.exports = mongoose.model("Review", reviewSchema);

