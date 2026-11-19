/**
 * Phase A3 verification — admin catalog GET + PUT min selection on chessonesTest.
 * Spins an ephemeral Express app (does not require the long-lived server).
 *
 * Usage: node scripts/test-option-a-phase-a3-admin-apis.js
 */
require("dotenv").config();
const assert = require("assert");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const AppVersionPolicy = require("../models/AppVersionPolicy");
const AppReleaseCatalog = require("../models/AppReleaseCatalog");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessonesTest";

const dbNameFromUri = (uri) => {
  const path = String(uri).split("?")[0];
  return path.split("/").pop() || "";
};

const IOS_BUILD_OLD = 940010;
const IOS_BUILD_NEW = 940014;
const IOS_BUILD_ABOVE_LATEST = 940099;
const ANDROID_BUILD = 950001;
const TEST_BUILDS = [
  IOS_BUILD_OLD,
  IOS_BUILD_NEW,
  IOS_BUILD_ABOVE_LATEST,
  ANDROID_BUILD,
];

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

function request(baseUrl, { method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  assert.strictEqual(
    dbNameFromUri(MONGODB_URI),
    "chessonesTest",
    "Refusing: DB must be chessonesTest"
  );
  assert.ok(process.env.JWT_SECRET, "JWT_SECRET required");

  console.log("Connecting:", MONGODB_URI.replace(/:[^:@]+@/, ":***@"));
  await mongoose.connect(MONGODB_URI);

  const iosSnap = await snapshotPolicy("IOS");
  const androidSnap = await snapshotPolicy("ANDROID");

  const app = express();
  app.use(express.json());
  app.use("/api/admin", require("../routes/admin"));
  app.use("/api/public", require("../routes/public"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  let adminToken;
  let nonAdminToken;

  try {
    await AppReleaseCatalog.deleteMany({ buildNumber: { $in: TEST_BUILDS } });

    let admin = await User.findOne({ email: "coadmin@gmail.com" });
    if (!admin) {
      admin = await User.create({
        username: "coadmin",
        email: "coadmin@gmail.com",
        password: await bcrypt.hash("CoAdmin@", 10),
        role: "ADMIN",
        fullName: "CO Admin",
      });
    } else if (admin.role !== "ADMIN") {
      admin.role = "ADMIN";
      await admin.save();
    }

    let nonAdmin = await User.findOne({
      role: { $ne: "ADMIN" },
      isDeleted: { $ne: true },
    }).select("_id email role");
    if (!nonAdmin) {
      throw new Error(
        "No non-admin user available in chessonesTest for authz negative test"
      );
    }

    adminToken = jwt.sign({ userId: admin._id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    nonAdminToken = jwt.sign({ userId: nonAdmin._id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    const now = new Date();
    await AppReleaseCatalog.insertMany([
      {
        platform: "IOS",
        version: "2.2",
        buildNumber: IOS_BUILD_OLD,
        firstDetectedAt: now,
        lastSeenAt: now,
        source: "STORE_SYNC",
        currentlyLive: false,
        storeReleaseStatus: "REPLACED_WITH_NEW_VERSION",
      },
      {
        platform: "IOS",
        version: "2.3",
        buildNumber: IOS_BUILD_NEW,
        firstDetectedAt: now,
        lastSeenAt: now,
        source: "STORE_SYNC",
        currentlyLive: true,
        storeReleaseStatus: "READY_FOR_DISTRIBUTION",
      },
      {
        platform: "ANDROID",
        version: "1.5.0",
        buildNumber: ANDROID_BUILD,
        firstDetectedAt: now,
        lastSeenAt: now,
        source: "STORE_SYNC",
        currentlyLive: true,
        storeReleaseStatus: "completed",
      },
    ]);

    await AppVersionPolicy.findOneAndUpdate(
      { platform: "IOS" },
      {
        $set: {
          platform: "IOS",
          latestVersion: "2.3",
          latestBuildNumber: IOS_BUILD_NEW,
          minimumSupportedVersion: "2.3",
          minimumSupportedBuildNumber: IOS_BUILD_NEW,
          updatePolicy: "OPTIONAL",
          isActive: true,
        },
      },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );

    await AppVersionPolicy.findOneAndUpdate(
      { platform: "ANDROID" },
      {
        $set: {
          platform: "ANDROID",
          latestVersion: "1.5.0",
          latestBuildNumber: ANDROID_BUILD,
          minimumSupportedVersion: "1.5.0",
          minimumSupportedBuildNumber: ANDROID_BUILD,
          updatePolicy: "MANDATORY",
          isActive: true,
        },
      },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );

    // --- Auth ---
    const noAuth = await request(baseUrl, {
      method: "GET",
      path: "/api/admin/app-version-policies/ios/releases",
    });
    assert.strictEqual(noAuth.status, 401);

    const nonAdminRes = await request(baseUrl, {
      method: "GET",
      path: "/api/admin/app-version-policies/ios/releases",
      token: nonAdminToken,
    });
    assert.strictEqual(nonAdminRes.status, 403);

    // --- GET iOS releases (no Android) ---
    const iosReleases = await request(baseUrl, {
      method: "GET",
      path: "/api/admin/app-version-policies/ios/releases?limit=50",
      token: adminToken,
    });
    assert.strictEqual(iosReleases.status, 200);
    assert.strictEqual(iosReleases.json.data.platform, "IOS");
    const iosBuilds = iosReleases.json.data.releases.map((r) => r.buildNumber);
    assert.ok(iosBuilds.includes(IOS_BUILD_NEW));
    assert.ok(iosBuilds.includes(IOS_BUILD_OLD));
    assert.ok(!iosBuilds.includes(ANDROID_BUILD));
    for (let i = 1; i < iosBuilds.length; i += 1) {
      assert.ok(
        iosBuilds[i - 1] >= iosBuilds[i],
        "iOS releases must be sorted buildNumber desc"
      );
    }

    // --- GET Android releases (no iOS) ---
    const androidReleases = await request(baseUrl, {
      method: "GET",
      path: "/api/admin/app-version-policies/android/releases",
      token: adminToken,
    });
    assert.strictEqual(androidReleases.status, 200);
    const androidBuilds = androidReleases.json.data.releases.map(
      (r) => r.buildNumber
    );
    assert.ok(androidBuilds.includes(ANDROID_BUILD));
    assert.ok(!androidBuilds.includes(IOS_BUILD_NEW));
    assert.ok(!androidBuilds.includes(IOS_BUILD_OLD));

    // --- Unknown platform ---
    const badPlatform = await request(baseUrl, {
      method: "GET",
      path: "/api/admin/app-version-policies/windows/releases",
      token: adminToken,
    });
    assert.strictEqual(badPlatform.status, 400);

    // --- Select valid older catalog release as minimum ---
    const selectMin = await request(baseUrl, {
      method: "PUT",
      path: "/api/admin/app-version-policies/ios",
      token: adminToken,
      body: {
        latestVersion: "9.9.9",
        latestBuildNumber: 999999,
        minimumSupportedBuildNumber: IOS_BUILD_OLD,
        minimumSupportedVersion: "should-be-ignored",
        updatePolicy: "OPTIONAL",
      },
    });
    assert.strictEqual(selectMin.status, 200, JSON.stringify(selectMin.json));
    assert.strictEqual(
      selectMin.json.data.policy.minimumSupportedBuildNumber,
      IOS_BUILD_OLD
    );
    assert.strictEqual(selectMin.json.data.policy.minimumSupportedVersion, "2.2");
    // latest* ignored — still store/policy owned tip
    assert.strictEqual(
      selectMin.json.data.policy.latestBuildNumber,
      IOS_BUILD_NEW
    );
    assert.strictEqual(selectMin.json.data.policy.latestVersion, "2.3");
    assert.strictEqual(selectMin.json.data.policy.updatePolicy, "OPTIONAL");

    // --- Wrong platform build (Android build on iOS PUT) ---
    const wrongPlatform = await request(baseUrl, {
      method: "PUT",
      path: "/api/admin/app-version-policies/ios",
      token: adminToken,
      body: { minimumSupportedBuildNumber: ANDROID_BUILD },
    });
    assert.strictEqual(wrongPlatform.status, 400);

    // --- Nonexistent build ---
    const missing = await request(baseUrl, {
      method: "PUT",
      path: "/api/admin/app-version-policies/ios",
      token: adminToken,
      body: { minimumSupportedBuildNumber: 941111 },
    });
    assert.strictEqual(missing.status, 400);

    // --- Min above latest ---
    await AppReleaseCatalog.create({
      platform: "IOS",
      version: "9.0.0",
      buildNumber: IOS_BUILD_ABOVE_LATEST,
      firstDetectedAt: now,
      lastSeenAt: now,
      source: "MANUAL",
      currentlyLive: false,
    });
    const aboveLatest = await request(baseUrl, {
      method: "PUT",
      path: "/api/admin/app-version-policies/ios",
      token: adminToken,
      body: { minimumSupportedBuildNumber: IOS_BUILD_ABOVE_LATEST },
    });
    assert.strictEqual(aboveLatest.status, 400);

    // --- updatePolicy unchanged when omitted ---
    const beforePolicy = await AppVersionPolicy.findOne({
      platform: "IOS",
    }).lean();
    assert.strictEqual(beforePolicy.updatePolicy, "OPTIONAL");
    const omitPolicy = await request(baseUrl, {
      method: "PUT",
      path: "/api/admin/app-version-policies/ios",
      token: adminToken,
      body: {
        minimumSupportedBuildNumber: IOS_BUILD_OLD,
        updateTitle: "Updated title only",
      },
    });
    assert.strictEqual(omitPolicy.status, 200);
    assert.strictEqual(omitPolicy.json.data.policy.updatePolicy, "OPTIONAL");
    assert.strictEqual(
      omitPolicy.json.data.policy.updateTitle,
      "Updated title only"
    );

    // Android MANDATORY preserved when omitted
    const androidOmit = await request(baseUrl, {
      method: "PUT",
      path: "/api/admin/app-version-policies/android",
      token: adminToken,
      body: { storeUrl: "https://play.google.com/store/apps/details?id=test" },
    });
    assert.strictEqual(androidOmit.status, 200);
    assert.strictEqual(androidOmit.json.data.policy.updatePolicy, "MANDATORY");
    assert.strictEqual(
      androidOmit.json.data.policy.minimumSupportedBuildNumber,
      ANDROID_BUILD
    );
    assert.strictEqual(
      androidOmit.json.data.policy.latestBuildNumber,
      ANDROID_BUILD
    );

    // --- Public endpoint unchanged / no catalog or storeSync ---
    const publicIos = await request(baseUrl, {
      method: "GET",
      path: "/api/public/app-version-policy?platform=ios",
    });
    assert.strictEqual(publicIos.status, 200);
    assert.ok(publicIos.json.data);
    assert.ok(!("storeSync" in publicIos.json.data));
    assert.ok(!("releases" in publicIos.json.data));
    assert.ok(!("catalog" in publicIos.json.data));
    assert.strictEqual(
      publicIos.json.data.minimumSupportedBuildNumber,
      IOS_BUILD_OLD
    );
    assert.strictEqual(publicIos.json.data.latestBuildNumber, IOS_BUILD_NEW);

    console.log("\nAll Phase A3 checks passed.");
  } finally {
    await AppReleaseCatalog.deleteMany({ buildNumber: { $in: TEST_BUILDS } });
    await restorePolicy("IOS", iosSnap);
    await restorePolicy("ANDROID", androidSnap);
    await new Promise((r) => server.close(r));
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error("Phase A3 test failed:", err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
