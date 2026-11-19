/**
 * Phase A2 runner — backfill AppReleaseCatalog from AppVersionPolicy on chessonesTest only.
 *
 * Usage: node scripts/migrate-app-release-catalog-a2.js
 *
 * Does not modify AppVersionPolicy fields (minimum*, updatePolicy, storeSync, latest*).
 * Does not call Apple/Google store APIs.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const {
  migrateAppReleaseCatalogFromPolicies,
} = require("../services/storeSync/migrateAppReleaseCatalog");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessonesTest";

const dbNameFromUri = (uri) => {
  const path = String(uri).split("?")[0];
  const parts = path.split("/");
  return parts[parts.length - 1] || "";
};

async function main() {
  const dbName = dbNameFromUri(MONGODB_URI);
  if (dbName !== "chessonesTest") {
    console.error(
      `Refusing to run Phase A2 migration: DB must be chessonesTest (got "${dbName}")`
    );
    process.exit(1);
  }

  console.log("Connecting:", MONGODB_URI.replace(/:[^:@]+@/, ":***@"));
  await mongoose.connect(MONGODB_URI);

  try {
    const result = await migrateAppReleaseCatalogFromPolicies();
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Phase A2 migration failed:", err);
  process.exit(1);
});
