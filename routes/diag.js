/**
 * TEMPORARY network RTT diagnostics only — remove after measurement.
 * No gameplay / LiveGame / move-path involvement.
 *
 * GET /api/diag/rtt       — no auth, no DB (pure client↔Render path)
 * GET /api/diag/rtt-auth  — JWT verify only, no User.findById / Mongo
 */

const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

function markServer(kind, stage, extra = {}) {
  console.log(
    "[live-move-rtt-diag]",
    JSON.stringify({
      kind,
      stage,
      t: Date.now(),
      ...extra,
    })
  );
}

function jwtOnly(req, res, next) {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "No token provided, authorization denied",
    });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.userId) {
      return res.status(401).json({
        success: false,
        message: "Token is not valid",
      });
    }
    req.diagUserId = String(decoded.userId);
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Token is not valid",
    });
  }
}

function sendRtt(req, res, kind) {
  const t0 = process.hrtime.bigint();
  markServer(kind, "REQUEST_RECEIVED", {
    userId: req.diagUserId || null,
  });
  const serverNow = Date.now();
  const body = {
    success: true,
    data: {
      ok: true,
      kind,
      serverNow,
    },
  };
  res.on("finish", () => {
    const elapsedMs =
      Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
    markServer(kind, "RESPONSE_FINISH", {
      userId: req.diagUserId || null,
      serverHandlerMs: elapsedMs,
    });
  });
  markServer(kind, "RESPONSE_SENT", {
    userId: req.diagUserId || null,
  });
  return res.status(200).json(body);
}

router.get("/rtt", (req, res) => sendRtt(req, res, "rtt_public"));

router.get("/rtt-auth", jwtOnly, (req, res) =>
  sendRtt(req, res, "rtt_jwt_only")
);

module.exports = router;
