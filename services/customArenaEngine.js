const crypto = require("crypto");
const mongoose = require("mongoose");
const CustomArena = require("../models/CustomArena");
const Game = require("../models/Game");
const { setGameCategory } = require("./ratingEngine");
const {
  selectMatchCountPairings,
  selectTimeDurationPairings,
  isMatchCountArenaComplete,
  hasActivePairings,
  upsertPairStats,
  ensureLeaderboardRows,
  applyArenaGameResult,
  buildParticipantRoster,
  buildLeaderboardEntries,
  buildInitialPlayerStates,
  getMaxConcurrentMatches,
} = require("../utils/customArenaPairing");

function markArenaDirty(arena) {
  arena.markModified("activePairings");
  arena.markModified("playerStates");
  if (arena.leaderboard) arena.markModified("leaderboard");
  if (arena.pairStats) arena.markModified("pairStats");
  if (arena.recordedGameIds) arena.markModified("recordedGameIds");
}

async function linkGameToArenaPairing(gameId, arenaId, pairingId) {
  if (!gameId || !arenaId || !pairingId) return;
  await Game.updateOne(
    { gameId: String(gameId) },
    {
      $set: {
        arenaId,
        arenaPairingId: String(pairingId),
      },
    }
  );
}

function newPairingId() {
  return crypto.randomBytes(8).toString("hex");
}

function ensureRuntimeInitialized(arena, hostUser) {
  if (
    Array.isArray(arena.participantUserIds) &&
    arena.participantUserIds.length > 0 &&
    Array.isArray(arena.leaderboard) &&
    arena.leaderboard.length > 0
  ) {
    return false;
  }

  const hostPlays = arena.hostPlays !== false;
  const roster = buildParticipantRoster(hostUser, hostPlays, arena.invitedPlayers);

  arena.participantUserIds = roster.map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  arena.leaderboard = buildLeaderboardEntries(hostUser, hostPlays, arena.invitedPlayers);
  arena.playerStates = buildInitialPlayerStates(roster);
  arena.pairStats = arena.pairStats || [];
  arena.activePairings = arena.activePairings || [];
  return true;
}

async function initializeArenaRuntime(arenaId, hostUser) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) return null;

  const changed = ensureRuntimeInitialized(arena, hostUser);
  if (changed) {
    await arena.save();
  }
  return arena;
}

function setPlayerStatus(playerStates, userId, patch) {
  const id = String(userId);
  return (playerStates || []).map((state) =>
    String(state.userId) === id ? { ...state, ...patch } : state
  );
}

async function tickArenaPairings(arenaId) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena || arena.status !== "live") return arena;

  const roster = (arena.participantUserIds || []).map(String);
  if (roster.length < 2) return arena;

  let selected = [];
  if (arena.format === "match_count") {
    selected = selectMatchCountPairings({
      roster,
      pairStats: arena.pairStats,
      playerStates: arena.playerStates,
      activePairings: arena.activePairings,
      matchCount: arena.matchCount,
    });
  } else {
    selected = selectTimeDurationPairings({
      roster,
      pairStats: arena.pairStats,
      playerStates: arena.playerStates,
      activePairings: arena.activePairings,
    });
  }

  if (selected.length === 0) return arena;

  const activePairings = [...(arena.activePairings || [])];
  let playerStates = [...(arena.playerStates || [])];

  const newPairings = [];

  for (const pairing of selected) {
    const pairingId = newPairingId();
    const whiteStr = String(pairing.whiteUserId);
    const blackStr = String(pairing.blackUserId);
    newPairings.push({ pairingId, whiteUserId: pairing.whiteUserId });
    activePairings.push({
      pairingId,
      whiteUserId: pairing.whiteUserId,
      blackUserId: pairing.blackUserId,
      gameId: null,
      status: "pending",
      acceptedUserIds: [
        new mongoose.Types.ObjectId(whiteStr),
        new mongoose.Types.ObjectId(blackStr),
      ],
      createdAt: new Date(),
    });

    playerStates = setPlayerStatus(playerStates, pairing.whiteUserId, {
      status: "matched",
      matchmakingReady: false,
      currentGameId: null,
    });
    playerStates = setPlayerStatus(playerStates, pairing.blackUserId, {
      status: "matched",
      matchmakingReady: false,
      currentGameId: null,
    });
  }

  arena.activePairings = activePairings;
  arena.playerStates = playerStates;
  markArenaDirty(arena);
  await arena.save();

  for (const { pairingId, whiteUserId } of newPairings) {
    await startArenaPairingGame(arenaId, pairingId, whiteUserId);
  }

  return CustomArena.findById(arenaId);
}

