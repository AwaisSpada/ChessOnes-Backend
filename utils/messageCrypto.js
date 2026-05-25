/**
 * Messenger message encryption (AES-256-GCM).
 *
 * Storage envelope: `enc:v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>`
 *  - 12-byte random IV (GCM-standard)
 *  - 16-byte auth tag (built-in integrity check)
 *  - URL-safe-ish base64 to keep it compact in Mongo
 *
 * Key resolution (in order):
 *  1. `process.env.MESSAGE_ENCRYPTION_KEY` — required in production.
 *     Accepts 64-char hex (32 bytes) or 44-char base64 (32 bytes) or any
 *     length string (will be HKDF-extended via scrypt to 32 bytes).
 *  2. Fallback (dev only): derived from `JWT_SECRET` via scrypt. Logs a
 *     warning on first use so prod isn't silently using a derived key.
 *
 * Backward-compatible reads: `decrypt()` returns the input unchanged when it
 * doesn't carry the `enc:v1:` prefix, so any old plaintext rows still render.
 */

const crypto = require("crypto");

const ENVELOPE_PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SCRYPT_SALT = Buffer.from("chessones:messenger:v1", "utf8");

let cachedKey = null;
let warnedAboutFallback = false;

function deriveKey(material) {
  return crypto.scryptSync(material, SCRYPT_SALT, KEY_BYTES);
}

function resolveKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.MESSAGE_ENCRYPTION_KEY;
  if (raw && raw.trim()) {
    const v = raw.trim();
    // Try hex (64 chars)
    if (/^[0-9a-fA-F]{64}$/.test(v)) {
      cachedKey = Buffer.from(v, "hex");
      return cachedKey;
    }
    // Try base64 → exactly 32 bytes
    try {
      const buf = Buffer.from(v, "base64");
      if (buf.length === KEY_BYTES) {
        cachedKey = buf;
        return cachedKey;
      }
    } catch (_) {
      /* fall through to scrypt */
    }
    // Anything else: extend deterministically.
    cachedKey = deriveKey(v);
    return cachedKey;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret && jwtSecret.trim()) {
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      console.warn(
        "[messageCrypto] MESSAGE_ENCRYPTION_KEY not set — falling back to a " +
          "key derived from JWT_SECRET. Set MESSAGE_ENCRYPTION_KEY to a 32-byte " +
          "hex/base64 secret in production (e.g. `openssl rand -hex 32`)."
      );
    }
    cachedKey = deriveKey(jwtSecret);
    return cachedKey;
  }

  throw new Error(
    "messageCrypto: no MESSAGE_ENCRYPTION_KEY or JWT_SECRET configured"
  );
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt a UTF-8 string. Returns the storage envelope.
 * Idempotent: already-encrypted envelopes are returned unchanged.
 */
function encrypt(plaintext) {
  if (typeof plaintext !== "string") return plaintext;
  if (plaintext === "") return ""; // keep empty snippets cheap
  if (isEncrypted(plaintext)) return plaintext;

  const key = resolveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX.replace(/:$/, ""),
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a storage envelope. Strings without the `enc:v1:` prefix are
 * returned unchanged so we can keep reading any legacy plaintext rows.
 */
function decrypt(value) {
  if (typeof value !== "string" || value === "") return value;
  if (!isEncrypted(value)) return value;

  const parts = value.split(":");
  // ["enc", "v1", iv, tag, ct]
  if (parts.length !== 5) {
    return value;
  }
  try {
    const key = resolveKey();
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const ct = Buffer.from(parts[4], "base64");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out.toString("utf8");
  } catch (err) {
    console.error("[messageCrypto] decrypt failed:", err.message);
    return "";
  }
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  ENVELOPE_PREFIX,
};
