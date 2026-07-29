const fs = require("fs");
const path = require("path");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getMessaging: getFirebaseMessaging } = require("firebase-admin/messaging");

let initAttempted = false;
let initOk = false;

function parseServiceAccountJson(raw) {
  let text = String(raw || "").trim();
  // Render / dotenv sometimes wraps the whole value in quotes.
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    text = text.slice(1, -1);
  }
  return JSON.parse(text);
}

/**
 * Init firebase-admin from env:
 * - FIREBASE_SERVICE_ACCOUNT_JSON = full JSON string
 * - or FIREBASE_SERVICE_ACCOUNT_PATH = absolute/relative path to JSON file
 */
function initFirebaseAdmin() {
  if (initAttempted) return initOk;
  initAttempted = true;

  try {
    if (getApps().length > 0) {
      initOk = true;
      return true;
    }

    let credentials = null;
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

    if (jsonEnv && String(jsonEnv).trim()) {
      credentials = parseServiceAccountJson(jsonEnv);
    } else if (filePath && String(filePath).trim()) {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);
      credentials = parseServiceAccountJson(fs.readFileSync(resolved, "utf8"));
    }

    if (!credentials) {
      console.warn(
        "[firebase] No FIREBASE_SERVICE_ACCOUNT_JSON / PATH — push disabled"
      );
      return false;
    }

    if (!credentials.client_email || !credentials.private_key) {
      console.error(
        "[firebase] Service account JSON missing client_email / private_key"
      );
      return false;
    }

    // Env paste sometimes turns real newlines into "\\n" twice — normalize once.
    if (typeof credentials.private_key === "string") {
      credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }

    initializeApp({
      credential: cert(credentials),
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
  return getFirebaseMessaging();
}

module.exports = {
  initFirebaseAdmin,
  getMessaging,
};
