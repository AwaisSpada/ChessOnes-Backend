# Puzzle Model Migration Guide

## Overview
This document describes the enhancements made to the Puzzle and PuzzleAttempt models to support multi-move solutions and detailed attempt tracking, while maintaining full backward compatibility.

## Changes Summary

### Puzzle Model Enhancements

#### New Fields Added
1. **solutionTree** (Optional Array)
   - Type: Array of objects `[{ move: String, reply: String }]`
   - Purpose: Support multi-move solution trees with branching logic
   - Example:
     ```json
     [
       { "move": "e2e4", "reply": "e7e5" },
       { "move": "d2d4", "reply": "d7d5" }
     ]
     ```
   - **Backward Compatibility**: Optional field, defaults to `undefined`
   - **Usage**: If present, prefer over `moves` field for puzzle logic

2. **popularityScore** (Number)
   - Type: Number
   - Default: 0
   - Purpose: Derived popularity metric for better ranking
   - **Backward Compatibility**: Safe default, indexed for performance

3. **averageSolveTime** (Number)
   - Type: Number (seconds)
   - Default: 0
   - Purpose: Track average time users take to solve this puzzle
   - **Backward Compatibility**: Safe default

#### Existing Fields (UNCHANGED)
- ✅ `puzzleId` - Still required, unique, indexed
- ✅ `fen` - Still required
- ✅ `moves` - **Still required** (kept for backward compatibility)
- ✅ `rating` - Still required, indexed
- ✅ `difficulty` - Still calculated from rating (pre-save hook unchanged)
- ✅ All other fields remain unchanged

#### New Index
- Added: `{ popularityScore: -1 }` for efficient popularity-based queries

### PuzzleAttempt Model Enhancements

#### New Fields Added
1. **attemptHistory** (Optional Array)
   - Type: Array of sub-documents
   - Structure:
     ```json
     [{
       "attemptIndex": 1,
       "movesPlayed": ["e2e4", "e7e5"],
       "solved": false,
       "timeSpent": 45,
       "usedHints": 2,
       "createdAt": "2026-01-08T10:30:00Z"
     }]
     ```
   - Purpose: Track detailed history of each attempt
   - **Backward Compatibility**: Optional field, defaults to `undefined`
   - **Usage**: Append new entries, never replace existing data

#### Existing Fields (UNCHANGED)
- ✅ `user` - Still required, indexed
- ✅ `puzzle` - Still required, indexed
- ✅ `solved` - Still used for overall solved status
- ✅ `attempts` - Still incremented on each attempt
- ✅ `timeSpent` - Still accumulated across attempts
- ✅ `ratingChange` - Still calculated using ELO system

#### Existing Index (UNCHANGED)
- ✅ `{ user: 1, puzzle: 1 }` with unique constraint

## Backward Compatibility Guarantees

### ✅ Existing Puzzles
- All existing puzzles will continue to work without modification
- The `moves` field is still required and will be used by default
- Frontend code parsing `p.moves` will work unchanged
- Rating calculation and difficulty assignment unchanged

### ✅ Existing Puzzle Attempts
- All existing attempts remain valid
- Upsert logic in `/api/puzzles/:id/attempt` works unchanged
- Rating change calculation unchanged
- Statistics aggregation unchanged

### ✅ API Routes
- No breaking changes to any endpoint
- All query parameters work as before
- Response formats unchanged (new fields simply omitted if not present)

### ✅ Frontend Code
- Current puzzle parsing logic works unchanged
- `parseMoves(p.moves, activeColor)` continues to work
- No frontend changes required for existing functionality

## Migration Strategy

### Phase 1: Model Updates (✅ COMPLETED)
- Models updated with new optional fields
- Indexes added safely
- No data migration required

### Phase 2: Optional Enhancements (Future)
When you're ready to use the new features:

1. **Using solutionTree**:
   ```javascript
   // In puzzle creation/import
   const puzzle = new Puzzle({
     puzzleId: "abc123",
     fen: "...",
     moves: "e2e4 e7e5", // Keep for backward compatibility
     solutionTree: [
       { move: "e2e4", reply: "e7e5" },
       { move: "d2d4", reply: "d7d5" }
     ],
     // ... other fields
   });
   ```

2. **Using attemptHistory**:
   ```javascript
   // In puzzle attempt submission
   attempt.attemptHistory = attempt.attemptHistory || [];
   attempt.attemptHistory.push({
     attemptIndex: attempt.attempts + 1,
     movesPlayed: ["e2e4", "e7e5"],
     solved: true,
     timeSpent: 45,
     usedHints: 0,
     createdAt: new Date()
   });
   ```

3. **Updating popularityScore**:
   ```javascript
   // Periodic background job
   puzzle.popularityScore = puzzle.nbPlays * 0.7 + puzzle.popularity * 0.3;
   await puzzle.save();
   ```

