/**
 * Pure pairing + scoring helpers for custom arenas.
 * Match count: fixed games per opponent, alternating colors.
 * Time duration: rematch blocked until each player faces someone else.
 */

const ARENA_SCORING = Object.freeze({ win: 2, draw: 1, loss: 0 });

function cloneLeaderboardRow(row) {
  if (!row) return row;
  if (typeof row.toObject === "function") {
    return row.toObject();
  }
  return { ...row };
}

function canonicalPair(userId1, userId2) {
  const sorted = [String(userId1), String(userId2)].sort();
  return { playerA: sorted[0], playerB: sorted[1], key: sorted.join(":") };
}

function getPairStatsRecord(pairStats, userId1, userId2) {
  const { playerA, playerB } = canonicalPair(userId1, userId2);
  return (pairStats || []).find(
    (record) =>
      String(record.playerA) === playerA && String(record.playerB) === playerB
  );
}

function getPairGamesPlayed(pairStats, userId1, userId2) {
  return getPairStatsRecord(pairStats, userId1, userId2)?.gamesPlayed ?? 0;
}

function getNextWhitePlayer(userId1, userId2, pairRecord) {
  const { playerA, playerB } = canonicalPair(userId1, userId2);
  if (!pairRecord || !pairRecord.gamesPlayed) {
    return playerA;
  }
  const lastWhite = String(pairRecord.lastWhiteUserId);
  return lastWhite === playerA ? playerB : playerA;
}

function getMaxConcurrentMatches(rosterSize) {
  return Math.floor(Math.max(0, rosterSize) / 2);
}

function getActivePairingCount(activePairings) {
  return (activePairings || []).filter(
    (pairing) => pairing.status === "pending" || pairing.status === "active"
  ).length;
}

function isLeftTournamentState(state) {
  return state?.status === "left_tournament";
}

function getActiveArenaRoster(playerStates, roster) {
  return (roster || []).map(String).filter((id) => {
    const state = (playerStates || []).find((s) => String(s.userId) === id);
    return !isLeftTournamentState(state);
  });
}

function getBusyPlayerIds(playerStates) {
  const busy = new Set();
  for (const state of playerStates || []) {
    if (isLeftTournamentState(state)) continue;
    if (state.status === "in_game" || state.status === "matched") {
      busy.add(String(state.userId));
    }
  }
  return busy;
}

function getQueuePlayerIds(playerStates, roster) {
  const busy = getBusyPlayerIds(playerStates);
  return getActiveArenaRoster(playerStates, roster).filter((id) => {
    if (busy.has(id)) return false;
    const state = (playerStates || []).find((s) => String(s.userId) === id);
    return state?.status === "idle" && state.matchmakingReady === true;
  });
}

function getFreePlayerIds(playerStates, roster) {
  const busy = getBusyPlayerIds(playerStates);
  return (roster || []).map(String).filter((id) => !busy.has(id));
}

function selectMatchCountPairings({
  roster,
  pairStats,
  playerStates,
  activePairings,
  matchCount,
}) {
  const maxConcurrent = getMaxConcurrentMatches(roster.length);
  const slots = maxConcurrent - getActivePairingCount(activePairings);
  if (slots <= 0) return [];

  const queueIds = new Set(getQueuePlayerIds(playerStates, roster));
  const candidates = [];

  for (let i = 0; i < roster.length; i += 1) {
    for (let j = i + 1; j < roster.length; j += 1) {
      const playerA = String(roster[i]);
      const playerB = String(roster[j]);
      if (!queueIds.has(playerA) || !queueIds.has(playerB)) continue;

      const played = getPairGamesPlayed(pairStats, playerA, playerB);
      const remaining = matchCount - played;
      if (remaining > 0) {
        candidates.push({ playerA, playerB, remaining, played });
      }
    }
  }

  candidates.sort((a, b) => b.remaining - a.remaining || a.played - b.played);

  const selected = [];
  const used = new Set();

  for (const candidate of candidates) {
    if (selected.length >= slots) break;
    if (used.has(candidate.playerA) || used.has(candidate.playerB)) continue;

    const pairRecord = getPairStatsRecord(pairStats, candidate.playerA, candidate.playerB);
    const whiteUserId = getNextWhitePlayer(
      candidate.playerA,
      candidate.playerB,
      pairRecord
    );
    const blackUserId =
      whiteUserId === candidate.playerA ? candidate.playerB : candidate.playerA;

    selected.push({
      whiteUserId,
      blackUserId,
      playerA: candidate.playerA,
      playerB: candidate.playerB,
    });
    used.add(candidate.playerA);
    used.add(candidate.playerB);
  }

  return selected;
}

