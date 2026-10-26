const LoginEvent = require("../models/LoginEvent");

/** Fire-and-forget — never blocks or fails auth. */
function recordLoginEvent(userId) {
  if (!userId) return;
  LoginEvent.create({ user: userId }).catch((err) => {
    console.error("[LoginEvent] record failed:", err?.message || err);
  });
}

module.exports = { recordLoginEvent };
