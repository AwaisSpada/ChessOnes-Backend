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
const {
  createLiveMoveServerTiming,
  resolveIncomingRequestId,
} = require("../utils/liveMoveServerTiming");

const MOVE_TIMING = () =>
  process.env.LIVE_MOVE_TIMING === "1" ||
  process.env.LIVE_MOVE_TIMING === "true";

function useLiveHttpMovePath() {
  return LIVE_HTTP_VIA_MANAGER === true && LIVE_MEMORY_SNAPSHOT === true;
}

async function authAndPreloadGameForMove(req, res, next) {
  const t0 = Date.now();
  const timing = createLiveMoveServerTiming({
    gameId: req.params?.gameId,
    requestId: resolveIncomingRequestId(req),
  });
  req.liveMoveServerTiming = timing;
  timing.mark("REQUEST_RECEIVED");

  const mark = (label) => {
    if (!MOVE_TIMING()) return;
    console.log(
      `[live-move-timing] ${label}=${Date.now() - t0}ms game=${req.params?.gameId || "?"}`
    );
  };

  try {
    timing.mark("AUTH_STARTED");
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

    mark("jwt_ok");

    const gameId = req.params.gameId;
    const phase2 = useLiveHttpMovePath();

    timing.mark("GAME_LOAD_STARTED", {
      phase2HttpViaManager: phase2,
    });
    timing.mark("LIVE_GAME_MANAGER_LOOKUP_STARTED");

    const userPromise = User.findById(decoded.userId)
      .select("-password")
      .then((user) => {
        timing.setUserId(user?._id);
        timing.mark("AUTH_COMPLETED");
        return user;
      });

    let gamePromise;

    if (phase2 && gameId) {
      const cached = LiveGameManager.get(gameId);
      if (cached) {
        timing.mark("LIVE_GAME_MANAGER_LOOKUP_COMPLETED", {
          source: "memory",
          status: cached.status,
          ply: cached.ply,
        });
        timing.mark("GAME_LOAD_COMPLETED", {
          source: "memory",
          skippedMongo: true,
        });
        // Leave req.preloadedGame unset so bot/legacy fallback can still Game.findOne.
        req.liveGameMemoryHit = true;
        gamePromise = Promise.resolve(null);
      } else {
        timing.mark("LIVE_GAME_MANAGER_LOOKUP_COMPLETED", {
          source: "miss",
          deferredHydrate: true,
        });
        // Defer Mongo hydrate to httpMoveAdapter.getOrHydrate (single load on miss).
        timing.mark("GAME_LOAD_COMPLETED", {
          source: "deferred_to_adapter",
          skippedMongo: true,
        });
        req.liveGameMemoryHit = false;
        gamePromise = Promise.resolve(null);
      }
    } else {
      timing.mark("LIVE_GAME_MANAGER_LOOKUP_COMPLETED", {
        source: "not_applicable",
        reason: "phase2_flags_off",
      });
      gamePromise = (
        gameId ? Game.findOne({ gameId }) : Promise.resolve(null)
      ).then((game) => {
        timing.mark("GAME_LOAD_COMPLETED", { source: "mongo" });
        return game;
      });
    }

    const [user, game] = await Promise.all([userPromise, gamePromise]);

    mark("user_and_game_loaded");

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
    req._liveMoveTimingT0 = t0;
    timing.setUserId(user._id);
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
