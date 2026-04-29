# Stockfish Engine ELO/Difficulty Implementation

## Overview

This document describes how the Stockfish chess engine is configured based on bot ELO ratings in the ChessOnes application. The system uses Stockfish's built-in `UCI_Elo` limiting mechanism to control bot strength.

## Bot Model Structure

Each bot in the database (`back/models/Bot.js`) has the following relevant fields:

- **`elo`**: Number (typically 600-2600) - The bot's ELO rating
- **`difficulty`**: String ("easy", "medium", "hard") - Currently **not used** in Stockfish configuration

## ELO to Stockfish Configuration Mapping

### Function: `getStockfishConfig(elo)`

**Location**: `back/utils/stockfish.js` (lines 40-69)

**Input**:

- `elo`: Bot's ELO rating (number)

**Process**:

1. **Clamp ELO to valid range**:

   - Site ELO range: `600` (min) to `2600` (max)
   - Formula: `clampedSiteElo = Math.max(600, Math.min(2600, elo || 1500))`

2. **Calculate interpolation factor**:

   - `t = (clampedSiteElo - 600) / (2600 - 600)`
   - This gives a value between 0.0 (for ELO 600) and 1.0 (for ELO 2600)

3. **Map to Stockfish UCI_Elo**:

   - Stockfish ELO range: `1350` (min) to `2850` (max)
   - Formula: `engineElo = Math.round(1350 + t * (2850 - 1350))`
   - Example: ELO 1000 → t ≈ 0.2 → engineElo ≈ 1650

4. **Calculate Skill Level**:

   - Range: `0` to `20`
   - Formula: `skillLevel = Math.round(t * 20)`
   - Example: ELO 1000 → skillLevel ≈ 4

5. **Calculate Move Time**:
   - Range: `200ms` (min) to `1500ms` (max)
   - Formula: `movetime = Math.round(200 + t * (1500 - 200))`
   - Example: ELO 1000 → movetime ≈ 460ms

**Output**:

```javascript
{
  engineElo: 1650,      // Stockfish UCI_Elo value
  skillLevel: 4,        // Stockfish Skill Level (0-20)
  movetime: 460,        // Thinking time in milliseconds
  depth: 0             // Not used (depth is controlled by movetime)
}
```

## Stockfish Engine Configuration

### Function: `getBestMoveFromEngine(board, currentTurn, moveHistory, elo)`

**Location**: `back/utils/stockfish.js` (lines 531-570)

**Process**:

1. **Ensure engine is ready**: Waits for Stockfish to initialize and respond with "uciok"

2. **Get configuration**: Calls `getStockfishConfig(elo)` to get engine parameters

3. **Convert board to FEN**: Uses `boardToFEN()` to create a FEN string from the current position

4. **Configure Stockfish via UCI commands**:

   ```
   ucinewgame
   isready
   setoption name UCI_LimitStrength value true
   setoption name UCI_Elo value <engineElo>
   setoption name Skill Level value <skillLevel>
   setoption name Threads value 2
   setoption name Hash value 128
   position fen <fen_string>
   go movetime <movetime>
   ```

5. **Wait for response**: Parses Stockfish's "bestmove" output from stdout

6. **Convert UCI move to board indices**: Uses `uciToBoardIndices()` to convert (e.g., "e2e4") to `{from: 52, to: 36}`

**Key Stockfish Options**:

- `UCI_LimitStrength = true`: Enables ELO limiting mode
- `UCI_Elo`: The target ELO strength (1350-2850)
- `Skill Level`: Additional strength modifier (0-20)
- `movetime`: Maximum time Stockfish can think per move

## How Bot Moves Are Generated

### Route: `POST /api/games/:gameId/move`

**Location**: `back/routes/games.js` (lines 561-978)

**Flow**:

1. **User makes a move** → Move is validated and saved

2. **If bot's turn** → Triggered asynchronously via `setImmediate()`

3. **Load bot data**:

   ```javascript
   const bot = await Bot.findById(currentGame.bot);
   // bot.elo = 1000 (example)
   // bot.difficulty = "easy" (logged but NOT used)
   ```

4. **Call Stockfish**:

   ```javascript
   botMoveIndices = await getBestMove(
     currentGame.board,
     currentGame.currentTurn,
     currentGame.moves,
     bot.elo // Only ELO is passed, difficulty is ignored
   );
   ```

5. **Validate move**: If Stockfish returns an illegal move, fallback to best legal move using material evaluation

6. **Save and broadcast**: Bot's move is saved and sent to the client via WebSocket

## ELO Mapping Examples

| Site ELO | Interpolation (t) | Stockfish ELO | Skill Level | Move Time (ms) |
| -------- | ----------------- | ------------- | ----------- | -------------- |
| 600      | 0.0               | 1350          | 0           | 200            |
| 800      | 0.1               | 1500          | 2           | 330            |
| 1000     | 0.2               | 1650          | 4           | 460            |
| 1200     | 0.3               | 1800          | 6           | 590            |
| 1400     | 0.4               | 1950          | 8           | 720            |
| 1600     | 0.5               | 2100          | 10          | 850            |
| 1800     | 0.6               | 2250          | 12          | 980            |
| 2000     | 0.7               | 2400          | 14          | 1110           |
| 2200     | 0.8               | 2550          | 16          | 1240           |
| 2400     | 0.9               | 2700          | 18          | 1370           |
| 2600     | 1.0               | 2850          | 20          | 1500           |

## Important Notes

### What Works

✅ **ELO-based strength control**: Stockfish's `UCI_Elo` provides accurate strength limiting  
✅ **Linear mapping**: Simple, predictable scaling from site ELO to engine ELO  
✅ **Move time scaling**: Stronger bots get more thinking time  
✅ **Fallback mechanism**: If Stockfish returns illegal move, system picks best legal move

### Current Limitations

❌ **Difficulty field is ignored**: The `bot.difficulty` field ("easy", "medium", "hard") is logged but **not used** in Stockfish configuration  
❌ **Linear mapping may feel off**: ELO 1000 maps to ~1650 Stockfish ELO, which might feel stronger than expected for "easy" bots  
❌ **No difficulty-based adjustments**: "Easy" bots don't get additional weakening beyond their ELO

## Fallback Behavior

If Stockfish fails or returns an illegal move:

1. **Get all legal moves** using `getAllLegalMoves()`
2. **Evaluate each move** using simple material counting:
   - Pawn = 100
   - Knight/Bishop = 300
   - Rook = 500
   - Queen = 900
3. **Pick the best move** based on material evaluation (maximize for white, minimize for black)

## File Structure

```
back/
├── models/
│   └── Bot.js                    # Bot schema (elo, difficulty fields)
├── routes/
│   └── games.js                  # Bot move endpoint (calls getBestMove)
└── utils/
    ├── stockfish.js              # ELO mapping & Stockfish integration
    └── chess-engine.js           # Fallback move validation
```

## Related Functions

- `getStockfishConfig(elo)`: Maps site ELO to Stockfish parameters
- `getBestMoveFromEngine(...)`: Communicates with Stockfish via UCI protocol
- `getBestMove(...)`: Wrapper with fallback handling
- `boardToFEN(...)`: Converts board array to FEN string
- `uciToBoardIndices(...)`: Converts UCI move format to board indices

---

**Last Updated**: Based on current codebase state  
**Stockfish Version**: Stockfish 17
