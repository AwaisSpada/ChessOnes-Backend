/**
 * Cleanup Script: Remove Duplicate Badges from Users
 * 
 * This script removes duplicate badge entries from all users' badges arrays.
 * It keeps only the first occurrence of each unique badgeId.
 * 
 * Usage:
 *   node scripts/cleanup-duplicate-badges.js
 */

const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/chess-app";

async function cleanupDuplicateBadges() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find all users with badges
    const users = await User.find({ "badges.0": { $exists: true } });
    console.log(`📊 Found ${users.length} users with badges\n`);

    let totalDuplicatesRemoved = 0;
    let usersAffected = 0;

    for (const user of users) {
      if (!user.badges || user.badges.length === 0) {
        continue;
      }

      const originalCount = user.badges.length;
      const seenBadgeIds = new Set();
      const uniqueBadges = [];

      // Filter duplicates, keeping only the first occurrence
      for (const badge of user.badges) {
        if (!badge.badgeId) {
          // Skip badges with null badgeId
          continue;
        }

        const badgeIdStr = badge.badgeId.toString();

        if (!seenBadgeIds.has(badgeIdStr)) {
          seenBadgeIds.add(badgeIdStr);
          uniqueBadges.push(badge);
        } else {
          // This is a duplicate
          totalDuplicatesRemoved++;
        }
      }

      // Only update if duplicates were found
      if (uniqueBadges.length < originalCount) {
        user.badges = uniqueBadges;
        await user.save();
        usersAffected++;
        console.log(`✅ Cleaned user ${user.username || user._id}: Removed ${originalCount - uniqueBadges.length} duplicate(s) (${originalCount} → ${uniqueBadges.length})`);
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("📈 CLEANUP SUMMARY:");
    console.log("=".repeat(60));
    console.log(`   Total users checked: ${users.length}`);
    console.log(`   Users with duplicates: ${usersAffected}`);
    console.log(`   Total duplicates removed: ${totalDuplicatesRemoved}`);
    console.log("=".repeat(60));

    if (totalDuplicatesRemoved === 0) {
      console.log("\n✅ No duplicates found! All user badges are unique.");
    } else {
      console.log(`\n✅ Cleanup complete! Removed ${totalDuplicatesRemoved} duplicate badge(s) from ${usersAffected} user(s).`);
    }

  } catch (error) {
    console.error("❌ Error during cleanup:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB");
    process.exit(0);
  }
}

// Run cleanup
cleanupDuplicateBadges();
