/**
 * Phase A2 — idempotent AppReleaseCatalog backfill from existing AppVersionPolicy data.
 *
 * Trust rules:
 *   - STORE_SYNC only when storeSync.lastSyncStatus === SUCCESS with valid
 *     lastSyncedStoreVersion + lastSyncedStoreBuild.
 *   - Technical baseline 1.0.0 / build 1 without successful store sync may be
 *     preserved as source BOOTSTRAP (never STORE_SYNC).
 *   - Never fabricates other historical releases.
 *   - Never modifies AppVersionPolicy (minimum*, updatePolicy, storeSync, latest*).
 *   - Never downgrades existing catalog source; never rewrites firstDetectedAt /
 *     lastSeenAt on re-runs.
 */

const AppVersionPolicy = require("../../models/AppVersionPolicy");
const AppReleaseCatalog = require("../../models/AppReleaseCatalog");

const BOOTSTRAP_VERSION = "1.0.0";
const BOOTSTRAP_BUILD = 1;

const SOURCE_RANK = Object.freeze({
  BOOTSTRAP: 1,
  MANUAL: 2,
  PLAY_SEED: 3,
  ASC_BACKFILL: 3,
  STORE_SYNC: 4,
});

const PLATFORMS = ["ANDROID", "IOS"];

const asPositiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

const isSuccessfulStoreSync = (storeSync) => {
  const s = storeSync || {};
  const status = String(s.lastSyncStatus || "")
    .trim()
    .toUpperCase();
  if (status !== "SUCCESS") return false;
  const version = String(s.lastSyncedStoreVersion || "").trim();
  const build = asPositiveInt(s.lastSyncedStoreBuild);
  return Boolean(version) && build != null;
};

const isTechnicalBaselinePolicy = (policy) => {
  if (!policy) return false;
  if (isSuccessfulStoreSync(policy.storeSync)) return false;
  const latestVersion = String(policy.latestVersion || "").trim();
  const latestBuild = asPositiveInt(policy.latestBuildNumber);
  return latestVersion === BOOTSTRAP_VERSION && latestBuild === BOOTSTRAP_BUILD;
};

/**
 * Insert or lightly upgrade a catalog row without clobbering detection timestamps
 * or downgrading source.
 */
const upsertCatalogPreserve = async ({
  platform,
  version,
  buildNumber,
  source,
  currentlyLive,
  storeReleaseStatus,
  detectedAt,
}) => {
  const existing = await AppReleaseCatalog.findOne({ platform, buildNumber });

  if (!existing) {
    const created = await AppReleaseCatalog.create({
      platform,
      version: String(version).trim(),
      buildNumber,
      firstDetectedAt: detectedAt,
      lastSeenAt: detectedAt,
      source,
      currentlyLive: Boolean(currentlyLive),
      storeReleaseStatus: storeReleaseStatus || null,
    });
    return { action: "inserted", entry: created.toObject() };
  }

  const $set = {};
  const existingRank = SOURCE_RANK[existing.source] || 0;
  const desiredRank = SOURCE_RANK[source] || 0;

  // Upgrade source only (never downgrade).
  if (desiredRank > existingRank) {
    $set.source = source;
  }

  // Fill missing storeReleaseStatus; never clear an existing value.
  if (
    storeReleaseStatus &&
    !existing.storeReleaseStatus
  ) {
    $set.storeReleaseStatus = storeReleaseStatus;
  }

  // Refresh marketing version string only when empty (should not happen).
  if (!String(existing.version || "").trim() && version) {
    $set.version = String(version).trim();
  }

  // Promote currentlyLive when migration asserts this tip is live from SUCCESS.
  // Never force currentlyLive false on an existing live row from a weaker source path.
  if (currentlyLive === true && existing.currentlyLive !== true) {
    $set.currentlyLive = true;
  }

  if (Object.keys($set).length === 0) {
    return { action: "unchanged", entry: existing.toObject() };
  }

  const updated = await AppReleaseCatalog.findOneAndUpdate(
    { _id: existing._id },
    { $set },
    { new: true, runValidators: true }
  ).lean();

  return { action: "upgraded", entry: updated };
};

const clearOtherCurrentlyLive = async (platform, keepBuildNumber) => {
  await AppReleaseCatalog.updateMany(
    {
      platform,
      currentlyLive: true,
      buildNumber: { $ne: keepBuildNumber },
    },
    { $set: { currentlyLive: false } }
  );
};

