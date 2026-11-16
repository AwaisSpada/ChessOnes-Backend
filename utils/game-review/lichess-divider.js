/**
 * Port of lichess-org/scalachess Divider.scala (master).
 * Boards include the start position (index 0 = ply 0).
 */

const { Chess } = require("chess.js");

const FILES = "abcdefgh";

function square(file, rank) {
  return FILES[file] + String(rank);
}

function rankOf(sq) {
  return Number(sq[1]);
}

function majorsAndMinors(pieces) {
  let n = 0;
  for (const p of pieces) {
    if (p.type !== "k" && p.type !== "p") n += 1;
  }
  return n;
}

function backrankSparse(pieces) {
  let whiteRank1 = 0;
  let blackRank8 = 0;
  for (const p of pieces) {
    if (p.color === "w" && rankOf(p.square) === 1) whiteRank1 += 1;
    if (p.color === "b" && rankOf(p.square) === 8) blackRank8 += 1;
  }
  return whiteRank1 < 4 || blackRank8 < 4;
}

/** score(y, white, black) — scalachess Divider after mixedness symmetry fix. */
function score(y, white, black) {
  switch (white) {
    case 0:
      switch (black) {
        case 1:
          return 1 + y;
        case 2:
          return y < 6 ? 2 + (6 - y) : 0;
        case 3:
          return y < 7 ? 3 + (7 - y) : 0;
        case 4:
          return y < 7 ? 3 + (7 - y) : 0;
        default:
          return 0;
      }
    case 1:
      switch (black) {
        case 0:
          return 1 + (8 - y);
        case 1:
          return 5 + Math.abs(4 - y);
        case 2:
          return 4 + (7 - y);
        case 3:
          return 5 + (7 - y);
        default:
          return 0;
      }
    case 2:
      switch (black) {
        case 0:
          return y > 2 ? 2 + (y - 2) : 0;
        case 1:
          return 4 + (y - 1);
        case 2:
          return 7;
        default:
          return 0;
      }
    case 3:
      switch (black) {
        case 0:
          return y > 1 ? 3 + (y - 1) : 0;
        case 1:
          return 5 + (y - 1);
        default:
          return 0;
      }
    case 4:
      return black === 0 && y > 1 ? 3 + (y - 1) : 0;
    default:
      return 0;
  }
}

function mixedness(pieces) {
  const at = new Map();
  for (const p of pieces) at.set(p.square, p.color);
  let acc = 0;
  for (let yIdx = 0; yIdx <= 6; yIdx++) {
    for (let x = 0; x <= 6; x++) {
      const y = yIdx + 1;
      let white = 0;
      let black = 0;
      for (const [df, dr] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const sq = square(x + df, yIdx + 1 + dr);
        const c = at.get(sq);
        if (c === "w") white += 1;
        else if (c === "b") black += 1;
      }
      acc += score(y, white, black);
    }
  }
  return acc;
}

function piecesFromChess(chess) {
  const out = [];
  const grid = chess.board();
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    for (let f = 0; f < 8; f++) {
      const cell = grid[r][f];
      if (!cell) continue;
      out.push({
        color: cell.color,
        type: cell.type,
        square: cell.square || square(f, rank),
      });
    }
  }
  return out;
}

function applyUci(chess, uci) {
  const played = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  });
  if (played) return true;
  try {
    return Boolean(chess.move(uci));
  } catch {
    return false;
  }
}

function boardsFromUci(uciMoves) {
  const chess = new Chess();
  const boards = [piecesFromChess(chess)];
  for (const raw of uciMoves || []) {
    const uci = String(raw).toLowerCase();
    if (!applyUci(chess, uci)) break;
    boards.push(piecesFromChess(chess));
  }
  return boards;
}

function isMiddlegameBoard(pieces) {
  return majorsAndMinors(pieces) <= 10 || backrankSparse(pieces) || mixedness(pieces) > 150;
}

function isEndgameBoard(pieces) {
  return majorsAndMinors(pieces) <= 6;
}

/**
 * @param {Array<Array<{color:string,type:string,square:string}>>} boards
 * @returns {{ middle: number|null, end: number|null, plies: number }}
 */
function divide(boards) {
  const plies = boards.length;
  let midGame = null;
  for (let i = 0; i < boards.length; i++) {
    if (isMiddlegameBoard(boards[i])) {
      midGame = i;
      break;
    }
  }
  let endGame = null;
  if (midGame != null) {
    for (let i = 0; i < boards.length; i++) {
      if (isEndgameBoard(boards[i])) {
        endGame = i;
        break;
      }
    }
  }
  const middle = midGame != null && (endGame == null || midGame < endGame) ? midGame : null;
  return { middle, end: endGame, plies };
}

module.exports = {
  divide,
  divideUci: (uciMoves) => divide(boardsFromUci(uciMoves)),
  boardsFromUci,
  majorsAndMinors,
  backrankSparse,
  mixedness,
  isMiddlegameBoard,
  isEndgameBoard,
};
