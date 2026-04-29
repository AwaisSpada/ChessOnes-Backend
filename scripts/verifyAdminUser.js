/**
 * Script to verify admin user exists and check credentials
 * Usage: node scripts/verifyAdminUser.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const bcrypt = require("bcryptjs");

const ADMIN_EMAIL = "coadmin@gmail.com";
const ADMIN_PASSWORD = "CoAdmin@";

async function verifyAdminUser() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    // Normalize email (same as login route does)
    const normalizedEmail = ADMIN_EMAIL.toLowerCase().trim();
    console.log(`\n🔍 Searching for user with email: "${normalizedEmail}"`);

    // Find user (same query as login route)
    const user = await User.findOne({
      $and: [
        {
          $or: [
            { email: normalizedEmail },
            { username: normalizedEmail }
          ]
        },
        { email: { $exists: true, $ne: null, $ne: "" } },
        { password: { $exists: true, $ne: null, $ne: "" } }
      ]
    });

    if (!user) {
      console.log("❌ User not found!");
      console.log("\n📋 Checking all users with similar emails...");
      const allUsers = await User.find({ email: { $regex: "admin", $options: "i" } });
      if (allUsers.length > 0) {
        console.log("Found users with 'admin' in email:");
        allUsers.forEach(u => {
          console.log(`  - Email: "${u.email}", Username: "${u.username}", Role: "${u.role || 'USER'}"`);
        });
      }
      await mongoose.disconnect();
      return;
    }

    console.log("✅ User found!");
    console.log(`   Email: "${user.email}"`);
    console.log(`   Username: "${user.username}"`);
    console.log(`   Role: "${user.role || 'USER'}"`);
    console.log(`   Has Password: ${!!user.password}`);
    console.log(`   Password Length: ${user.password ? user.password.length : 0}`);

    // Test password
    console.log(`\n🔐 Testing password...`);
    const isMatch = await user.comparePassword(ADMIN_PASSWORD);
    console.log(`   Password Match: ${isMatch ? "✅ YES" : "❌ NO"}`);

    if (!isMatch) {
      console.log("\n⚠️  Password doesn't match. Let's try to update it...");
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(ADMIN_PASSWORD, salt);
      await user.save();
      console.log("✅ Password updated!");
      
      // Test again
      const newMatch = await user.comparePassword(ADMIN_PASSWORD);
      console.log(`   Password Match After Update: ${newMatch ? "✅ YES" : "❌ NO"}`);
    }

    // Check role
    if (user.role !== "ADMIN") {
      console.log("\n⚠️  User role is not ADMIN. Updating to ADMIN...");
      user.role = "ADMIN";
      await user.save();
      console.log("✅ Role updated to ADMIN!");
    }

    await mongoose.disconnect();
    console.log("\n✅ Verification complete!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

verifyAdminUser();

