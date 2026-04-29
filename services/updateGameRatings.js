const User = require("../models/User");

/**
 * Update Glicko-2 ratings for both players after a game ends
 * This is a reusable function that can be called from any game end scenario
 * 
 * @param {Object} game - Game object with players, category, and result
 * @param {Object} io - Socket.io instance for emitting events
 * @returns {Promise<void>}
 */
async function updateGameRatings(game, io) {
  console.log(`[Rating] updateGameRatings called for game ${game.gameId}:`, {
    type: game.type,
    category: game.category,
    hasWhite: !!game.players.white,
    hasBlack: !!game.players.black,
    movesCount: game.moves?.length || 0,
    result: game.result,
  });

  // Check if game was aborted (no moves made)
  const isAborted = !game.moves || game.moves.length === 0;
  
  // Only update ratings for multiplayer games, not bot games, and not aborted games
  if (game.type === "bot" || !game.players.white || !game.players.black || isAborted || !game.category) {
    if (isAborted) {
      console.log(`[Rating] Skipping rating update for aborted game ${game.gameId} (no moves made)`);
    } else if (game.type === "bot") {
      console.log(`[Rating] Skipping rating update for bot game ${game.gameId}`);
    } else if (!game.category) {
      console.log(`[Rating] Skipping rating update for game ${game.gameId} - no category set`);
    } else {
      console.log(`[Rating] Skipping rating update for game ${game.gameId} - missing players or other issue`);
    }
    return;
  }

  try {
    const { calculateNewRatings } = require("./ratingEngine");
    
    // Ensure players are populated (handle both ObjectId and populated objects)
    const whitePlayerId = game.players.white?._id || game.players.white;
    const blackPlayerId = game.players.black?._id || game.players.black;
    
    if (!whitePlayerId || !blackPlayerId) {
      console.error("[Rating] Missing player IDs:", {
        white: whitePlayerId,
        black: blackPlayerId,
        gameId: game.gameId,
      });
      return;
    }
    
    // Fetch full user objects with ratings
    const whiteUser = await User.findById(whitePlayerId);
    const blackUser = await User.findById(blackPlayerId);
    
    if (!whiteUser || !blackUser) {
      console.error("[Rating] Could not find one or both users for rating update:", {
        whiteUserId: whitePlayerId,
        blackUserId: blackPlayerId,
        whiteFound: !!whiteUser,
        blackFound: !!blackUser,
      });
      return;
    }

    // Determine result from white player's perspective
    const whiteResult =
      game.result?.winner === "white"
        ? "win"
        : game.result?.winner === "black"
        ? "loss"
        : "draw";
    
    console.log(`[Rating] Game result:`, {
      winner: game.result?.winner,
      reason: game.result?.reason,
      whiteResult: whiteResult,
    });
    
    // Use the stored category from the game
    // If category is missing, set it based on timeControl
    let ratingType = game.category;
    if (!ratingType && game.timeControl) {
      const { setGameCategory } = require("./ratingEngine");
      setGameCategory(game);
      ratingType = game.category;
      await game.save();
      console.log(`[Rating] Set missing category for game ${game.gameId}: ${ratingType}`);
    }
    
    if (!ratingType) {
      console.error(`[Rating] Cannot determine game category for game ${game.gameId}`);
      return;
    }

    if (ratingType === "un-timed") {
      console.log(
        `[Rating] Skipping Glicko update for un-timed game ${game.gameId} (no rating pool)`
      );
      return;
    }
    
    console.log(`[Rating] Using category: ${ratingType} for rating update`);
    
    // Get current rating data for this category
    const whiteRatingData = whiteUser.ratings?.[ratingType] || {
      rating: 1500,
      rd: 350,
      volatility: 0.06,
      gamesPlayed: 0,
    };
    
    const blackRatingData = blackUser.ratings?.[ratingType] || {
      rating: 1500,
      rd: 350,
      volatility: 0.06,
      gamesPlayed: 0,
    };
    
    console.log(`[Rating] Current ratings before update:`, {
      white: {
        rating: whiteRatingData.rating,
        rd: whiteRatingData.rd,
        gamesPlayed: whiteRatingData.gamesPlayed,
      },
      black: {
        rating: blackRatingData.rating,
        rd: blackRatingData.rd,
        gamesPlayed: blackRatingData.gamesPlayed,
      },
    });
    
    // Store old ratings for change calculation
    const whiteOldRating = whiteRatingData.rating;
    const blackOldRating = blackRatingData.rating;
    
    // Calculate new ratings
    const updatedRatings = calculateNewRatings(
      whiteRatingData,
      blackRatingData,
      whiteResult,
      ratingType
    );
    
    // Initialize ratings object if needed
    if (!whiteUser.ratings) {
      whiteUser.ratings = {
        bullet: { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 },
        blitz: { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 },
        rapid: { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 },
      };
    }
    if (!blackUser.ratings) {
      blackUser.ratings = {
        bullet: { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 },
        blitz: { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 },
        rapid: { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 },
      };
    }
    
    // Atomically update both users' ratings
    whiteUser.ratings[ratingType] = updatedRatings.player1;
    blackUser.ratings[ratingType] = updatedRatings.player2;
    
    console.log(`[Rating] Saving updated ratings to database:`, {
      white: {
        rating: updatedRatings.player1.rating,
        rd: updatedRatings.player1.rd,
        gamesPlayed: updatedRatings.player1.gamesPlayed,
      },
      black: {
        rating: updatedRatings.player2.rating,
        rd: updatedRatings.player2.rd,
        gamesPlayed: updatedRatings.player2.gamesPlayed,
      },
    });
    
    await whiteUser.save();
    await blackUser.save();
    
    console.log(`[Rating] Ratings saved successfully to database`);
    
    // Calculate rating changes
    const whiteRatingChange = Math.round(updatedRatings.player1.rating - whiteOldRating);
    const blackRatingChange = Math.round(updatedRatings.player2.rating - blackOldRating);
    
    // Emit rating update events via Socket.io
    if (io) {
      const whitePayload = {
        newRating: Math.round(updatedRatings.player1.rating),
        ratingChange: whiteRatingChange,
        category: ratingType,
        isProvisional: updatedRatings.player1.gamesPlayed < 5,
        gamesPlayed: updatedRatings.player1.gamesPlayed,
      };
      
      const blackPayload = {
        newRating: Math.round(updatedRatings.player2.rating),
        ratingChange: blackRatingChange,
        category: ratingType,
        isProvisional: updatedRatings.player2.gamesPlayed < 5,
        gamesPlayed: updatedRatings.player2.gamesPlayed,
      };
      
      const whiteRoom = `user:${whiteUser._id.toString()}`;
      const blackRoom = `user:${blackUser._id.toString()}`;
      
      console.log(`[Rating] Emitting RATING_UPDATED events:`, {
        whiteRoom,
        whitePayload,
        blackRoom,
        blackPayload,
      });
      
      // Emit to white player
      io.to(whiteRoom).emit("RATING_UPDATED", whitePayload);
      
      // Emit to black player
      io.to(blackRoom).emit("RATING_UPDATED", blackPayload);
      
      // Also emit to game room as backup
      io.to(game.gameId).emit("RATING_UPDATED", {
        white: whitePayload,
        black: blackPayload,
      });
      
      console.log(`[Rating] RATING_UPDATED events emitted successfully to rooms: ${whiteRoom}, ${blackRoom}, ${game.gameId}`);
    } else {
      console.warn(`[Rating] Socket.io instance not available, cannot emit RATING_UPDATED events`);
    }
    
      console.log(`[Rating] Updated ${ratingType} ratings for game ${game.gameId}:`, {
      white: { old: whiteOldRating, new: updatedRatings.player1.rating, change: whiteRatingChange },
      black: { old: blackOldRating, new: updatedRatings.player2.rating, change: blackRatingChange },
    });

    // Badge awarding intentionally happens in routes/games.js only, via
    // services/achievementService, to keep a single source of truth.
  } catch (ratingError) {
    // Don't fail game completion if rating calculation fails
    console.error("[Rating] Error updating ratings:", ratingError);
  }
}

module.exports = { updateGameRatings };

