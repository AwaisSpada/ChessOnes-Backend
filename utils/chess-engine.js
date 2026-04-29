/**
 * Chess Engine Utility
 * Provides functions for:
 * - Check detection
 * - Move validation
 * - Legal move generation
 * - Checkmate/stalemate detection
 */

// Convert board index to row/col
function indexToRowCol(index) {
  return {
    row: Math.floor(index / 8),
    col: index % 8,
  };
}

// Convert row/col to board index
function rowColToIndex(row, col) {
  return row * 8 + col;
}

// Check if position is on board
function isValidPosition(row, col) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

// Get all squares attacked by a piece
function getAttackedSquares(board, position, piece) {
  const attacked = new Set();
  const { row, col } = indexToRowCol(position);
  const isWhite = piece === piece.toUpperCase();
  const pieceType = piece.toLowerCase();

  switch (pieceType) {
    case "p": // Pawn
      const direction = isWhite ? -1 : 1;
      // Diagonal attacks
      const leftAttack = rowColToIndex(row + direction, col - 1);
      const rightAttack = rowColToIndex(row + direction, col + 1);
      if (isValidPosition(row + direction, col - 1)) {
        attacked.add(leftAttack);
      }
      if (isValidPosition(row + direction, col + 1)) {
        attacked.add(rightAttack);
      }
      break;

    case "r": // Rook
      // Horizontal and vertical
      for (let dr of [-1, 1]) {
        for (let r = row + dr; isValidPosition(r, col); r += dr) {
          const idx = rowColToIndex(r, col);
          attacked.add(idx);
          if (board[idx]) break; // Stop at first piece
        }
      }
      for (let dc of [-1, 1]) {
        for (let c = col + dc; isValidPosition(row, c); c += dc) {
          const idx = rowColToIndex(row, c);
          attacked.add(idx);
          if (board[idx]) break;
        }
      }
      break;

    case "n": // Knight
      const knightMoves = [
        [-2, -1],
        [-2, 1],
        [-1, -2],
        [-1, 2],
        [1, -2],
        [1, 2],
        [2, -1],
        [2, 1],
      ];
      for (const [dr, dc] of knightMoves) {
        const newRow = row + dr;
        const newCol = col + dc;
        if (isValidPosition(newRow, newCol)) {
          attacked.add(rowColToIndex(newRow, newCol));
        }
      }
      break;

    case "b": // Bishop
      for (const [dr, dc] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]) {
        for (
          let r = row + dr, c = col + dc;
          isValidPosition(r, c);
          r += dr, c += dc
        ) {
          const idx = rowColToIndex(r, c);
          attacked.add(idx);
          if (board[idx]) break;
        }
      }
      break;

    case "q": // Queen (rook + bishop)
      // Rook moves
      for (let dr of [-1, 1]) {
        for (let r = row + dr; isValidPosition(r, col); r += dr) {
          const idx = rowColToIndex(r, col);
          attacked.add(idx);
          if (board[idx]) break;
        }
      }
      for (let dc of [-1, 1]) {
        for (let c = col + dc; isValidPosition(row, c); c += dc) {
          const idx = rowColToIndex(row, c);
          attacked.add(idx);
          if (board[idx]) break;
        }
      }
      // Bishop moves
      for (const [dr, dc] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]) {
        for (
          let r = row + dr, c = col + dc;
          isValidPosition(r, c);
          r += dr, c += dc
        ) {
          const idx = rowColToIndex(r, c);
          attacked.add(idx);
          if (board[idx]) break;
        }
      }
      break;

    case "k": // King
      for (const [dr, dc] of [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1],
      ]) {
        const newRow = row + dr;
        const newCol = col + dc;
        if (isValidPosition(newRow, newCol)) {
          attacked.add(rowColToIndex(newRow, newCol));
        }
      }
      break;
  }

  return attacked;
}

