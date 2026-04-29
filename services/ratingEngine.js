const { Glicko2 } = require("glicko2");

/**
 * Glicko-2 Rating Calculation Service
 * 
 * System constant tau = 0.5 (controls volatility changes)
 * This value is recommended by Glicko-2 for most applications
 */
const TAU = 0.5;

// Initialize Glicko-2 rating system
const ratingSystem = new Glicko2({
  tau: TAU,
  rating: 1500,
  rd: 350,
  vol: 0.06,
});

/**
 * Determine time control category from game time control
 * 
 * @param {Number} initialTime - Initial time in milliseconds
 * @returns {String} - 'bullet', 'blitz', 'rapid', or 'un-timed'
 */
function getTimeControlCategory(initialTime) {
  if (initialTime === 0) {
    return "un-timed";
  }
  // Convert milliseconds to minutes
  const minutes = initialTime / 60000;

  if (minutes < 3) {
    return "bullet";
  } else if (minutes <= 10) {
    return "blitz";
  } else {
    return "rapid";
  }
}

/**
 * Set category on game object based on time control
 * This should be called when creating a game
 * 
 * @param {Object} game - Game object or game data
 * @returns {String} - The category that was set
 */
function setGameCategory(game) {
  const initialTime = game.timeControl?.initial || game.timeControl?.initial || 600000;
  const category = getTimeControlCategory(initialTime);
  
  if (game.set) {
    // Mongoose document
    game.category = category;
  } else {
    // Plain object
    game.category = category;
  }
  
  return category;
}

/**
 * Calculate new Glicko-2 ratings for both players after a game
 * 
 * @param {Object} player1 - First player's rating data for the time control
 * @param {Object} player2 - Second player's rating data for the time control
 * @param {String} result - Game result from player1's perspective: 'win', 'loss', or 'draw'
 * @param {String} type - Time control type: 'bullet', 'blitz', or 'rapid'
 * @returns {Object} - Updated ratings for both players
 * 
 * @example
 * const player1 = { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 };
 * const player2 = { rating: 1500, rd: 350, volatility: 0.06, gamesPlayed: 0 };
 * const result = 'win'; // player1 won
 * const updated = calculateNewRatings(player1, player2, result, 'blitz');
 * // Returns: { player1: { rating: 1650, rd: 290, volatility: 0.06, gamesPlayed: 1 }, ... }
 */