function canPairTimeDuration(playerA, playerB, playerStates) {
  const stateA = (playerStates || []).find(
    (state) => String(state.userId) === String(playerA)
  );
  const stateB = (playerStates || []).find(
    (state) => String(state.userId) === String(playerB)
  );
  if (!stateA || !stateB) return false;
  if (stateA.status !== "idle" || stateB.status !== "idle") return false;
  if (!stateA.matchmakingReady || !stateB.matchmakingReady) return false;

  const lastA = stateA.lastOpponentUserId
    ? String(stateA.lastOpponentUserId)
    : null;
  const lastB = stateB.lastOpponentUserId
    ? String(stateB.lastOpponentUserId)
    : null;

  if (lastA === String(playerB) && lastB === String(playerA)) {
    return false;
  }

  return true;
}

function selectTimeDurationPairings({
  roster,
  pairStats,
  playerStates,
  activePairings,
}) {
  const maxConcurrent = getMaxConcurrentMatches(roster.length);
  const slots = maxConcurrent - getActivePairingCount(activePairings);
  if (slots <= 0) return [];

  const freeList = getQueuePlayerIds(playerStates, roster);
  const candidates = [];

  for (let i = 0; i < freeList.length; i += 1) {
    for (let j = i + 1; j < freeList.length; j += 1) {
      const playerA = String(freeList[i]);
      const playerB = String(freeList[j]);
      if (!canPairTimeDuration(playerA, playerB, playerStates)) continue;

      const played = getPairGamesPlayed(pairStats, playerA, playerB);
      candidates.push({ playerA, playerB, played });
    }
  }

  candidates.sort((a, b) => a.played - b.played);

  const selected = [];
  const used = new Set();

  for (const candidate of candidates) {
    if (selected.length >= slots) break;
    if (used.has(candidate.playerA) || used.has(candidate.playerB)) continue;

    const pairRecord = getPairStatsRecord(pairStats, candidate.playerA, candidate.playerB);
    const whiteUserId = getNextWhitePlayer(
      candidate.playerA,
      candidate.playerB,
      pairRecord
    );
    const blackUserId =
      whiteUserId === candidate.playerA ? candidate.playerB : candidate.playerA;

    selected.push({
      whiteUserId,
      blackUserId,
      playerA: candidate.playerA,
      playerB: candidate.playerB,
    });
    used.add(candidate.playerA);
    used.add(candidate.playerB);
  }

  return selected;
}

function isMatchCountArenaComplete(roster, pairStats, matchCount) {
  if (!Array.isArray(roster) || roster.length < 2) return false;

  for (let i = 0; i < roster.length; i += 1) {
    for (let j = i + 1; j < roster.length; j += 1) {
      if (getPairGamesPlayed(pairStats, roster[i], roster[j]) < matchCount) {
        return false;
      }
    }
  }

  return true;
}

function hasActivePairings(activePairings) {
  return getActivePairingCount(activePairings) > 0;
}

function upsertPairStats(pairStats, userId1, userId2, whiteUserId) {
  const { playerA, playerB } = canonicalPair(userId1, userId2);
  const next = Array.isArray(pairStats) ? [...pairStats] : [];
  const index = next.findIndex(
    (record) =>
      String(record.playerA) === playerA && String(record.playerB) === playerB
  );

  if (index === -1) {
    next.push({
      playerA,
      playerB,
      gamesPlayed: 1,
      lastWhiteUserId: String(whiteUserId),
    });
    return next;
  }

  next[index] = {
    ...next[index],
    gamesPlayed: (next[index].gamesPlayed || 0) + 1,
    lastWhiteUserId: String(whiteUserId),
  };
  return next;
}

