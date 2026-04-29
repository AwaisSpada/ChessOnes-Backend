const express = require("express");
const { body, validationResult } = require("express-validator");
const {
  sendMail,
  getContactInboxEmail,
  buildContactInquiryEmail,
  buildNewsletterSignupEmail,
  CHESSONES_FROM_SUPPORT,
} = require("../utils/sendMail");

const router = express.Router();

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
