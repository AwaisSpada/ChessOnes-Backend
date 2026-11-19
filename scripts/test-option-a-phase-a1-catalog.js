/**
 * Phase A1 verification — AppReleaseCatalog + sync latest-only promotion.
 * Isolated QA DB only (chessonesTest). Restores policy snapshots and deletes
 * test catalog builds afterward.
 *
 * Usage: node scripts/test-option-a-phase-a1-catalog.js
 */
require("dotenv").config();
const assert = require("assert");
const mongoose = require("mongoose");
const AppVersionPolicy = require("../models/AppVersionPolicy");
const AppReleaseCatalog = require("../models/AppReleaseCatalog");
const {
  applySyncResult,
} = require("../services/storeSync/syncAppVersionFromStores");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessonesTest";

const TEST_IOS_BUILD_A = 910001;
const TEST_IOS_BUILD_B = 910002;
const TEST_ANDROID_BUILD = 920001;
const TEST_BUILDS = [TEST_IOS_BUILD_A, TEST_IOS_BUILD_B, TEST_ANDROID_BUILD];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbNameFromUri = (uri) => {
  try {
    const path = String(uri).split("?")[0];
    const parts = path.split("/");
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
};

async function snapshotPolicy(platform) {
  return AppVersionPolicy.findOne({ platform }).lean();
}

async function restorePolicy(platform, snap) {
  if (!snap) {
    await AppVersionPolicy.deleteOne({ platform });
    return;
  }
  const { _id, __v, ...rest } = snap;
  await AppVersionPolicy.replaceOne({ platform }, rest, { upsert: true });
}

async function cleanupTestCatalog() {
  await AppReleaseCatalog.deleteMany({
    buildNumber: { $in: TEST_BUILDS },
  });
}

async function ensurePolicy(platform, fields) {
  await AppVersionPolicy.findOneAndUpdate(
    { platform },
    { $set: { platform, ...fields } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
}

async function main() {
  const dbName = dbNameFromUri(MONGODB_URI);
  assert.strictEqual(
    dbName,
    "chessonesTest",
    `Refusing to run: DB must be chessonesTest (got "${dbName}")`
  );

  console.log("Connecting:", MONGODB_URI.replace(/:[^:@]+@/, ":***@"));
  await mongoose.connect(MONGODB_URI);

  const iosSnap = await snapshotPolicy("IOS");
  const androidSnap = await snapshotPolicy("ANDROID");

  let transactionalObserved = null;

  try {
    await cleanupTestCatalog();

    // Seed policies with distinct minimum + OPTIONAL / MANDATORY — sync must not touch them.
    await ensurePolicy("IOS", {
      latestVersion: "1.0.0",
      latestBuildNumber: 1,
      minimumSupportedVersion: "1.0.0",
      minimumSupportedBuildNumber: 1,
      updatePolicy: "OPTIONAL",
      updateTitle: "A1 iOS test",
      isActive: true,
      storeSync: {
        lastSyncStatus: null,
        lastSyncedStoreVersion: null,
        lastSyncedStoreBuild: null,
      },
    });
    await ensurePolicy("ANDROID", {
      latestVersion: "1.0.0",
      latestBuildNumber: 1,
      minimumSupportedVersion: "1.0.0",
      minimumSupportedBuildNumber: 1,
      updatePolicy: "MANDATORY",
      updateTitle: "A1 Android test",
      isActive: true,
      storeSync: {
        lastSyncStatus: null,
        lastSyncedStoreVersion: null,
        lastSyncedStoreBuild: null,
      },
    });

    // --- 1) First SUCCESS creates one catalog entry; updates latest only ---
    const first = await applySyncResult("IOS", {
      success: true,
      configured: true,
      version: "2.9.0",
      build: TEST_IOS_BUILD_A,
      releaseStatus: "READY_FOR_DISTRIBUTION",
      storeAvailability: "PRODUCTION",
    });
    assert.strictEqual(first.success, true);
    transactionalObserved = first.transactional;
    assert.strictEqual(first.latestVersion, "2.9.0");
    assert.strictEqual(first.latestBuildNumber, TEST_IOS_BUILD_A);
    assert.strictEqual(first.minimumSupportedVersion, "1.0.0");
    assert.strictEqual(first.minimumSupportedBuildNumber, 1);
    assert.strictEqual(first.updatePolicy, "OPTIONAL");
    assert.strictEqual(first.catalog?.source, "STORE_SYNC");
    assert.strictEqual(first.catalog?.currentlyLive, true);

    const iosCountAfterFirst = await AppReleaseCatalog.countDocuments({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD_A,
    });
    assert.strictEqual(iosCountAfterFirst, 1);

    const firstEntry = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD_A,
    }).lean();
    assert.ok(firstEntry);
    assert.strictEqual(firstEntry.source, "STORE_SYNC");
    const firstSeen = new Date(firstEntry.firstDetectedAt).getTime();
    const firstLast = new Date(firstEntry.lastSeenAt).getTime();

    await sleep(50);

    // --- 2) Repeated sync: no duplicate; lastSeenAt advances; firstDetectedAt stable ---
    const second = await applySyncResult("IOS", {
      success: true,
      configured: true,
      version: "2.9.0",
      build: TEST_IOS_BUILD_A,
      releaseStatus: "READY_FOR_DISTRIBUTION",
      storeAvailability: "PRODUCTION",
    });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.minimumSupportedBuildNumber, 1);
    assert.strictEqual(second.updatePolicy, "OPTIONAL");

    const iosCountAfterSecond = await AppReleaseCatalog.countDocuments({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD_A,
    });
    assert.strictEqual(iosCountAfterSecond, 1);

    const secondEntry = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD_A,
    }).lean();
    assert.strictEqual(
      new Date(secondEntry.firstDetectedAt).getTime(),
      firstSeen
    );
    assert.ok(new Date(secondEntry.lastSeenAt).getTime() >= firstLast);

    // --- 3) Newer release: new catalog row; old currentlyLive false; min unchanged ---
    const newer = await applySyncResult("IOS", {
      success: true,
      configured: true,
      version: "3.0.0",
      build: TEST_IOS_BUILD_B,
      releaseStatus: "READY_FOR_DISTRIBUTION",
      storeAvailability: "PRODUCTION",
    });
    assert.strictEqual(newer.success, true);
    assert.strictEqual(newer.latestBuildNumber, TEST_IOS_BUILD_B);
    assert.strictEqual(newer.minimumSupportedBuildNumber, 1);
    assert.strictEqual(newer.updatePolicy, "OPTIONAL");

    const oldLive = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD_A,
    }).lean();
    const newLive = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD_B,
    }).lean();
    assert.strictEqual(oldLive.currentlyLive, false);
    assert.strictEqual(newLive.currentlyLive, true);
    assert.strictEqual(newLive.source, "STORE_SYNC");

    // --- 4) Failed sync preserves catalog + policy fields ---
    const beforeFailPolicy = await AppVersionPolicy.findOne({
      platform: "IOS",
    }).lean();
    const beforeFailCatalogCount = await AppReleaseCatalog.countDocuments({
      platform: "IOS",
      buildNumber: { $in: [TEST_IOS_BUILD_A, TEST_IOS_BUILD_B] },
    });

    const failed = await applySyncResult("IOS", {
      success: false,
      configured: true,
      error: "Simulated store failure",
    });
    assert.strictEqual(failed.success, false);
    assert.strictEqual(failed.catalogUpserted, false);

    const afterFailPolicy = await AppVersionPolicy.findOne({
      platform: "IOS",
    }).lean();
    assert.strictEqual(afterFailPolicy.latestBuildNumber, TEST_IOS_BUILD_B);
    assert.strictEqual(afterFailPolicy.minimumSupportedBuildNumber, 1);
    assert.strictEqual(afterFailPolicy.updatePolicy, "OPTIONAL");
    assert.strictEqual(afterFailPolicy.storeSync.lastSyncStatus, "FAILED");
    assert.strictEqual(
      afterFailPolicy.storeSync.lastSyncedStoreBuild,
      beforeFailPolicy.storeSync.lastSyncedStoreBuild
    );

    const afterFailCatalogCount = await AppReleaseCatalog.countDocuments({
      platform: "IOS",
      buildNumber: { $in: [TEST_IOS_BUILD_A, TEST_IOS_BUILD_B] },
    });
    assert.strictEqual(afterFailCatalogCount, beforeFailCatalogCount);

    // --- 5) Platform independence: Android SUCCESS does not alter iOS ---
    const iosBeforeAndroid = await AppVersionPolicy.findOne({
      platform: "IOS",
    }).lean();
    const iosCatalogBefore = await AppReleaseCatalog.find({
      platform: "IOS",
      buildNumber: { $in: [TEST_IOS_BUILD_A, TEST_IOS_BUILD_B] },
    })
      .sort({ buildNumber: 1 })
      .lean();

    const androidSync = await applySyncResult("ANDROID", {
      success: true,
      configured: true,
      version: "4.1.0",
      build: TEST_ANDROID_BUILD,
      releaseStatus: "completed",
      storeAvailability: "PRODUCTION",
    });
    assert.strictEqual(androidSync.success, true);
    assert.strictEqual(androidSync.updatePolicy, "MANDATORY");
    assert.strictEqual(androidSync.minimumSupportedBuildNumber, 1);
    assert.strictEqual(androidSync.latestBuildNumber, TEST_ANDROID_BUILD);

    const iosAfterAndroid = await AppVersionPolicy.findOne({
      platform: "IOS",
    }).lean();
    assert.strictEqual(
      iosAfterAndroid.latestBuildNumber,
      iosBeforeAndroid.latestBuildNumber
    );
    assert.strictEqual(
      iosAfterAndroid.minimumSupportedBuildNumber,
      iosBeforeAndroid.minimumSupportedBuildNumber
    );
    assert.strictEqual(
      iosAfterAndroid.updatePolicy,
      iosBeforeAndroid.updatePolicy
    );

    const iosCatalogAfter = await AppReleaseCatalog.find({
      platform: "IOS",
      buildNumber: { $in: [TEST_IOS_BUILD_A, TEST_IOS_BUILD_B] },
    })
      .sort({ buildNumber: 1 })
      .lean();
    assert.strictEqual(iosCatalogAfter.length, iosCatalogBefore.length);
    assert.strictEqual(
      iosCatalogAfter[1].currentlyLive,
      iosCatalogBefore[1].currentlyLive
    );

    const androidOnly = await AppReleaseCatalog.countDocuments({
      platform: "ANDROID",
      buildNumber: TEST_ANDROID_BUILD,
    });
    assert.strictEqual(androidOnly, 1);

    // --- 6) Bootstrap must not be auto-classified as STORE_SYNC without store detection ---
    // Failed/unconfigured sync must not create a BOOTSTRAP or STORE_SYNC row for 1.0.0/1.
    await AppReleaseCatalog.deleteMany({
      platform: "IOS",
      buildNumber: 1,
      version: "1.0.0",
    });
    await applySyncResult("IOS", {
      success: false,
      configured: false,
      error: "not configured",
      missingEnv: ["APPLE_ASC_KEY_ID"],
    });
    const bootstrapAsStore = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: 1,
      source: "STORE_SYNC",
    }).lean();
    assert.strictEqual(
      bootstrapAsStore,
      null,
      "Failed sync must not invent STORE_SYNC catalog for bootstrap build"
    );

    // Explicit BOOTSTRAP insert (future/manual path) stays distinguishable.
    await AppReleaseCatalog.create({
      platform: "IOS",
      version: "1.0.0",
      buildNumber: 1,
      firstDetectedAt: new Date(),
      lastSeenAt: new Date(),
      source: "BOOTSTRAP",
      currentlyLive: false,
    });
    const bootstrapRow = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: 1,
    }).lean();
    assert.strictEqual(bootstrapRow.source, "BOOTSTRAP");
    await AppReleaseCatalog.deleteOne({ platform: "IOS", buildNumber: 1 });

    console.log("\nAll Phase A1 checks passed.");
    console.log(
      "Transactional writes:",
      transactionalObserved === true
        ? "yes (MongoDB transaction committed)"
        : transactionalObserved === false
          ? "no — fell back to sequential writes (report as consistency limitation)"
          : "unknown"
    );
  } finally {
    await cleanupTestCatalog();
    await AppReleaseCatalog.deleteMany({
      platform: "IOS",
      buildNumber: 1,
      source: "BOOTSTRAP",
    });
    await restorePolicy("IOS", iosSnap);
    await restorePolicy("ANDROID", androidSnap);
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error("Phase A1 test failed:", err);
  try {
    await cleanupTestCatalog();
    await mongoose.disconnect();
  } catch {
    // ignore cleanup errors
  }
  process.exit(1);
});