function lookupParticipantMeta(arena, userId) {
  const id = String(userId);
  const hostId = String(arena?.createdBy?._id || arena?.createdBy || "");
  if (id === hostId && arena?.createdBy && typeof arena.createdBy === "object") {
    return {
      avatar: arena.createdBy.avatar || "",
      country: arena.createdBy.country || "",
    };
  }
  const invite = (arena?.invitedPlayers || []).find(
    (entry) => entry?.userId && String(entry.userId) === id
  );
  return {
    avatar: invite?.avatar || "",
    country: invite?.country || "",
  };
}

function enrichLeaderboardRow(row, arena) {
  const meta = lookupParticipantMeta(arena, row.userId);
  return {
    ...cloneLeaderboardRow(row),
    avatar: row.avatar || meta.avatar || "",
    country: row.country || meta.country || "",
  };
}

function ensureLeaderboardRows(leaderboard, whiteUserId, blackUserId, arenaMeta = {}) {
  const { invitedPlayers = [], createdBy } = arenaMeta;
  const next = (leaderboard || []).map(cloneLeaderboardRow);

  const lookup = new Map();
  if (createdBy) {
    const id = String(createdBy._id || createdBy);
    lookup.set(id, {
      userId: id,
      username: createdBy.username || "host",
      displayName: createdBy.fullName || createdBy.username || "Host",
      avatar: createdBy.avatar || "",
      country: createdBy.country || "",
    });
  }
  for (const invite of invitedPlayers || []) {
    if (!invite?.userId) continue;
    const id = String(invite.userId);
    lookup.set(id, {
      userId: id,
      username: invite.username || "player",
      displayName: invite.displayName || invite.username || "Player",
      avatar: invite.avatar || "",
      country: invite.country || "",
    });
  }

  const ensure = (userId) => {
    const id = String(userId);
    if (next.find((row) => String(row.userId) === id)) return;
    const meta = lookup.get(id);
    next.push({
      userId: id,
      username: meta?.username || "player",
      displayName: meta?.displayName || "Player",
      avatar: meta?.avatar || "",
      country: meta?.country || "",
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gamesPlayed: 0,
    });
  };

  ensure(whiteUserId);
  ensure(blackUserId);
  return next;
}

function applyArenaGameResult(leaderboard, whiteUserId, blackUserId, winner) {
  const whiteId = String(whiteUserId);
  const blackId = String(blackUserId);
  const next = (leaderboard || []).map(cloneLeaderboardRow);

  const whiteRow = next.find((row) => String(row.userId) === whiteId);
  const blackRow = next.find((row) => String(row.userId) === blackId);
  if (!whiteRow || !blackRow) return next;

  whiteRow.gamesPlayed = (whiteRow.gamesPlayed || 0) + 1;
  blackRow.gamesPlayed = (blackRow.gamesPlayed || 0) + 1;

  if (winner === "white") {
    whiteRow.wins = (whiteRow.wins || 0) + 1;
    whiteRow.points = (whiteRow.points || 0) + ARENA_SCORING.win;
    blackRow.losses = (blackRow.losses || 0) + 1;
  } else if (winner === "black") {
    blackRow.wins = (blackRow.wins || 0) + 1;
    blackRow.points = (blackRow.points || 0) + ARENA_SCORING.win;
    whiteRow.losses = (whiteRow.losses || 0) + 1;
  } else {
    whiteRow.draws = (whiteRow.draws || 0) + 1;
    blackRow.draws = (blackRow.draws || 0) + 1;
    whiteRow.points = (whiteRow.points || 0) + ARENA_SCORING.draw;
    blackRow.points = (blackRow.points || 0) + ARENA_SCORING.draw;
  }

  return next.sort((a, b) => {
    if ((b.points || 0) !== (a.points || 0)) return (b.points || 0) - (a.points || 0);
    if ((b.wins || 0) !== (a.wins || 0)) return (b.wins || 0) - (a.wins || 0);
    return (a.gamesPlayed || 0) - (b.gamesPlayed || 0);
  });
}

