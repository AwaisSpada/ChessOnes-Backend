const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const Stats = require("../models/Stats");
const UserInvite = require("../models/UserInvite");
const PasswordReset = require("../models/PasswordReset");
const auth = require("../middleware/auth");
const {
  sendMail,
  buildPasswordResetEmail,
  CHESSONES_FROM_NOREPLY,
} = require("../utils/sendMail");

const router = express.Router();

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" })
}

// @route   POST /api/auth/signup
// @desc    Register user
// @access  Public
router.post(
  "/signup",
  [
    body("email").isEmail(),
    body("username").isLength({ min: 3, max: 20 }).trim(),
    body("password").isLength({ min: 6 }),
    body("fullName").isLength({ min: 2 }).trim(),
    body("ageGroup").isIn(["under-18", "18-25", "26-35", "36-50", "over-50"]),
    body("inviteToken").optional().isString(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const {
        email,
        username,
        password,
        fullName,
        ageGroup,
        country,
        inviteToken,
      } = req.body;

      // Normalize email for storage (lowercase and trim, but preserve dots)
      const normalizedEmail = email.toLowerCase().trim();

      // Check if user already exists (normalize email for comparison)
      const existingUser = await User.findOne({
        $or: [{ email: normalizedEmail }, { username }],
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          message:
            existingUser.email === normalizedEmail
              ? "Email already registered"
              : "Username already taken",
        });
      }

      // Initialize Glicko-2 ratings with defaults (1500/350/0.06) for all categories
      const defaultRatings = {
        bullet: {
          rating: 1500.0,
          rd: 350.0,
          volatility: 0.06,
          gamesPlayed: 0,
        },
        blitz: {
          rating: 1500.0,
          rd: 350.0,
          volatility: 0.06,
          gamesPlayed: 0,
        },
        rapid: {
          rating: 1500.0,
          rd: 350.0,
          volatility: 0.06,
          gamesPlayed: 0,
        },
      };

      // Create new user (store normalized email with dots preserved)
      const user = new User({
        email: normalizedEmail,
        username,
        password,
        fullName,
        ageGroup,
        country: country || "",
        status: "online",
        ratings: defaultRatings,
      });

      await user.save();

      // Create initial stats
      const stats = new Stats({
        user: user._id,
      });
      await stats.save();

      // If signup came from a platform invite, auto-connect friends
      if (inviteToken) {
        try {
          const invite = await UserInvite.findOne({
            token: inviteToken,
            status: "pending",
          }).populate("inviter");

          if (invite && invite.inviter) {
            // Optional email safety check: ensure invite email matches signup email
            if (
              invite.email.toLowerCase() === email.toLowerCase() ||
              !invite.email
            ) {
              const inviter = invite.inviter;

              // Add each other as friends if not already
              if (
                !inviter.friends.some(
                  (id) => id.toString() === user._id.toString()
                )
              ) {
                inviter.friends.push(user._id);
              }
              if (
                !user.friends.some(
                  (id) => id.toString() === inviter._id.toString()
                )
              ) {
                user.friends.push(inviter._id);
              }

              await inviter.save();
              await user.save();

              invite.status = "accepted";
              invite.acceptedBy = user._id;
              await invite.save();
            }
          }
        } catch (inviteErr) {
          console.error("Invite linking error during signup:", inviteErr);
          // Do not fail signup if invite processing fails
        }
      }

      // Generate token
      const token = generateToken(user._id);

      res.status(201).json({
        success: true,
        message: "User registered successfully",
        data: {
          token,
          user: {
            id: user._id,
            username: user.username,
            email: user.email,
            fullName: user.fullName,
            ratings: user.ratings,
            status: user.status,
            country: user.country,
            hasAcceptedPolicies: user.hasAcceptedPolicies === true,
          },
        },
      });
    } catch (error) {
      console.error("Signup error:", error);
      res.status(500).json({
        success: false,
        message: "Server error during registration",
      });
    }
  }
);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post(
  "/login",
  [
    body("identifier")
      .notEmpty()
      .trim(), // email or username
    body("password").notEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req)
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Please provide valid credentials",
        })
      }

      const { identifier, password } = req.body

      // Normalize identifier for email lookup (lowercase and trim, preserve dots)
      const normalizedIdentifier = identifier.toLowerCase().trim();

      console.log("[Login] Attempting login:", {
        identifier: identifier,
        normalizedIdentifier: normalizedIdentifier,
        hasPassword: !!password
      });

      // Find user by email or username
      // IMPORTANT: Only find users that have email and password (not permanently deleted)
      const user = await User.findOne({
        $and: [
          {
            $or: [
              { email: normalizedIdentifier },
              { username: identifier.trim() }
            ]
          },
          { email: { $exists: true, $ne: null, $ne: "" } }, // Email must exist (not deleted)
          { password: { $exists: true, $ne: null, $ne: "" } } // Password must exist (not deleted)
        ]
      })

      if (!user) {
        console.log("[Login] User not found for identifier:", normalizedIdentifier);
        return res.status(400).json({
          success: false,
          message: "Invalid credentials",
        })
      }

      console.log("[Login] User found:", {
        email: user.email,
        username: user.username,
        role: user.role
      });

      // Check password
      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        console.log("[Login] Password mismatch for user:", user.email);
        return res.status(400).json({ success: false, message: "Invalid credentials" });
      }

      console.log("[Login] Password verified successfully for user:", user.email);

      // Check if user is suspended BEFORE generating token
      if (user.isSuspended) {
        console.log("[Login] User is suspended:", user.email);
        return res.status(403).json({
          success: false,
          message: "Your account is suspended. Please contact customer support for more information.",
        });
      }

      // If user has pending_deletion status, cancel it (Chess.com style)
      // This works even if deletionDate has passed - as long as the account wasn't permanently deleted yet
      if (user.accountStatus === "pending_deletion") {
        user.accountStatus = "active";
        user.deletionDate = null;
        await user.save();
        console.log(`✅ Account deletion canceled for user ${user._id} - Welcome back!`);
        // Return a flag to show "Welcome Back! Deletion Canceled" message on frontend
        return res.json({
          success: true,
          message: "Login successful",
          deletionCanceled: true, // Flag for frontend message
          data: {
            token: generateToken(user._id),
            user: {
              id: user._id,
              username: user.username,
              email: user.email,
              fullName: user.fullName,
              ratings: user.ratings,
              avatar: user.avatar,
              status: "online",
              country: user.country,
              role: user.role || "USER", // Include role for admin check
            hasAcceptedPolicies: user.hasAcceptedPolicies === true,
            },
          },
        });
      }

      // Update last active and status
      user.status = "online"
      await user.updateLastActive()

      // Generate token
      const token = generateToken(user._id)

      res.json({
        success: true,
        message: "Login successful",
        data: {
          token,
          user: {
            id: user._id,
            username: user.username,
            email: user.email,
            fullName: user.fullName,
            ratings: user.ratings,
            avatar: user.avatar,
            status: user.status,
            country: user.country,
            role: user.role || "USER", // Include role for admin check
            hasAcceptedPolicies: user.hasAcceptedPolicies === true,
          },
        },
      })
    } catch (error) {
      console.error("Login error:", error)
      res.status(500).json({
        success: false,
        message: "Server error during login",
      })
    }
  },
)

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post("/logout", auth, async (req, res) => {
  try {
    req.user.status = "offline"
    await req.user.save()

    res.json({
      success: true,
      message: "Logged out successfully",
    })
  } catch (error) {
    console.error("Logout error:", error)
    res.status(500).json({
      success: false,
      message: "Server error during logout",
    })
  }
})

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("-password")
      .populate("badges.badgeId", "name description imageUrl");
    res.json({
      success: true,
      data: { user },
    })
  } catch (error) {
    console.error("Get user error:", error)
    res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

// @route   GET /api/auth/check-email
// @desc    Check if email is available
// @access  Public
router.get("/check-email", async (req, res) => {
  try {
    const { email } = req.query

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      })
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() })

    res.json({
      success: true,
      available: !existingUser,
      message: existingUser ? "Email already registered" : "Email is available",
    })
  } catch (error) {
    console.error("Check email error:", error)
    res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

// @route   GET /api/auth/check-username
// @desc    Check if username is available
// @access  Public
router.get("/check-username", async (req, res) => {
  try {
    const { username } = req.query

    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Username is required",
      })
    }

    const existingUser = await User.findOne({ username })

    res.json({
      success: true,
      available: !existingUser,
      message: existingUser ? "Username already taken" : "Username is available",
    })
  } catch (error) {
    console.error("Check username error:", error)
    res.status(500).json({
      success: false,
      message: "Server error",
    })
  }
})

