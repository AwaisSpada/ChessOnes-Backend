const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 50, // Increased for closed account names
      validate: {
        validator: function(v) {
          // Allow shorter usernames for closed accounts (skip validation)
          if (this.isDeleted) return true;
          return v && v.length >= 3;
        },
        message: 'Username must be at least 3 characters long'
      }
    },
    email: {
      type: String,
      required: function() {
        // Email not required for deleted accounts
        return !this.isDeleted;
      },
      unique: true,
      sparse: true, // Allow multiple null values
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: function() {
        // Password not required for social auth users
        return !this.provider;
      },
      minlength: 6,
    },
    provider: {
      type: String,
      enum: ["google", "facebook", null],
      default: null,
    },
    providerId: {
      type: String,
      default: null,
    },
    fullName: {
      type: String,
      required: function() {
        // FullName not required for deleted accounts
        return !this.isDeleted;
      },
      trim: true,
    },
    ageGroup: {
      type: String,
      enum: ["under-18", "18-25", "26-35", "36-50", "over-50"],
      required: function() {
        // Age group not required for social auth users
        return !this.provider;
      },
    },
    country: {
      type: String,
      default: "",
      trim: true,
    },
    avatar: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["online", "offline", "in-game"],
      default: "online",
    },
    about: {
      type: String,
      maxlength: 500,
      default: "",
    },
    // Glicko-2 Rating System - Three time control categories
    ratings: {
      bullet: {
        rating: { type: Number, default: 1500.0 },
        rd: { type: Number, default: 350.0 }, // Rating Deviation
        volatility: { type: Number, default: 0.06 },
        gamesPlayed: { type: Number, default: 0 },
      },
      blitz: {
        rating: { type: Number, default: 1500.0 },
        rd: { type: Number, default: 350.0 },
        volatility: { type: Number, default: 0.06 },
        gamesPlayed: { type: Number, default: 0 },
      },
      rapid: {
        rating: { type: Number, default: 1500.0 },
        rd: { type: Number, default: 350.0 },
        volatility: { type: Number, default: 0.06 },
        gamesPlayed: { type: Number, default: 0 },
      },
    },
    puzzleRating: {
      type: Number,
      default: 100,
      min: 0,
    },
    puzzleStreak: {
      type: Number,
      default: 0,
      min: 0,
    },
    preferences: {
      theme: {
        type: String,
        enum: ["light", "dark"],
        default: "dark",
      },
      boardStyle: {
        type: String,
        enum: ["classic", "modern", "wood"],
        default: "classic",
      },
      // Support both old Boolean format and new object format for backward compatibility
      notifications: {
        type: mongoose.Schema.Types.Mixed,
        default: true, // Default to true for old users
      },
      // New nested preference structures
      gameplay: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
      display: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
      sound: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
      privacy: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },
    friends: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    friendRequests: [
      {
        from: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        status: {
          type: String,
          enum: ["pending", "accepted", "declined"],
          default: "pending",
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    lastActive: {
      type: Date,
      default: Date.now,
    },
    accountStatus: {
      type: String,
      enum: ["active", "pending_deletion", "deleted"],
      default: "active",
    },
    deletionDate: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true, // Index for quick lookups in UI
    },
    // Admin role
    role: {
      type: String,
      enum: ["USER", "ADMIN"],
      default: "USER",
      index: true,
    },
    // Badges earned by the user
    badges: [
      {
        badgeId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Badge",
          required: true,
        },
        earnedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // User suspension status
    isSuspended: {
      type: Boolean,
      default: false,
      index: true,
    },
    hasAcceptedPolicies: {
      type: Boolean,
      default: false,
      index: true,
    },
    acceptedPoliciesAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  // Skip password hashing for social auth users (no password)
  if (this.provider) {
    return next();
  }
  
  // Skip password hashing for deleted accounts (password is already hashed in anonymizeUser)
  // Deleted accounts have passwords that are already bcrypt hashes (60 chars)
  if (this.isDeleted && this.password && this.password.length >= 60) {
    // Password is already a hash, skip re-hashing
    return next();
  }
  
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Update last active
userSchema.methods.updateLastActive = function () {
  this.lastActive = new Date();
  return this.save();
};

module.exports = mongoose.model("User", userSchema);


