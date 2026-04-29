# Glicko-2 Rating System Implementation

## Overview

This document describes the Glicko-2 rating calculation service implementation for the ChessOnes platform.

## Files

- **`services/ratingEngine.js`** - Main rating calculation service
- **`routes/games.js`** - Integration point for rating updates after games

## System Configuration

- **TAU (τ)**: 0.5
  - Controls the volatility changes in the Glicko-2 system
  - Recommended value for most chess rating applications

## Time Control Categories

The system automatically categorizes games into three time control types:

- **Bullet**: < 3 minutes initial time
- **Blitz**: 3-10 minutes initial time  
- **Rapid**: > 10 minutes initial time

Each category maintains separate ratings, rating deviations (RD), and volatility values.

## Rating Initialization

New users start with:
- **Rating**: 1500.0
- **RD (Rating Deviation)**: 350.0
- **Volatility**: 0.06
- **Games Played**: 0

## Provisional Ratings

Ratings are considered "provisional" (displayed with "?") when `gamesPlayed < 5`.

The Glicko-2 system naturally decreases RD over time:
- Starting RD: 350
- After 1 game: ~290-300 (depending on opponent)
- After 2-3 games: ~250-280
- After 4-5 games: ~200-250
- After 6+ games: < 200 (established rating)

This ensures the provisional "?" disappears within 4-6 games as required.

## API Functions

### `calculateNewRatings(player1, player2, result, type)`

Calculates new Glicko-2 ratings for two players after a game.

**Parameters:**
- `player1`: Object with `{ rating, rd, volatility, gamesPlayed }`
- `player2`: Object with `{ rating, rd, volatility, gamesPlayed }`
- `result`: String - "win", "loss", or "draw" (from player1's perspective)
- `type`: String - "bullet", "blitz", or "rapid"

**Returns:**
```javascript
{
  player1: {
    rating: 1650.5,
    rd: 290.2,
    volatility: 0.06,
    gamesPlayed: 1
  },
  player2: {
    rating: 1349.5,
    rd: 290.2,
    volatility: 0.06,
    gamesPlayed: 1
  }
}
```

### `calculateRatingsFromGame(user1, user2, result, initialTime)`

Convenience function that extracts rating data from user objects and determines time control category.

**Parameters:**
- `user1`: User object with `ratings` property
- `user2`: User object with `ratings` property
- `result`: String - "win", "loss", or "draw" (from user1's perspective)
- `initialTime`: Number - Initial time in milliseconds

**Returns:** Same as `calculateNewRatings`

### `getTimeControlCategory(initialTime)`

Determines the time control category from initial time.

**Parameters:**
- `initialTime`: Number - Initial time in milliseconds

**Returns:** "bullet", "blitz", or "rapid"

## Integration Points

### Game End Flow

Ratings are updated in the `/api/games/:gameId/end` endpoint:

1. Game result is determined
2. Stats are updated (existing flow)
3. **NEW**: Glicko-2 ratings are calculated and updated
4. Player status is updated
5. WebSocket notification is sent

**Important Notes:**
- Ratings are only updated for **multiplayer games** (not bot games)
- Both players must exist in the game
- Rating calculation errors don't fail game completion
- All calculations are performed **server-side**

## Data Integrity

- ✅ All calculations are server-side only
- ✅ Ratings are stored in the User model's `ratings` object
- ✅ Each time control category is independent
- ✅ Games played counter is incremented automatically
- ✅ RD decreases naturally with each game

## Example Usage

```javascript
const { calculateNewRatings } = require('./services/ratingEngine');

const player1 = {
  rating: 1500,
  rd: 350,
  volatility: 0.06,
  gamesPlayed: 0
};

const player2 = {
  rating: 1500,
  rd: 350,
  volatility: 0.06,
  gamesPlayed: 0
};

// Player 1 wins
const updated = calculateNewRatings(player1, player2, 'win', 'blitz');

console.log(updated.player1.rating); // ~1650
console.log(updated.player1.rd);     // ~290
console.log(updated.player1.gamesPlayed); // 1
```

## Testing

To test the rating system:

1. Create two users
2. Play a game between them
3. Check that ratings are updated in the database
4. Verify RD decreases with each game
5. Confirm provisional "?" disappears after 5 games

## Future Enhancements

- Add rating history tracking
- Implement rating decay for inactive players
- Add rating change notifications
- Create rating leaderboards per time control