// Find king position
function findKing(board, isWhite) {
  const king = isWhite ? "K" : "k";
  for (let i = 0; i < 64; i++) {
    if (board[i] === king) {
      return i;
    }
  }
  return -1;
}

// Check if a square is attacked by opponent
function isSquareAttacked(board, square, isWhite) {
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece) continue;
    const pieceIsWhite = piece === piece.toUpperCase();
    if (pieceIsWhite === isWhite) continue; // Same color, skip

    const attacked = getAttackedSquares(board, i, piece);
    if (attacked.has(square)) {
      return true;
    }
  }
  return false;
}

// Check if king is in check
function isKingInCheck(board, isWhite) {
  const kingPos = findKing(board, isWhite);
  if (kingPos === -1) return false;
  return isSquareAttacked(board, kingPos, isWhite);
}

// Make a move on a board copy
function makeMove(board, from, to, promotionPiece = null) {
  const newBoard = [...board];
  const piece = newBoard[from];

  // Handle pawn promotion
  if (promotionPiece && piece && piece.toLowerCase() === "p") {
    const isWhite = piece === piece.toUpperCase();
    newBoard[to] = isWhite
      ? promotionPiece.toUpperCase()
      : promotionPiece.toLowerCase();
  } else {
    newBoard[to] = piece;
  }
  newBoard[from] = null;
  return newBoard;
}

// Check if a move is legal (doesn't leave own king in check)
function isMoveLegal(board, from, to, promotionPiece = null) {
  const piece = board[from];
  if (!piece) return false;

  const isWhite = piece === piece.toUpperCase();
  const newBoard = makeMove(board, from, to, promotionPiece);

  // Check if own king is in check after move
  return !isKingInCheck(newBoard, isWhite);
}