// @route   POST /api/auth/forgot-password
// @desc    Send password reset verification code
// @access  Public
router.post(
  "/forgot-password",
  [body("email").isEmail()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Invalid email address",
          errors: errors.array(),
        });
      }

      const { email } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      // Check if user exists
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        // Don't reveal if email exists or not for security
        return res.json({
          success: true,
          message: "If an account with that email exists, a verification code has been sent.",
        });
      }

      // Generate 6-digit random code
      const code = Math.floor(100000 + Math.random() * 900000).toString();

      // Set expiration to 10 minutes from now
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      // Delete any existing unused codes for this email
      await PasswordReset.deleteMany({
        email: normalizedEmail,
        used: false,
      });

      // Save new code
      const passwordReset = new PasswordReset({
        email: normalizedEmail,
        code,
        expiresAt,
        used: false,
      });
      await passwordReset.save();

      // Send email with verification code
      try {
        await sendMail({
          to: normalizedEmail,
          from: CHESSONES_FROM_NOREPLY,
          subject: "ChessOnes - Password Reset Verification Code",
          html: buildPasswordResetEmail({
            userName: user.fullName || user.username,
            verificationCode: code,
          }),
        });

        console.log(`[PasswordReset] Verification code sent to ${normalizedEmail}`);
      } catch (emailError) {
        console.error("[PasswordReset] Failed to send email:", emailError);
        // Delete the code if email failed
        await PasswordReset.findByIdAndDelete(passwordReset._id);
        return res.status(500).json({
          success: false,
          message: "Failed to send verification email. Please try again later.",
        });
      }

      res.json({
        success: true,
        message: "If an account with that email exists, a verification code has been sent.",
      });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   POST /api/auth/verify-code