async function attachGameToPairing(arenaId, pairingId, gameId) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) return null;

  const pairing = (arena.activePairings || []).find((p) => p.pairingId === pairingId);
  if (!pairing) return null;

  pairing.gameId = gameId;
  pairing.status = "active";

  arena.playerStates = setPlayerStatus(arena.playerStates, pairing.whiteUserId, {
    currentGameId: gameId,
  });
  arena.playerStates = setPlayerStatus(arena.playerStates, pairing.blackUserId, {
    currentGameId: gameId,
  });

  markArenaDirty(arena);
  await arena.save();
  await linkGameToArenaPairing(gameId, arena._id, pairingId);
  return arena;
}

async function findArenaPairingForGame(arena, gameId) {
  if (!arena || !gameId) return null;
  const gid = String(gameId);

  const openMatch = (arena.activePairings || []).find(
    (entry) => entry.gameId === gid && entry.status !== "completed"
  );
  if (openMatch) return openMatch;

  const anyMatch = (arena.activePairings || []).find((entry) => entry.gameId === gid);
  if (anyMatch) return anyMatch;

  const playersWithGame = (arena.playerStates || [])
    .filter((state) => state.currentGameId === gid)
    .map((state) => String(state.userId));

  if (playersWithGame.length >= 2) {
    const [a, b] = playersWithGame;
    const samePlayers = (arena.activePairings || []).filter((entry) => {
      const white = String(entry.whiteUserId);
      const black = String(entry.blackUserId);
      return (white === a && black === b) || (white === b && black === a);
    });
    const openByPlayers = samePlayers.find((entry) => entry.status !== "completed");
    if (openByPlayers) return openByPlayers;
    const byGameId = samePlayers.find((entry) => entry.gameId === gid);
    if (byGameId) return byGameId;
    if (samePlayers.length > 0) {
      return samePlayers.sort(
        (x, y) => new Date(y.createdAt || 0) - new Date(x.createdAt || 0)
      )[0];
    }
  }

  return null;
}

async function findArenaByGameId(gameId) {
  if (!gameId) return null;
  const gid = String(gameId);

  const gameDoc = await Game.findOne({ gameId: gid }).select("arenaId");
  if (gameDoc?.arenaId) {
    const arena = await CustomArena.findById(gameDoc.arenaId);
    if (arena) return arena;
  }

  let arena = await CustomArena.findOne({ "activePairings.gameId": gid });
  if (arena) return arena;

  arena = await CustomArena.findOne({ "playerStates.currentGameId": gid });
  return arena;
}

