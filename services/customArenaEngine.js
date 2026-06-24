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

async function saveArenaDoc(arena, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      markArenaDirty(arena);
      await arena.save();
      return arena;
    } catch (err) {
      const isVersion =
        err?.name === "VersionError" ||
        String(err?.message || "").includes("No matching document");
      if (!isVersion || attempt === maxAttempts - 1) {
        throw err;
      }
      const fresh = await CustomArena.findById(arena._id);
      if (!fresh) throw err;
      fresh.playerStates = arena.playerStates;
      fresh.activePairings = arena.activePairings;
      if (arena.leaderboard) fresh.leaderboard = arena.leaderboard;
      if (arena.pairStats) fresh.pairStats = arena.pairStats;
      if (arena.recordedGameIds) fresh.recordedGameIds = arena.recordedGameIds;
      arena = fresh;
    }
  }
  return arena;
}

/**
 * Close arena pairings whose linked Game documents already finished
 * (e.g. disconnect / timeout while arena document was not updated).
 */
async function syncStaleArenaPairings(arenaId) {
  let arena = await CustomArena.findById(arenaId);
  if (!arena) return null;

  const activeWithGame = (arena.activePairings || []).filter(
    (pairing) => pairing.status === "active" && pairing.gameId
  );
  if (!activeWithGame.length) return arena;

  const games = await Game.find({
    gameId: { $in: activeWithGame.map((p) => String(p.gameId)) },
  })
    .select("gameId status result")
    .lean();

  let changed = false;
  for (const game of games) {
    const status = String(game.status || "").toLowerCase();
    if (status !== "completed" && status !== "abandoned") continue;

    const winner = game.result?.winner;
    const normalized =
      winner === "white" || winner === "black" || winner === "draw"
        ? winner
        : "draw";
    const outcome = await recordArenaResultForGame(String(game.gameId), {
      winner: normalized,
      reason: game.result?.reason || "stale-sync",
    });
    if (!outcome.error) {
      changed = true;
      arena = await CustomArena.findById(arenaId);
      continue;
    }

    const pairingIndex = (arena.activePairings || []).findIndex(
      (p) => String(p.gameId) === String(game.gameId) && p.status === "active"
    );
    if (pairingIndex === -1) continue;

    const pairing = arena.activePairings[pairingIndex];
    const pairings = [...arena.activePairings];
    pairings[pairingIndex] = {
      ...pairing,
      status: "completed",
      completedAt: pairing.completedAt || new Date(),
      result: pairing.result || normalized,
    };
    arena.activePairings = pairings;

    let playerStates = [...(arena.playerStates || [])];
    for (const pid of [pairing.whiteUserId, pairing.blackUserId]) {
      playerStates = setPlayerStatus(playerStates, String(pid), {
        status: "idle",
        matchmakingReady: false,
        currentGameId: null,
      });
    }
    arena.playerStates = playerStates;
    changed = true;
  }

  if (changed) {
    arena = await saveArenaDoc(arena);
  }

  return arena;
}

