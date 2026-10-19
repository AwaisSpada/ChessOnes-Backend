/**
 * Puzzle Wars — isolated Socket.IO + matchmaking.
 * Does NOT touch chess matchmakingPool, Game invites, or Puzzle Rush routes.
 */
const matchService = require("./matchService");
const PuzzleWarsMatch = require("../../models/PuzzleWarsMatch");
const User = require("../../models/User");

/** @type {import('socket.io').Server | null} */
let ioRef = null;

/** userId -> { userId, socketId, brief, joinedAt } */
const queue = new Map();
/** userId -> { userId, socketId, brief, postedAt } open seeks */
const openSeeks = new Map();
/** matchId -> timeout handle */
const endTimers = new Map();
/** sockets subscribed to open lobby */
const lobbySockets = new Set();

async function policiesOk(userId) {
  if (!userId) return false;
  const user = await User.findById(userId).select("hasAcceptedPolicies").lean();
  return !!(user && user.hasAcceptedPolicies === true);
}

function emitToUser(userId, event, payload) {
  if (!ioRef || !userId) return;
  ioRef.to(`user:${String(userId)}`).emit(event, payload);
}

function lobbyPayload() {
  return {
    seeks: [...openSeeks.values()].map((s) => ({
      userId: s.userId,
      username: s.brief.username,
      fullName: s.brief.fullName,
      avatar: s.brief.avatar,
      puzzleRating: s.brief.puzzleRating,
      postedAt: s.postedAt,
    })),
  };
}

function broadcastLobby() {
  if (!ioRef) return;
  const payload = lobbyPayload();
  for (const socketId of lobbySockets) {
    const sock = ioRef.sockets.sockets.get(socketId);
    if (sock) sock.emit("puzzle-wars:lobby", payload);
  }
}

/** Remove seeks for users already in pending/ready/live matches. */
async function scrubBusySeeks() {
  const ids = [...openSeeks.keys()];
  if (!ids.length) return false;
  let changed = false;
  await Promise.all(
    ids.map(async (uid) => {
      try {
        const busy = await matchService.findBusyMatch(uid);
        if (busy) {
          queue.delete(uid);
          if (openSeeks.delete(uid)) changed = true;
        }
      } catch {
        /* ignore single-user lookup errors */
      }
    }),
  );
  return changed;
}

function clearEndTimer(matchId) {
  const t = endTimers.get(String(matchId));
  if (t) clearTimeout(t);
  endTimers.delete(String(matchId));
}

function scheduleMatchEnd(match) {
  const matchId = String(match._id);
  clearEndTimer(matchId);
  if (!match.endsAt) return;
  const ms = Math.max(0, new Date(match.endsAt).getTime() - Date.now());
  const handle = setTimeout(async () => {
    endTimers.delete(matchId);
    try {
      const finished = await matchService.finishMatch(matchId);
      broadcastFinished(finished);
    } catch (err) {
      console.error("[puzzle-wars] end timer error:", err);
    }
  }, ms + 50);
  endTimers.set(matchId, handle);
}

function broadcastState(match) {
  const payload = matchService.serializeMatch(match, { includePuzzles: false });
  for (const p of match.players || []) {
    emitToUser(p.userId, "puzzle-wars:state", payload);
  }
}

function broadcastFinished(match) {
  clearEndTimer(match._id);
  // Safety: never leave finished players listed as open challenges.
  leaveQueueMany(playerIdsOf(match));
  const payload = matchService.serializeMatch(match, { includePuzzles: false });
  for (const p of match.players || []) {
    emitToUser(p.userId, "puzzle-wars:finished", payload);
  }
}

function leaveQueueMany(userIds) {
  let seeksChanged = false;
  for (const id of userIds || []) {
    if (!id) continue;
    const uid = String(id);
    queue.delete(uid);
    if (openSeeks.delete(uid)) seeksChanged = true;
  }
  if (seeksChanged) broadcastLobby();
}

function leaveQueue(userId) {
  leaveQueueMany([userId]);
}

function playerIdsOf(match) {
  return (match?.players || []).map((p) => p.userId).filter(Boolean);
}

function emitMatchFound(match) {
  // Every match path must drop both players from queue + open seeks.
  leaveQueueMany(playerIdsOf(match));
  const full = matchService.serializeMatch(match, { includePuzzles: true });
  for (const p of match.players || []) {
    const opp = matchService.opponentOf(match, p.userId);
    emitToUser(p.userId, "puzzle-wars:match-found", {
      ...full,
      opponent: opp ? matchService.serializePlayer(opp) : null,
    });
  }
}