async function recordArenaGameResult(arenaId, { pairingId, gameId, winner }) {
  const arena = await CustomArena.findById(arenaId).populate(
    "createdBy",
    "username fullName avatar"
  );
  if (!arena) {
    return { arena: null, error: "Arena not found" };
  }
  if (arena.status !== "live" && arena.status !== "ended") {
    return { arena, error: "Arena is not active" };
  }

  const normalizedWinner =
    winner === "white" || winner === "black" || winner === "draw" ? winner : null;
  if (!normalizedWinner) {
    return { arena, error: "Invalid winner" };
  }

  const resolvedGameId = gameId ? String(gameId) : null;
  if (
    resolvedGameId &&
    (arena.recordedGameIds || []).map(String).includes(resolvedGameId)
  ) {
    return { arena, error: null };
  }

  const pairings = [...(arena.activePairings || [])];
  let pairingIndex = pairings.findIndex(
    (pairing) => pairingId && pairing.pairingId === pairingId
  );
  if (pairingIndex === -1 && resolvedGameId) {
    pairingIndex = pairings.findIndex(
      (pairing) => pairing.gameId === resolvedGameId
    );
  }
  if (pairingIndex === -1 && resolvedGameId) {
    const fallback = findArenaPairingForGame(arena, resolvedGameId);
    if (fallback) {
      pairingIndex = pairings.findIndex(
        (pairing) => pairing.pairingId === fallback.pairingId
      );
    }
  }

  if (pairingIndex === -1) {
    return { arena, error: "Pairing not found" };
  }

  const pairing = pairings[pairingIndex];
  if (pairing.status === "completed") {
    const alreadyRecorded =
      resolvedGameId &&
      (arena.recordedGameIds || []).map(String).includes(resolvedGameId);
    if (alreadyRecorded) {
      return { arena, error: null };
    }
    if (
      resolvedGameId &&
      pairing.gameId &&
      pairing.gameId !== resolvedGameId
    ) {
      return { arena, error: "Pairing already completed" };
    }
    // Completed in pairing state but arena points not applied yet — continue.
  }

  const whiteUserId = String(pairing.whiteUserId);
  const blackUserId = String(pairing.blackUserId);

  if (!arena.leaderboard?.length) {
    ensureRuntimeInitialized(arena, arena.createdBy);
  }

  arena.leaderboard = ensureLeaderboardRows(
    arena.leaderboard,
    whiteUserId,
    blackUserId,
    {
      invitedPlayers: arena.invitedPlayers,
      createdBy: arena.createdBy,
    }
  );

  arena.leaderboard = applyArenaGameResult(
    arena.leaderboard,
    whiteUserId,
    blackUserId,
    normalizedWinner
  );
  arena.pairStats = upsertPairStats(
    arena.pairStats,
    whiteUserId,
    blackUserId,
    whiteUserId
  );

  pairings[pairingIndex] = {
    ...pairing,
    gameId: resolvedGameId || pairing.gameId,
    status: "completed",
    completedAt: new Date(),
    result: normalizedWinner,
  };
  arena.activePairings = pairings;

  if (resolvedGameId) {
    const recorded = new Set((arena.recordedGameIds || []).map(String));
    recorded.add(resolvedGameId);
    arena.recordedGameIds = [...recorded];
  }

  let playerStates = [...(arena.playerStates || [])];
  playerStates = setPlayerStatus(playerStates, whiteUserId, {
    status: "idle",
    matchmakingReady: false,
    currentGameId: null,
    lastOpponentUserId: blackUserId,
  });
  playerStates = setPlayerStatus(playerStates, blackUserId, {
    status: "idle",
    matchmakingReady: false,
    currentGameId: null,
    lastOpponentUserId: whiteUserId,
  });
  arena.playerStates = playerStates;

  if (
    arena.format === "match_count" &&
    isMatchCountArenaComplete(
      (arena.participantUserIds || []).map(String),
      arena.pairStats,
      arena.matchCount
    ) &&
    !hasActivePairings(
      arena.activePairings.filter((p) => p.status !== "completed")
    )
  ) {
    arena.status = "ended";
    arena.endedAt = new Date();
  }

  markArenaDirty(arena);
  await arena.save();
  return { arena, error: null };
}

