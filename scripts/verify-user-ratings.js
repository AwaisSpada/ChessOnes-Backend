/**
 * Verify a user's bullet/blitz/rapid ratings in DB (compare with profile UI).
 * Usage: node scripts/verify-user-ratings.js <username_or_email>
 * Example: node scripts/verify-user-ratings.js myuser
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const query = process.argv[2];
if (!query) {
  console.log("Usage: node scripts/verify-user-ratings.js <username_or_email>");
  process.exit(1);
}

async function run() {
  try {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
    await mongoose.connect(mongoUri);
    const q = query.toLowerCase().trim();
    const user = await User.findOne({
      $or: [
        { username: new RegExp("^" + q + "$", "i") },
        { email: q },
      ],
    })
      .select("username email ratings")
      .lean();

    if (!user) {
      console.log("User not found for:", query);
      process.exit(1);
    }

    const r = user.ratings || {};
    const bullet = r.bullet?.rating ?? 1500;
    const blitz = r.blitz?.rating ?? 1500;
    const rapid = r.rapid?.rating ?? 1500;

    console.log("\n--- DB ratings (logged-in user) ---");
    console.log("User:", user.username || user.email);
    console.log("Bullet:", Math.round(bullet));
    console.log("Blitz:", Math.round(blitz));
    console.log("Rapid:", Math.round(rapid));
    console.log("-----------------------------------\n");
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

run();