// @desc    Verify password reset code
// @access  Public
router.post(
  "/verify-code",
  [
    // Only validate email format – do NOT normalize here, we normalize manually below
    body("email").isEmail(),
    body("code").isLength({ min: 6, max: 6 }).isNumeric(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Invalid email or code format",
          errors: errors.array(),
        });
      }

      const { email, code } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      console.log("[VERIFY_CODE] Incoming", { email, normalizedEmail, code });

      // Find the latest unused password reset record for this email
      const passwordReset = await PasswordReset.findOne({
        email: normalizedEmail,
        used: false,
      }).sort({ createdAt: -1 });

      console.log(
        "[VERIFY_CODE] Found record:",
        passwordReset && {
          email: passwordReset.email,
          code: passwordReset.code,
          used: passwordReset.used,
          expiresAt: passwordReset.expiresAt,
          createdAt: passwordReset.createdAt,
        }
      );

      // If no record or code doesn't match, treat as invalid/expired
      if (!passwordReset || String(passwordReset.code) !== String(code)) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired verification code",
        });
      }

      // Check if code is expired
      if (new Date() > passwordReset.expiresAt) {
        await PasswordReset.findByIdAndDelete(passwordReset._id);
        return res.status(400).json({
          success: false,
          message: "Verification code has expired. Please request a new one.",
        });
      }

      // Code is valid - return success (code will be used in reset-password)
      res.json({
        success: true,
        message: "Verification code is valid",
        data: {
          email: normalizedEmail,
          code: code, // Return code for use in reset-password endpoint
        },
      });
    } catch (error) {
      console.error("Verify code error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// @route   POST /api/auth/reset-password
// @desc    Reset password with verified code
// @access  Public
router.post(
  "/reset-password",
  [
    // Only validate email format – do NOT normalize here, we normalize manually below
    body("email").isEmail(),
    body("code").isLength({ min: 6, max: 6 }).isNumeric(),
    body("newPassword").isLength({ min: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { email, code, newPassword } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      console.log("[RESET_PASSWORD] Incoming", {
        email,
        normalizedEmail,
        code,
      });

      // Find and verify the latest unused password reset record
      const passwordReset = await PasswordReset.findOne({
        email: normalizedEmail,
        used: false,
      }).sort({ createdAt: -1 });

      console.log(
        "[RESET_PASSWORD] Found record:",
        passwordReset && {
          email: passwordReset.email,
          code: passwordReset.code,
          used: passwordReset.used,
          expiresAt: passwordReset.expiresAt,
          createdAt: passwordReset.createdAt,
        }
      );

      if (!passwordReset || String(passwordReset.code) !== String(code)) {
        return res.status(400).json({
          success: false,
          message: "Invalid or expired verification code",
        });
      }

      // Check if code is expired
      if (new Date() > passwordReset.expiresAt) {
        await PasswordReset.findByIdAndDelete(passwordReset._id);
        return res.status(400).json({
          success: false,
          message: "Verification code has expired. Please request a new one.",
        });
      }

      // Find user
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Update password (bcrypt hashing is handled by User model pre-save hook)
      user.password = newPassword;
      await user.save();

      // Mark code as used
      passwordReset.used = true;
      await passwordReset.save();

      console.log(`[PasswordReset] Password reset successful for ${normalizedEmail}`);

      res.json({
        success: true,
        message: "Password has been reset successfully",
      });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
      }
    }
  );

// @route   POST /api/auth/social
// @desc    Create or login user via social auth (Google/Facebook)
// @access  Public
router.post("/social", async (req, res) => {
  try {
    const { provider, providerId, email, name, image } = req.body;

    if (!provider || !providerId || !email) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists by providerId or email
    let user = await User.findOne({
      $or: [
        { provider, providerId },
        { email: normalizedEmail },
      ],
    });

    if (user) {
      // Update existing user with social auth info if needed
      if (!user.provider) {
        user.provider = provider;
        user.providerId = providerId;
      }
      if (image && !user.avatar) {
        user.avatar = image;
      }
      if (name && !user.fullName) {
        user.fullName = name;
      }
      await user.save();
    } else {
      // Create new user
      // Generate username from email or name
      let username = email.split("@")[0].toLowerCase();
      if (name) {
        username = name.toLowerCase().replace(/\s+/g, "").substring(0, 20);
      }
      
      // Ensure username is unique
      let uniqueUsername = username;
      let counter = 1;
      while (await User.findOne({ username: uniqueUsername })) {
        uniqueUsername = `${username}${counter}`;
        counter++;
      }

      // Initialize Glicko-2 ratings with defaults (1500/350/0.06) for all categories
      const defaultRatings = {
        bullet: {
          rating: 1500.0,
          rd: 350.0,
          volatility: 0.06,
          gamesPlayed: 0,
        },
        blitz: {
          rating: 1500.0,
          rd: 350.0,
          volatility: 0.06,
          gamesPlayed: 0,
        },
        rapid: {
          rating: 1500.0,
          rd: 350.0,
          volatility: 0.06,
          gamesPlayed: 0,
        },
      };

      user = new User({
        email: normalizedEmail,
        username: uniqueUsername,
        password: Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-12), // Random password for social users
        fullName: name || "",
        avatar: image || null,
        provider,
        providerId,
        ageGroup: "18-25", // Default
        status: "online",
        ratings: defaultRatings,
      });

      await user.save();

      // Create initial stats
      const stats = new Stats({
        user: user._id,
      });
      await stats.save();
    }

    // Generate JWT token
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: "Social authentication successful",
      data: {
        token,
        user: {
          id: user._id,
          _id: user._id,
          username: user.username,
          email: user.email,
          fullName: user.fullName,
          avatar: user.avatar,
          ratings: user.ratings,
          status: user.status,
          country: user.country,
          hasAcceptedPolicies: user.hasAcceptedPolicies === true,
        },
      },
    });
  } catch (error) {
    console.error("Social auth error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during social authentication",
    });
  }
});