function buildParticipantRoster(hostUser, hostPlays, invitedPlayers) {
  const roster = [];
  const seen = new Set();

  const add = (userId) => {
    const id = String(userId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    roster.push(id);
  };

  if (hostPlays !== false && hostUser?._id) {
    add(hostUser._id);
  }

  for (const invite of invitedPlayers || []) {
    if (invite?.userId) add(invite.userId);
  }

  return roster;
}

function buildLeaderboardEntries(hostUser, hostPlays, invitedPlayers) {
  const entries = [];
  const seen = new Set();

  const pushEntry = (user) => {
    const userId = String(user.userId || user._id);
    if (!userId || seen.has(userId)) return;
    seen.add(userId);
    entries.push({
      userId,
      username: user.username || "player",
      displayName: user.displayName || user.fullName || user.username || "Player",
      avatar: user.avatar || "",
      country: user.country || "",
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gamesPlayed: 0,
    });
  };

  if (hostPlays !== false && hostUser?._id) {
    pushEntry({
      userId: hostUser._id,
      username: hostUser.username,
      displayName: hostUser.fullName || hostUser.username,
      avatar: hostUser.avatar,
      country: hostUser.country,
    });
  }

  for (const invite of invitedPlayers || []) {
    pushEntry(invite);
  }

  return entries;
}

function buildInitialPlayerStates(roster) {
  return roster.map((userId) => ({
    userId: String(userId),
    status: "idle",
    matchmakingReady: false,
    currentGameId: null,
    lastOpponentUserId: null,
  }));
}

function isLeaderboardRowDiscarded(arena, userId) {
  const uid = String(userId);
  const state = (arena.playerStates || []).find((s) => String(s.userId) === uid);
  if (state?.status === "left_tournament") return true;
  const row = (arena.leaderboard || []).find((r) => String(r.userId) === uid);
  return !!row?.discarded;
}

function buildRuntimeLeaderboard(arena) {
  const rows = (arena.leaderboard || []).map((row) => {
    const enriched = enrichLeaderboardRow(row, arena);
    const discarded = isLeaderboardRowDiscarded(arena, enriched.userId);
    return {
      enriched,
      discarded,
      points: enriched.points || 0,
      gamesPlayed: enriched.gamesPlayed || 0,
      wins: enriched.wins || 0,
    };
  });

  const sortByStanding = (a, b) =>
    b.points - a.points ||
    b.wins - a.wins ||
    b.gamesPlayed - a.gamesPlayed;

  const active = rows.filter((r) => !r.discarded).sort(sortByStanding);
  const left = rows.filter((r) => r.discarded).sort(sortByStanding);
  const ordered = [...active, ...left];

  return ordered.map((entry, index) => {
    const enriched = entry.enriched;
    return {
      rank: index + 1,
      userId: String(enriched.userId),
      username: enriched.username,
      displayName: enriched.displayName,
      avatar: enriched.avatar || "",
      country: enriched.country || "",
      points: enriched.points || 0,
      wins: enriched.wins || 0,
      draws: enriched.draws || 0,
      losses: enriched.losses || 0,
      gamesPlayed: enriched.gamesPlayed || 0,
      discarded: entry.discarded,
    };
  });
}

function markLeaderboardRowDiscarded(leaderboard, userId) {
  const uid = String(userId);
  return (leaderboard || []).map((row) => {
    const rowObj = row?.toObject?.() ? row.toObject() : { ...row };
    if (String(rowObj.userId) !== uid) return rowObj;
    return { ...rowObj, discarded: true };
  });
}

module.exports = {
  ARENA_SCORING,
  canonicalPair,
  getPairStatsRecord,
  getPairGamesPlayed,
  getNextWhitePlayer,
  getMaxConcurrentMatches,
  getActivePairingCount,
  getFreePlayerIds,
  getQueuePlayerIds,
  getBusyPlayerIds,
  getActiveArenaRoster,
  selectMatchCountPairings,
  selectTimeDurationPairings,
  canPairTimeDuration,
  isMatchCountArenaComplete,
  hasActivePairings,
  upsertPairStats,
  ensureLeaderboardRows,
  applyArenaGameResult,
  buildParticipantRoster,
  buildLeaderboardEntries,
  buildInitialPlayerStates,
  enrichLeaderboardRow,
  lookupParticipantMeta,
  buildRuntimeLeaderboard,
  markLeaderboardRowDiscarded,
  isLeaderboardRowDiscarded,
};
