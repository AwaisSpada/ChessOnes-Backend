/**
 * Script to create an admin user
 * Usage: node scripts/createAdminUser.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const ADMIN_EMAIL = "coadmin@gmail.com";
const ADMIN_PASSWORD = "CoAdmin@";
const ADMIN_USERNAME = "coadmin";
const ADMIN_FULLNAME = "Co Admin";

async function createAdminUser() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { email: ADMIN_EMAIL.toLowerCase() },
        { username: ADMIN_USERNAME },
      ],
    });

    if (existingUser) {
      console.log("⚠️  User already exists!");
      console.log("   Email:", existingUser.email);
      console.log("   Username:", existingUser.username);
      console.log("   Current Role:", existingUser.role);

      // Update role to ADMIN if not already
      if (existingUser.role !== "ADMIN") {
        existingUser.role = "ADMIN";
        await existingUser.save();
        console.log("✅ Updated user role to ADMIN");
      } else {
        console.log("✅ User is already an ADMIN");
      }

      // Update password if needed
      if (ADMIN_PASSWORD) {
        existingUser.password = ADMIN_PASSWORD; // Will be hashed by pre-save hook
        await existingUser.save();
        console.log("✅ Password updated");
      }

      await mongoose.disconnect();
      return;
    }

    // Create new admin user
    console.log("📝 Creating new admin user...");
    const adminUser = new User({
      email: ADMIN_EMAIL.toLowerCase(),
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD, // Will be hashed by pre-save hook
      fullName: ADMIN_FULLNAME,
      ageGroup: "26-35", // Required field
      country: "",
      role: "ADMIN",
      status: "online",
      // Initialize Glicko-2 ratings
      ratings: {
        bullet: { rating: 1500.0, rd: 350.0, volatility: 0.06, gamesPlayed: 0 },
        blitz: { rating: 1500.0, rd: 350.0, volatility: 0.06, gamesPlayed: 0 },
        rapid: { rating: 1500.0, rd: 350.0, volatility: 0.06, gamesPlayed: 0 },
      },
    });

    await adminUser.save();
    console.log("✅ Admin user created successfully!");
    console.log("   Email:", adminUser.email);
    console.log("   Username:", adminUser.username);
    console.log("   Role:", adminUser.role);
    console.log("   User ID:", adminUser._id);

    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB");
  } catch (error) {
    console.error("❌ Error creating admin user:", error);
    if (error.code === 11000) {
      console.error("   Duplicate key error - user with this email or username already exists");
    }
    process.exit(1);
  }
}

// Run the script
createAdminUser();

