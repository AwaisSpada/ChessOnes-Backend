/**
 * Phase A2 verification on chessonesTest only.
 * Seeds temporary SUCCESS / bootstrap scenarios, runs migration twice, restores.
 *
 * Usage: node scripts/test-option-a-phase-a2-migration.js
 */
require("dotenv").config();
const assert = require("assert");
const mongoose = require("mongoose");
const AppVersionPolicy = require("../models/AppVersionPolicy");
const AppReleaseCatalog = require("../models/AppReleaseCatalog");
const {
  migrateAppReleaseCatalogFromPolicies,
  BOOTSTRAP_VERSION,
  BOOTSTRAP_BUILD,
} = require("../services/storeSync/migrateAppReleaseCatalog");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessonesTest";

const TEST_IOS_BUILD = 930014;
const TEST_ANDROID_BUILD = 1;

const dbNameFromUri = (uri) => {
  const path = String(uri).split("?")[0];
  return path.split("/").pop() || "";
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

async function main() {
  assert.strictEqual(
    dbNameFromUri(MONGODB_URI),
    "chessonesTest",
    "Refusing: DB must be chessonesTest"
  );

  console.log("Connecting:", MONGODB_URI.replace(/:[^:@]+@/, ":***@"));
  await mongoose.connect(MONGODB_URI);

  const iosSnap = await snapshotPolicy("IOS");
  const androidSnap = await snapshotPolicy("ANDROID");
  const catalogSnap = await AppReleaseCatalog.find({}).lean();

  try {
    // Clean test builds; keep unrelated catalog rows for "remain intact" check below.
    await AppReleaseCatalog.deleteMany({
      $or: [
        { platform: "IOS", buildNumber: TEST_IOS_BUILD },
        { platform: "IOS", buildNumber: BOOTSTRAP_BUILD, source: "BOOTSTRAP" },
        {
          platform: "ANDROID",
          buildNumber: BOOTSTRAP_BUILD,
          source: "BOOTSTRAP",
        },
      ],
    });

    // Pre-existing unrelated catalog row must survive.
    const sentinel = await AppReleaseCatalog.findOneAndUpdate(
      { platform: "IOS", buildNumber: 939999 },
      {
        $setOnInsert: {
          platform: "IOS",
          version: "9.9.9",
          buildNumber: 939999,
          firstDetectedAt: new Date("2024-01-01T00:00:00.000Z"),
          lastSeenAt: new Date("2024-01-01T00:00:00.000Z"),
          source: "MANUAL",
          currentlyLive: false,
        },
      },
      { upsert: true, new: true }
    ).lean();
    const sentinelFirst = new Date(sentinel.firstDetectedAt).getTime();

    // iOS: successful store sync tip (trustworthy STORE_SYNC backfill).
    const syncedAt = new Date("2025-06-15T12:00:00.000Z");
    await AppVersionPolicy.findOneAndUpdate(
      { platform: "IOS" },
      {
        $set: {
          platform: "IOS",
          latestVersion: "2.3",
          latestBuildNumber: TEST_IOS_BUILD,
          minimumSupportedVersion: "2.0",
          minimumSupportedBuildNumber: 10,
          updatePolicy: "OPTIONAL",
          isActive: true,
          storeSync: {
            lastSyncedAt: syncedAt,
            lastSyncAttemptedAt: syncedAt,
            lastSyncStatus: "SUCCESS",
            lastSyncError: null,
            lastSyncedStoreVersion: "2.3",
            lastSyncedStoreBuild: TEST_IOS_BUILD,
            releaseStatus: "READY_FOR_DISTRIBUTION",
            storeAvailability: "PRODUCTION",
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );

    // Android: technical baseline only — must become BOOTSTRAP, never STORE_SYNC.
    await AppVersionPolicy.findOneAndUpdate(
      { platform: "ANDROID" },
      {
        $set: {
          platform: "ANDROID",
          latestVersion: BOOTSTRAP_VERSION,
          latestBuildNumber: BOOTSTRAP_BUILD,
          minimumSupportedVersion: BOOTSTRAP_VERSION,
          minimumSupportedBuildNumber: BOOTSTRAP_BUILD,
          updatePolicy: "MANDATORY",
          isActive: true,
          storeSync: {
            lastSyncedAt: null,
            lastSyncAttemptedAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
            lastSyncedStoreVersion: null,
            lastSyncedStoreBuild: null,
            releaseStatus: null,
            storeAvailability: null,
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );

    const iosBefore = await AppVersionPolicy.findOne({ platform: "IOS" }).lean();
    const androidBefore = await AppVersionPolicy.findOne({
      platform: "ANDROID",
    }).lean();

    const run1 = await migrateAppReleaseCatalogFromPolicies();
    assert.strictEqual(run1.success, true);
    assert.strictEqual(run1.historicalRecovery.appleAscApiCalls, false);
    assert.strictEqual(run1.historicalRecovery.googlePlayApiCalls, false);

    const iosCat = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD,
    }).lean();
    assert.ok(iosCat, "iOS SUCCESS tip must be catalogued");
    assert.strictEqual(iosCat.source, "STORE_SYNC");
    assert.strictEqual(iosCat.version, "2.3");
    assert.strictEqual(iosCat.currentlyLive, true);
    assert.strictEqual(
      new Date(iosCat.firstDetectedAt).toISOString(),
      syncedAt.toISOString()
    );
    assert.strictEqual(
      new Date(iosCat.lastSeenAt).toISOString(),
      syncedAt.toISOString()
    );

    const androidCat = await AppReleaseCatalog.findOne({
      platform: "ANDROID",
      buildNumber: BOOTSTRAP_BUILD,
    }).lean();
    assert.ok(androidCat, "Android baseline should be preserved as BOOTSTRAP");
    assert.strictEqual(androidCat.source, "BOOTSTRAP");
    assert.strictEqual(androidCat.version, BOOTSTRAP_VERSION);
    assert.strictEqual(androidCat.currentlyLive, false);

    // Baseline must not appear as STORE_SYNC.
    const fakeStore = await AppReleaseCatalog.findOne({
      platform: "ANDROID",
      buildNumber: BOOTSTRAP_BUILD,
      source: "STORE_SYNC",
    }).lean();
    assert.strictEqual(fakeStore, null);

    // Sentinel intact.
    const sentinelAfter = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: 939999,
    }).lean();
    assert.ok(sentinelAfter);
    assert.strictEqual(new Date(sentinelAfter.firstDetectedAt).getTime(), sentinelFirst);
    assert.strictEqual(sentinelAfter.source, "MANUAL");

    // Idempotent second run.
    const run2 = await migrateAppReleaseCatalogFromPolicies();
    assert.strictEqual(run2.success, true);
    const iosPlat2 = run2.platforms.find((p) => p.platform === "IOS");
    const androidPlat2 = run2.platforms.find((p) => p.platform === "ANDROID");
    assert.strictEqual(iosPlat2.inserted, 0);
    assert.strictEqual(androidPlat2.inserted, 0);

    const iosCat2 = await AppReleaseCatalog.findOne({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD,
    }).lean();
    assert.strictEqual(
      new Date(iosCat2.firstDetectedAt).toISOString(),
      syncedAt.toISOString()
    );
    assert.strictEqual(
      new Date(iosCat2.lastSeenAt).toISOString(),
      syncedAt.toISOString()
    );

    const iosCount = await AppReleaseCatalog.countDocuments({
      platform: "IOS",
      buildNumber: TEST_IOS_BUILD,
    });
    assert.strictEqual(iosCount, 1);

    // Policies completely unchanged (including storeSync / minimum / policy).
    const iosAfter = await AppVersionPolicy.findOne({ platform: "IOS" }).lean();
    const androidAfter = await AppVersionPolicy.findOne({
      platform: "ANDROID",
    }).lean();

    assert.strictEqual(iosAfter.minimumSupportedVersion, "2.0");
    assert.strictEqual(iosAfter.minimumSupportedBuildNumber, 10);
    assert.strictEqual(iosAfter.updatePolicy, "OPTIONAL");
    assert.strictEqual(iosAfter.latestBuildNumber, TEST_IOS_BUILD);
    assert.strictEqual(iosAfter.storeSync.lastSyncStatus, "SUCCESS");
    assert.strictEqual(
      iosAfter.storeSync.lastSyncedStoreBuild,
      iosBefore.storeSync.lastSyncedStoreBuild
    );

    assert.strictEqual(androidAfter.minimumSupportedBuildNumber, BOOTSTRAP_BUILD);
    assert.strictEqual(androidAfter.updatePolicy, "MANDATORY");
    assert.strictEqual(androidAfter.latestVersion, BOOTSTRAP_VERSION);
    assert.strictEqual(androidAfter.storeSync.lastSyncStatus, null);

    // Deep compare critical policy fields vs pre-migration snapshot.
    for (const key of [
      "latestVersion",
      "latestBuildNumber",
      "minimumSupportedVersion",
      "minimumSupportedBuildNumber",
      "updatePolicy",
    ]) {
      assert.strictEqual(iosAfter[key], iosBefore[key], `IOS.${key}`);
      assert.strictEqual(androidAfter[key], androidBefore[key], `ANDROID.${key}`);
    }

    console.log("\nAll Phase A2 checks passed.");
  } finally {
    await AppReleaseCatalog.deleteMany({
      $or: [
        { platform: "IOS", buildNumber: TEST_IOS_BUILD },
        { platform: "IOS", buildNumber: 939999 },
        { platform: "IOS", buildNumber: BOOTSTRAP_BUILD, source: "BOOTSTRAP" },
        {
          platform: "ANDROID",
          buildNumber: BOOTSTRAP_BUILD,
          source: "BOOTSTRAP",
        },
      ],
    });

    // Restore prior catalog snapshot (best-effort for non-test rows).
    if (catalogSnap.length) {
      for (const row of catalogSnap) {
        const { _id, __v, ...rest } = row;
        await AppReleaseCatalog.updateOne(
          { platform: rest.platform, buildNumber: rest.buildNumber },
          { $setOnInsert: rest },
          { upsert: true }
        );
      }
    }

    await restorePolicy("IOS", iosSnap);
    await restorePolicy("ANDROID", androidSnap);
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error("Phase A2 test failed:", err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
