# Game Review Processor

A complete Stockfish-based game review system for analyzing chess games move-by-move.

## Features

- ✅ **Move-by-move analysis** using Stockfish depth 15
- ✅ **Move classification**: Good, Inaccuracy, Mistake, Blunder
- ✅ **Missed mate detection**
- ✅ **Tactical swing detection** (large evaluation changes)
- ✅ **Opening detection** (basic ECO recognition)
- ✅ **Endgame phase detection**
- ✅ **Actionable suggestions** based on game analysis
- ✅ **PGN parsing** (minimal, no external dependencies)
- ✅ **UCI move format** support

## Architecture

### Modular Design

```
utils/game-review/
├── index.js          # Main entry point
├── engine.js         # Stockfish communication & process management
├── parser.js         # PGN parsing (minimal, no external libs)
├── analyzer.js       # Main analysis loop
├── classifier.js     # Move classification logic
├── suggestions.js    # Suggestion generation
├── example.js        # Usage examples
├── USAGE.md          # Detailed usage guide
└── README.md         # This file
```

### Single Process Design

**Why single Stockfish process instead of pool?**

1. **Sequential Analysis**: Game reviews analyze moves sequentially (move 1, then 2, then 3...)
2. **Resource Efficiency**: Stockfish is CPU-intensive; parallel analysis would overload the system
3. **State Management**: Easier to manage position state without race conditions
4. **Queue System**: Built-in queue handles sequential requests properly

## Quick Start

```javascript
const { generateGameReview } = require('./utils/game-review');

const review = await generateGameReview({
  moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
  depth: 15
});

console.log(`Accuracy: ${review.overview.accuracy}%`);
console.log(`Blunders: ${review.summary.blunders}`);
```

## API Integration

The module is integrated into the Express API:

**Route**: `POST /api/game-review/:gameId`

**Authentication**: Required (JWT token)

**Response**:
```json
{
  "success": true,
  "message": "Game review generated successfully",
  "data": {
    "review": {
      "overview": { ... },
      "moves": [ ... ],
      "summary": { ... },
      "opening": { ... },
      "endgame": { ... },
      "suggestions": [ ... ]
    }
  }
}
```

## Move Classifications

| Label | Centipawn Loss | Description |
|-------|---------------|-------------|
| **good** | < 50 | Move is within acceptable range |
| **inaccuracy** | 50-149 | Minor inaccuracy, not critical |
| **mistake** | 150-299 | Significant error |
| **blunder** | ≥ 300 | Major error or missed mate |

## Performance

- **Per move**: ~2-5 seconds (depth 15)
- **40-move game**: ~2-3 minutes total
- **Memory**: Single Stockfish process (~50-100MB)
- **CPU**: High during analysis (single-threaded)

## Error Handling

The module includes robust error handling:
- Stockfish process failures
- Timeout handling (30s default per position)
- Invalid move format detection
- Queue management for concurrent requests

## Limitations

1. **PGN Parsing**: Basic parser, may not handle all variations/comments
2. **SAN Support**: PGN moves in SAN format need conversion (currently assumes UCI)
3. **Opening Detection**: Simplified, uses basic pattern matching
4. **Endgame Detection**: Heuristic-based (move count), not material-based

## Future Enhancements

- [ ] Full SAN to UCI conversion
- [ ] ECO database integration for opening detection
- [ ] Material-based endgame detection
- [ ] Caching system for completed game reviews
- [ ] Parallel analysis for faster reviews (with resource limits)
- [ ] Export to PGN with annotations
- [ ] Interactive review viewer

## Testing

Run the example:
```bash
node utils/game-review/example.js
```

## Dependencies

- **Stockfish binary**: Must be available in `stockfish/` directory
- **Node.js**: v14+ (uses async/await, optional chaining)

## License

Part of ChessOnes project.


