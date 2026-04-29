const User = require("../models/User");
const Badge = require("../models/Badge");
const Stats = require("../models/Stats");
const Game = require("../models/Game");
const { Chess } = require("chess.js");

/**
 * Check and award badges based on user stats and game events
 * Called after a game ends to check if user qualifies for any badges
 * 
 * @param {String} userId - User ID to check badges for
 * @param {String} gameId - Game ID (optional, for GAME_EVENT and OPENING badges)
 * @param {Object} io - Socket.io instance for emitting events (optional)
 * @returns {Promise<Array>} Array of newly awarded badges
 */
async function checkAndAwardBadges(userId, gameId = null, io = null) {
  try {
    console.log(`[Achievement] 🔍 Checking badges for user ${userId}, gameId: ${gameId || "N/A"}`);
    
    // Get user and stats
    const user = await User.findById(userId);
    if (!user) {
      console.error(`[Achievement] ❌ User not found: ${userId}`);
      return [];
    }

    const stats = await Stats.findOne({ user: userId });
    if (!stats) {
      console.log(`[Achievement] ⚠️ No stats found for user ${userId}, skipping badge check`);
      return [];
    }

    // Debug: Log current stats for badge checking
    console.log(`[Achievement] 📊 Current stats for user ${userId}:`, {
      totalGames: stats.gamesPlayed?.total || 0,
      bulletGames: stats.gamesPlayed?.bullet || 0,
      blitzGames: stats.gamesPlayed?.blitz || 0,
      rapidGames: stats.gamesPlayed?.rapid || 0,
      totalWins: stats.wins?.total || 0,
      bulletWins: stats.wins?.bullet || 0,
      blitzWins: stats.wins?.blitz || 0,
      rapidWins: stats.wins?.rapid || 0,
    });

    // Get game data if gameId is provided (for GAME_EVENT and OPENING badges)
    let game = null;
    if (gameId) {
      game = await Game.findOne({ gameId }).lean();
    }

    // Get all auto-award badges
    const autoBadges = await Badge.find({ autoAward: true }).lean();
    
    const newlyAwarded = [];

    for (const badge of autoBadges) {
      // STRICT DUPLICATE CHECK: Check if user already has this badge by ID
      const hasBadgeById = user.badges.some(
        (b) => b.badgeId && b.badgeId.toString() === badge._id.toString()
      );

      if (hasBadgeById) {
        console.log(`[Achievement] ⏭️ Skipping badge "${badge.name}" - user already has this badge (ID: ${badge._id})`);
        continue; // Skip if already awarded
      }

      // ADDITIONAL CHECK: If badge has a key, also check by key to prevent duplicates
      if (badge.key) {
        // Fetch all badge IDs that the user has to check their keys
        const userBadgeIds = user.badges
          .filter(b => b.badgeId)
          .map(b => b.badgeId.toString());
        
        if (userBadgeIds.length > 0) {
          const userBadgesWithKeys = await Badge.find({ 
            _id: { $in: userBadgeIds },
            key: badge.key 
          }).lean();
          
          if (userBadgesWithKeys.length > 0) {
            console.log(`[Achievement] ⏭️ Skipping badge "${badge.name}" - user already has a badge with key "${badge.key}"`);
            continue; // Skip if user already has a badge with the same key
          }
        }
      }

      // Check if user meets criteria based on badge category
      let qualifies = false;

      if (badge.badgeCategory === "STATISTIC") {
        qualifies = checkStatisticBadge(badge, stats, user);
      } else if (badge.badgeCategory === "GAME_EVENT") {
        if (!game) {
          continue; // Skip GAME_EVENT badges if no game data
        }
        qualifies = checkGameEventBadge(badge, game, user);
      } else if (badge.badgeCategory === "OPENING") {
        if (!game) {
          continue; // Skip OPENING badges if no game data
        }
        qualifies = checkOpeningBadge(badge, game);
      } else {
        // Legacy badge checking (backward compatibility)
        qualifies = checkLegacyBadge(badge, stats, user);
      }

      if (qualifies) {
        // FINAL DUPLICATE CHECK: Reload user to ensure we have the latest badge data
        // This prevents race conditions where multiple requests might award the same badge
        const freshUser = await User.findById(userId);
        if (!freshUser) {
          console.error(`[Achievement] ❌ User not found during badge award: ${userId}`);
          continue;
        }

        // Double-check that the badge wasn't awarded in the meantime
        const stillHasBadge = freshUser.badges.some(
          (b) => b.badgeId && b.badgeId.toString() === badge._id.toString()
        );

        if (stillHasBadge) {
          console.log(`[Achievement] ⚠️ Badge "${badge.name}" was already awarded (race condition prevented)`);
          continue;
        }

        // Award the badge
        freshUser.badges.push({
          badgeId: badge._id,
          earnedAt: new Date(),
        });

        await freshUser.save();

        newlyAwarded.push(badge);

        console.log(`[Achievement] ✅ Awarded badge "${badge.name}" (${badge.key || badge._id}) to user ${userId}`);
        console.log(`[Achievement] 🎖️ Badge details:`, {
          name: badge.name,
          category: badge.badgeCategory,
          metric: badge.logicConfig?.metric || badge.category,
          targetValue: badge.targetValue || badge.logicConfig?.value,
        });
        console.log(`[Achievement] 📋 User now has ${freshUser.badges.length} total badge(s)`);

        // Emit socket event if io is provided
        if (io) {
          io.to(`user:${userId}`).emit("BADGE_EARNED", {
            badge: {
              _id: badge._id,
              name: badge.name,
              description: badge.description,
              imageUrl: badge.imageUrl,
            },
            earnedAt: new Date(),
          });
        }
      } else {
        console.log(`[Achievement] ❌ User ${userId} does NOT qualify for badge "${badge.name}"`);
      }
    }

    return newlyAwarded;
  } catch (error) {
    console.error(`[Achievement] Error checking badges for user ${userId}:`, error);
    return [];
  }
}

