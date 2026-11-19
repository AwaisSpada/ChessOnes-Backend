const express = require("express");
const { body, validationResult } = require("express-validator");
const {
  sendMail,
  getContactInboxEmail,
  buildContactInquiryEmail,
  buildNewsletterSignupEmail,
  CHESSONES_FROM_SUPPORT,
} = require("../utils/sendMail");
const AppVersionPolicy = require("../models/AppVersionPolicy");

const router = express.Router();

const normalizePlatform = (raw) => {
  const value = String(raw || "")
    .trim()
    .toUpperCase();
  if (value === "ANDROID") return "ANDROID";
  if (value === "IOS" || value === "IPHONE" || value === "IPAD") return "IOS";
  return null;
};

const resolvePlatformFromRequest = (req) => {
  const fromQuery = normalizePlatform(req.query.platform);
  if (fromQuery) return fromQuery;
  const fromHeader = normalizePlatform(req.get("X-App-Platform"));
  if (fromHeader) return fromHeader;
  return null;
};

const toPublicPolicyPayload = (doc) => ({
  platform: doc.platform,
  latestVersion: doc.latestVersion,
  latestBuildNumber: doc.latestBuildNumber,
  minimumSupportedVersion: doc.minimumSupportedVersion,
  minimumSupportedBuildNumber: doc.minimumSupportedBuildNumber,
  updatePolicy: doc.updatePolicy,
  updateTitle: doc.updateTitle || "Update available",
  updateMessage:
    doc.updateMessage ||
    "A new version of ChessOnes is available. Please update for the best experience.",
  storeUrl: doc.storeUrl || "",
  isActive: Boolean(doc.isActive),
  updatedAt: doc.updatedAt || null,
});

// @route   GET /api/public/app-version-policy
// @desc    Active mobile app version policy for ANDROID or IOS (no auth)
// @access  Public
router.get("/app-version-policy", async (req, res) => {
  try {
    const platform = resolvePlatformFromRequest(req);
    if (!platform) {
      return res.status(400).json({
        success: false,
        message: "platform is required (android or ios).",
        data: null,
      });
    }

    const policy = await AppVersionPolicy.findOne({
      platform,
      isActive: true,
    }).lean();

    if (!policy) {
      return res.status(404).json({
        success: false,
        message: `No active app version policy for ${platform}.`,
        data: null,
      });
    }

    return res.json({
      success: true,
      message: "App version policy loaded.",
      data: toPublicPolicyPayload(policy),
    });
  } catch (err) {
    console.error("Public app-version-policy route error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load app version policy. Please try again later.",
      data: null,
    });
  }
});


// @route   POST /api/public/contact
// @desc    Send contact form message to team inbox (uses shared sendMail)
// @access  Public
router.post(
  "/contact",
  [
    body("name").trim().isLength({ min: 1, max: 200 }),
    body("email").isEmail().normalizeEmail(),
    body("message").trim().isLength({ min: 5, max: 10000 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Please check your name, email, and message, then try again.",
        });
      }

      const { name, email, message } = req.body;
      const inbox = getContactInboxEmail();
      const html = buildContactInquiryEmail({ name, email, message });
      const text = `Contact form — ${name} <${email}>\n\n${message}`;

      await sendMail({
        to: inbox,
        from: CHESSONES_FROM_SUPPORT,
        replyTo: email,
        subject: `[ChessOnes Contact] ${name}`,
        text,
        html,
      });

      return res.json({
        success: true,
        message: "Your message was sent. We will get back to you soon.",
      });
    } catch (err) {
      console.error("Public contact route error:", err);
      return res.status(500).json({
        success: false,
        message: "We could not send your message. Please try again later.",
      });
    }
  }
);

// @route   POST /api/public/newsletter
// @desc    Notify team of a newsletter subscription (uses shared sendMail)
// @access  Public
router.post(
  "/newsletter",
  [body("email").isEmail().normalizeEmail()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Please enter a valid email address.",
        });
      }

      const { email } = req.body;
      const inbox = getContactInboxEmail();
      const html = buildNewsletterSignupEmail({ subscriberEmail: email });
      const text = `Newsletter signup: ${email}`;

      await sendMail({
        to: inbox,
        from: CHESSONES_FROM_SUPPORT,
        subject: `[ChessOnes Newsletter] ${email}`,
        text,
        html,
      });

      return res.json({
        success: true,
        message: "Thanks — you are subscribed to updates.",
      });
    } catch (err) {
      console.error("Public newsletter route error:", err);
      return res.status(500).json({
        success: false,
        message: "We could not complete your subscription. Please try again later.",
      });
    }
  }
);

module.exports = router;
