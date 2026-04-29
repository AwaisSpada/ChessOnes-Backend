const User = require("../models/User");
const GameInvitation = require("../models/GameInvitation");
const UserInvite = require("../models/UserInvite");
const PasswordReset = require("../models/PasswordReset");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

/**
 * Anonymizes a user account while preserving database integrity
 * - Generates random username
 * - Sets email to deleted format
 * - Sets password to random hash (prevents login)
 * - Clears personal data (bio, avatar, fullName)
 * - Sets isDeleted flag
 * - Cleans up all notifications/subscriptions
 * 
 * @param {string} userId - MongoDB ObjectId of the user to anonymize
 * @returns {Promise<Object>} - Updated user object
 */
async function anonymizeUser(userId) {
  try {
    // Generate random username (e.g., 'Closed_Account_12345')
    const randomSuffix = Math.floor(Math.random() * 100000);
    const anonymizedUsername = `Closed_Account_${randomSuffix}`;

    // Generate random 64-character hash for password (prevents any future login)
    const randomPassword = crypto.randomBytes(32).toString("hex"); // 64 characters
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    // Set email to deleted format (or null if database allows)
    const deletedEmail = `deleted_${userId}@example.com`;

    // Update user record
    // Load user first, then update and save with validation disabled
    // This ensures isDeleted is set before any validation runs
    const user = await User.findById(userId);
    if (!user) {
      throw new Error(`User with ID ${userId} not found`);
    }

    // Set all fields for anonymization
    // Set isDeleted first so validators can check it if needed
    user.isDeleted = true;
    user.username = anonymizedUsername;
    user.email = deletedEmail;
    user.password = hashedPassword; // Already hashed, pre-save hook will skip it
    user.fullName = null;
    user.about = null;
    user.avatar = null;
    user.accountStatus = "deleted";
    user.status = "offline";
    user.friends = [];
    user.friendRequests = [];
    user.preferences = {
      theme: "dark",
      boardStyle: "classic",
      notifications: false,
    };

    // Save with validation completely disabled for deleted accounts
    const updatedUser = await user.save({ validateBeforeSave: false });

    if (!updatedUser) {
      throw new Error(`User with ID ${userId} not found`);
    }

    // Clean up notifications and subscriptions
    // 1. Delete all GameInvitations where user is sender or receiver
    await GameInvitation.deleteMany({
      $or: [
        { fromUser: userId },
        { toUser: userId },
      ],
    });

    // 2. Delete all UserInvites where user is inviter or invitee
    await UserInvite.deleteMany({
      $or: [
        { inviter: userId },
        { acceptedBy: userId },
      ],
    });

    // 3. Delete all PasswordReset records for this user
    await PasswordReset.deleteMany({
      email: { $regex: deletedEmail, $options: "i" },
    });

    console.log(`✅ Anonymized user ${userId} (was: ${updatedUser.username || "unknown"})`);
    
    return updatedUser;
  } catch (error) {
    console.error(`❌ Error anonymizing user ${userId}:`, error);
    throw error;
  }
}

module.exports = { anonymizeUser };

