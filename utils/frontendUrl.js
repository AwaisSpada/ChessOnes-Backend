/**
 * Public URL of the Next.js app (used in emails, invite links).
 * - Set FRONTEND_URL in .env (e.g. http://localhost:3001 locally, https://www.chessones.com in prod).
 * - If unset: development defaults to localhost:3000; production defaults to chessones.com.
 */
function getPublicFrontendUrl() {
  const raw = process.env.FRONTEND_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    return "https://www.chessones.com";
  }

  return "http://localhost:3000";
}

/** Deployed app origin used when FRONTEND_URL is local — email clients cannot load images from localhost. */
const PRODUCTION_FRONTEND_ORIGIN = "https://www.chessones.com";

/**
 * Public API origin for /join/:token smart redirects (App + Web).
 * Prefer NEXT_PUBLIC_API_URL (already set on Render); fallback RENDER_EXTERNAL_URL.
 */
function getPublicApiUrl() {
  const explicit =
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "").replace(/\/api\/?$/, "");

  const port = process.env.PORT || 5050;
  return `http://localhost:${port}`;
}

function buildChallengeJoinUrls(token) {
  const frontend = getPublicFrontendUrl();
  const api = getPublicApiUrl();
  return {
    /** Share URL — brand domain (OG preview + WhatsApp). */
    joinUrl: `${frontend}/join/${token}`,
    /** API smart chooser (legacy / deep redirects). */
    apiJoinUrl: `${api}/join/${token}`,
    webJoinUrl: `${frontend}/home?invite=${encodeURIComponent(token)}`,
    appDeepLink: `chessones://invite/${token}`,
  };
}

/**
 * Base URL for static files referenced in HTML emails (e.g. logo image URLs).
 * Recipients' mail apps fetch these URLs; they must be publicly reachable.
 * - Set EMAIL_ASSET_BASE_URL to override (e.g. CDN).
 * - If FRONTEND_URL is localhost/127.0.0.1, falls back to the production deploy so logos work while you dev the API locally.
 */
function getEmailAssetBaseUrl() {
  const explicit = process.env.EMAIL_ASSET_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const frontend = getPublicFrontendUrl();
  try {
    const { hostname } = new URL(frontend);
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return PRODUCTION_FRONTEND_ORIGIN;
    }
  } catch {
    // ignore invalid FRONTEND_URL
  }
  return frontend;
}

module.exports = {
  getPublicFrontendUrl,
  getPublicApiUrl,
  getEmailAssetBaseUrl,
  buildChallengeJoinUrls,
  PRODUCTION_FRONTEND_ORIGIN,
};
