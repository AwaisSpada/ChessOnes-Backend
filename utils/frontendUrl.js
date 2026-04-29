/**
 * Public URL of the Next.js app (used in emails, invite links).
 * - Set FRONTEND_URL in .env (e.g. http://localhost:3000 locally, https://your-app.vercel.app in prod).
 * - If unset: development defaults to localhost:3000; production defaults to the main Vercel deploy.
 */
function getPublicFrontendUrl() {
  const raw = process.env.FRONTEND_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") {
    return "https://chessones-frontend-v2.vercel.app";
  }

  return "http://localhost:3000";
}

/** Deployed app origin used when FRONTEND_URL is local — email clients cannot load images from localhost. */
const PRODUCTION_FRONTEND_ORIGIN = "https://chessones-frontend-v2.vercel.app";

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

module.exports = { getPublicFrontendUrl, getEmailAssetBaseUrl };
