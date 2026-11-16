/**
 * Fishnet HTTP protocol (lichess-org/fishnet doc/protocol.md).
 * Local worker uses the queue directly; rust fishnet can use these routes.
 */

const express = require("express");
const queue = require("../utils/fishnet/queue");

const router = express.Router();

function configuredKey() {
  return String(process.env.FISHNET_KEY || "").trim();
}

function authorized(req) {
  const expected = configuredKey();
  if (!expected) return false;
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return token.length > 0 && token === expected;
}

function requireKey(req, res, next) {
  if (authorized(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

router.post("/acquire", requireKey, (req, res) => {
  const slow = String(req.query.slow || "") === "true";
  const job = queue.acquire({ slow });
  if (!job) return res.status(204).end();
  return res.status(202).json(queue.toAcquirePayload(job));
});

router.post("/analysis/:workId", requireKey, (req, res) => {
  const workId = req.params.workId;
  const analysis = req.body && req.body.analysis;
  if (!Array.isArray(analysis)) {
    return res.status(400).json({ error: "analysis array required" });
  }
  const ok = queue.complete(workId, analysis, req.body.stockfish);
  if (!ok) return res.status(404).json({ error: "unknown work" });
  if (String(req.query.stop || "") === "true") return res.status(204).end();
  const next = queue.acquire({ slow: String(req.query.slow || "") === "true" });
  if (!next) return res.status(204).end();
  return res.status(202).json(queue.toAcquirePayload(next));
});

router.post("/abort/:workId", requireKey, (req, res) => {
  const ok = queue.abort(req.params.workId);
  if (!ok) return res.status(404).end();
  return res.status(204).end();
});

router.get("/status", (_req, res) => {
  res.status(200).json(queue.status());
});

router.get("/key", requireKey, (_req, res) => {
  res.status(200).end();
});

router.get("/key/:key", (req, res) => {
  const expected = configuredKey();
  if (expected && req.params.key === expected) return res.status(200).end();
  return res.status(404).end();
});

module.exports = router;
