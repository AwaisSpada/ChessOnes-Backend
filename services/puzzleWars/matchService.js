const PuzzleRushPuzzle = require("../../models/PuzzleRushPuzzle");
const PuzzleWarsMatch = require("../../models/PuzzleWarsMatch");
const User = require("../../models/User");

const MATCH_DURATION_MS = PuzzleWarsMatch.MATCH_DURATION_MS;
const SEQUENCE_SIZE = PuzzleWarsMatch.SEQUENCE_SIZE;

function serializePuzzle(doc) {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    puzzleId: doc.puzzleId,
    fen: doc.fen,
    moves: doc.moves,
    rating: doc.rating,
    themes: doc.themes || [],
    category: doc.category || "",
  };
}

function serializePlayer(p) {
  return {
    userId: String(p.userId),
    username: p.username || "",
    fullName: p.fullName || "",
    avatar: p.avatar ?? null,
    puzzleRating: p.puzzleRating ?? 1200,
    score: p.score ?? 0,
    puzzleIndex: p.puzzleIndex ?? 0,
    ready: !!p.ready,
  };
}

function serializeMatch(doc, { includePuzzles = true } = {}) {
  if (!doc) return null;
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    matchId: String(o._id),
    status: o.status,
    mode: o.mode,
    durationMs: o.durationMs ?? MATCH_DURATION_MS,
    players: (o.players || []).map(serializePlayer),
    startedAt: o.startedAt ? new Date(o.startedAt).toISOString() : null,
    endsAt: o.endsAt ? new Date(o.endsAt).toISOString() : null,
    finishedAt: o.finishedAt ? new Date(o.finishedAt).toISOString() : null,
    winnerId: o.winnerId ? String(o.winnerId) : null,
    result: o.result,
    puzzles: includePuzzles ? o.puzzles || [] : undefined,
    puzzleCount: (o.puzzles || []).length,
  };
}

async function loadUserBrief(userId) {
  const user = await User.findById(userId)
    .select("username fullName avatar puzzleRating hasAcceptedPolicies")
    .lean();
  if (!user) return null;
  return {
    userId: String(user._id),
    username: user.username || "",
    fullName: user.fullName || user.username || "",
    avatar: user.avatar ?? null,
    puzzleRating: user.puzzleRating ?? 1200,
    hasAcceptedPolicies: user.hasAcceptedPolicies === true,
  };
}

async function sampleSharedSequenceSafe(count = SEQUENCE_SIZE) {
  const size = Math.min(60, Math.max(20, count));
  let puzzles = await PuzzleRushPuzzle.aggregate([
    { $match: { rating: { $gte: 600, $lte: 1800 } } },
    { $sample: { size } },
    {
      $project: {
        puzzleId: 1,
        fen: 1,
        moves: 1,
        rating: 1,
        themes: 1,
        category: 1,
      },
    },
  ]);

  if (puzzles.length < Math.min(10, size)) {
    puzzles = await PuzzleRushPuzzle.aggregate([
      { $sample: { size } },
      {
        $project: {
          puzzleId: 1,
          fen: 1,
          moves: 1,
          rating: 1,
          themes: 1,
          category: 1,
        },
      },
    ]);
  }

  if (!puzzles.length) {
    throw new Error("Puzzle pool is empty");
  }
  return puzzles.map(serializePuzzle);
}

function toPlayerDoc(brief) {
  return {
    userId: brief.userId,
    username: brief.username,
    fullName: brief.fullName,
    avatar: brief.avatar,
    puzzleRating: brief.puzzleRating,
    score: 0,
    puzzleIndex: 0,
    ready: false,
  };
}

async function createMatch({ mode, playerA, playerB, challengerId = null, challengeeId = null }) {
  const puzzles = await sampleSharedSequenceSafe(SEQUENCE_SIZE);
  const match = await PuzzleWarsMatch.create({
    status: mode === "friend" ? "pending" : "ready",
    mode,
    durationMs: MATCH_DURATION_MS,
    puzzles,
    players: [toPlayerDoc(playerA), toPlayerDoc(playerB)],
    challengerId,
    challengeeId,
  });
  return match;
}

/**
 * Only a live match still on the clock should block Find Rival / challenges.
 * Expired / null-endsAt shells must not trap players after a crash or missed timer.
 */
async function findLiveMatch(userId) {
  if (!userId) return null;
  return PuzzleWarsMatch.findOne({
    status: "live",
    "players.userId": userId,
    endsAt: { $gt: new Date() },
  })
    .select("_id status mode endsAt")
    .lean();
}

/**
 * Abandoned lobby / ready shells left after a previous session.
 * Closing them lets the player search again without a hard block.
 */
async function abandonNonLiveMatches(userId) {
  if (!userId) return 0;
  const res = await PuzzleWarsMatch.updateMany(
    {
      status: { $in: ["pending", "ready"] },
      "players.userId": userId,
    },
    {
      $set: {
        status: "finished",
        finishedAt: new Date(),
        result: "draw",
        winnerId: null,
      },
    },
  );
  return res.modifiedCount || res.nModified || 0;
}

/** Live matches whose clock already ended (or never got endsAt). */
async function abandonStaleLiveMatches(userId) {
  if (!userId) return 0;
  const graceMs = MATCH_DURATION_MS + 5 * 60 * 1000;
  const startedCutoff = new Date(Date.now() - graceMs);
  const res = await PuzzleWarsMatch.updateMany(
    {
      status: "live",
      "players.userId": userId,
      $or: [
        { endsAt: { $lte: new Date() } },
        { endsAt: null },
        { startedAt: { $lte: startedCutoff } },
      ],
    },
    {
      $set: {
        status: "finished",
        finishedAt: new Date(),
        result: "draw",
        winnerId: null,
      },
    },
  );
  return res.modifiedCount || res.nModified || 0;
}

