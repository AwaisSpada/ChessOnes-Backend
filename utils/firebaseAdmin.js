const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

let initAttempted = false;
let initOk = false;

/**
 * Init firebase-admin from env:
 * - FIREBASE_SERVICE_ACCOUNT_JSON = full JSON string
 * - or FIREBASE_SERVICE_ACCOUNT_PATH = absolute/relative path to JSON file
 */
function initFirebaseAdmin() {
  if (initAttempted) return initOk;
  initAttempted = true;

  try {
    if (admin.apps.length) {
      initOk = true;
      return true;
    }

    let credentials = null;
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

    if (jsonEnv && String(jsonEnv).trim()) {
      credentials = JSON.parse(jsonEnv);
    } else if (filePath && String(filePath).trim()) {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);
      credentials = JSON.parse(fs.readFileSync(resolved, "utf8"));
    }

    if (!credentials) {
      console.warn(
        "[firebase] No FIREBASE_SERVICE_ACCOUNT_JSON / PATH — push disabled"
      );
      return false;
    }

    admin.initializeApp({
      credential: admin.credential.cert(credentials),
    });
    initOk = true;
    console.log("[firebase] Admin SDK initialized");
    return true;
  } catch (err) {
    console.error("[firebase] Admin init failed:", err.message);
    initOk = false;
    return false;
  }
}

function getMessaging() {
  if (!initFirebaseAdmin()) return null;
  return admin.messaging();
}

module.exports = {
  initFirebaseAdmin,
  getMessaging,
  admin,
};