/**
 * Check STATISTIC badge criteria
 * 
 * @param {Object} badge - Badge document
 * @param {Object} stats - User stats document
 * @param {Object} user - User document
 * @returns {Boolean} True if user qualifies
 */
function checkStatisticBadge(badge, stats, user) {
  try {
    const { logicConfig, targetValue, condition = "gte" } = badge;
    const metric = logicConfig?.metric || badge.category; // Fallback to legacy category

    let userValue = 0;

    switch (metric) {
      case "wins":
      case "totalWins":
        userValue = stats.wins?.total || 0;
        break;

      case "botWins":
        userValue = stats.wins?.bot || 0;
        break;

      case "streak":
      case "winStreak":
        userValue = stats.currentStreak || 0;
        break;

      case "rating":
      case "highestRating":
        const ratings = user.ratings || {};
        const bulletRating = ratings.bullet?.rating || 1500;
        const blitzRating = ratings.blitz?.rating || 1500;
        const rapidRating = ratings.rapid?.rating || 1500;
        userValue = Math.max(bulletRating, blitzRating, rapidRating);
        break;

      case "bulletRating":
        userValue = user.ratings?.bullet?.rating || 1500;
        break;

      case "blitzRating":
        userValue = user.ratings?.blitz?.rating || 1500;
        break;

      case "rapidRating":
        userValue = user.ratings?.rapid?.rating || 1500;
        break;

      case "games":
      case "totalGames":
        userValue = stats.gamesPlayed?.total || 0;
        break;

      case "bulletGames":
        userValue = stats.gamesPlayed?.bullet || 0;
        break;

      case "blitzGames":
        userValue = stats.gamesPlayed?.blitz || 0;
        break;

      case "rapidGames":
        userValue = stats.gamesPlayed?.rapid || 0;
        break;

      case "bulletWins":
        userValue = stats.wins?.bullet || 0;
        break;

      case "blitzWins":
        userValue = stats.wins?.blitz || 0;
        break;

      case "rapidWins":
        userValue = stats.wins?.rapid || 0;
        break;

      default:
        console.warn(`[Achievement] Unknown STATISTIC metric: ${metric}`);
        return false;
    }

    // Apply condition
    const effectiveCondition = logicConfig?.condition || condition;
    if (effectiveCondition === "exact") {
      return userValue === targetValue;
    } else if (effectiveCondition === "gte") {
      return userValue >= targetValue;
    } else {
      console.warn(`[Achievement] Unknown condition: ${effectiveCondition}`);
      return false;
    }
  } catch (error) {
    console.error(`[Achievement] Error checking STATISTIC badge ${badge._id}:`, error);
    return false;
  }
}

