/**
 * Google Play — live production track versionName + versionCode.
 *
 * Uses Android Publisher API edits.tracks.get(track=production) and only accepts
 * releases with status "completed" (publicly rolled out). Draft / inProgress ignored.
 *
 * Env (names only):
 *   GOOGLE_PLAY_PACKAGE_NAME
 *   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON       (full JSON string)
 *   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH  (optional alternative file path)
 */

const fs = require("fs");
const { fetchWithTimeout } = require("./fetchWithTimeout");

const TIMEOUT_MS = 15000;
const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

const readServiceAccount = () => {
  const inline = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (inline && String(inline).trim()) {
    try {
      return JSON.parse(String(inline));
    } catch {
      const err = new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON");
      err.code = "INVALID_SERVICE_ACCOUNT_JSON";
      throw err;
    }
  }
  const keyPath = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH;
  if (keyPath && String(keyPath).trim()) {
    const raw = fs.readFileSync(String(keyPath).trim(), "utf8");
    return JSON.parse(raw);
  }
  return null;
};

const getGooglePlayConfig = () => {
  const packageName = String(process.env.GOOGLE_PLAY_PACKAGE_NAME || "").trim();
  let serviceAccount = null;
  let parseError = null;
  try {
    serviceAccount = readServiceAccount();
  } catch (err) {
    parseError = err;
  }
  const missing = [];
  if (!packageName) missing.push("GOOGLE_PLAY_PACKAGE_NAME");
  if (!serviceAccount && !parseError) {
    missing.push(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH"
    );
  }
  return { packageName, serviceAccount, missing, parseError };
};

const getAccessToken = async (serviceAccount) => {
  let GoogleAuth;
  try {
    ({ GoogleAuth } = require("google-auth-library"));
  } catch {
    const err = new Error(
      "google-auth-library is required for Google Play sync but could not be loaded"
    );
    err.code = "MISSING_GOOGLE_AUTH";
    throw err;
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key,
    },
    scopes: [PLAY_SCOPE],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token || tokenResponse;
  if (!token || typeof token !== "string") {
    const err = new Error("Failed to obtain Google Play access token");
    err.code = "PLAY_AUTH_FAILED";
    throw err;
  }
  return token;
};

const playFetchJson = async (url, accessToken, options = {}) => {
  const response = await fetchWithTimeout(
    url,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    },
    TIMEOUT_MS
  );

  if (!response.ok) {
    const err = new Error(`Google Play API HTTP ${response.status}`);
    err.code = "PLAY_HTTP_ERROR";
    err.status = response.status;
    throw err;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
};

const pickCompletedProductionRelease = (trackPayload) => {
  const releases = Array.isArray(trackPayload?.releases) ? trackPayload.releases : [];
  const completed = releases.filter(
    (r) => String(r?.status || "").toLowerCase() === "completed"
  );
  if (completed.length === 0) return null;

  let best = null;
  let bestCode = -1;
  for (const release of completed) {
    const codes = Array.isArray(release.versionCodes) ? release.versionCodes : [];
    for (const raw of codes) {
      const code = Number.parseInt(String(raw), 10);
      if (Number.isFinite(code) && code > bestCode) {
        bestCode = code;
        best = release;
      }
    }
  }
  if (!best || bestCode < 1) return null;
  return { release: best, versionCode: bestCode };
};

const resolveVersionName = async (base, editId, accessToken, versionCode, release) => {
  // 1) APK listing often includes versionName.
  try {
    const apksJson = await playFetchJson(
      `${base}/edits/${encodeURIComponent(editId)}/apks`,
      accessToken,
      { method: "GET" }
    );
    const apks = Array.isArray(apksJson?.apks) ? apksJson.apks : [];
    const match = apks.find(
      (apk) => Number.parseInt(String(apk.versionCode), 10) === versionCode
    );
    const fromApk = String(match?.versionName || "").trim();
    if (fromApk) return fromApk;
  } catch {
    // Bundles-only apps may 404 apks — continue.
  }

  // 2) Release "name" in Play Console is often set to the marketing version.
  const releaseName = String(release?.name || "").trim();
  if (releaseName && /\d/.test(releaseName)) return releaseName;

  return null;
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
const fetchGooglePlayProductionVersion = async () => {
  const { packageName, serviceAccount, missing, parseError } = getGooglePlayConfig();

  if (parseError) {
    return {
      configured: false,
      success: false,
      error: parseError.message || "Invalid Google Play service account configuration",
      missingEnv: missing,
    };
  }

  if (missing.length) {
    return {
      configured: false,
      success: false,
      error: `Google Play is not configured. Missing: ${missing.join(", ")}`,
      missingEnv: missing,
    };
  }

  let editId = null;
  let accessToken = null;
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    packageName
  )}`;

  try {
    accessToken = await getAccessToken(serviceAccount);

    const edit = await playFetchJson(`${base}/edits`, accessToken, {
      method: "POST",
      body: "{}",
    });
    editId = edit?.id;
    if (!editId) {
      return {
        configured: true,
        success: false,
        error: "Google Play edit creation returned no edit id",
      };
    }

    const track = await playFetchJson(
      `${base}/edits/${encodeURIComponent(editId)}/tracks/production`,
      accessToken,
      { method: "GET" }
    );

    const picked = pickCompletedProductionRelease(track);
    if (!picked) {
      return {
        configured: true,
        success: false,
        error:
          "No completed production-track release found on Google Play (draft/inProgress ignored).",
      };
    }

    const version = await resolveVersionName(
      base,
      editId,
      accessToken,
      picked.versionCode,
      picked.release
    );

    if (!version) {
      return {
        configured: true,
        success: false,
        error:
          "Could not resolve production versionName for the completed release versionCode.",
      };
    }

    return {
      configured: true,
      success: true,
      version,
      build: picked.versionCode,
      releaseStatus: "completed",
      storeAvailability: "PRODUCTION",
    };
  } catch (err) {
    const message =
      err?.code === "STORE_TIMEOUT"
        ? err.message
        : err?.status === 401 || err?.status === 403
          ? "Google Play authentication failed. Check service account access to the Play Console app."
          : err?.message || "Google Play store sync failed";
    return {
      configured: true,
      success: false,
      error: message,
    };
  } finally {
    if (editId && accessToken) {
      try {
        await playFetchJson(
          `${base}/edits/${encodeURIComponent(editId)}`,
          accessToken,
          { method: "DELETE" }
        );
      } catch {
        // Best-effort cleanup.
      }
    }
  }
};

module.exports = {
  fetchGooglePlayProductionVersion,
  getGooglePlayConfig,
};
