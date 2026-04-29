const User = require("../models/User");

/**
 * Middleware to check if the authenticated user is an admin
 * Must be used after the auth middleware
 */
const isAdmin = async (req, res, next) => {
  try {
    // Check if user is authenticated (should be set by auth middleware)
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Fetch the full user document to check role
    const user = await User.findById(req.user._id).select("role");
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Check if user is admin
    if (user.role !== "ADMIN") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin privileges required.",
      });
    }

    // User is admin, proceed
    next();
  } catch (error) {
    console.error("[isAdmin] Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while checking admin status",
    });
  }
};

module.exports = isAdmin;

