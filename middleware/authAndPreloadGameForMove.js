/**
 * Move-route auth + game preload.
 *
 * Same guarantees as `auth` + `requirePoliciesAccepted`, but runs
 * User.findById and Game.findOne in parallel so the live-human clock drain
 * window (settle → applyServerElapsedClock) is max(auth, game) not sum.
 *
 * Does not change ClockAuthority, flags, or LIVE_WS_MOVES.
 */
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Game = require("../models/Game");
const {
  createLiveMoveServerTiming,
  resolveIncomingRequestId,
} = require("../utils/liveMoveServerTiming");

const MOVE_TIMING = () =>
  process.env.LIVE_MOVE_TIMING === "1" ||
  process.env.LIVE_MOVE_TIMING === "true";

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
    timing.mark("GAME_LOAD_STARTED");
    const userPromise = User.findById(decoded.userId)
      .select("-password")
      .then((user) => {
        timing.setUserId(user?._id);
        timing.mark("AUTH_COMPLETED");
        return user;
      });
    const gamePromise = (gameId
      ? Game.findOne({ gameId })
      : Promise.resolve(null)
    ).then((game) => {
      timing.mark("GAME_LOAD_COMPLETED");
      return game;
    });

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
    req.preloadedGame = game;
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
