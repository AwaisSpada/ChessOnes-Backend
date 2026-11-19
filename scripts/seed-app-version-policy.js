/**
 * Dev helper: upsert ANDROID + IOS app version policies for local testing.
 * Usage: node scripts/seed-app-version-policy.js
 * Not used by production deploy — Phase 1 admin UI will manage policies.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const AppVersionPolicy = require("../models/AppVersionPolicy");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";

async function upsert(platform, patch) {
  const doc = await AppVersionPolicy.findOneAndUpdate(
    { platform },
    { $set: { platform, ...patch, isActive: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  console.log(`Upserted ${platform}:`, {
    latestVersion: doc.latestVersion,
    latestBuildNumber: doc.latestBuildNumber,
    minimumSupportedBuildNumber: doc.minimumSupportedBuildNumber,
    updatePolicy: doc.updatePolicy,
  });
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  await upsert("ANDROID", {
    latestVersion: "1.0.6",
    latestBuildNumber: 7,
    minimumSupportedVersion: "1.0.0",
    minimumSupportedBuildNumber: 1,
    updatePolicy: "OPTIONAL",
    updateTitle: "Update available",
    updateMessage: "A newer ChessOnes build is available on Google Play.",
    storeUrl: "https://play.google.com/store/apps/details?id=com.chessones.mobile",
  });
  await upsert("IOS", {
    latestVersion: "2.3",
    latestBuildNumber: 14,
    minimumSupportedVersion: "2.0",
    minimumSupportedBuildNumber: 1,
    updatePolicy: "OPTIONAL",
    updateTitle: "Update available",
    updateMessage: "A newer ChessOnes build is available on the App Store.",
    storeUrl: "https://apps.apple.com/app/id0000000000",
  });
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
