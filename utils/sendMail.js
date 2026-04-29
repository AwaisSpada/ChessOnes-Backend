const nodemailer = require("nodemailer");
const { getPublicFrontendUrl, getEmailAssetBaseUrl } = require("./frontendUrl");

const CHESSONES_SMTP_USER = "admin@chessones.com";
const CHESSONES_FROM_NOREPLY = '"ChessOnes" <noreply@chessones.com>';
const CHESSONES_FROM_SUPPORT = '"ChessOnes Support" <support@chessones.com>';
const CHESSONES_CONTACT_INBOX = "admin@chessones.com";

/**
 * Absolute URL for the ChessOnes wordmark (served from Next.js /public/assets).
 * Uses getEmailAssetBaseUrl() so the logo URL works when FRONTEND_URL is localhost
 * (mail clients cannot load images from the developer's machine).
 */
function getEmailLogoUrl() {
  return `${getEmailAssetBaseUrl()}/assets/logo.png`;
}

/**
 * Shared HTML shell: #0A0F1B surface, subtle sky/cyan glow, card with border-white/10,
 * logo on top (matches web app chrome — no chess-piece emoji in header).
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getContactInboxEmail() {
  return CHESSONES_CONTACT_INBOX;
}

function renderChessOnesEmailLayout({ headline, bodyHtml }) {
  const homeUrl = getPublicFrontendUrl();
  const logoUrl = getEmailLogoUrl();
  return `
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background-color: #0A0F1B; padding: 40px 16px;">
  <tr>
    <td align="center" style="background-color: #0A0F1B; background-image: radial-gradient(ellipse 120% 90% at 50% -30%, rgba(56, 189, 248, 0.14), transparent), radial-gradient(ellipse 90% 70% at 100% 0%, rgba(6, 182, 212, 0.1), transparent);">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width: 560px; width: 100%; background: linear-gradient(155deg, rgba(15, 23, 42, 0.92) 0%, rgba(7, 16, 24, 0.96) 45%, rgba(3, 10, 18, 1) 100%); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255,255,255,0.04) inset;">
        <tr>
          <td align="center" style="padding: 32px 28px 12px 28px;">
            <a href="${homeUrl}/" target="_blank" rel="noopener noreferrer" style="text-decoration: none; display: inline-block;">
              <img src="${logoUrl}" width="200" height="56" alt="ChessOnes" border="0" style="display: block; max-width: 200px; width: 200px; height: auto; border: 0; outline: none;" />
            </a>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 4px 28px 20px 28px; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: #f8fafc; line-height: 1.3;">
            ${headline}
          </td>
        </tr>
        ${bodyHtml}
        <tr>
          <td style="padding: 24px 28px 32px 28px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 13px; line-height: 20px; color: #64748b;">
            Best regards,<br/>
            <span style="color: #94a3b8;">The ChessOnes Team</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/**
 * Primary CTA pill — sky → cyan (same family as in-app primary buttons).
 */
function emailPrimaryButton(href, label) {
  return `
        <tr>
          <td align="center" style="padding: 8px 28px 8px 28px;">
            <a href="${href}" target="_blank" rel="noopener noreferrer" style="display: inline-block; background: linear-gradient(90deg, #0284c7 0%, #0891b2 50%, #06b6d4 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 9999px; font-weight: 700; font-size: 15px; letter-spacing: 0.02em; box-shadow: 0 10px 25px -8px rgba(14, 165, 233, 0.45);">
              ${label}
            </a>
          </td>
        </tr>`;
}

