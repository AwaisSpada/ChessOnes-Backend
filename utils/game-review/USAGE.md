# Game Review Processor - Usage Guide

## Overview

The Game Review Processor analyzes chess games using Stockfish to provide detailed move-by-move analysis, classification, and suggestions.

## Basic Usage

```javascript
const { generateGameReview } = require('./utils/game-review');

// Using UCI moves array
const review = await generateGameReview({
  moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
  depth: 15, // Optional: analysis depth (default: 15)
  movetime: 5000, // Optional: time limit in ms (overrides depth if set)
});

// Using PGN string
const reviewFromPGN = await generateGameReview({
  optionalPgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5',
  depth: 15,
});
```

## Review Output Structure

```javascript
{
  overview: {
    totalMoves: 40,
    accuracy: 75.5,
    quality: "good",
    dateAnalyzed: "2024-01-15T10:30:00.000Z"
  },
  moves: [
    {
      moveNumber: 1,
      playedMove: "e2e4",
      bestMove: "e2e4",
      evalBefore: "+0.20",
      evalAfter: "+0.30",
      evalBestAfter: "+0.30",
      centipawnLoss: 0,
      label: "good",
      pv: ["e2e4", "e7e5", "g1f3", "b8c6"],
      missedMate: false,
      tacticalSwing: false,
      depth: 15
    },
    // ... more moves
  ],
  summary: {
    totalMoves: 40,
    accuracy: 75.5,
    averageCentipawnLoss: 24.5,
    blunders: 2,
    mistakes: 5,
    inaccuracies: 8,
    goodMoves: 25,
    missedMates: 1,
    tacticalSwings: 3,
    bestMove: { moveNumber: 15, ... },
    worstMove: { moveNumber: 23, ... }
  },
  opening: {
    name: "King's Knight Opening",
    eco: "C20"
  },
  endgame: {
    phase: "endgame",
    moveCount: 40,
    finalEvaluation: "+1.50"
  },
  suggestions: [
    {
      type: "tactics",
      priority: "high",
      title: "Practice Tactical Puzzles",
      description: "You missed 1 mate opportunity in this game...",
      action: "Solve 10-20 tactical puzzles daily..."
    }
    // ... more suggestions
  ]
}
```

## Move Classifications

- **good**: centipawnLoss < 50
- **inaccuracy**: 50 <= centipawnLoss < 150
- **mistake**: 150 <= centipawnLoss < 300
- **blunder**: centipawnLoss >= 300

## API Integration

Add the route to your Express app:

```javascript
// In server.js
app.use("/api/game-review", require("./routes/game-review"));
```

Then call from frontend:

```javascript
// POST /api/game-review/:gameId
const response = await fetch(`/api/game-review/${gameId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});

const { review } = await response.json();
```

## Advanced Usage

### Custom Analysis Depth

```javascript
const review = await generateGameReview({
  moves: movesArray,
  depth: 20, // Deeper analysis (slower)
});
```

### Time-Limited Analysis

```javascript
const review = await generateGameReview({
  moves: movesArray,
  movetime: 3000, // 3 seconds per position
});
```

### Accessing Sub-Modules

```javascript
const { parser, analyzer, classifier, engine } = require('./utils/game-review');

// Parse PGN
const moves = parser.parsePGN(pgnString);

// Analyze single move
const moveAnalysis = await analyzer.analyzeMove(
  movesUpToBefore,
  playedMove,
  moveNumber,
  { depth: 15 }
);

// Classify move
const label = classifier.classifyMove(centipawnLoss, { missedMate: false });
```

## Error Handling

```javascript
try {
  const review = await generateGameReview({ moves: movesArray });
} catch (error) {
  if (error.message.includes('Stockfish')) {
    console.error('Stockfish engine error:', error);
  } else if (error.message.includes('No moves')) {
    console.error('Invalid input:', error);
  } else {
    console.error('Unknown error:', error);
  }
}
```

## Performance Considerations

- Analysis time: ~2-5 seconds per move (depending on depth)
- For a 40-move game: ~2-3 minutes total
- Consider caching reviews for completed games
- Use lower depth (10-12) for faster analysis during development

## Cleanup

When done with all reviews, cleanup the engine:

```javascript
const { cleanup } = require('./utils/game-review');
cleanup(); // Closes Stockfish process
```

## Notes

- Uses a single shared Stockfish process (sequential analysis)
- Moves must be in UCI format (e.g., "e2e4")
- PGN parsing is basic - may not handle all variations/comments
- Stockfish binary must be available in `stockfish/` directory


