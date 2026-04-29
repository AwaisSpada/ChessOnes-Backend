const User = require("../models/User");
const Badge = require("../models/Badge");
const Stats = require("../models/Stats");

/**
 * Check and award badges based on user stats
 * Called after a game ends to check if user qualifies for any badges
 * 
 * @param {String} userId - User ID to check badges for
 * @param {Object} io - Socket.io instance for emitting events (optional)
 * @returns {Promise<Array>} Array of newly awarded badges
 */
async function checkAndAwardBadges(userId, io = null) {
  try {
    // Get user and stats
    const user = await User.findById(userId);
    if (!user) {
      console.error(`[Badge] User not found: ${userId}`);
      return [];
    }

    const stats = await Stats.findOne({ user: userId });
    if (!stats) {
      console.log(`[Badge] No stats found for user ${userId}, skipping badge check`);
      return [];
    }

    // Get all auto-award badges
    const autoBadges = await Badge.find({ autoAward: true }).lean();
    
    const newlyAwarded = [];

    for (const badge of autoBadges) {
      // Check if user already has this badge
      const hasBadge = user.badges.some(
        (b) => b.badgeId.toString() === badge._id.toString()
      );

      if (hasBadge) {
        continue; // Skip if already awarded
      }

      // Check if user meets criteria
      const qualifies = checkBadgeCriteria(badge, stats, user);

      if (qualifies) {
        // Award the badge
        user.badges.push({
          badgeId: badge._id,
          earnedAt: new Date(),
        });

        await user.save();

        newlyAwarded.push(badge);

        console.log(`[Badge] ✅ Awarded badge "${badge.name}" to user ${userId}`);

        // Emit socket event if io is provided
        if (io) {
          io.to(`user:${userId}`).emit("BADGE_EARNED", {
            badge: {
              _id: badge._id,
              name: badge.name,
              description: badge.description,
              imageUrl: badge.imageUrl,
            },
            earnedAt: new Date(),
          });
        }
      }
    }

    return newlyAwarded;
  } catch (error) {
    console.error(`[Badge] Error checking badges for user ${userId}:`, error);
    return [];
  }
}

/**
 * Check if user meets badge criteria
 * 
 * @param {Object} badge - Badge document
 * @param {Object} stats - User stats document
 * @param {Object} user - User document
 * @returns {Boolean} True if user qualifies
 */
function checkBadgeCriteria(badge, stats, user) {
  const { category, targetValue, condition = "gte" } = badge;

  try {
    let userValue = 0;

    // Get the user's current value for the metric
    switch (category) {
      case "wins":
        userValue = stats.wins?.total || 0;
        break;

      case "streak":
      case "winStreak":
        userValue = stats.currentStreak || 0;
        break;

      case "rating":
      case "highestRating":
        // Get the highest rating across all categories
        const ratings = user.ratings || {};
        const bulletRating = ratings.bullet?.rating || 1500;
        const blitzRating = ratings.blitz?.rating || 1500;
        const rapidRating = ratings.rapid?.rating || 1500;
        userValue = Math.max(bulletRating, blitzRating, rapidRating);
        break;

      case "games":
      case "totalGames":
        userValue = stats.gamesPlayed?.total || 0;
        break;

      case "botWins":
        userValue = stats.wins?.bot || 0;
        break;

      case "custom":
        // Custom criteria - can be extended as needed
        // For now, return false (admin must manually award custom badges)
        return false;

      default:
        console.warn(`[Badge] Unknown category: ${category}`);
        return false;
    }

    // Apply condition
    if (condition === "exact") {
      return userValue === targetValue;
    } else if (condition === "gte") {
      return userValue >= targetValue;
    } else {
      console.warn(`[Badge] Unknown condition: ${condition}`);
      return false;
    }
  } catch (error) {
    console.error(`[Badge] Error checking criteria for badge ${badge._id}:`, error);
    return false;
  }
}

/**
 * Manually award a badge to a user (admin function)
 * 
 * @param {String} userId - User ID
 * @param {String} badgeId - Badge ID
 * @returns {Promise<Object>} Awarded badge info
 */
async function awardBadgeManually(userId, badgeId) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const badge = await Badge.findById(badgeId);
    if (!badge) {
      throw new Error("Badge not found");
    }

    // Check if user already has this badge
    const hasBadge = user.badges.some(
      (b) => b.badgeId.toString() === badgeId
    );

    if (hasBadge) {
      throw new Error("User already has this badge");
    }

    // Award the badge
    user.badges.push({
      badgeId: badge._id,
      earnedAt: new Date(),
    });

    await user.save();

    return {
      badge: {
        _id: badge._id,
        name: badge.name,
        description: badge.description,
        imageUrl: badge.imageUrl,
      },
      earnedAt: new Date(),
    };
  } catch (error) {
    console.error(`[Badge] Error manually awarding badge:`, error);
    throw error;
  }
}

module.exports = {
  checkAndAwardBadges,
  checkBadgeCriteria,
  awardBadgeManually,
};

