# Backend Scripts

This directory contains utility scripts for the ChessOnes backend.

## Available Scripts

### verify-puzzle-models.js

**Purpose**: Verify that Puzzle and PuzzleAttempt model updates maintain backward compatibility.

**Usage**:
```bash
cd ChessOnes-Backend
node scripts/verify-puzzle-models.js
```

**What it tests**:
- ✅ Schema has all required fields
- ✅ New fields are optional with safe defaults
- ✅ Can create documents without new fields (backward compatibility)
- ✅ Can create documents with new fields (new functionality)
- ✅ Pre-save hooks still work (difficulty calculation)
- ✅ Existing documents in database are still valid
- ✅ Indexes are correct

**Requirements**:
- MongoDB connection (uses `MONGODB_URI` env var or defaults to `mongodb://localhost:27017/chessones`)
- Node.js installed

**Expected Output**:
```
============================================================
Puzzle Model Sanity Check
============================================================

ℹ Connecting to MongoDB: mongodb://localhost:27017/chessones
✓ Connected to MongoDB
✓ Puzzle schema has required 'moves' field
✓ Puzzle schema has optional 'solutionTree' field
✓ Puzzle schema has 'popularityScore' field with default
✓ Puzzle schema has 'averageSolveTime' field with default
✓ PuzzleAttempt schema has required fields
✓ PuzzleAttempt schema has optional 'attemptHistory' field
✓ Can create puzzle without new fields
✓ Can create puzzle with new fields
✓ Difficulty calculation pre-save hook works
✓ Can create puzzle attempt without new fields
✓ Can create puzzle attempt with new fields
✓ Existing puzzles in database are still valid
ℹ Found 1234 existing puzzles in database
ℹ Sample puzzle: abc123 (rating: 1500)
✓ Existing puzzle attempts in database are still valid
ℹ Found 567 existing puzzle attempts in database
ℹ Sample attempt: solved=true, attempts=2
✓ Puzzle indexes are correct
ℹ Puzzle indexes: _id_, puzzleId_1, rating_1, ...
✓ PuzzleAttempt indexes are correct
ℹ PuzzleAttempt indexes: _id_, user_1_puzzle_1, ...
✓ Disconnected from MongoDB

============================================================
Test Summary
============================================================
Passed: 12
Failed: 0
============================================================

✓ All tests passed! Models are backward compatible.
```

**Troubleshooting**:

1. **Connection Error**:
   ```
   Error: connect ECONNREFUSED 127.0.0.1:27017
   ```
   Solution: Ensure MongoDB is running or set `MONGODB_URI` environment variable:
   ```bash
   export MONGODB_URI="mongodb://your-mongodb-url"
   node scripts/verify-puzzle-models.js
   ```

2. **No Puzzles Found**:
   ```
   ⚠ No existing puzzles found in database
   ```
   This is a warning, not an error. The script will still verify that the schema is correct.

3. **Schema Validation Error**:
   ```
   ✗ Puzzle schema has required 'moves' field: moves field is not required
   ```
   Solution: Check that the model file hasn't been modified incorrectly. The `moves` field must remain required.

**Exit Codes**:
- `0` - All tests passed
- `1` - One or more tests failed

---

## Adding New Scripts

When adding new scripts to this directory:

1. Add a descriptive comment at the top of the file
2. Include usage instructions
3. Handle errors gracefully
4. Use meaningful exit codes
5. Update this README with script documentation

---

## Related Documentation

- `../PUZZLE_MODEL_MIGRATION_GUIDE.md` - Comprehensive migration guide
- `../PUZZLE_MODEL_CHANGES_SUMMARY.md` - Summary of changes
- `../PUZZLE_MODEL_VISUAL_SUMMARY.md` - Visual reference
- `../models/Puzzle.js` - Puzzle model source
- `../models/PuzzleAttempt.js` - PuzzleAttempt model source