// @route   POST /api/auth/accept-policies
// @desc    Persist first-time policy acknowledgment
// @access  Private
router.post(
  "/accept-policies",
  [
    auth,
    body("acceptedTerms").custom((v) => v === true),
    body("confirmedAge13Plus").custom((v) => v === true),
    body("understandsSuspension").custom((v) => v === true),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "All policy confirmations are required",
          errors: errors.array(),
        });
      }

      if (req.user.hasAcceptedPolicies === true) {
        return res.json({
          success: true,
          message: "Policies already accepted",
          data: {
            hasAcceptedPolicies: true,
            acceptedPoliciesAt: req.user.acceptedPoliciesAt,
          },
        });
      }

      req.user.hasAcceptedPolicies = true;
      req.user.acceptedPoliciesAt = new Date();
      await req.user.save();

      return res.json({
        success: true,
        message: "Policies accepted successfully",
        data: {
          hasAcceptedPolicies: true,
          acceptedPoliciesAt: req.user.acceptedPoliciesAt,
        },
      });
    } catch (error) {
      console.error("Accept policies error:", error);
      return res.status(500).json({
        success: false,
        message: "Server error while accepting policies",
      });
    }
  }
);

// @route   POST /api/auth/delete-account
// @desc    Request account deletion (sets pending_deletion status)
// @access  Private
router.post("/delete-account", auth, async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Set account status to pending_deletion and deletionDate to 10 days from now
    user.accountStatus = "pending_deletion";
    user.deletionDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days
    await user.save();

    res.json({
      success: true,
      message: "Account deletion scheduled. You have 10 days to cancel by logging in.",
      deletionDate: user.deletionDate,
    });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router