function serializeArenaRuntime(arena) {
  const roster = (arena.participantUserIds || []).map(String);
  return {
    arenaId: String(arena._id),
    status: arena.status,
    format: arena.format,
    matchCount: arena.matchCount,
    durationMinutes: arena.durationMinutes,
    hostPlays: arena.hostPlays !== false,
    maxConcurrentMatches: getMaxConcurrentMatches(roster.length),
    participantCount: roster.length,
    participantUserIds: roster,
    leaderboard: (arena.leaderboard || []).map((row, index) => ({
      rank: index + 1,
      userId: String(row.userId),
      username: row.username,
      displayName: row.displayName,
      avatar: row.avatar || "",
      points: row.points || 0,
      wins: row.wins || 0,
      draws: row.draws || 0,
      losses: row.losses || 0,
      gamesPlayed: row.gamesPlayed || 0,
    })),
    playerStates: (arena.playerStates || []).map((state) => ({
      userId: String(state.userId),
      status: state.status,
      matchmakingReady: !!state.matchmakingReady,
      currentGameId: state.currentGameId || null,
      lastOpponentUserId: state.lastOpponentUserId
        ? String(state.lastOpponentUserId)
        : null,
    })),
    pairStats: (arena.pairStats || []).map((record) => ({
      playerA: String(record.playerA),
      playerB: String(record.playerB),
      gamesPlayed: record.gamesPlayed || 0,
      lastWhiteUserId: record.lastWhiteUserId
        ? String(record.lastWhiteUserId)
        : null,
    })),
    activePairings: (arena.activePairings || [])
      .filter((pairing) => pairing.status === "pending" || pairing.status === "active")
      .map((pairing) => ({
        pairingId: pairing.pairingId,
        whiteUserId: String(pairing.whiteUserId),
        blackUserId: String(pairing.blackUserId),
        gameId: pairing.gameId || null,
        status: pairing.status,
        acceptedUserIds: (pairing.acceptedUserIds || []).map((id) => String(id)),
        createdAt: pairing.createdAt,
      })),
    completedPairings: (arena.activePairings || [])
      .filter((pairing) => pairing.status === "completed" && pairing.gameId)
      .map((pairing) => ({
        pairingId: pairing.pairingId,
        whiteUserId: String(pairing.whiteUserId),
        blackUserId: String(pairing.blackUserId),
        gameId: pairing.gameId,
        status: "completed",
        result: pairing.result || null,
        completedAt: pairing.completedAt || null,
      }))
      .sort(
        (a, b) =>
          new Date(b.completedAt || 0).getTime() -
          new Date(a.completedAt || 0).getTime()
      ),
    pendingPairings: (arena.activePairings || [])
      .filter((pairing) => pairing.status === "pending")
      .map((pairing) => ({
        pairingId: pairing.pairingId,
        whiteUserId: String(pairing.whiteUserId),
        blackUserId: String(pairing.blackUserId),
      })),
  };
}

async function getArenaRuntimeState(arenaId, { autoTick = false } = {}) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) return null;

  if (arena.status === "live" && autoTick) {
    await tickArenaPairings(arenaId);
  }

  const refreshed = await CustomArena.findById(arenaId);
  return serializeArenaRuntime(refreshed);
}

function findUserPendingPairing(activePairings, userId) {
  const uid = String(userId);
  return (activePairings || []).find(
    (pairing) =>
      (String(pairing.whiteUserId) === uid ||
        String(pairing.blackUserId) === uid) &&
      pairing.status === "pending" &&
      !pairing.gameId
  );
}

function removePendingPairingForUser(activePairings, userId) {
  const uid = String(userId);
  const index = (activePairings || []).findIndex(
    (pairing) =>
      (String(pairing.whiteUserId) === uid ||
        String(pairing.blackUserId) === uid) &&
      pairing.status === "pending" &&
      !pairing.gameId
  );
  if (index === -1) return { pairings: activePairings || [], removed: null };
  const removed = activePairings[index];
  const next = [...activePairings];
  next.splice(index, 1);
  return { pairings: next, removed };
}

async function enterArenaLobby(arenaId, userId) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    return { runtime: null, error: "Arena not found" };
  }
  if (arena.status !== "live") {
    return {
      runtime: serializeArenaRuntime(arena),
      error: null,
    };
  }

  const uid = String(userId);
  const roster = (arena.participantUserIds || []).map(String);
  if (!roster.includes(uid)) {
    return { runtime: null, error: "You are not in this arena" };
  }

  let playerStates = [...(arena.playerStates || [])];
  const stateIndex = playerStates.findIndex((s) => String(s.userId) === uid);
  if (stateIndex === -1) {
    return { runtime: null, error: "Player state not found" };
  }

  const myState = playerStates[stateIndex];

  if (myState.status === "in_game" && myState.currentGameId) {
    const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
    return { runtime, error: null };
  }

  const pendingConfirm = findUserPendingPairing(arena.activePairings, uid);
  if (myState.status === "matched" && pendingConfirm) {
    const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
    return { runtime, error: null };
  }

  let activePairings = [...(arena.activePairings || [])];
  const { pairings: clearedPairings, removed } = removePendingPairingForUser(
    activePairings,
    uid
  );
  activePairings = clearedPairings;

  if (removed) {
    const otherId =
      String(removed.whiteUserId) === uid
        ? String(removed.blackUserId)
        : String(removed.whiteUserId);
    playerStates = setPlayerStatus(playerStates, otherId, {
      status: "idle",
      matchmakingReady: false,
      currentGameId: null,
    });
  }

  playerStates = setPlayerStatus(playerStates, uid, {
    status: "idle",
    matchmakingReady: false,
    currentGameId: null,
  });

  arena.activePairings = activePairings;
  arena.playerStates = playerStates;
  await arena.save();

  const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
  return { runtime, error: null };
}