function calculateNewRatings(player1, player2, result, type) {
  // Validate inputs
  if (!player1 || !player2) {
    throw new Error("Both players must have rating data");
  }
  
  if (!["win", "loss", "draw"].includes(result)) {
    throw new Error("Result must be 'win', 'loss', or 'draw'");
  }
  
  if (!["bullet", "blitz", "rapid"].includes(type)) {
    throw new Error("Type must be 'bullet', 'blitz', or 'rapid'");
  }

  // Determine initial RD based on games played
  // Provisional (< 5 games): Use stored RD or default 350
  // Confirmed (>= 5 games): Use 50 (fixed for established players)
  const p1CurrentGamesPlayed = player1.gamesPlayed || 0;
  const p2CurrentGamesPlayed = player2.gamesPlayed || 0;
  
  const p1InitialRd = p1CurrentGamesPlayed >= 5 ? 50 : (player1.rd || 350);
  const p2InitialRd = p2CurrentGamesPlayed >= 5 ? 50 : (player2.rd || 350);
  
  console.log(`[Rating Engine] Initializing players with RD:`, {
    player1: { gamesPlayed: p1CurrentGamesPlayed, rd: p1InitialRd, isConfirmed: p1CurrentGamesPlayed >= 5 },
    player2: { gamesPlayed: p2CurrentGamesPlayed, rd: p2InitialRd, isConfirmed: p2CurrentGamesPlayed >= 5 },
  });

  // Create Glicko-2 player objects
  const p1 = ratingSystem.makePlayer(
    player1.rating || 1500,
    p1InitialRd,
    player1.volatility || 0.06
  );
  
  const p2 = ratingSystem.makePlayer(
    player2.rating || 1500,
    p2InitialRd,
    player2.volatility || 0.06
  );

  // Convert result to Glicko-2 score (1 = win, 0 = loss, 0.5 = draw)
  // Score is from player1's perspective
  let score;
  if (result === "win") {
    score = 1;
  } else if (result === "loss") {
    score = 0;
  } else {
    score = 0.5;
  }

  // Add results for both players
  // p1's result against p2
  p1.addResult(p2, score);
  
  // p2's result against p1 (reverse the score)
  // If p1 wins (1), p2 loses (0). If p1 loses (0), p2 wins (1). If draw (0.5), both get 0.5
  p2.addResult(p1, 1 - score);

  // Update ratings after adding results
  p1.update_rank();
  p2.update_rank();

  // Get updated values
  // getRating() returns a single number (the rating), not an array
  const p1Rating = p1.getRating();
  let p1Rd = p1.getRd();
  const p1Vol = p1.getVol();
  
  const p2Rating = p2.getRating();
  let p2Rd = p2.getRd();
  const p2Vol = p2.getVol();

  // Calculate games played after this game
  const p1GamesPlayed = (player1.gamesPlayed || 0) + 1;
  const p2GamesPlayed = (player2.gamesPlayed || 0) + 1;

  // RD Management: Set RD to 50 for confirmed ratings (>= 5 games), keep calculated RD for provisional (< 5 games)
  // Provisional ratings (< 5 games): Use calculated RD (starts at 350, decreases with each game)
  // Confirmed ratings (>= 5 games): Set RD to 50 (fixed value for established players)
  if (p1GamesPlayed >= 5) {
    p1Rd = 50;
    console.log(`[Rating Engine] Player 1 has ${p1GamesPlayed} games - setting RD to 50 (confirmed rating)`);
  } else {
    console.log(`[Rating Engine] Player 1 has ${p1GamesPlayed} games - using calculated RD ${p1Rd.toFixed(2)} (provisional rating)`);
  }

  if (p2GamesPlayed >= 5) {
    p2Rd = 50;
    console.log(`[Rating Engine] Player 2 has ${p2GamesPlayed} games - setting RD to 50 (confirmed rating)`);
  } else {
    console.log(`[Rating Engine] Player 2 has ${p2GamesPlayed} games - using calculated RD ${p2Rd.toFixed(2)} (provisional rating)`);
  }

  const updatedRatings = {
    player1: {
      rating: p1Rating, // Updated rating
      rd: p1Rd,     // Updated rating deviation (50 if confirmed, calculated if provisional)
      volatility: p1Vol, // Updated volatility
      gamesPlayed: p1GamesPlayed,
    },
    player2: {
      rating: p2Rating,
      rd: p2Rd,
      volatility: p2Vol,
      gamesPlayed: p2GamesPlayed,
    },
  };

  console.log(`[Rating Engine] Calculated new ratings:`, {
    input: {
      player1: { rating: player1.rating, rd: player1.rd, gamesPlayed: player1.gamesPlayed },
      player2: { rating: player2.rating, rd: player2.rd, gamesPlayed: player2.gamesPlayed },
      gameResult: result,
    },
    output: {
      player1: updatedRatings.player1,
      player2: updatedRatings.player2,
    },
    changes: {
      player1: updatedRatings.player1.rating - player1.rating,
      player2: updatedRatings.player2.rating - player2.rating,
    },
  });

  // Return updated rating objects
  return updatedRatings;
}

/**
 * Calculate new ratings from game data
 * 
 * This is a convenience function that extracts rating data from user objects
 * and determines the time control category from the game.
 * 
 * @param {Object} user1 - First user object (must have ratings object)
 * @param {Object} user2 - Second user object (must have ratings object)
 * @param {String} result - Game result from user1's perspective: 'win', 'loss', or 'draw'
 * @param {Number} initialTime - Initial time in milliseconds
 * @returns {Object} - Updated ratings for both players
 */
function calculateRatingsFromGame(user1, user2, result, initialTime) {
  // Determine time control category
  const type = getTimeControlCategory(initialTime);
  
  // Extract current rating data for the time control
  const player1Data = user1.ratings?.[type] || {
    rating: 1500,
    rd: 350,
    volatility: 0.06,
    gamesPlayed: 0,
  };
  
  const player2Data = user2.ratings?.[type] || {
    rating: 1500,
    rd: 350,
    volatility: 0.06,
    gamesPlayed: 0,
  };

  // Calculate new ratings
  return calculateNewRatings(player1Data, player2Data, result, type);
}

module.exports = {
  TAU,
  calculateNewRatings,
  calculateRatingsFromGame,
  getTimeControlCategory,
  setGameCategory,
};