4. **Updating averageSolveTime**:
   ```javascript
   // After each successful attempt
   const solvedAttempts = await PuzzleAttempt.find({ 
     puzzle: puzzleId, 
     solved: true 
   });
   const avgTime = solvedAttempts.reduce((sum, a) => sum + a.timeSpent, 0) / solvedAttempts.length;
   puzzle.averageSolveTime = avgTime;
   await puzzle.save();
   ```

### Phase 3: Frontend Enhancements (Future)
When ready to use multi-move solutions:

1. Update puzzle parsing to check for `solutionTree` first:
   ```typescript
   const parsePuzzle = (p: any) => {
     if (p.solutionTree && p.solutionTree.length > 0) {
       // Use new solution tree logic
       return parseSolutionTree(p.solutionTree);
     } else {
       // Fall back to existing moves parsing
       return parseMoves(p.moves, activeColor);
     }
   };
   ```

2. Add attempt history tracking in frontend:
   ```typescript
   const submitPuzzleAttempt = async (solved: boolean, movesPlayed: string[]) => {
     const response = await apiClient.post(`/api/puzzles/${puzzleId}/attempt`, {
       solved,
       timeSpent,
       attemptHistory: {
         attemptIndex: currentAttemptIndex,
         movesPlayed,
         solved,
         timeSpent,
         usedHints: hintsUsed
       }
     });
   };
   ```

## Data Validation

### Safe Defaults
All new fields have safe defaults that won't break existing functionality:
- `solutionTree`: `undefined` (optional)
- `popularityScore`: `0` (neutral)
- `averageSolveTime`: `0` (neutral)
- `attemptHistory`: `undefined` (optional)

### Schema Validation
Mongoose will validate:
- ✅ `solutionTree` must be array of objects with `move` (required) and `reply` (optional)
- ✅ `attemptHistory` must be array of objects with required fields
- ✅ All existing validations remain in place

## Testing Recommendations

### 1. Existing Functionality Tests
```javascript
// Test that existing puzzles still work
const puzzle = await Puzzle.findOne({ puzzleId: "existing-puzzle" });
expect(puzzle.moves).toBeDefined();
expect(puzzle.difficulty).toBeDefined();

// Test that existing attempts still work
const attempt = await PuzzleAttempt.findOne({ user: userId, puzzle: puzzleId });
expect(attempt.solved).toBeDefined();
expect(attempt.attempts).toBeGreaterThan(0);
```

### 2. New Fields Tests
```javascript
// Test that new fields are optional
const newPuzzle = new Puzzle({
  puzzleId: "test-123",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  moves: "e2e4 e7e5",
  rating: 1500
});
await newPuzzle.save(); // Should work without new fields

// Test that new fields can be added
newPuzzle.solutionTree = [{ move: "e2e4", reply: "e7e5" }];
await newPuzzle.save(); // Should work with new fields
```

### 3. API Endpoint Tests
```javascript
// Test puzzle creation without new fields
POST /api/puzzles
{
  "puzzleId": "test-123",
  "fen": "...",
  "moves": "e2e4 e7e5",
  "rating": 1500
}
// Should return 201 Created

// Test puzzle attempt without attemptHistory
POST /api/puzzles/:id/attempt
{
  "solved": true,
  "timeSpent": 45
}
// Should return 200 OK with rating change
```

## Rollback Plan

If issues arise, rollback is simple:

1. **Remove new indexes** (optional, won't break anything):
   ```javascript
   db.puzzles.dropIndex({ popularityScore: -1 });
   ```

2. **Revert model files**:
   ```bash
   git checkout HEAD~1 ChessOnes-Backend/models/Puzzle.js
   git checkout HEAD~1 ChessOnes-Backend/models/PuzzleAttempt.js
   ```

3. **No data migration needed** - existing data remains valid

## Performance Considerations

### Index Impact
- New `popularityScore` index: Minimal impact, only used for popularity-based queries
- Existing indexes unchanged
- Query performance for existing queries: **No impact**

### Storage Impact
- New optional fields only consume space when populated
- Existing documents: **No additional storage**
- New documents without new fields: **No additional storage**

### Query Performance
- Queries not using new fields: **No impact**
- Queries using `popularityScore`: **Improved** (indexed)
- Backward compatible queries: **Unchanged**

## Support and Questions

For questions or issues related to this migration:
1. Check this guide first
2. Review the model files: `models/Puzzle.js` and `models/PuzzleAttempt.js`
3. Test with existing data before deploying
4. Monitor logs for any validation errors

## Summary

✅ **Zero Breaking Changes**
✅ **Full Backward Compatibility**
✅ **No Data Migration Required**
✅ **Existing Functionality Preserved**
✅ **Safe to Deploy**

The models are now enhanced to support advanced features while maintaining complete compatibility with existing code and data.



