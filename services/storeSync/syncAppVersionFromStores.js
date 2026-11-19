/**
 * Orchestrates manual per-platform store sync into AppVersionPolicy + AppReleaseCatalog.
 *
 * On SUCCESS for a platform:
 *   - Upserts detected release into AppReleaseCatalog (source STORE_SYNC)
 *   - Marks that release currentlyLive; clears currentlyLive on other platform releases
 *   - Updates storeSync metadata
 *   - Updates latestVersion / latestBuildNumber only
 *   - Never changes minimumSupported* or updatePolicy
 *
 * On FAILED / NOT_CONFIGURED:
 *   - Records attempt status/error only
 *   - Never clears prior successful storeSync version/build
 *   - Never modifies latest* / minimum* / updatePolicy
 *   - Never creates catalog records
 *
 * Missing policy documents are not created.
 * Bootstrap baselines (1.0.0 / build 1) are never invented into the catalog here.
 */

const mongoose = require("mongoose");
const AppVersionPolicy = require("../../models/AppVersionPolicy");
const AppReleaseCatalog = require("../../models/AppReleaseCatalog");
const { fetchAppleProductionVersion } = require("./appleAppStoreSync");
const { fetchGooglePlayProductionVersion } = require("./googlePlayStoreSync");

const toStoreSyncAdminPayload = (storeSync) => {
  const s = storeSync || {};
  return {
    lastSyncedAt: s.lastSyncedAt || null,
    lastSyncAttemptedAt: s.lastSyncAttemptedAt || null,
    lastSyncStatus: s.lastSyncStatus || null,
    lastSyncError: s.lastSyncError || null,
    lastSyncedStoreVersion: s.lastSyncedStoreVersion || null,
    lastSyncedStoreBuild:
      typeof s.lastSyncedStoreBuild === "number" ? s.lastSyncedStoreBuild : null,
    releaseStatus: s.releaseStatus || null,
    storeAvailability: s.storeAvailability || null,
  };
};

/** Reject fake/empty detections before any policy/catalog write. */
const isValidDetectedRelease = (result) => {
  if (!result || result.success !== true) return false;
  const version = String(result.version || "").trim();
  const build = Number(result.build);
  return Boolean(version) && Number.isInteger(build) && build >= 1;
};

const isTransactionUnsupportedError = (err) => {
  const msg = String(err?.message || "");
  const code = err?.code;
  return (
    code === 20 ||
    code === 263 ||
    /transaction numbers are only allowed/i.test(msg) ||
    /IllegalOperation/i.test(msg) ||
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(msg)
  );
};

/**
 * Upsert a store-detected release into the catalog for one platform.
 * firstDetectedAt set only on insert; lastSeenAt always refreshed.
 * Source is always STORE_SYNC on this path (genuine store detection).
 */
