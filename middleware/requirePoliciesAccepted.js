const requirePoliciesAccepted = (req, res, next) => {
  if (!req.user || req.user.hasAcceptedPolicies !== true) {
    return res.status(403).json({
      success: false,
      code: "POLICY_ACCEPTANCE_REQUIRED",
      message:
        "Policy acknowledgment is required before starting or joining games.",
    });
  }

  next();
};

module.exports = requirePoliciesAccepted;
