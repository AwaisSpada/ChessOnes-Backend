const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const APPLE_ISS = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const DEFAULT_AUDIENCE = "com.chessones.mobile";

let keyCache = { fetchedAt: 0, keys: [] };

async function loadAppleKeys() {
  const now = Date.now();
  if (keyCache.keys.length && now - keyCache.fetchedAt < 60 * 60 * 1000) {
    return keyCache.keys;
  }
  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) {
    throw new Error("Failed to fetch Apple public keys");
  }
  const body = await response.json();
  keyCache = { fetchedAt: now, keys: body.keys || [] };
  return keyCache.keys;
}

async function publicKeyForKid(kid) {
  let keys = await loadAppleKeys();
  let jwk = keys.find((key) => key.kid === kid);
  if (!jwk) {
    keyCache = { fetchedAt: 0, keys: [] };
    keys = await loadAppleKeys();
    jwk = keys.find((key) => key.kid === kid);
  }
  if (!jwk) {
    throw new Error("Apple signing key not found");
  }
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Verify a Sign in with Apple identity token and return { sub, email }.
 */
async function verifyAppleIdentityToken(identityToken) {
  if (!identityToken || typeof identityToken !== "string") {
    throw new Error("Missing Apple identity token");
  }

  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded || typeof decoded === "string" || !decoded.header?.kid) {
    throw new Error("Invalid Apple identity token");
  }

  const audience = process.env.APPLE_CLIENT_ID || DEFAULT_AUDIENCE;
  const key = await publicKeyForKid(decoded.header.kid);
  const payload = jwt.verify(identityToken, key, {
    algorithms: ["RS256"],
    issuer: APPLE_ISS,
    audience,
  });

  if (!payload?.sub) {
    throw new Error("Apple token missing subject");
  }

  return {
    sub: String(payload.sub),
    email: typeof payload.email === "string" ? payload.email.toLowerCase().trim() : "",
  };
}

module.exports = { verifyAppleIdentityToken };