async function recordArenaResultForGame(gameId, result) {
  if (!gameId || !result) return { arena: null, error: null };

  const winner = result.winner;
  if (winner !== "white" && winner !== "black" && winner !== "draw") {
    return { arena: null, error: null };
  }

  const gid = String(gameId);
  const gameDoc = await Game.findOne({ gameId: gid }).select(
    "arenaId arenaPairingId"
  );

  if (gameDoc?.arenaId && gameDoc?.arenaPairingId) {
    const outcome = await recordArenaGameResult(String(gameDoc.arenaId), {
      pairingId: String(gameDoc.arenaPairingId),
      gameId: gid,
      winner,
    });
    if (outcome.error) {
      console.warn("[Arena] linked game record failed:", gid, outcome.error);
    }
    return outcome;
  }

  const arena = await findArenaByGameId(gid);
  if (!arena) {
    console.warn("[Arena] no arena found for completed game:", gid);
    return { arena: null, error: null };
  }

  const pairing = findArenaPairingForGame(arena, gid);
  if (!pairing) {
    console.warn("[Arena] no pairing for completed game:", gid);
    return { arena, error: null };
  }

  const outcome = await recordArenaGameResult(String(arena._id), {
    pairingId: pairing.pairingId,
    gameId: gid,
    winner,
  });

  if (outcome.error) {
    console.warn("[Arena] could not record game result:", gid, outcome.error);
  }

  if (outcome.arena && !outcome.error) {
    await linkGameToArenaPairing(gid, outcome.arena._id, pairing.pairingId);
  }

  return outcome;
}

function arenaTimeControlToGame(timeControl) {
  const initial = Math.max(1, Number(timeControl?.time || 180)) * 1000;
  const increment = Math.max(0, Number(timeControl?.increment || 0)) * 1000;
  return { initial, increment };
}

async function startArenaPairingGame(arenaId, pairingId, userId) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    return { arena: null, game: null, error: "Arena not found" };
  }
  if (arena.status !== "live") {
    return { arena, game: null, error: "Arena is not live" };
  }

  const pairing = (arena.activePairings || []).find((p) => p.pairingId === pairingId);
  if (!pairing) {
    return { arena, game: null, error: "Pairing not found" };
  }

  const userStr = String(userId);
  const whiteStr = String(pairing.whiteUserId);
  const blackStr = String(pairing.blackUserId);
  if (userStr !== whiteStr && userStr !== blackStr) {
    return { arena, game: null, error: "You are not in this pairing" };
  }

  if (pairing.gameId) {
    const existing = await Game.findOne({ gameId: pairing.gameId });
    if (existing && existing.status === "active") {
      return { arena, game: existing, error: null };
    }
    pairing.gameId = null;
  }

  if (pairing.status !== "pending" && pairing.status !== "active") {
    return { arena, game: null, error: "Pairing is not available" };
  }

  const accepted = (pairing.acceptedUserIds || []).map(String);
  if (!accepted.includes(whiteStr) || !accepted.includes(blackStr)) {
    return {
      arena,
      game: null,
      error: "Both players must confirm the match before starting",
    };
  }

  const resolvedTimeControl = arenaTimeControlToGame(arena.timeControl);
  const gameId = Math.random().toString(36).substr(2, 9);
  const game = new Game({
    gameId,
    type: "friend",
    isRated: arena.ratingMode !== "unrated",
    arenaId: arena._id,
    arenaPairingId: pairing.pairingId,
    players: {
      white: pairing.whiteUserId,
      black: pairing.blackUserId,
    },
    timeControl: resolvedTimeControl,
    timeRemaining: {
      white: resolvedTimeControl.initial,
      black: resolvedTimeControl.initial,
    },
    status: "active",
  });
  setGameCategory(game);
  await game.save();

  pairing.gameId = gameId;
  pairing.status = "active";
  arena.playerStates = setPlayerStatus(arena.playerStates, whiteStr, {
    status: "in_game",
    matchmakingReady: false,
    currentGameId: gameId,
  });
  arena.playerStates = setPlayerStatus(arena.playerStates, blackStr, {
    status: "in_game",
    matchmakingReady: false,
    currentGameId: gameId,
  });
  markArenaDirty(arena);
  await arena.save();

  return { arena, game, error: null };
}

