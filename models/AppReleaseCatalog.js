const mongoose = require("mongoose");

/**
 * Persistent release history per platform (Option A).
 * Populated primarily by successful manual store sync (source STORE_SYNC).
 * Technical bootstrap baselines must use source BOOTSTRAP — never STORE_SYNC.
 */
const appReleaseCatalogSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: ["ANDROID", "IOS"],
      uppercase: true,
      trim: true,
    },
    version: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },
    buildNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "buildNumber must be an integer",
      },
    },
    firstDetectedAt: {
      type: Date,
      required: true,
    },
    lastSeenAt: {
      type: Date,
      required: true,
    },
    source: {
      type: String,
      required: true,
      enum: ["STORE_SYNC", "ASC_BACKFILL", "PLAY_SEED", "MANUAL", "BOOTSTRAP"],
      uppercase: true,
      trim: true,
    },
    currentlyLive: {
      type: Boolean,
      default: false,
      index: true,
    },
    storeReleaseStatus: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

appReleaseCatalogSchema.index({ platform: 1, buildNumber: 1 }, { unique: true });
appReleaseCatalogSchema.index({ platform: 1, currentlyLive: 1 });

module.exports = mongoose.model("AppReleaseCatalog", appReleaseCatalogSchema);
