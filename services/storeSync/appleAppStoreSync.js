/**
 * Apple App Store Connect — live production iOS version + build.
 *
 * Uses App Store Connect API (not iTunes lookup alone) so we can read the
 * released CFBundleVersion. Only READY_FOR_DISTRIBUTION versions count as live.
 *
 * Env (names only):
 *   APPLE_ASC_ISSUER_ID
 *   APPLE_ASC_KEY_ID
 *   APPLE_ASC_PRIVATE_KEY          (PEM contents, \n escaped OK)
 *   APPLE_ASC_PRIVATE_KEY_PATH    (optional alternative to PRIVATE_KEY)
 *   APPLE_ASC_APP_ID              (App Store Connect numeric app id)
 */

const fs = require("fs");
const jwt = require("jsonwebtoken");
const { fetchWithTimeout } = require("./fetchWithTimeout");

const ASC_BASE = "https://api.appstoreconnect.apple.com/v1";
const TIMEOUT_MS = 15000;

const readPrivateKey = () => {
  const inline = process.env.APPLE_ASC_PRIVATE_KEY;
  if (inline && String(inline).trim()) {
    return String(inline).replace(/\\n/g, "\n").trim();
  }
  const keyPath = process.env.APPLE_ASC_PRIVATE_KEY_PATH;
  if (keyPath && String(keyPath).trim()) {
    return fs.readFileSync(String(keyPath).trim(), "utf8");
  }
  return null;
};

const getAppleConfig = () => {
  const issuerId = String(process.env.APPLE_ASC_ISSUER_ID || "").trim();
  const keyId = String(process.env.APPLE_ASC_KEY_ID || "").trim();
  const appId = String(process.env.APPLE_ASC_APP_ID || "").trim();
  const privateKey = readPrivateKey();
  const missing = [];
  if (!issuerId) missing.push("APPLE_ASC_ISSUER_ID");
  if (!keyId) missing.push("APPLE_ASC_KEY_ID");
  if (!appId) missing.push("APPLE_ASC_APP_ID");
  if (!privateKey) missing.push("APPLE_ASC_PRIVATE_KEY or APPLE_ASC_PRIVATE_KEY_PATH");
  return { issuerId, keyId, appId, privateKey, missing };
};

const createAscToken = (issuerId, keyId, privateKey) =>
  jwt.sign({}, privateKey, {
    algorithm: "ES256",
    expiresIn: "15m",
    issuer: issuerId,
    audience: "appstoreconnect-v1",
    keyid: keyId,
    header: {
      alg: "ES256",
      kid: keyId,
      typ: "JWT",
    },
  });

const ascFetchJson = async (path, token) => {
  const response = await fetchWithTimeout(
    `${ASC_BASE}${path}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
    TIMEOUT_MS
  );

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      const first = Array.isArray(body?.errors) ? body.errors[0] : null;
      detail = String(first?.detail || first?.title || "").trim();
    } catch {
      // ignore body parse failures
    }
    const err = new Error(
      detail
        ? `App Store Connect HTTP ${response.status}: ${detail}`
        : `App Store Connect HTTP ${response.status}`
    );
    err.code = "ASC_HTTP_ERROR";
    err.status = response.status;
    throw err;
  }

  return response.json();
};

/**
 * @returns {Promise<{
 *   configured: boolean,
 *   success: boolean,
 *   version?: string,
 *   build?: number,
 *   releaseStatus?: string,
 *   storeAvailability?: string,
 *   error?: string,
 *   missingEnv?: string[],
 * }>}
 */
const fetchAppleProductionVersion = async () => {
  const { issuerId, keyId, appId, privateKey, missing } = getAppleConfig();
  if (missing.length) {
    return {
      configured: false,
      success: false,
      error: `Apple App Store Connect is not configured. Missing: ${missing.join(", ")}`,
      missingEnv: missing,
    };
  }

  try {
    const token = createAscToken(issuerId, keyId, privateKey);

    // Live / distributable iOS versions only.
    // ASC rejects sort= on this collection; filter uses appVersionState (not deprecated
    // appStoreState=READY_FOR_DISTRIBUTION — that value is invalid and returns HTTP 400).
    const versionsPath =
      `/apps/${encodeURIComponent(appId)}/appStoreVersions` +
      `?filter[platform]=IOS` +
      `&filter[appVersionState]=READY_FOR_DISTRIBUTION` +
      `&limit=20`;

    const versionsJson = await ascFetchJson(versionsPath, token);
    const versions = Array.isArray(versionsJson?.data) ? versionsJson.data : [];

    if (versions.length === 0) {
      return {
        configured: true,
        success: false,
        error:
          "No iOS App Store version in READY_FOR_DISTRIBUTION state (no live production release found).",
      };
    }

    // Newest createdDate first (API does not allow sort on this endpoint).
    versions.sort((a, b) => {
      const ta = Date.parse(a?.attributes?.createdDate || 0) || 0;
      const tb = Date.parse(b?.attributes?.createdDate || 0) || 0;
      return tb - ta;
    });

    const liveVersion = versions[0];
    const versionString = String(liveVersion?.attributes?.versionString || "").trim();
    const appStoreState = String(
      liveVersion?.attributes?.appVersionState ||
        liveVersion?.attributes?.appStoreState ||
        ""
    ).trim();
    const versionId = liveVersion?.id;

    if (!versionString || !versionId) {
      return {
        configured: true,
        success: false,
        error: "Live App Store version payload missing versionString or id.",
      };
    }

    const buildJson = await ascFetchJson(
      `/appStoreVersions/${encodeURIComponent(versionId)}/build`,
      token
    );
    const buildVersionRaw = buildJson?.data?.attributes?.version;
    const buildNumber = Number.parseInt(String(buildVersionRaw || "").trim(), 10);

    if (!Number.isFinite(buildNumber) || buildNumber < 1) {
      return {
        configured: true,
        success: false,
        error:
          "Live App Store version has no valid build number (CFBundleVersion). Ensure a build is attached to the released version.",
      };
    }

    return {
      configured: true,
      success: true,
      version: versionString,
      build: buildNumber,
      releaseStatus: appStoreState || "READY_FOR_DISTRIBUTION",
      storeAvailability: "PRODUCTION",
    };
  } catch (err) {
    const message =
      err?.code === "STORE_TIMEOUT"
        ? err.message
        : err?.status === 401 || err?.status === 403
          ? "App Store Connect authentication failed. Check ASC key permissions."
          : err?.message || "Apple store sync failed";
    return {
      configured: true,
      success: false,
      error: message,
    };
  }
};

module.exports = {
  fetchAppleProductionVersion,
  getAppleConfig,
};