// Microsoft 365 SMTP transporter (GoDaddy-hosted mailbox)
const transporter = nodemailer.createTransport({
  host: "smtp.office365.com",
  port: 587,
  secure: false, // STARTTLS
  auth: {
    user: CHESSONES_SMTP_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  tls: {
    ciphers: "SSLv3",
  },
});

/**
 * Sends an email using the shared transporter.
 * @param {Object} options nodemailer options (to, subject, text/html, etc.)
 */
async function sendMail(options = {}) {
  if (!options.to || !options.subject || (!options.text && !options.html)) {
    throw new Error(
      "Missing required mail options (to, subject, text or html)."
    );
  }

  if (!process.env.EMAIL_PASSWORD) {
    throw new Error("EMAIL_PASSWORD must be set in environment.");
  }

  return transporter.sendMail({
    from: options.from || CHESSONES_FROM_NOREPLY,
    ...options,
  });
}

/**
 * Builds the HTML body for a challenge invitation email.
 * @param {Object} options
 * @param {string} options.inviterName
 * @param {string} options.inviteeName
 * @param {string} options.joinUrl
 * @param {string} options.gameType
 * @param {{initial:number, increment:number}} options.timeControl
 */
function buildChallengeInviteEmail({
  inviterName,
  inviteeName,
  joinUrl,
  gameType,
  timeControl,
}) {
  const readableControl = `${Math.round((timeControl?.initial || 0) / 60000)}+${
    timeControl?.increment || 0
  }`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="font-family: Arial, sans-serif; background: #0b0b0f; padding: 32px; color: #f5f5f5;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background: #111827; border-radius: 16px; padding: 32px;">
            <tr>
              <td align="center" style="font-size: 24px; font-weight: bold; letter-spacing: 1px;">
                ChessOnes Challenge Awaits ♟️
              </td>
            </tr>
            <tr>
              <td style="padding-top: 24px; font-size: 16px; line-height: 24px;">
                Hi ${inviteeName || "Chesser"},
              </td>
            </tr>
            <tr>
              <td style="padding-top: 12px; font-size: 16px; line-height: 24px;">
                <strong>${
                  inviterName || "A fellow player"
                }</strong> just challenged you to a ${gameType} match on <strong>ChessOnes</strong>.
              </td>
            </tr>
            <tr>
              <td style="padding-top: 12px; font-size: 15px; color: #9ca3af;">
                Time Control: <strong>${readableControl}</strong>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-top: 28px;">
                <a href="${joinUrl}" style="background: #10b981; color: #0b0b0f; text-decoration: none; padding: 16px 32px; border-radius: 999px; font-weight: bold; display: inline-block;">
                  Join the game
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding-top: 20px; font-size: 14px; color: #9ca3af;">
                This link is valid for the next 15 minutes. If it expires, ask ${
                  inviterName || "your friend"
                } to send a new invite.
              </td>
            </tr>
            <tr>
              <td style="padding-top: 32px; font-size: 14px; color: #6b7280;">
                Happy playing,<br/>The ChessOnes Team
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Platform invite — uses shared ChessOnes email layout + logo from FRONTEND_URL.
 *
 * @param {Object} options
 * @param {string} options.inviterName
 * @param {string} options.inviteeEmail
 * @param {string} options.signupUrl
 */
function buildPlatformInviteEmail({ inviterName, inviteeEmail, signupUrl }) {
  const greet =
    inviteeEmail && inviteeEmail.includes("@")
      ? inviteeEmail.split("@")[0]
      : "there";
  const safeInviter = inviterName || "A friend";
  const bodyHtml = `
        <tr>
          <td style="padding: 8px 28px 0 28px; font-size: 16px; line-height: 24px; color: #e2e8f0;">
            Hi ${greet},
          </td>
        </tr>
        <tr>
          <td style="padding: 12px 28px 0 28px; font-size: 15px; line-height: 24px; color: #94a3b8;">
            <strong style="color: #f1f5f9;">${safeInviter}</strong> invited you to join <strong style="color: #f1f5f9;">ChessOnes</strong> — play online, track your ratings, and challenge friends.
          </td>
        </tr>
        <tr>
          <td style="padding: 12px 28px 0 28px; font-size: 14px; line-height: 22px; color: #64748b;">
            Use the button below to create your free account. After you sign up, you’ll be connected so you can play together anytime.
          </td>
        </tr>
        ${emailPrimaryButton(signupUrl, "Join ChessOnes")}
        <tr>
          <td style="padding: 16px 28px 0 28px; font-size: 12px; line-height: 18px; color: #64748b; text-align: center; word-break: break-all;">
            Or paste this link in your browser:<br/>
            <span style="color: #94a3b8;">${signupUrl}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 20px 28px 0 28px; font-size: 13px; line-height: 20px; color: #64748b;">
            <strong style="color: #94a3b8;">Note:</strong> This invite link expires in 7 days. If you didn’t expect this email, you can ignore it.
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 28px 16px 28px; font-size: 12px; color: #475569;">
            Sent to ${inviteeEmail || ""}
          </td>
        </tr>`;

  return renderChessOnesEmailLayout({
    headline: "You’re invited to ChessOnes",
    bodyHtml,
  });
}

/**
 * Password reset — verification code; same layout + logo as platform invite.
 * @param {Object} options
 * @param {string} options.userName
 * @param {string} options.verificationCode - 6-digit code
 */
function buildPasswordResetEmail({ userName, verificationCode }) {
  const bodyHtml = `
        <tr>
          <td style="padding: 8px 28px 0 28px; font-size: 16px; line-height: 24px; color: #e2e8f0;">
            Hi ${userName || "there"},
          </td>
        </tr>
        <tr>
          <td style="padding: 12px 28px 0 28px; font-size: 15px; line-height: 24px; color: #94a3b8;">
            We received a request to reset the password for your <strong style="color: #f1f5f9;">ChessOnes</strong> account.
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 28px 28px 16px 28px;">
            <table cellpadding="0" cellspacing="0" role="presentation" style="background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;">
              <tr>
                <td align="center" style="padding: 20px 36px 8px 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #64748b;">
                  Verification code
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 0 36px 22px 36px; font-size: 34px; font-weight: 800; letter-spacing: 10px; font-family: 'Courier New', Courier, monospace; color: #38bdf8;">
                  ${verificationCode}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 28px 8px 28px; font-size: 14px; line-height: 22px; color: #94a3b8; text-align: center;">
            Enter this code on the verification screen to set a new password.
          </td>
        </tr>
        <tr>
          <td style="padding: 12px 28px 24px 28px; font-size: 13px; line-height: 20px; color: #64748b;">
            <strong style="color: #94a3b8;">Important:</strong> This code expires in 10 minutes. If you didn’t request a password reset, you can ignore this email.
          </td>
        </tr>`;

  return renderChessOnesEmailLayout({
    headline: "Reset your password",
    bodyHtml,
  });
}

/**
 * Internal notification: contact form submission (HTML for team inbox).
 */
function buildContactInquiryEmail({ name, email, message }) {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const mailtoEmail = encodeURIComponent(email);
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br/>");
  const bodyHtml = `
        <tr>
          <td style="padding: 8px 28px 0 28px; font-size: 16px; line-height: 24px; color: #e2e8f0;">
            New contact form submission
          </td>
        </tr>
        <tr>
          <td style="padding: 12px 28px 0 28px; font-size: 14px; line-height: 22px; color: #94a3b8;">
            <strong style="color:#e2e8f0;">Name:</strong> ${safeName}<br/>
            <strong style="color:#e2e8f0;">Email:</strong> <a href="mailto:${mailtoEmail}" style="color:#38bdf8">${safeEmail}</a>
          </td>
        </tr>
        <tr>
          <td style="padding: 16px 28px 24px 28px; font-size: 14px; line-height: 22px; color: #cbd5e1;">
            ${safeMessage}
          </td>
        </tr>`;

  return renderChessOnesEmailLayout({
    headline: "Contact inquiry",
    bodyHtml,
  });
}

/**
 * Internal notification: newsletter signup (HTML for team inbox).
 */
function buildNewsletterSignupEmail({ subscriberEmail }) {
  const safe = escapeHtml(subscriberEmail);
  const mailto = encodeURIComponent(subscriberEmail);
  const bodyHtml = `
        <tr>
          <td style="padding: 8px 28px 0 28px; font-size: 16px; line-height: 24px; color: #e2e8f0;">
            Someone subscribed to the newsletter from the website.
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 28px 24px 28px; font-size: 15px; line-height: 24px; color: #94a3b8;">
            <strong style="color:#e2e8f0;">Email:</strong> <a href="mailto:${mailto}" style="color:#38bdf8">${safe}</a>
          </td>
        </tr>`;

  return renderChessOnesEmailLayout({
    headline: "Newsletter signup",
    bodyHtml,
  });
}

module.exports = {
  sendMail,
  CHESSONES_FROM_NOREPLY,
  CHESSONES_FROM_SUPPORT,
  getContactInboxEmail,
  buildChallengeInviteEmail,
  buildPlatformInviteEmail,
  buildPasswordResetEmail,
  buildContactInquiryEmail,
  buildNewsletterSignupEmail,
};
