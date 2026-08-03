/**
 * @deprecated Legacy Mongo Badge auto-award.
 * Use achievementUnlockService.js instead.
 */
async function checkAndAwardBadges() {
  console.warn(
    "[achievementService] deprecated — use achievementUnlockService.checkAndUnlockAchievements",
  );
  return [];
}

module.exports = {
  checkAndAwardBadges,
};
