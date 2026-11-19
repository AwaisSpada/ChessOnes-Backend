const mongoose = require("mongoose");

/**
 * One document per mobile platform (ANDROID / IOS).
 * Build numbers are the primary comparison keys for update enforcement.
 *
 * Separation (Option A):
 *   - latest*        : automatic from successful store sync
 *   - minimum*       : admin-selected (never auto-changed by store sync)
 *   - updatePolicy   : admin-selected (never auto-changed by store sync)
 *   - storeSync      : detection metadata from manual admin refresh
 *
 * Release history lives in AppReleaseCatalog (not embedded here).
 */
const appVersionPolicySchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: ["ANDROID", "IOS"],
      uppercase: true,
      trim: true,
    },
    latestVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },
    latestBuildNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "latestBuildNumber must be an integer",
      },
    },
    minimumSupportedVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },
    minimumSupportedBuildNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "minimumSupportedBuildNumber must be an integer",
      },
    },
    updatePolicy: {
      type: String,
      required: true,
      enum: ["OPTIONAL", "MANDATORY"],
      uppercase: true,
      default: "OPTIONAL",
    },
    updateTitle: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "Update available",
    },
    updateMessage: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "A new version of ChessOnes is available. Please update for the best experience.",
    },
    storeUrl: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    /**
     * Manual store synchronization metadata (Phase 3A).
     * Never written by the public API. Failed syncs must not clear successful version/build.
     */
    storeSync: {
      /** Last successful sync time (unchanged on failure). */
      lastSyncedAt: { type: Date, default: null },
      /** Last attempt time (success or failure). */
      lastSyncAttemptedAt: { type: Date, default: null },
      /** SUCCESS | FAILED | NOT_CONFIGURED | null */
      lastSyncStatus: {
        type: String,
        trim: true,
        uppercase: true,
        enum: ["SUCCESS", "FAILED", "NOT_CONFIGURED", null],
        default: null,
      },
      /** Safe admin-facing error message (no credentials / raw secrets). */
      lastSyncError: { type: String, trim: true, maxlength: 1000, default: null },
      /** Live store marketing version from last SUCCESS. */
      lastSyncedStoreVersion: { type: String, trim: true, default: null },
      /** Live store build / versionCode from last SUCCESS. */
      lastSyncedStoreBuild: { type: Number, default: null },
      /** e.g. READY_FOR_DISTRIBUTION / completed */
      releaseStatus: { type: String, trim: true, default: null },
      /** e.g. PRODUCTION */
      storeAvailability: { type: String, trim: true, default: null },
    },
  },
  {
    timestamps: true,
  }
);

appVersionPolicySchema.index({ platform: 1 }, { unique: true });

appVersionPolicySchema.pre("validate", function preValidate(next) {
  if (
    typeof this.minimumSupportedBuildNumber === "number" &&
    typeof this.latestBuildNumber === "number" &&
    this.minimumSupportedBuildNumber > this.latestBuildNumber
  ) {
    this.invalidate(
      "minimumSupportedBuildNumber",
      "minimumSupportedBuildNumber cannot exceed latestBuildNumber"
    );
  }
  next();
});

module.exports = mongoose.model("AppVersionPolicy", appVersionPolicySchema);