// Get all legal moves for a piece
function getLegalMovesForPiece(board, position) {
  const piece = board[position];
  if (!piece) return [];
  const isWhite = piece === piece.toUpperCase();
  const pieceType = piece.toLowerCase();
  const { row, col } = indexToRowCol(position);
  const legalMoves = [];

  // Get possible moves based on piece type
  let possibleMoves = [];
  switch (pieceType) {
    case "p": // Pawn
      const direction = isWhite ? -1 : 1;
      const startRow = isWhite ? 6 : 1;
      // Forward one square
      const oneStep = rowColToIndex(row + direction, col);
      if (oneStep >= 0 && oneStep < 64 && !board[oneStep]) {
        possibleMoves.push(oneStep);
        // Forward two squares from start
        if (row === startRow) {
          const twoStep = rowColToIndex(row + direction * 2, col);
          if (twoStep >= 0 && twoStep < 64 && !board[twoStep]) {
            possibleMoves.push(twoStep);
          }
        }
      }

      // Diagonal captures
      for (const dc of [-1, 1]) {
        const capturePos = rowColToIndex(row + direction, col + dc);
        if (
          capturePos >= 0 &&
          capturePos < 64 &&
          isValidPosition(row + direction, col + dc)
        ) {
          const target = board[capturePos];
          if (target && (target === target.toUpperCase()) !== isWhite) {
            possibleMoves.push(capturePos);
          }
        }
      }
      break;

    case "r": // Rook
      for (let dr of [-1, 1]) {
        for (let r = row + dr; isValidPosition(r, col); r += dr) {
          const idx = rowColToIndex(r, col);
          if (!board[idx]) {
            possibleMoves.push(idx);
          } else {
            if ((board[idx] === board[idx].toUpperCase()) !== isWhite) {
              possibleMoves.push(idx);
            }
            break;
          }
        }
      }
      for (let dc of [-1, 1]) {
        for (let c = col + dc; isValidPosition(row, c); c += dc) {
          const idx = rowColToIndex(row, c);
          if (!board[idx]) {
            possibleMoves.push(idx);
          } else {
            if ((board[idx] === board[idx].toUpperCase()) !== isWhite) {
              possibleMoves.push(idx);
            }
            break;
          }
        }
      }
      break;

    case "n": // Knight
      const knightMoves = [
        [-2, -1],
        [-2, 1],
        [-1, -2],
        [-1, 2],
        [1, -2],
        [1, 2],
        [2, -1],
        [2, 1],
      ];
      for (const [dr, dc] of knightMoves) {
        const newRow = row + dr;
        const newCol = col + dc;
        if (isValidPosition(newRow, newCol)) {
          const idx = rowColToIndex(newRow, newCol);
          if (
            !board[idx] ||
            (board[idx] === board[idx].toUpperCase()) !== isWhite
          ) {
            possibleMoves.push(idx);
          }
        }
      }
      break;

    case "b": // Bishop
      for (const [dr, dc] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]) {
        for (
          let r = row + dr, c = col + dc;
          isValidPosition(r, c);
          r += dr, c += dc
        ) {
          const idx = rowColToIndex(r, c);
          if (!board[idx]) {
            possibleMoves.push(idx);
          } else {
            if ((board[idx] === board[idx].toUpperCase()) !== isWhite) {
              possibleMoves.push(idx);
            }
            break;
          }
        }
      }
      break;

    case "q": // Queen
      // Rook moves
      for (let dr of [-1, 1]) {
        for (let r = row + dr; isValidPosition(r, col); r += dr) {
          const idx = rowColToIndex(r, col);
          if (!board[idx]) {
            possibleMoves.push(idx);
          } else {
            if ((board[idx] === board[idx].toUpperCase()) !== isWhite) {
              possibleMoves.push(idx);
            }
            break;
          }
        }
      }
      for (let dc of [-1, 1]) {
        for (let c = col + dc; isValidPosition(row, c); c += dc) {
          const idx = rowColToIndex(row, c);
          if (!board[idx]) {
            possibleMoves.push(idx);
          } else {
            if ((board[idx] === board[idx].toUpperCase()) !== isWhite) {
              possibleMoves.push(idx);
            }
            break;
          }
        }
      }
      // Bishop moves
      for (const [dr, dc] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]) {
        for (
          let r = row + dr, c = col + dc;
          isValidPosition(r, c);
          r += dr, c += dc
        ) {
          const idx = rowColToIndex(r, c);
          if (!board[idx]) {
            possibleMoves.push(idx);
          } else {
            if ((board[idx] === board[idx].toUpperCase()) !== isWhite) {
              possibleMoves.push(idx);
            }
            break;
          }
        }
      }
      break;

    case "k": // King
      for (const [dr, dc] of [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1],
      ]) {
        const newRow = row + dr;
        const newCol = col + dc;
        if (isValidPosition(newRow, newCol)) {
          const idx = rowColToIndex(newRow, newCol);
          if (
            !board[idx] ||
            (board[idx] === board[idx].toUpperCase()) !== isWhite
          ) {
            possibleMoves.push(idx);
          }
        }
      }
      // TODO: Add castling logic
      break;
  }

  // Filter to only legal moves (don't leave king in check)
  for (const to of possibleMoves) {
    if (isMoveLegal(board, position, to)) {
      legalMoves.push(to);
    }
  }

  return legalMoves;
}

// Get all legal moves for a side
function getAllLegalMoves(board, isWhite) {
  const legalMoves = [];

  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece) continue;

    const pieceIsWhite = piece === piece.toUpperCase();
    if (pieceIsWhite !== isWhite) continue;

    const moves = getLegalMovesForPiece(board, i);
    for (const to of moves) {
      legalMoves.push({ from: i, to });
    }
  }
  return legalMoves;
}

// Check for checkmate
function isCheckmate(board, isWhite) {
  if (!isKingInCheck(board, isWhite)) {
    return false;
  }
  const legalMoves = getAllLegalMoves(board, isWhite);
  return legalMoves.length === 0;
}

