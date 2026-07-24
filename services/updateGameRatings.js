const User = require("../models/User");
const Game = require("../models/Game");

const DEFAULT_RATING = {
  rating: 1500,
  rd: 350,
  volatility: 0.06,
  gamesPlayed: 0,
};

function playerId(player) {
  if (!player) return null;
  return player._id || player;
}

function alreadyHasRatingChanges(game) {
  const changes = game?.ratingChanges;
  if (!changes) return null;
  const white = changes.white;
  const black = changes.black;
  if (typeof white === "number" && typeof black === "number") {
    return { white, black };
  }
  return null;
}

/**
 * Update Glicko-2 ratings for both players after a game ends.
 * Computes deltas first, persists with parallel updateOne (no full-doc save),
 * and is idempotent if ratingChanges are already on the game.
 *
 * @param {Object} game - Game object with players, category, and result
 * @param {Object} io - Socket.io instance for emitting events
 * @returns {Promise<{white:number,black:number}|null>}
 */
async function updateGameRatings(game, io) {
  if (game.result?.reason === "first-move-abandon") {
    return null;
  }

  const existing = alreadyHasRatingChanges(game);
  if (existing) {
    return existing;
  }

  const isAborted = !game.moves || game.moves.length === 0;

  if (
    game.type === "bot" ||
    game.isRated === false ||
    !game.players.white ||
    !game.players.black ||
    isAborted ||
    !game.category
  ) {
    return null;
  }

  try {
    const { calculateNewRatings } = require("./ratingEngine");

    const whitePlayerId = playerId(game.players.white);
    const blackPlayerId = playerId(game.players.black);

    if (!whitePlayerId || !blackPlayerId) {
      console.error("[Rating] Missing player IDs for", game.gameId);
      return null;
    }

    // Prefer already-populated player docs (avoids extra round-trips on /end).
    let whiteRatings = game.players.white?.ratings;
    let blackRatings = game.players.black?.ratings;

    if (!whiteRatings || !blackRatings) {
      const [whiteUser, blackUser] = await Promise.all([
        User.findById(whitePlayerId).select("ratings").lean(),
        User.findById(blackPlayerId).select("ratings").lean(),
      ]);
      if (!whiteUser || !blackUser) {
        console.error("[Rating] Could not find users for", game.gameId);
        return null;
      }
      whiteRatings = whiteUser.ratings;
      blackRatings = blackUser.ratings;
    }

    const whiteResult =
      game.result?.winner === "white"
        ? "win"
        : game.result?.winner === "black"
          ? "loss"
          : "draw";

    let ratingType = game.category;
    if (!ratingType && game.timeControl) {
      const { setGameCategory } = require("./ratingEngine");
      setGameCategory(game);
      ratingType = game.category;
      await Game.updateOne(
        { gameId: game.gameId },
        { $set: { category: ratingType } }
      );
    }

    if (!ratingType || ratingType === "un-timed") {
      return null;
    }

    const whiteRatingData = whiteRatings?.[ratingType] || { ...DEFAULT_RATING };
    const blackRatingData = blackRatings?.[ratingType] || { ...DEFAULT_RATING };
    const whiteOldRating = whiteRatingData.rating;
    const blackOldRating = blackRatingData.rating;

    const updatedRatings = calculateNewRatings(
      whiteRatingData,
      blackRatingData,
      whiteResult,
      ratingType
    );

    const whiteRatingChange = Math.round(
      updatedRatings.player1.rating - whiteOldRating
    );
    const blackRatingChange = Math.round(
      updatedRatings.player2.rating - blackOldRating
    );
    const ratingChanges = {
      white: whiteRatingChange,
      black: blackRatingChange,
    };

    // Mark in-memory immediately so callers/emits are not blocked on Mongo writes.
    game.ratingChanges = ratingChanges;

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

    // Persist + profile rating events in the background (Chess.com-style).
    setImmediate(() => {
      void (async () => {
        try {
          await Promise.all([
            Game.updateOne(
              { gameId: game.gameId },
              { $set: { ratingChanges } }
            ),
            User.updateOne(
              { _id: whitePlayerId },
              { $set: { [`ratings.${ratingType}`]: updatedRatings.player1 } }
            ),
            User.updateOne(
              { _id: blackPlayerId },
              { $set: { [`ratings.${ratingType}`]: updatedRatings.player2 } }
            ),
          ]);
        } catch (persistErr) {
          console.error(
            `[Rating] Failed to persist ratings for ${game.gameId}:`,
            persistErr
          );
        }

        if (!io) return;
        try {
          io.to(`user:${whitePlayerId.toString()}`).emit(
            "RATING_UPDATED",
            whitePayload
          );
          io.to(`user:${blackPlayerId.toString()}`).emit(
            "RATING_UPDATED",
            blackPayload
          );
          io.to(game.gameId).emit("RATING_UPDATED", {
            white: whitePayload,
            black: blackPayload,
          });
        } catch (emitErr) {
          console.error(
            `[Rating] Failed to emit RATING_UPDATED for ${game.gameId}:`,
            emitErr
          );
        }
      })();
    });

    return ratingChanges;
  } catch (ratingError) {
    console.error("[Rating] Error updating ratings:", ratingError);
    return null;
  }
}

module.exports = { updateGameRatings };
