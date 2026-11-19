/**
 * Phase 0 verification for AppVersionPolicy + public route behavior.
 * Usage: node scripts/test-app-version-policy.js
 */
require("dotenv").config();
const assert = require("assert");
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const AppVersionPolicy = require("../models/AppVersionPolicy");
const publicRouter = require("../routes/public");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, json, body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function evaluate(installedBuild, remote) {
  const updateAvailable = installedBuild > 0 && installedBuild < remote.latestBuildNumber;
  const updateRequired =
    installedBuild > 0 && installedBuild < remote.minimumSupportedBuildNumber;
  return { updateAvailable, updateRequired };
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  await AppVersionPolicy.findOneAndUpdate(
    { platform: "ANDROID" },
    {
      $set: {
        platform: "ANDROID",
        latestVersion: "1.0.6",
        latestBuildNumber: 7,
        minimumSupportedVersion: "1.0.0",
        minimumSupportedBuildNumber: 5,
        updatePolicy: "MANDATORY",
        updateTitle: "Update required",
        updateMessage: "Please update ChessOnes (Android test).",
        storeUrl: "https://play.google.com/store/apps/details?id=com.chessones.mobile",
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );

  await AppVersionPolicy.findOneAndUpdate(
    { platform: "IOS" },
    {
      $set: {
        platform: "IOS",
        latestVersion: "2.3",
        latestBuildNumber: 14,
        minimumSupportedVersion: "2.0",
        minimumSupportedBuildNumber: 10,
        updatePolicy: "OPTIONAL",
        updateTitle: "Update available",
        updateMessage: "Please update ChessOnes (iOS test).",
        storeUrl: "https://apps.apple.com/app/id0000000000",
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );

  const app = express();
  app.use("/api/public", publicRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  const android = await request(port, "/api/public/app-version-policy?platform=android");
  assert.strictEqual(android.status, 200);
  assert.strictEqual(android.json.success, true);
  assert.strictEqual(android.json.data.platform, "ANDROID");
  assert.strictEqual(android.json.data.latestBuildNumber, 7);
  assert.strictEqual(android.json.data.minimumSupportedBuildNumber, 5);
  assert.strictEqual(android.json.data.updatePolicy, "MANDATORY");
  assert.ok(!("storeSync" in android.json.data));

  const iosHeader = await request(port, "/api/public/app-version-policy", {
    "X-App-Platform": "ios",
  });
  assert.strictEqual(iosHeader.status, 200);
  assert.strictEqual(iosHeader.json.data.platform, "IOS");
  assert.strictEqual(iosHeader.json.data.updatePolicy, "OPTIONAL");

  const missing = await request(port, "/api/public/app-version-policy");
  assert.strictEqual(missing.status, 400);

  const invalid = await request(port, "/api/public/app-version-policy?platform=windows");
  assert.strictEqual(invalid.status, 400);

  // No auth header — still works
  const noAuth = await request(port, "/api/public/app-version-policy?platform=ANDROID", {
    Authorization: "Bearer totally-invalid-token",
  });
  assert.strictEqual(noAuth.status, 200);

  // Inactive policy → 404
  await AppVersionPolicy.updateOne({ platform: "ANDROID" }, { $set: { isActive: false } });
  const inactive = await request(port, "/api/public/app-version-policy?platform=android");
  assert.strictEqual(inactive.status, 404);
  await AppVersionPolicy.updateOne({ platform: "ANDROID" }, { $set: { isActive: true } });

  // Build comparison (mirrors mobile evaluateAppVersionPolicy)
  const remoteAndroid = android.json.data;
  assert.deepStrictEqual(evaluate(4, remoteAndroid), {
    updateAvailable: true,
    updateRequired: true,
  });
  assert.deepStrictEqual(evaluate(5, remoteAndroid), {
    updateAvailable: true,
    updateRequired: false,
  });
  assert.deepStrictEqual(evaluate(7, remoteAndroid), {
    updateAvailable: false,
    updateRequired: false,
  });
  assert.deepStrictEqual(evaluate(8, remoteAndroid), {
    updateAvailable: false,
    updateRequired: false,
  });

  // Unique platform constraint
  let dupFailed = false;
  try {
    await AppVersionPolicy.create({
      platform: "ANDROID",
      latestVersion: "9.9.9",
      latestBuildNumber: 99,
      minimumSupportedVersion: "1.0.0",
      minimumSupportedBuildNumber: 1,
      updatePolicy: "OPTIONAL",
    });
  } catch (_) {
    dupFailed = true;
  }
  assert.strictEqual(dupFailed, true);

  server.close();
  await mongoose.disconnect();
  console.log("Phase 0 app-version-policy tests: PASS");
}

main().catch(async (err) => {
  console.error("Phase 0 app-version-policy tests: FAIL");
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