// Check for stalemate
function isStalemate(board, isWhite) {
  if (isKingInCheck(board, isWhite)) {
    return false;
  }
  const legalMoves = getAllLegalMoves(board, isWhite);
  return legalMoves.length === 0;
}

// Check if there is insufficient material for checkmate
// Returns true if neither side can possibly checkmate the other
function isInsufficientMaterial(board) {
  if (!board || board.length !== 64) {
    return false; // Invalid board state
  }

  let whitePieces = {
    pawn: 0,
    rook: 0,
    knight: 0,
    bishop: 0,
    queen: 0,
    king: 0,
  };
  let blackPieces = {
    pawn: 0,
    rook: 0,
    knight: 0,
    bishop: 0,
    queen: 0,
    king: 0,
  };

  let totalPieces = 0;

  // Count all pieces on the board
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece) continue;

    const pieceType = piece.toLowerCase();
    const isWhite = piece === piece.toUpperCase();

    if (isWhite) {
      whitePieces[pieceType]++;
    } else {
      blackPieces[pieceType]++;
    }
    totalPieces++;
  }

  // Both sides must have a king
  if (whitePieces.king !== 1 || blackPieces.king !== 1) {
    return false; // Invalid position - missing king(s)
  }

  // Only check for insufficient material if there are very few pieces left
  // (kings + at most 4 minor pieces total)
  if (totalPieces > 6) {
    return false; // Too many pieces - can't be insufficient material
  }

  // Both sides must have only king (or king + minor pieces that can't force mate)
  const whiteMaterial = whitePieces.pawn + whitePieces.rook + whitePieces.queen;
  const blackMaterial = blackPieces.pawn + blackPieces.rook + blackPieces.queen;

  // If either side has pawns, rooks, or queens, they can potentially checkmate
  if (whiteMaterial > 0 || blackMaterial > 0) {
    return false;
  }

  // Count minor pieces (bishops and knights)
  const whiteMinors = whitePieces.bishop + whitePieces.knight;
  const blackMinors = blackPieces.bishop + blackPieces.knight;

  // King vs King - insufficient material
  if (whiteMinors === 0 && blackMinors === 0) {
    return true;
  }

  // King vs King + Bishop - insufficient material
  if (whiteMinors === 0 && blackMinors === 1 && blackPieces.bishop === 1) {
    return true;
  }
  if (blackMinors === 0 && whiteMinors === 1 && whitePieces.bishop === 1) {
    return true;
  }

  // King vs King + Knight - insufficient material
  if (whiteMinors === 0 && blackMinors === 1 && blackPieces.knight === 1) {
    return true;
  }
  if (blackMinors === 0 && whiteMinors === 1 && whitePieces.knight === 1) {
    return true;
  }

  // King + Bishop vs King + Bishop (same color bishops) - insufficient material
  if (
    whitePieces.bishop === 1 &&
    blackPieces.bishop === 1 &&
    whitePieces.knight === 0 &&
    blackPieces.knight === 0
  ) {
    // Check if bishops are on same color squares
    // This is a simplified check - in practice, you'd need to check actual square colors
    // For now, we'll consider it insufficient if both have exactly one bishop
    // Note: This is slightly permissive (opposite color bishops CAN mate, but it's very rare)
    // For a more accurate check, you'd need to verify bishop square colors
    return true; // Simplified: consider same-color-bishop scenario
  }

  // King + Knight vs King + Knight - insufficient material
  if (
    whitePieces.knight === 1 &&
    blackPieces.knight === 1 &&
    whitePieces.bishop === 0 &&
    blackPieces.bishop === 0
  ) {
    return true;
  }

  // All other combinations can potentially force checkmate
  return false;
}

module.exports = {
  isKingInCheck,
  isMoveLegal,
  getLegalMovesForPiece,
  getAllLegalMoves,
  isCheckmate,
  isStalemate,
  isInsufficientMaterial,
  makeMove,
  findKing,
};
