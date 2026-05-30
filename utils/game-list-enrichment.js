const mongoose = require("mongoose");
const Game = require("../models/Game");
const Review = require("../models/Review");

/** Same idea as frontend getGameEndTimestamp — NOT updatedAt (reviews bump it). */
const END_TIME_ADD_FIELDS = {
  endTime: {
    $let: {
      vars: {
        lastMove: { $arrayElemAt: [{ $ifNull: ["$moves", []] }, -1] },
      },
      in: {
        $ifNull: ["$$lastMove.timestamp", "$updatedAt"],
      },
    },
  },
};

function toObjectId(id) {
  if (id == null) return id;
  const s = String(id);
  if (mongoose.Types.ObjectId.isValid(s)) {
    return new mongoose.Types.ObjectId(s);
  }
  return id;
}

function userGamesMatch(userId) {
  const oid = toObjectId(userId);
  return {
    $or: [{ "players.white": oid }, { "players.black": oid }],
  };
}

function normalizeAccuracy(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

/** Same labels as review page MoveStatsPanel — must match what users see in Stats tab. */
const EXCELLENT_MOVE_LABELS = new Set([
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
]);

/**
 * Accuracy from review moves (review Stats tab formula), not reviewData.players.*.accuracy
 * which uses a different centipawn-loss formula and can disagree with the UI.
 */
function accuracyFromReviewMoves(moves, side) {
  if (!Array.isArray(moves) || moves.length === 0 || !side) return null;

  const playerMoves = moves.filter((_, idx) =>
    side === "white" ? idx % 2 === 0 : idx % 2 === 1
  );
  const validMoves = playerMoves.filter(
    (m) => !m?.error && m?.centipawnLoss !== undefined
  );
  if (validMoves.length === 0) return null;

  let excellentMoves = 0;
  for (const move of validMoves) {
    const label = String(move.label || "").toLowerCase();
    if (EXCELLENT_MOVE_LABELS.has(label)) excellentMoves++;
  }

  return normalizeAccuracy((excellentMoves / validMoves.length) * 100);
}

function playerIdStr(playerRef) {
  if (playerRef == null || playerRef === "") return "";
  if (typeof playerRef === "object") {
    const id = playerRef._id ?? playerRef.id ?? playerRef;
    if (id != null && typeof id === "object" && typeof id.toString === "function") {
      return String(id);
    }
    return String(id ?? "");
  }
  return String(playerRef);
}

function idsMatch(a, b) {
  const sa = playerIdStr(a);
  const sb = playerIdStr(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  if (
    mongoose.Types.ObjectId.isValid(sa) &&
    mongoose.Types.ObjectId.isValid(sb)
  ) {
    return new mongoose.Types.ObjectId(sa).equals(new mongoose.Types.ObjectId(sb));
  }
  return false;
}

/**
 * Which side the viewing user played — same rules as game-review enrichReviewWithGameData.
 * Bot games: human is opposite of botSide (players.white/black IDs alone are not enough).
 */
function resolveUserSide(game, forUserId) {
  if (!game || forUserId == null) return null;
  const players = game.players;
  if (!players) return null;

  if (game.type === "bot" && game.botSide) {
    return game.botSide === "white" ? "black" : "white";
  }

  const whiteId = playerIdStr(players.white);
  const blackId = playerIdStr(players.black);
  if (whiteId && idsMatch(whiteId, forUserId)) return "white";
  if (blackId && idsMatch(blackId, forUserId)) return "black";

  return null;
}

/**
 * Attach the given user's review accuracy to each game (null when no completed review).
 */
async function attachReviewAccuracyToGames(games, forUserId) {
  const uid = forUserId != null ? String(forUserId).trim() : "";
  if (!Array.isArray(games) || games.length === 0 || !uid) {
    return games.map((g) => (g.toObject ? g.toObject() : { ...g }));
  }

  const gameIds = games.map((g) => g.gameId).filter(Boolean);
  const reviews =
    gameIds.length === 0
      ? []
      : await Review.find({
          gameId: { $in: gameIds },
          status: "completed",
          reviewData: { $ne: null },
        })
          .select("gameId reviewData.moves")
          .lean();

  const reviewMap = new Map(reviews.map((r) => [r.gameId, r]));

  return games.map((game) => {
    const obj = game.toObject ? game.toObject() : { ...game };
    const review = reviewMap.get(obj.gameId);
    const moves = review?.reviewData?.moves;
    if (!Array.isArray(moves) || moves.length === 0) {
      obj.accuracy = null;
      return obj;
    }

    const side = resolveUserSide(obj, uid);
    if (!side) {
      obj.accuracy = null;
      return obj;
    }
    obj.accuracy = accuracyFromReviewMoves(moves, side);
    return obj;
  });
}

/** Same skip rules as services/updateGameRatings.js */
function gameAffectsRating(game) {
  if (!game) return false;
  if (game.result?.reason === "first-move-abandon") return false;
  if (game.type === "bot") return false;
  if (game.isRated === false) return false;
  if (!game.players?.white || !game.players?.black) return false;
  if (!Array.isArray(game.moves) || game.moves.length === 0) return false;
  if (!game.category || game.category === "un-timed") return false;
  return true;
}

/** Attach viewing user's stored rating delta (null when game did not affect rating). */
function attachRatingChangeToGames(games, forUserId) {
  const uid = forUserId != null ? String(forUserId).trim() : "";
  if (!Array.isArray(games) || games.length === 0 || !uid) {
    return games.map((g) => (g.toObject ? g.toObject() : { ...g }));
  }

  return games.map((game) => {
    const obj = game.toObject ? game.toObject() : { ...game };
    if (!gameAffectsRating(obj)) {
      obj.ratingChange = null;
      return obj;
    }

    const side = resolveUserSide(obj, uid);
    const changes = obj.ratingChanges;
    if (!side || !changes || typeof changes !== "object") {
      obj.ratingChange = null;
      return obj;
    }

    const delta = changes[side];
    obj.ratingChange =
      typeof delta === "number" && Number.isFinite(delta) ? delta : null;
    return obj;
  });
}

/** Completed games whose last move (or fallback createdAt) is today — server local date. */
async function getPlayedTodayCounts(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const countFor = async (extraMatch = {}) => {
    const rows = await Game.aggregate([
      {
        $match: {
          ...userGamesMatch(userId),
          status: "completed",
          ...extraMatch,
        },
      },
      { $addFields: END_TIME_ADD_FIELDS },
      { $match: { endTime: { $gte: startOfDay } } },
      { $count: "total" },
    ]);
    return rows[0]?.total ?? 0;
  };

  const [overall, bullet, blitz, rapid] = await Promise.all([
    countFor({}),
    countFor({ category: "bullet" }),
    countFor({ category: "blitz" }),
    countFor({ category: "rapid" }),
  ]);

  return { overall, bullet, blitz, rapid };
}

/**
 * List user games sorted by when they were actually played (last move time),
 * not document updatedAt — so review generation does not reorder history.
 */
async function fetchUserGamesByPlayEndTime(userId, query, skip, limit) {
  const pipeline = [
    { $match: query },
    { $addFields: END_TIME_ADD_FIELDS },
    { $sort: { endTime: -1 } },
    { $skip: skip },
    { $limit: limit },
  ];

  const rows = await Game.aggregate(pipeline);

  return Game.populate(rows, [
    {
      path: "players.white",
      select: "username fullName avatar country rating isDeleted",
    },
    {
      path: "players.black",
      select: "username fullName avatar country rating isDeleted",
    },
    {
      path: "bot",
      select: "key name photoUrl difficulty elo subtitle description",
    },
  ]);
}

module.exports = {
  attachReviewAccuracyToGames,
  attachRatingChangeToGames,
  getPlayedTodayCounts,
  fetchUserGamesByPlayEndTime,
  userGamesMatch,
  toObjectId,
  gameAffectsRating,
};
