const mongoose = require("mongoose");

/**
 * One document per mobile platform (ANDROID / IOS).
 * Build numbers are the primary comparison keys for update enforcement.
 * Store-sync metadata fields are reserved for a later phase (auto Play/App Store sync).
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
    /** Reserved for future automatic store synchronization (Phase 5+). */
    storeSync: {
      lastSyncedAt: { type: Date, default: null },
      lastSyncedStoreVersion: { type: String, trim: true, default: null },
      lastSyncedStoreBuild: { type: Number, default: null },
      releaseStatus: { type: String, trim: true, default: null },
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
