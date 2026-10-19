/**
 * Puzzle Wars REST — isolated from /api/puzzle-rush and /api/games.
 */
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const PuzzleWarsMatch = require("../models/PuzzleWarsMatch");
const matchService = require("../services/puzzleWars/matchService");

/**
 * GET /api/puzzle-wars/matches/:matchId
 * Authoritative match snapshot including shared puzzle sequence.
 */
router.get("/matches/:matchId", auth, async (req, res) => {
  try {
    const match = await PuzzleWarsMatch.findById(req.params.matchId);
    if (!match) {
      return res.status(404).json({ success: false, message: "Match not found" });
    }
    const uid = String(req.user._id);
    const isPlayer = match.players.some((p) => String(p.userId) === uid);
    if (!isPlayer) {
      return res.status(403).json({ success: false, message: "Not a player in this match" });
    }
    return res.json({
      success: true,
      data: matchService.serializeMatch(match, { includePuzzles: true }),
    });
  } catch (error) {
    console.error("Puzzle Wars get match error:", error);
    return res.status(500).json({ success: false, message: "Failed to load match" });
  }
});

/**
 * GET /api/puzzle-wars/lobby
 * Snapshot of open random seeks (also pushed via socket).
 */
router.get("/lobby", auth, async (_req, res) => {
  try {
    // Lobby is socket-primary; REST returns empty stub for cold start UIs.
    return res.json({ success: true, data: { seeks: [] } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to load lobby" });
  }
});

module.exports = router;