const migratePlatformPolicy = async (policy) => {
  const platform = policy.platform;
  const result = {
    platform,
    inserted: 0,
    upgraded: 0,
    unchanged: 0,
    skippedReason: null,
    actions: [],
  };

  if (isSuccessfulStoreSync(policy.storeSync)) {
    const version = String(policy.storeSync.lastSyncedStoreVersion).trim();
    const buildNumber = asPositiveInt(policy.storeSync.lastSyncedStoreBuild);
    const detectedAt =
      policy.storeSync.lastSyncedAt != null
        ? new Date(policy.storeSync.lastSyncedAt)
        : policy.updatedAt
          ? new Date(policy.updatedAt)
          : new Date();

    const upsert = await upsertCatalogPreserve({
      platform,
      version,
      buildNumber,
      source: "STORE_SYNC",
      currentlyLive: true,
      storeReleaseStatus: policy.storeSync.releaseStatus || null,
      detectedAt,
    });

    if (upsert.action === "inserted") result.inserted += 1;
    else if (upsert.action === "upgraded") result.upgraded += 1;
    else result.unchanged += 1;
    result.actions.push({
      kind: "STORE_SYNC",
      buildNumber,
      version,
      action: upsert.action,
    });

    await clearOtherCurrentlyLive(platform, buildNumber);
    return result;
  }

  if (isTechnicalBaselinePolicy(policy)) {
    const detectedAt = policy.createdAt
      ? new Date(policy.createdAt)
      : policy.updatedAt
        ? new Date(policy.updatedAt)
        : new Date();

    const upsert = await upsertCatalogPreserve({
      platform,
      version: BOOTSTRAP_VERSION,
      buildNumber: BOOTSTRAP_BUILD,
      source: "BOOTSTRAP",
      currentlyLive: false,
      storeReleaseStatus: null,
      detectedAt,
    });

    if (upsert.action === "inserted") result.inserted += 1;
    else if (upsert.action === "upgraded") result.upgraded += 1;
    else result.unchanged += 1;
    result.actions.push({
      kind: "BOOTSTRAP",
      buildNumber: BOOTSTRAP_BUILD,
      version: BOOTSTRAP_VERSION,
      action: upsert.action,
    });
    return result;
  }

  result.skippedReason =
    "No successful storeSync tip and latest* is not the technical bootstrap baseline; nothing trustworthy to backfill.";
  return result;
};

/**
 * Run Phase A2 migration for ANDROID + IOS.
 * Never writes AppVersionPolicy.
 */
const migrateAppReleaseCatalogFromPolicies = async () => {
  const policies = await AppVersionPolicy.find({
    platform: { $in: PLATFORMS },
  }).lean();

  const byPlatform = { ANDROID: null, IOS: null };
  for (const doc of policies) {
    if (doc.platform === "ANDROID" || doc.platform === "IOS") {
      byPlatform[doc.platform] = doc;
    }
  }

  const platforms = [];
  const errors = [];

  for (const platform of PLATFORMS) {
    const policy = byPlatform[platform];
    if (!policy) {
      platforms.push({
        platform,
        inserted: 0,
        upgraded: 0,
        unchanged: 0,
        skippedReason: "No AppVersionPolicy document",
        actions: [],
      });
      continue;
    }

    try {
      platforms.push(await migratePlatformPolicy(policy));
    } catch (err) {
      errors.push({
        platform,
        error: err?.message || String(err),
      });
      platforms.push({
        platform,
        inserted: 0,
        upgraded: 0,
        unchanged: 0,
        skippedReason: `Migration error: ${err?.message || String(err)}`,
        actions: [],
        error: true,
      });
    }
  }

  return {
    success: errors.length === 0,
    platforms,
    errors,
    historicalRecovery: {
      appleAscApiCalls: false,
      googlePlayApiCalls: false,
      reason:
        "Phase A2 uses existing Mongo policy/storeSync data only. External store history APIs are not invoked.",
    },
  };
};

module.exports = {
  migrateAppReleaseCatalogFromPolicies,
  isSuccessfulStoreSync,
  isTechnicalBaselinePolicy,
  upsertCatalogPreserve,
  BOOTSTRAP_VERSION,
  BOOTSTRAP_BUILD,
  SOURCE_RANK,
};