const upsertStoreDetectedCatalogRelease = async (
  platform,
  { version, buildNumber, storeReleaseStatus, seenAt },
  session = null
) => {
  const opts = session ? { session } : {};

  await AppReleaseCatalog.updateMany(
    {
      platform,
      currentlyLive: true,
      buildNumber: { $ne: buildNumber },
    },
    { $set: { currentlyLive: false } },
    opts
  );

  const updated = await AppReleaseCatalog.findOneAndUpdate(
    { platform, buildNumber },
    {
      $set: {
        version,
        lastSeenAt: seenAt,
        currentlyLive: true,
        storeReleaseStatus: storeReleaseStatus || null,
        // Store path confirms detection — never leave BOOTSTRAP pretending to be store.
        source: "STORE_SYNC",
      },
      $setOnInsert: {
        firstDetectedAt: seenAt,
        platform,
        buildNumber,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      ...opts,
    }
  ).lean();

  return updated;
};

const applySuccessfulSyncWrites = async (
  platform,
  { version, build, releaseStatus, storeAvailability, attemptedAt },
  session = null
) => {
  const opts = session
    ? { session, new: true, runValidators: true }
    : { new: true, runValidators: true };

  const catalogEntry = await upsertStoreDetectedCatalogRelease(
    platform,
    {
      version,
      buildNumber: build,
      storeReleaseStatus: releaseStatus || null,
      seenAt: attemptedAt,
    },
    session
  );

  // latest* + storeSync only — never minimumSupported* / updatePolicy.
  const updated = await AppVersionPolicy.findOneAndUpdate(
    { platform },
    {
      $set: {
        latestVersion: version,
        latestBuildNumber: build,
        "storeSync.lastSyncAttemptedAt": attemptedAt,
        "storeSync.lastSyncedAt": attemptedAt,
        "storeSync.lastSyncStatus": "SUCCESS",
        "storeSync.lastSyncError": null,
        "storeSync.lastSyncedStoreVersion": version,
        "storeSync.lastSyncedStoreBuild": build,
        "storeSync.releaseStatus": releaseStatus || null,
        "storeSync.storeAvailability": storeAvailability || "PRODUCTION",
      },
    },
    opts
  ).lean();

  return { updated, catalogEntry };
};

const applySyncResult = async (platform, result) => {
  const attemptedAt = new Date();
  const existing = await AppVersionPolicy.findOne({ platform }).lean();

  if (!existing) {
    return {
      platform,
      success: false,
      configured: Boolean(result?.configured),
      promoted: false,
      catalogUpserted: false,
      transactional: null,
      error: `No AppVersionPolicy document for ${platform}. Create/save a policy first, then sync.`,
      missingEnv: result?.missingEnv || undefined,
      storeSync: null,
      created: false,
    };
  }

  // Success path requires real detected version+build (never invent).
  if (result?.success === true && !isValidDetectedRelease(result)) {
    result = {
      ...result,
      success: false,
      configured: true,
      error:
        "Store sync returned success without a valid version/build; policy fields were not modified.",
    };
  }

  if (!result.success) {
    const $set =
      result.configured === false
        ? {
            "storeSync.lastSyncAttemptedAt": attemptedAt,
            "storeSync.lastSyncStatus": "NOT_CONFIGURED",
            "storeSync.lastSyncError":
              result.error || "Store sync is not configured",
          }
        : {
            "storeSync.lastSyncAttemptedAt": attemptedAt,
            "storeSync.lastSyncStatus": "FAILED",
            "storeSync.lastSyncError": result.error || "Store sync failed",
          };

    const updated = await AppVersionPolicy.findOneAndUpdate(
      { platform },
      { $set },
      { new: true, runValidators: true }
    ).lean();

    return {
      platform,
      success: false,
      configured: result.configured !== false,
      promoted: false,
      catalogUpserted: false,
      transactional: null,
      updatePolicy: updated?.updatePolicy,
      latestVersion: updated?.latestVersion,
      latestBuildNumber: updated?.latestBuildNumber,
      minimumSupportedVersion: updated?.minimumSupportedVersion,
      minimumSupportedBuildNumber: updated?.minimumSupportedBuildNumber,
      error: result.error,
      missingEnv: result.missingEnv || undefined,
      storeSync: toStoreSyncAdminPayload(updated?.storeSync),
    };
  }

  const version = String(result.version).trim();
  const build = Number(result.build);
  const payload = {
    version,
    build,
    releaseStatus: result.releaseStatus || null,
    storeAvailability: result.storeAvailability || "PRODUCTION",
    attemptedAt,
  };

  let updated;
  let catalogEntry;
  let transactional = false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const writes = await applySuccessfulSyncWrites(platform, payload, session);
      updated = writes.updated;
      catalogEntry = writes.catalogEntry;
    });
    transactional = true;
  } catch (err) {
    if (!isTransactionUnsupportedError(err)) {
      throw err;
    }
    // Standalone / non-replica Mongo: sequential writes (not atomic across collections).
    const writes = await applySuccessfulSyncWrites(platform, payload, null);
    updated = writes.updated;
    catalogEntry = writes.catalogEntry;
    transactional = false;
  } finally {
    session.endSession();
  }

  return {
    platform,
    success: true,
    configured: true,
    // latest* updated from store; minimum* intentionally untouched (Option A).
    promoted: true,
    catalogUpserted: Boolean(catalogEntry),
    transactional,
    version,
    build,
    releaseStatus: result.releaseStatus,
    storeAvailability: result.storeAvailability || "PRODUCTION",
    updatePolicy: updated?.updatePolicy,
    latestVersion: updated?.latestVersion,
    latestBuildNumber: updated?.latestBuildNumber,
    minimumSupportedVersion: updated?.minimumSupportedVersion,
    minimumSupportedBuildNumber: updated?.minimumSupportedBuildNumber,
    catalog: catalogEntry
      ? {
          platform: catalogEntry.platform,
          version: catalogEntry.version,
          buildNumber: catalogEntry.buildNumber,
          source: catalogEntry.source,
          currentlyLive: catalogEntry.currentlyLive,
          firstDetectedAt: catalogEntry.firstDetectedAt,
          lastSeenAt: catalogEntry.lastSeenAt,
          storeReleaseStatus: catalogEntry.storeReleaseStatus || null,
        }
      : null,
    storeSync: toStoreSyncAdminPayload(updated?.storeSync),
  };
};

const normalizePlatformList = (raw) => {
  if (!raw) return ["ANDROID", "IOS"];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    const p = String(item || "")
      .trim()
      .toUpperCase();
    if ((p === "ANDROID" || p === "IOS") && !out.includes(p)) out.push(p);
  }
  return out.length ? out : ["ANDROID", "IOS"];
};

/**
 * Manually sync live store version info for one or both platforms.
 * @param {{ platforms?: string[] }} options
 */
const syncAppVersionFromStores = async (options = {}) => {
  const platforms = normalizePlatformList(options.platforms);
  const results = {};

  for (const platform of platforms) {
    if (platform === "IOS") {
      const apple = await fetchAppleProductionVersion();
      results.IOS = await applySyncResult("IOS", apple);
    } else if (platform === "ANDROID") {
      const google = await fetchGooglePlayProductionVersion();
      results.ANDROID = await applySyncResult("ANDROID", google);
    }
  }

  return { platforms, results };
};

module.exports = {
  syncAppVersionFromStores,
  toStoreSyncAdminPayload,
  applySyncResult,
  isValidDetectedRelease,
  upsertStoreDetectedCatalogRelease,
};