/**
 * Check GAME_EVENT badge criteria
 * 
 * @param {Object} badge - Badge document
 * @param {Object} game - Game document
 * @param {Object} user - User document
 * @returns {Boolean} True if user qualifies
 */
function checkGameEventBadge(badge, game, user) {
  try {
    const { logicConfig } = badge;
    const event = logicConfig?.event;

    if (!event) {
      console.warn(`[Achievement] GAME_EVENT badge ${badge._id} missing event in logicConfig`);
      return false;
    }

    // Determine if user won the game
    const userIsWhite = game.players?.white?.toString() === user._id.toString();
    const userIsBlack = game.players?.black?.toString() === user._id.toString();
    const userWon = (userIsWhite && game.result?.winner === "white") || 
                    (userIsBlack && game.result?.winner === "black");

    if (!userWon) {
      return false; // Most game event badges require a win
    }

    switch (event) {
      case "heart_attack_finish":
        // Win with less than 0.5 seconds remaining
        const userTimeRemaining = userIsWhite ? game.timeRemaining?.white : game.timeRemaining?.black;
        return userTimeRemaining && userTimeRemaining < 500; // Less than 500ms

      case "mate_with_pawn":
        // Check if the last move was a pawn checkmate
        if (!game.moves || game.moves.length === 0) return false;
        const lastMove = game.moves[game.moves.length - 1];
        const isPawn = lastMove.piece?.toLowerCase() === "p";
        const isCheckmate = game.result?.reason === "checkmate";
        return isPawn && isCheckmate;

      case "mate_with_knight":
        // Check if the last move was a knight checkmate
        if (!game.moves || game.moves.length === 0) return false;
        const lastMoveKnight = game.moves[game.moves.length - 1];
        const isKnight = lastMoveKnight.piece?.toLowerCase() === "n";
        const isCheckmateKnight = game.result?.reason === "checkmate";
        return isKnight && isCheckmateKnight;

      case "castling_mate":
        // Check if checkmate was delivered via castling
        if (!game.moves || game.moves.length === 0) return false;
        const lastMoveCastle = game.moves[game.moves.length - 1];
        const isCastling = lastMoveCastle.notation?.includes("O-O") || 
                          lastMoveCastle.notation?.includes("0-0");
        const isCheckmateCastle = game.result?.reason === "checkmate";
        return isCastling && isCheckmateCastle;

      case "total_annihilation":
        // Win without losing any pieces (simplified - check if no captures by opponent)
        // This is a simplified check - a full implementation would track all captures
        return game.result?.reason === "checkmate";

      case "bullet_win":
        // Win in bullet time control
        return game.category === "bullet" && userWon;

      case "blitz_win":
        // Win in blitz time control
        return game.category === "blitz" && userWon;

      case "rapid_win":
        // Win in rapid time control
        return game.category === "rapid" && userWon;

      default:
        console.warn(`[Achievement] Unknown GAME_EVENT: ${event}`);
        return false;
    }
  } catch (error) {
    console.error(`[Achievement] Error checking GAME_EVENT badge ${badge._id}:`, error);
    return false;
  }
}

/**
 * Check OPENING badge criteria
 * 
 * @param {Object} badge - Badge document
 * @param {Object} game - Game document
 * @returns {Boolean} True if opening matches
 */
