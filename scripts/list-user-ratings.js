/**
 * List all users' bullet/blitz/rapid ratings from DB for cross-check with profile.
 * Usage: node scripts/list-user-ratings.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

async function run() {
  try {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
    await mongoose.connect(mongoUri);
    const users = await User.find({})
      .select("username email ratings")
      .lean();

    console.log("\n--- DB ratings (all users) ---\n");
    if (users.length === 0) {
      console.log("No users in DB.");
    } else {
      users.forEach((u) => {
        const r = u.ratings || {};
        const bullet = Math.round(r.bullet?.rating ?? 1500);
        const blitz = Math.round(r.blitz?.rating ?? 1500);
        const rapid = Math.round(r.rapid?.rating ?? 1500);
        console.log(`${u.username || u.email || u._id}\t Bullet: ${bullet}  Blitz: ${blitz}  Rapid: ${rapid}`);
      });
    }
    console.log("\n-----------------------------------\n");
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

run();