async function setArenaMatchmakingReady(arenaId, userId, ready) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    return { arena: null, runtime: null, error: "Arena not found" };
  }
  if (arena.status !== "live") {
    return { arena, runtime: null, error: "Arena is not live" };
  }

  const uid = String(userId);
  const roster = (arena.participantUserIds || []).map(String);
  if (!roster.includes(uid)) {
    return { arena, runtime: null, error: "You are not in this arena" };
  }

  let playerStates = [...(arena.playerStates || [])];
  const index = playerStates.findIndex((s) => String(s.userId) === uid);
  if (index === -1) {
    return { arena, runtime: null, error: "Player state not found" };
  }

  const state = playerStates[index];
  if (state.status === "matched" || state.status === "in_game") {
    return {
      arena,
      runtime: null,
      error: "Cannot change queue while in a match or game",
    };
  }

  playerStates[index] = {
    ...state,
    status: "idle",
    matchmakingReady: !!ready,
    currentGameId: null,
  };
  arena.playerStates = playerStates;
  await arena.save();

  if (ready) {
    await tickArenaPairings(arenaId);
  }

  const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
  return { arena, runtime, error: null };
}

async function acceptArenaPairing(arenaId, pairingId, userId) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    return { arena: null, game: null, runtime: null, error: "Arena not found" };
  }
  if (arena.status !== "live") {
    return { arena, game: null, runtime: null, error: "Arena is not live" };
  }

  const pairing = (arena.activePairings || []).find((p) => p.pairingId === pairingId);
  if (!pairing) {
    return { arena, game: null, runtime: null, error: "Pairing not found" };
  }

  const uid = String(userId);
  const whiteStr = String(pairing.whiteUserId);
  const blackStr = String(pairing.blackUserId);
  if (uid !== whiteStr && uid !== blackStr) {
    return { arena, game: null, runtime: null, error: "You are not in this pairing" };
  }

  if (pairing.gameId) {
    const existing = await Game.findOne({ gameId: pairing.gameId });
    if (existing?.status === "active") {
      const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
      return { arena, game: existing, runtime, error: null };
    }
  }

  const accepted = (pairing.acceptedUserIds || []).map(String);
  if (!accepted.includes(uid)) {
    pairing.acceptedUserIds = [
      ...(pairing.acceptedUserIds || []),
      new mongoose.Types.ObjectId(uid),
    ];
    markArenaDirty(arena);
    await arena.save();
  }

  const refreshed = await CustomArena.findById(arenaId);
  const freshPairing = (refreshed.activePairings || []).find(
    (p) => p.pairingId === pairingId
  );
  const acceptedNow = (freshPairing?.acceptedUserIds || []).map(String);
  const bothReady =
    acceptedNow.includes(whiteStr) && acceptedNow.includes(blackStr);

  if (!bothReady) {
    const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
    return { arena: refreshed, game: null, runtime, error: null };
  }

  const started = await startArenaPairingGame(arenaId, pairingId, userId);
  const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
  return {
    arena: started.arena,
    game: started.game,
    runtime,
    error: started.error,
  };
}

module.exports = {
  ensureRuntimeInitialized,
  initializeArenaRuntime,
  tickArenaPairings,
  attachGameToPairing,
  recordArenaGameResult,
  recordArenaResultForGame,
  serializeArenaRuntime,
  getArenaRuntimeState,
  enterArenaLobby,
  startArenaPairingGame,
  setArenaMatchmakingReady,
  acceptArenaPairing,
};