function checkOpeningBadge(badge, game) {
  try {
    const { logicConfig } = badge;
    const openingName = logicConfig?.opening;

    if (!openingName) {
      console.warn(`[Achievement] OPENING badge ${badge._id} missing opening in logicConfig`);
      return false;
    }

    if (!game.moves || game.moves.length === 0) {
      return false;
    }

    // Convert game moves to PGN format for opening detection
    const chess = new Chess();
    
    try {
      // Replay moves to get the position
      for (const move of game.moves) {
        if (move.notation) {
          try {
            chess.move(move.notation);
          } catch (e) {
            // If notation parsing fails, try to construct from from/to
            const fromSquare = indexToSquare(move.from);
            const toSquare = indexToSquare(move.to);
            if (fromSquare && toSquare) {
              try {
                chess.move({ from: fromSquare, to: toSquare, promotion: move.promotion });
              } catch (e2) {
                console.warn(`[Achievement] Failed to replay move: ${move.notation || `${fromSquare}-${toSquare}`}`);
              }
            }
          }
        }
      }

      // Get the opening name from chess.js
      const history = chess.history({ verbose: true });
      if (history.length < 2) {
        return false; // Need at least 2 moves for an opening
      }

      // Simple opening detection based on first few moves
      // This is a simplified version - a full implementation would use an opening database
      const opening = detectOpening(history, openingName);
      
      return opening === openingName;
    } catch (error) {
      console.error(`[Achievement] Error detecting opening:`, error);
      return false;
    }
  } catch (error) {
    console.error(`[Achievement] Error checking OPENING badge ${badge._id}:`, error);
    return false;
  }
}

/**
 * Detect opening from move history
 * Simplified opening detection - can be enhanced with a proper opening database
 */
function detectOpening(history, targetOpening) {
  if (history.length < 2) return null;

  const firstMove = history[0].san;
  const secondMove = history[1].san;

  // Simplified opening detection
  const openingMap = {
    "Ruy Lopez": firstMove === "e4" && secondMove === "e5" && history[2]?.san === "Nf3" && history[3]?.san === "Nc6" && history[4]?.san === "Bb5",
    "Sicilian Defense": firstMove === "e4" && secondMove === "c5",
    "French Defense": firstMove === "e4" && secondMove === "e6",
    "Caro-Kann Defense": firstMove === "e4" && secondMove === "c6",
    "Italian Game": firstMove === "e4" && secondMove === "e5" && history[2]?.san === "Nf3" && history[3]?.san === "Nc6" && history[4]?.san === "Bc4",
    "King's Gambit": firstMove === "e4" && secondMove === "e5" && history[2]?.san === "f4",
    "Queen's Gambit": firstMove === "d4" && secondMove === "d5" && history[2]?.san === "c4",
  };

  // Check if target opening matches
  for (const [opening, condition] of Object.entries(openingMap)) {
    if (opening === targetOpening && condition) {
      return opening;
    }
  }

  return null;
}

/**
 * Convert board index to square notation (e.g., 0 -> "a8", 63 -> "h1")
 */
function indexToSquare(index) {
  if (index < 0 || index > 63) return null;
  const file = String.fromCharCode(97 + (index % 8)); // a-h
  const rank = 8 - Math.floor(index / 8); // 1-8
  return file + rank;
}

/**
 * Legacy badge checking (backward compatibility)
 */
function checkLegacyBadge(badge, stats, user) {
  const { category, targetValue, condition = "gte" } = badge;

  try {
    let userValue = 0;

    switch (category) {
      case "wins":
        userValue = stats.wins?.total || 0;
        break;
      case "streak":
      case "winStreak":
        userValue = stats.currentStreak || 0;
        break;
      case "rating":
      case "highestRating":
        const ratings = user.ratings || {};
        const bulletRating = ratings.bullet?.rating || 1500;
        const blitzRating = ratings.blitz?.rating || 1500;
        const rapidRating = ratings.rapid?.rating || 1500;
        userValue = Math.max(bulletRating, blitzRating, rapidRating);
        break;
      case "games":
      case "totalGames":
        userValue = stats.gamesPlayed?.total || 0;
        break;
      case "botWins":
        userValue = stats.wins?.bot || 0;
        break;
      case "custom":
        return false;
      default:
        return false;
    }

    if (condition === "exact") {
      return userValue === targetValue;
    } else if (condition === "gte") {
      return userValue >= targetValue;
    }
    return false;
  } catch (error) {
    console.error(`[Achievement] Error checking legacy badge ${badge._id}:`, error);
    return false;
  }
}

module.exports = {
  checkAndAwardBadges,
  checkStatisticBadge,
  checkGameEventBadge,
  checkOpeningBadge,
};

// 