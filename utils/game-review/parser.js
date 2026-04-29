/**
 * PGN Parser Module
 * 
 * Minimal PGN parser without external dependencies.
 * Extracts move sequences from Portable Game Notation.
 * 
 * Supports:
 * - Standard algebraic notation (SAN) moves
 * - Move numbers
 * - Comments (ignored)
 * - Variations (ignored, takes main line)
 * - Result markers (1-0, 0-1, 1/2-1/2, *)
 */

/**
 * Convert SAN move to UCI (long algebraic) format
 * This is a simplified converter - handles most common cases
 */
function sanToUCI(san, position) {
  // This is a placeholder - full SAN to UCI conversion is complex
  // For now, we'll handle simple cases and use Stockfish to validate
  // In production, you'd want a full SAN parser
  
  // Remove check/checkmate markers
  san = san.replace(/[+#]/, "");
  
  // Handle castling
  if (san === "O-O" || san === "0-0") {
    return position === "white" ? "e1g1" : "e8g8";
  }
  if (san === "O-O-O" || san === "0-0-0") {
    return position === "white" ? "e1c1" : "e8c8";
  }
  
  // For now, return null and let Stockfish handle position building
  // A full implementation would parse SAN properly
  return null;
}

/**
 * Parse PGN string and extract move list
 * @param {string} pgn - PGN string
 * @returns {string[]} - Array of moves in UCI format (or SAN if conversion fails)
 */
function parsePGN(pgn) {
  if (!pgn || typeof pgn !== "string") {
    return [];
  }

  const moves = [];
  let inComment = false;
  let inVariation = false;
  let parenDepth = 0;
  let currentMove = "";

  // Remove header tags (metadata)
  let moveText = pgn.replace(/\[.*?\]/g, "");

  // Remove result markers
  moveText = moveText.replace(/\s*(1-0|0-1|1\/2-1\/2|\*)\s*$/, "");

  for (let i = 0; i < moveText.length; i++) {
    const char = moveText[i];
    const nextChar = moveText[i + 1];

    // Handle comments
    if (char === "{" && !inComment) {
      inComment = true;
      continue;
    }
    if (char === "}" && inComment) {
      inComment = false;
      continue;
    }
    if (inComment) continue;

    // Handle variations
    if (char === "(") {
      parenDepth++;
      inVariation = true;
      if (currentMove.trim()) {
        moves.push(currentMove.trim());
        currentMove = "";
      }
      continue;
    }
    if (char === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        inVariation = false;
      }
      continue;
    }
    if (inVariation) continue;

    // Build move string
    if (!/\s/.test(char) || (char === " " && currentMove.trim())) {
      currentMove += char;
    } else if (char === " " && !currentMove.trim()) {
      continue; // Skip leading spaces
    }

    // Check if we have a complete move
    // Moves typically end with space, period, or end of string
    if (
      (char === " " || char === "." || i === moveText.length - 1) &&
      currentMove.trim()
    ) {
      const move = currentMove.trim();
      
      // Skip move numbers (e.g., "1.", "23.")
      if (/^\d+\.$/.test(move)) {
        currentMove = "";
        continue;
      }

      // Skip result markers
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(move)) {
        currentMove = "";
        continue;
      }

      // Clean up move (remove dots, extra spaces)
      const cleanMove = move.replace(/\./g, "").trim();
      
      if (cleanMove && cleanMove.length > 0) {
        moves.push(cleanMove);
      }
      
      currentMove = "";
    }
  }

  // Add last move if exists
  if (currentMove.trim()) {
    const cleanMove = currentMove.trim().replace(/\./g, "");
    if (cleanMove && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(cleanMove)) {
      moves.push(cleanMove);
    }
  }

  return moves;
}

/**
 * Convert SAN moves to UCI format using Stockfish
 * This function will be called by the analyzer with Stockfish's help
 * @param {string[]} sanMoves - Array of SAN moves
 * @returns {Promise<string[]>} - Array of UCI moves
 */
async function convertSANToUCI(sanMoves, stockfishEngine) {
  // For now, return SAN moves as-is
  // The analyzer will need to handle SAN->UCI conversion
  // or we can use Stockfish's position command which accepts SAN in some formats
  // For simplicity, we'll assume moves are already in UCI format or
  // the caller will handle conversion
  
  return sanMoves;
}

/**
 * Validate move format
 * @param {string} move - Move string
 * @returns {boolean} - True if move looks like UCI format
 */
function isUCIMove(move) {
  // UCI format: e2e4, e7e8q (with promotion)
  return /^[a-h][1-8][a-h][1-8][qrnb]?$/.test(move.toLowerCase());
}

/**
 * Normalize move format
 * @param {string} move - Move string (UCI or SAN)
 * @returns {string} - Normalized move
 */
function normalizeMove(move) {
  if (!move) return "";
  
  // Convert to lowercase for UCI
  move = move.toLowerCase().trim();
  
  // Remove common annotations
  move = move.replace(/[!?+#x]/g, "");
  
  return move;
}

module.exports = {
  parsePGN,
  convertSANToUCI,
  isUCIMove,
  normalizeMove,
  sanToUCI,
};


