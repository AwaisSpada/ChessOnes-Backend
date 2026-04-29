const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Optional auth middleware - doesn't fail if no token, but sets req.user if token is valid
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      // No token provided - continue without user
      req.user = null;
      return next();
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select("-password");

      if (user) {
        req.user = user;
      } else {
        req.user = null;
      }
    } catch (error) {
      // Invalid token - continue without user
      req.user = null;
    }

    next();
  } catch (error) {
    console.error("Optional auth middleware error:", error);
    // Continue without user on error
    req.user = null;
    next();
  }
};

module.exports = optionalAuth;




