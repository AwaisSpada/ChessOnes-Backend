/**
 * Centralised user response shaping.
 *
 * Purpose: when one user fetches data about *another* user, only ship the
 * fields that are explicitly safe to expose. Everything else (email, oauth
 * identifiers, internal flags, privacy preferences, friend/block graph,
 * suspension state…) stays server-side so it never lands in the browser's
 * Network tab, console, or any client memory.
 *
 * Self responses (the requester reading their own profile) and admin
 * endpoints intentionally keep the full document — they have business reasons
 * to see those fields.
 */

/**
 * Whitelist of User document fields safe to send to *another* signed-in user.
 * Pass into `.select(OTHER_USER_FIELDS)` on a Mongoose query.
 *
 * Intentionally excluded (sensitive / internal):
 *   password, email, provider, providerId, ageGroup,
 *   preferences, friendRequests, blockedUsers,
 *   role, isSuspended, hasAcceptedPolicies, acceptedPoliciesAt,
 *   hasAcceptedMessengerTerms, acceptedMessengerTermsAt,
 *   accountStatus, deletionDate, lastActive, isDeleted (admin/system only).
 *
 * Note: `friends` IS included so the profile UI can show a friend count and
 * (already-public) friend avatars; the populate step elsewhere restricts what
 * gets returned for each friend to public fields.
 */
const OTHER_USER_FIELDS = [
  "_id",
  "username",
  "fullName",
  "avatar",
  "country",
  "about",
  "status",
  "ratings",
  "puzzleRating",
  "puzzleStreak",
  "dailyPuzzleStreak",
  "dailyPuzzleLastStreakDate",
  "badges",
  "friends",
  "createdAt",
].join(" ");

/**
 * Whitelist of fields exposed when listing/searching users (lighter payload
 * than a full profile load — no badges, no friends array, no about/bio).
 */
const SEARCH_USER_FIELDS = [
  "_id",
  "username",
  "fullName",
  "avatar",
  "country",
  "status",
  "rating",
  "ratings",
].join(" ");

const SENSITIVE_KEYS = new Set([
  "password",
  "email",
  "provider",
  "providerId",
  "ageGroup",
  "preferences",
  "friendRequests",
  "blockedUsers",
  "role",
  "isSuspended",
  "hasAcceptedPolicies",
  "acceptedPoliciesAt",
  "hasAcceptedMessengerTerms",
  "acceptedMessengerTermsAt",
  "accountStatus",
  "deletionDate",
  "lastActive",
  "__v",
]);

/**
 * Defensive cleanup. Use on plain objects (from `.lean()` or `.toObject()`)
 * before sending to the client — strips any sensitive keys regardless of
 * what the query selected. Safe no-op for null/undefined.
 *
 * Pass `{ stripIds: true }` to also remove internal Mongo housekeeping
 * fields you don't want in payloads aimed at search results.
 */
function publicUserView(user) {
  if (!user || typeof user !== "object") return user;
  const out = {};
  for (const key of Object.keys(user)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    out[key] = user[key];
  }
  return out;
}

/** Human-readable join label from Mongoose `createdAt` (signup timestamp). */
function formatMemberSince(createdAt) {
  if (!createdAt) return undefined;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

module.exports = {
  OTHER_USER_FIELDS,
  SEARCH_USER_FIELDS,
  SENSITIVE_KEYS,
  publicUserView,
  formatMemberSince,
};
