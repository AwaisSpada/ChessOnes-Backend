/**
 * Whether the user chose a ChessOnes password (email signup, set, change, or reset).
 * Social accounts store a dummy password, so `provider` alone is not enough after reset.
 * Legacy docs without the flag: email users → true, Google/Facebook → false.
 */
function resolveHasPassword(user) {
  if (!user) return false;
  if (typeof user.hasPassword === "boolean") return user.hasPassword;
  return !user.provider;
}

module.exports = { resolveHasPassword };
