/**
 * @deprecated Legacy Badge-collection awarder.
 * Replaced by services/achievementUnlockService.js + constants/achievementsCatalog.js.
 * Kept only so old imports do not crash; do not call from game-end.
 */
async function checkAndAwardBadges() {
  console.warn(
    "[badgeService] deprecated — use achievementUnlockService.checkAndUnlockAchievements",
  );
  return [];
}

async function awardBadgeManually() {
  console.warn("[badgeService] awardBadgeManually deprecated");
  return null;
}

module.exports = {
  checkAndAwardBadges,
  awardBadgeManually,
};