async function tryMatchQueue() {
  if (queue.size < 2) return;
  const entries = [...queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  const a = entries[0];
  const b = entries[1];
  if (!a || !b) return;
  queue.delete(a.userId);
  queue.delete(b.userId);
  openSeeks.delete(a.userId);
  openSeeks.delete(b.userId);
  broadcastLobby();

  try {
    const match = await matchService.createMatch({
      mode: "random",
      playerA: a.brief,
      playerB: b.brief,
    });
    emitMatchFound(match);
  } catch (err) {
    console.error("[puzzle-wars] queue match error:", err);
    emitToUser(a.userId, "puzzle-wars:error", { message: err.message || "Match failed" });
    emitToUser(b.userId, "puzzle-wars:error", { message: err.message || "Match failed" });
  }
}

function bindSocket(socket) {
  const uidOf = () => String(socket.data.userId || "");

  socket.on("puzzle-wars:join-queue", async () => {
    try {
      const userId = uidOf();
      if (!userId) {
        socket.emit("puzzle-wars:error", { message: "Not registered" });
        return;
      }
      if (!(await policiesOk(userId))) {
        socket.emit("puzzle-wars:error", { message: "Accept policies to play" });
        return;
      }
      const busy = await matchService.findBusyMatch(userId);
      if (busy) {
        socket.emit("puzzle-wars:error", {
          message: "Already in a Puzzle Wars match",
        });
        return;
      }
      const brief = await matchService.loadUserBrief(userId);
      if (!brief) {
        socket.emit("puzzle-wars:error", { message: "User not found" });
        return;
      }
      leaveQueue(userId);
      queue.set(userId, {
        userId,
        socketId: socket.id,
        brief,
        joinedAt: Date.now(),
      });
      // Also post as open seek so lobby players can accept
      openSeeks.set(userId, {
        userId,
        socketId: socket.id,
        brief,
        postedAt: new Date().toISOString(),
      });
      broadcastLobby();
      socket.emit("puzzle-wars:queue-joined", { ok: true });
      await tryMatchQueue();
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Queue failed" });
    }
  });

  socket.on("puzzle-wars:leave-queue", () => {
    const userId = uidOf();
    if (!userId) return;
    leaveQueue(userId);
    socket.emit("puzzle-wars:queue-left", { ok: true });
  });

  socket.on("puzzle-wars:lobby-subscribe", async () => {
    lobbySockets.add(socket.id);
    const scrubbed = await scrubBusySeeks();
    if (scrubbed) broadcastLobby();
    else socket.emit("puzzle-wars:lobby", lobbyPayload());
  });

  socket.on("puzzle-wars:lobby-unsubscribe", () => {
    lobbySockets.delete(socket.id);
  });

  socket.on("puzzle-wars:accept-open", async (payload = {}) => {
    try {
      const joinerId = uidOf();
      const targetUserId = String(payload.targetUserId || "");
      if (!joinerId || !targetUserId) {
        socket.emit("puzzle-wars:error", { message: "Invalid accept" });
        return;
      }
      if (joinerId === targetUserId) {
        socket.emit("puzzle-wars:error", { message: "Cannot accept your own seek" });
        return;
      }
      if (!(await policiesOk(joinerId))) {
        socket.emit("puzzle-wars:error", { message: "Accept policies to play" });
        return;
      }
      const seek = openSeeks.get(targetUserId);
      if (!seek) {
        socket.emit("puzzle-wars:error", { message: "Challenge no longer available" });
        return;
      }
      const [targetBusy, joinerBusy] = await Promise.all([
        matchService.findBusyMatch(targetUserId),
        matchService.findBusyMatch(joinerId),
      ]);
      if (targetBusy) {
        leaveQueue(targetUserId);
        socket.emit("puzzle-wars:error", {
          message: "Challenge no longer available",
        });
        return;
      }
      if (joinerBusy) {
        socket.emit("puzzle-wars:error", {
          message: "Already in a Puzzle Wars match",
        });
        return;
      }
      const joiner = await matchService.loadUserBrief(joinerId);
      if (!joiner) {
        socket.emit("puzzle-wars:error", { message: "User not found" });
        return;
      }
      leaveQueue(targetUserId);
      leaveQueue(joinerId);
      const match = await matchService.createMatch({
        mode: "open",
        playerA: seek.brief,
        playerB: joiner,
      });
      emitMatchFound(match);
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Accept failed" });
    }
  });

  socket.on("puzzle-wars:challenge-friend", async (payload = {}) => {
    try {
      const challengerId = uidOf();
      const friendId = String(payload.friendId || "");
      if (!challengerId || !friendId) {
        socket.emit("puzzle-wars:error", { message: "Invalid challenge" });
        return;
      }
      if (challengerId === friendId) {
        socket.emit("puzzle-wars:error", { message: "Cannot challenge yourself" });
        return;
      }
      if (!(await policiesOk(challengerId))) {
        socket.emit("puzzle-wars:error", { message: "Accept policies to play" });
        return;
      }
      const [challenger, friend] = await Promise.all([
        matchService.loadUserBrief(challengerId),
        matchService.loadUserBrief(friendId),
      ]);
      if (!challenger || !friend) {
        socket.emit("puzzle-wars:error", { message: "User not found" });
        return;
      }
      const [challengerBusy, friendBusy] = await Promise.all([
        matchService.findBusyMatch(challengerId),
        matchService.findBusyMatch(friendId),
      ]);
      if (challengerBusy) {
        socket.emit("puzzle-wars:error", {
          message: "Already in a Puzzle Wars match",
        });
        return;
      }
      if (friendBusy) {
        leaveQueue(friendId);
        socket.emit("puzzle-wars:error", {
          message: "Friend is already in a Puzzle Wars match",
        });
        return;
      }
      // Drop both from open seeks so neither stays Accept-able mid-challenge.
      leaveQueueMany([challengerId, friendId]);
      const match = await matchService.createMatch({
        mode: "friend",
        playerA: challenger,
        playerB: friend,
        challengerId,
        challengeeId: friendId,
      });
      const serialized = matchService.serializeMatch(match, { includePuzzles: false });
      socket.emit("puzzle-wars:challenge-sent", serialized);
      emitToUser(friendId, "puzzle-wars:challenge-incoming", {
        ...serialized,
        from: matchService.serializePlayer(match.players[0]),
      });
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Challenge failed" });
    }
  });

  socket.on("puzzle-wars:accept-challenge", async (payload = {}) => {
    try {
      const userId = uidOf();
      const matchId = String(payload.matchId || "");
      if (!userId || !matchId) {
        socket.emit("puzzle-wars:error", { message: "Invalid accept" });
        return;
      }
      if (!(await policiesOk(userId))) {
        socket.emit("puzzle-wars:error", { message: "Accept policies to play" });
        return;
      }
      const match = await matchService.acceptChallenge(matchId, userId);
      leaveQueueMany(playerIdsOf(match));
      emitMatchFound(match);
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Accept failed" });
    }
  });

  socket.on("puzzle-wars:decline-challenge", async (payload = {}) => {
    try {
      const userId = uidOf();
      const matchId = String(payload.matchId || "");
      if (!userId || !matchId) return;
      const match = await matchService.declineChallenge(matchId, userId);
      const payloadOut = { matchId: String(match._id) };
      for (const p of match.players || []) {
        emitToUser(p.userId, "puzzle-wars:challenge-declined", payloadOut);
      }
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Decline failed" });
    }
  });

  socket.on("puzzle-wars:ready", async (payload = {}) => {
    try {
      const userId = uidOf();
      const matchId = String(payload.matchId || "");
      if (!userId || !matchId) {
        socket.emit("puzzle-wars:error", { message: "Invalid ready" });
        return;
      }
      const match = await matchService.markReady(matchId, userId);
      broadcastState(match);
      if (match.status === "live" && match.endsAt) {
        scheduleMatchEnd(match);
        // Include puzzles once when live starts (clients may already have them)
        emitMatchFound(match);
      }
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Ready failed" });
    }
  });

  socket.on("puzzle-wars:report", async (payload = {}) => {
    try {
      const userId = uidOf();
      const matchId = String(payload.matchId || "");
      if (!userId || !matchId) return;
      const match = await matchService.reportProgress(matchId, userId, {
        action: payload.action,
        puzzleId: payload.puzzleId,
        puzzleIndex: payload.puzzleIndex,
      });
      if (match.status === "finished") {
        broadcastFinished(match);
      } else {
        broadcastState(match);
      }
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Report failed" });
    }
  });

  socket.on("puzzle-wars:forfeit", async (payload = {}) => {
    try {
      const userId = uidOf();
      const matchId = String(payload.matchId || "");
      if (!userId || !matchId) return;
      const match = await PuzzleWarsMatch.findById(matchId);
      if (!match || match.status === "finished") return;
      const idx = matchService.findPlayerIndex(match, userId);
      if (idx < 0) return;
      const opp = match.players[idx === 0 ? 1 : 0];
      match.winnerId = opp.userId;
      match.result = "win";
      match.status = "finished";
      match.finishedAt = new Date();
      await match.save();
      broadcastFinished(match);
    } catch (err) {
      socket.emit("puzzle-wars:error", { message: err.message || "Forfeit failed" });
    }
  });

  socket.on("disconnect", () => {
    lobbySockets.delete(socket.id);
    const userId = uidOf();
    if (!userId) return;
    // Only drop queue/seek if this socket still owns it
    const q = queue.get(userId);
    if (q && q.socketId === socket.id) {
      queue.delete(userId);
    }
    const seek = openSeeks.get(userId);
    if (seek && seek.socketId === socket.id) {
      openSeeks.delete(userId);
      broadcastLobby();
    }
  });
}

function init(io) {
  ioRef = io;
  io.on("connection", (socket) => {
    bindSocket(socket);
  });
  console.log("[puzzle-wars] socket handlers registered");
}

module.exports = { init };