/** Clear abandoned shells, then report only a truly active live match. */
async function releaseUserForQueue(userId) {
  await abandonNonLiveMatches(userId);
  await abandonStaleLiveMatches(userId);
  return findLiveMatch(userId);
}

/** @deprecated use findLiveMatch — kept for older callers */
async function findBusyMatch(userId) {
  return findLiveMatch(userId);
}

function findPlayerIndex(match, userId) {
  const uid = String(userId);
  return (match.players || []).findIndex((p) => String(p.userId) === uid);
}

function opponentOf(match, userId) {
  const idx = findPlayerIndex(match, userId);
  if (idx < 0) return null;
  return match.players[idx === 0 ? 1 : 0];
}

async function markReady(matchId, userId) {
  const match = await PuzzleWarsMatch.findById(matchId);
  if (!match) throw new Error("Match not found");
  if (match.status === "finished") throw new Error("Match already finished");
  if (match.status === "pending") throw new Error("Challenge not accepted yet");

  const idx = findPlayerIndex(match, userId);
  if (idx < 0) throw new Error("Not a player in this match");

  match.players[idx].ready = true;

  const bothReady = match.players.every((p) => p.ready);
  if (bothReady && match.status !== "live") {
    const now = new Date();
    match.status = "live";
    match.startedAt = now;
    // Full duration after client 3-2-1 (not eaten by the countdown).
    const countdownMs =
      PuzzleWarsMatch.CLIENT_COUNTDOWN_MS != null
        ? PuzzleWarsMatch.CLIENT_COUNTDOWN_MS
        : 3000;
    match.endsAt = new Date(
      now.getTime() + countdownMs + (match.durationMs || MATCH_DURATION_MS),
    );
  } else if (match.status === "pending") {
    match.status = "ready";
  } else if (match.status !== "live") {
    match.status = "ready";
  }

  await match.save();
  return match;
}

async function acceptChallenge(matchId, userId) {
  const match = await PuzzleWarsMatch.findById(matchId);
  if (!match) throw new Error("Match not found");
  if (match.mode !== "friend") throw new Error("Not a friend challenge");
  if (match.status !== "pending") throw new Error("Challenge is no longer pending");
  if (String(match.challengeeId) !== String(userId)) {
    throw new Error("Only the challenged player can accept");
  }
  match.status = "ready";
  await match.save();
  return match;
}

async function declineChallenge(matchId, userId) {
  const match = await PuzzleWarsMatch.findById(matchId);
  if (!match) throw new Error("Match not found");
  if (match.status !== "pending") throw new Error("Challenge is no longer pending");
  const uid = String(userId);
  const isParty =
    String(match.challengeeId) === uid || String(match.challengerId) === uid;
  if (!isParty) throw new Error("Not part of this challenge");
  match.status = "finished";
  match.finishedAt = new Date();
  match.result = "draw";
  await match.save();
  return match;
}

/**
 * Advance only the reporting player's index. Score++ only on solved.
 * Shared sequence is never mutated; both players read puzzles[player.puzzleIndex].
 */
async function reportProgress(matchId, userId, { action, puzzleId, puzzleIndex }) {
  const match = await PuzzleWarsMatch.findById(matchId);
  if (!match) throw new Error("Match not found");
  if (match.status !== "live") throw new Error("Match is not live");
  if (match.endsAt && Date.now() >= new Date(match.endsAt).getTime()) {
    return finishMatch(match);
  }

  const idx = findPlayerIndex(match, userId);
  if (idx < 0) throw new Error("Not a player in this match");

  const player = match.players[idx];
  const expectedIndex = player.puzzleIndex ?? 0;
  if (Number(puzzleIndex) !== expectedIndex) {
    throw new Error("Stale puzzle index");
  }

  const expected = match.puzzles[expectedIndex];
  if (!expected || expected.puzzleId !== String(puzzleId)) {
    throw new Error("Puzzle mismatch");
  }

  const act = String(action || "").toLowerCase();
  if (act === "solved") {
    player.score = (player.score || 0) + 1;
  } else if (act !== "skip" && act !== "wrong") {
    throw new Error("Invalid action");
  }

  player.puzzleIndex = expectedIndex + 1;
  match.markModified("players");
  await match.save();
  return match;
}

async function finishMatch(matchOrId) {
  const match =
    typeof matchOrId === "string" || matchOrId?._bsontype
      ? await PuzzleWarsMatch.findById(matchOrId)
      : matchOrId;
  if (!match) throw new Error("Match not found");
  if (match.status === "finished") return match;

  const [a, b] = match.players;
  const scoreA = a?.score ?? 0;
  const scoreB = b?.score ?? 0;
  if (scoreA > scoreB) {
    match.winnerId = a.userId;
    match.result = "win";
  } else if (scoreB > scoreA) {
    match.winnerId = b.userId;
    match.result = "win";
  } else {
    match.winnerId = null;
    match.result = "draw";
  }
  match.status = "finished";
  match.finishedAt = new Date();
  await match.save();
  return match;
}

module.exports = {
  MATCH_DURATION_MS,
  SEQUENCE_SIZE,
  serializeMatch,
  serializePlayer,
  loadUserBrief,
  createMatch,
  findLiveMatch,
  findBusyMatch,
  abandonNonLiveMatches,
  abandonStaleLiveMatches,
  releaseUserForQueue,
  findPlayerIndex,
  opponentOf,
  markReady,
  acceptChallenge,
  declineChallenge,
  reportProgress,
  finishMatch,
  sampleSharedSequenceSafe,
};
