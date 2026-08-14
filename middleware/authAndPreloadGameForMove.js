/**
 * Move-route auth + game preload.
 *
 * Same guarantees as `auth` + `requirePoliciesAccepted`.
 *
 * When LIVE_HTTP_VIA_MANAGER + LIVE_MEMORY_SNAPSHOT are on, skips Mongo
 * Game.findOne here: LiveGameManager memory hit is authoritative; cache miss
 * hydrates once inside httpMoveAdapter (avoids double Mongo load).
 *
 * Legacy path (flags off / bot fallback): still Game.findOne in parallel with User.
 */

const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Game = require("../models/Game");
const {
  LIVE_MEMORY_SNAPSHOT,
  LIVE_HTTP_VIA_MANAGER,
} = require("../services/live/flags");
const LiveGameManager = require("../services/live/LiveGameManager");

function useLiveHttpMovePath() {
  return LIVE_HTTP_VIA_MANAGER === true && LIVE_MEMORY_SNAPSHOT === true;
}

async function authAndPreloadGameForMove(req, res, next) {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No token provided, authorization denied",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: "Token is not valid",
      });
    }

    if (!decoded?.userId) {
      return res.status(401).json({
        success: false,
        message: "Token is not valid",
      });
    }

    const gameId = req.params.gameId;
    const phase2 = useLiveHttpMovePath();

    const userPromise = User.findById(decoded.userId).select("-password");

    let gamePromise;

    if (phase2 && gameId) {
      const cached = LiveGameManager.get(gameId);
      if (cached) {
        // Leave req.preloadedGame unset so bot/legacy fallback can still Game.findOne.
        req.liveGameMemoryHit = true;
        gamePromise = Promise.resolve(null);
      } else {
        // Defer Mongo hydrate to httpMoveAdapter.getOrHydrate (single load on miss).
        req.liveGameMemoryHit = false;
        gamePromise = Promise.resolve(null);
      }
    } else {
      gamePromise = gameId ? Game.findOne({ gameId }) : Promise.resolve(null);
    }

    const [user, game] = await Promise.all([userPromise, gamePromise]);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Token is not valid",
      });
    }

    if (user.isSuspended) {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended by an administrator",
      });
    }

    if (user.hasAcceptedPolicies !== true) {
      return res.status(403).json({
        success: false,
        code: "POLICY_ACCEPTANCE_REQUIRED",
        message:
          "Policy acknowledgment is required before starting or joining games.",
      });
    }

    req.user = user;
    if (!phase2) {
      req.preloadedGame = game;
    }
    next();
  } catch (error) {
    console.error("authAndPreloadGameForMove error:", error);
    return res.status(401).json({
      success: false,
      message: "Token is not valid",
    });
  }
}

module.exports = authAndPreloadGameForMove;