async function isGameStillActive(gameId) {
  if (!gameId) return false;
  const game = await Game.findOne({ gameId: String(gameId) })
    .select("status")
    .lean();
  if (!game) return false;
  const status = String(game.status || "").toLowerCase();
  return status === "active" || status === "waiting";
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

function arenaTimeControlToGame(timeControl) {
  const initial = Math.max(1, Number(timeControl?.time || 180)) * 1000;
  const increment = Math.max(0, Number(timeControl?.increment || 0)) * 1000;
  return { initial, increment };
}

async function tickArenaPairings(arenaId) {
  await syncStaleArenaPairings(arenaId);
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

  for (const pairing of selected) {
    const pairingId = newPairingId();
    const whiteStr = String(pairing.whiteUserId);
    const blackStr = String(pairing.blackUserId);
    const resolvedTimeControl = arenaTimeControlToGame(arena.timeControl);
    const gameId = Math.random().toString(36).substr(2, 9);
    const game = new Game({
      gameId,
      type: "friend",
      isRated: arena.ratingMode !== "unrated",
      arenaId: arena._id,
      arenaPairingId: pairingId,
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
    await linkGameToArenaPairing(gameId, arena._id, pairingId);

    activePairings.push({
      pairingId,
      whiteUserId: pairing.whiteUserId,
      blackUserId: pairing.blackUserId,
      gameId,
      status: "active",
      acceptedUserIds: [
        new mongoose.Types.ObjectId(whiteStr),
        new mongoose.Types.ObjectId(blackStr),
      ],
      createdAt: new Date(),
    });

    playerStates = setPlayerStatus(playerStates, pairing.whiteUserId, {
      status: "in_game",
      matchmakingReady: false,
      currentGameId: gameId,
    });
    playerStates = setPlayerStatus(playerStates, pairing.blackUserId, {
      status: "in_game",
      matchmakingReady: false,
      currentGameId: gameId,
    });
  }

  arena.activePairings = activePairings;
  arena.playerStates = playerStates;
  markArenaDirty(arena);
  await arena.save();

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

/**
 * Drop orphan pending pairings for players who already have an active game row.
 */
async function pruneStalePendingPairings(arenaId) {
  let arena = await CustomArena.findById(arenaId);
  if (!arena) return null;

  const pairings = [...(arena.activePairings || [])];
  const activeGameUsers = new Set();
  for (const pairing of pairings) {
    if (pairing.status === "active" && pairing.gameId) {
      activeGameUsers.add(String(pairing.whiteUserId));
      activeGameUsers.add(String(pairing.blackUserId));
    }
  }

  if (activeGameUsers.size === 0) return arena;

  const next = pairings.filter((pairing) => {
    if (pairing.status !== "pending" || pairing.gameId) return true;
    const white = String(pairing.whiteUserId);
    const black = String(pairing.blackUserId);
    return !activeGameUsers.has(white) && !activeGameUsers.has(black);
  });

  if (next.length === pairings.length) return arena;

  arena.activePairings = next;
  return saveArenaDoc(arena);
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
  let arena = await CustomArena.findById(arenaId);
  if (!arena) return null;

  arena = (await syncStaleArenaPairings(arenaId)) || arena;
  arena = (await pruneStalePendingPairings(arenaId)) || arena;

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

function findUserArenaPairing(activePairings, userId) {
  const uid = String(userId);
  return (activePairings || []).find(
    (pairing) =>
      String(pairing.whiteUserId) === uid || String(pairing.blackUserId) === uid
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
  let arena = await syncStaleArenaPairings(arenaId);
  if (!arena) {
    arena = await CustomArena.findById(arenaId);
  }
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

  let myState = playerStates[stateIndex];

  const activeGamePairing = (arena.activePairings || []).find(
    (pairing) =>
      (String(pairing.whiteUserId) === uid ||
        String(pairing.blackUserId) === uid) &&
      pairing.status === "active" &&
      pairing.gameId
  );
  if (activeGamePairing) {
    const stillLive = await isGameStillActive(activeGamePairing.gameId);
    if (stillLive) {
      const alreadyInGame =
        myState.status === "in_game" &&
        String(myState.currentGameId) === String(activeGamePairing.gameId);
      if (!alreadyInGame) {
        playerStates = setPlayerStatus(playerStates, uid, {
          status: "in_game",
          matchmakingReady: false,
          currentGameId: String(activeGamePairing.gameId),
        });
        arena.playerStates = playerStates;
        await saveArenaDoc(arena);
      }
      const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
      return { runtime, error: null };
    }
    arena = (await syncStaleArenaPairings(arenaId)) || arena;
    playerStates = [...(arena.playerStates || [])];
    const stateIndexAfterSync = playerStates.findIndex(
      (s) => String(s.userId) === uid
    );
    if (stateIndexAfterSync === -1) {
      return { runtime: null, error: "Player state not found" };
    }
    myState = playerStates[stateIndexAfterSync];
  }

  if (myState.status === "in_game" && myState.currentGameId) {
    const stillLive = await isGameStillActive(myState.currentGameId);
    if (stillLive) {
      const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
      return { runtime, error: null };
    }
    playerStates = setPlayerStatus(playerStates, uid, {
      status: "idle",
      matchmakingReady: false,
      currentGameId: null,
    });
    arena.playerStates = playerStates;
    await saveArenaDoc(arena);
    myState = { ...myState, status: "idle", currentGameId: null };
  }

  const pendingConfirm = findUserPendingPairing(arena.activePairings, uid);
  const myArenaPairing = findUserArenaPairing(arena.activePairings, uid);

  if (myArenaPairing) {
    const pairingGameId = myArenaPairing.gameId
      ? String(myArenaPairing.gameId)
      : null;
    const inActiveGame =
      myArenaPairing.status === "active" &&
      pairingGameId &&
      (await isGameStillActive(pairingGameId));

    if (inActiveGame) {
      if (
        myState.status !== "in_game" ||
        String(myState.currentGameId) !== pairingGameId
      ) {
        playerStates = setPlayerStatus(playerStates, uid, {
          status: "in_game",
          matchmakingReady: false,
          currentGameId: pairingGameId,
        });
        arena.playerStates = playerStates;
        await saveArenaDoc(arena);
      }
      const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
      return { runtime, error: null };
    }

    if (myArenaPairing.status === "pending" || !pairingGameId) {
      if (myState.status !== "matched" && myState.status !== "in_game") {
        playerStates = setPlayerStatus(playerStates, uid, {
          status: "matched",
          matchmakingReady: false,
          currentGameId: null,
        });
        arena.playerStates = playerStates;
        await saveArenaDoc(arena);
      }
      const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
      return { runtime, error: null };
    }
  }

  if (myState.status === "matched" && pendingConfirm) {
    const runtime = await getArenaRuntimeState(arenaId, { autoTick: false });
    return { runtime, error: null };
  }

  if (myState.matchmakingReady) {
    playerStates = setPlayerStatus(playerStates, uid, {
      status: "idle",
      matchmakingReady: false,
      currentGameId: null,
    });
    arena.playerStates = playerStates;
    await saveArenaDoc(arena);
  }

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

async function addInvitesToLiveArena(arenaId, resolvedInvites) {
  const arena = await CustomArena.findById(arenaId);
  if (!arena) {
    return { ok: false, message: "Arena not found", added: 0, arena: null };
  }

  if (!["live", "scheduled"].includes(arena.status)) {
    return {
      ok: false,
      message: "Players can only be added to live or scheduled arenas",
      added: 0,
      arena: null,
    };
  }

  const existingInviteIds = new Set();
  for (const id of arena.invitedUserIds || []) {
    if (id) existingInviteIds.add(String(id));
  }
  for (const invite of arena.invitedPlayers || []) {
    if (invite?.userId) existingInviteIds.add(String(invite.userId));
  }
  for (const id of arena.participantUserIds || []) {
    if (id) existingInviteIds.add(String(id));
  }

  const newInvites = (resolvedInvites || []).filter(
    (invite) => invite?.userId && !existingInviteIds.has(String(invite.userId))
  );

  if (newInvites.length === 0) {
    return {
      ok: false,
      message: "No new players to add",
      added: 0,
      arena,
    };
  }

  arena.invitedPlayers = [...(arena.invitedPlayers || []), ...newInvites];
  arena.invitedUserIds = [
    ...(arena.invitedUserIds || []),
    ...newInvites.map((invite) => invite.userId),
  ];
  arena.markModified("invitedPlayers");
  arena.markModified("invitedUserIds");

  const participantSet = new Set((arena.participantUserIds || []).map(String));
  const leaderboard = [...(arena.leaderboard || [])];
  const leaderboardIds = new Set(leaderboard.map((row) => String(row.userId)));
  let playerStates = [...(arena.playerStates || [])];
  const stateIds = new Set(playerStates.map((state) => String(state.userId)));

  for (const invite of newInvites) {
    const userId = String(invite.userId);
    if (!participantSet.has(userId)) {
      participantSet.add(userId);
      arena.participantUserIds = [
        ...(arena.participantUserIds || []),
        new mongoose.Types.ObjectId(userId),
      ];
    }

    if (!leaderboardIds.has(userId)) {
      leaderboardIds.add(userId);
      leaderboard.push({
        userId,
        username: invite.username || "player",
        displayName: invite.displayName || invite.username || "Player",
        avatar: invite.avatar || "",
        points: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        gamesPlayed: 0,
      });
    }

    if (!stateIds.has(userId)) {
      stateIds.add(userId);
      playerStates.push({
        userId,
        status: "idle",
        matchmakingReady: false,
        currentGameId: null,
        lastOpponentUserId: null,
      });
    }
  }

  arena.leaderboard = leaderboard;
  arena.playerStates = playerStates;
  markArenaDirty(arena);
  await saveArenaDoc(arena);

  return { ok: true, message: null, added: newInvites.length, arena, newInvites };
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
  addInvitesToLiveArena,
};
