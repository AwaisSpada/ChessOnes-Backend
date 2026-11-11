/**
 * Opening book for Game Review "Book" labels.
 * Data: Lichess chess-openings (public domain / CC0).
 * https://github.com/lichess-org/chess-openings
 */

const fs = require("fs");
const path = require("path");
const { Chess } = require("chess.js");

const OPENINGS_DIR = path.join(__dirname, "openings");
const FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"];

/** EPD (board, side, castling, ep) → { eco, name, ply } longest line wins */
const epdToOpening = new Map();
const bookEpds = new Set();
let loaded = false;
let loadError = null;

function fenToEpd(fen) {
  if (!fen || typeof fen !== "string") return "";
  const p = fen.trim().split(/\s+/);
  if (p.length < 4) return "";
  return `${p[0]} ${p[1]} ${p[2]} ${p[3]}`;
}

function epdKeysFromFen(fen) {
  const epd = fenToEpd(fen);
  if (!epd) return [];
  const p = epd.split(" ");
  const noEp = `${p[0]} ${p[1]} ${p[2]} -`;
  return epd === noEp ? [epd] : [epd, noEp];
}

function parseTsvLine(line) {
  if (!line || line.startsWith("eco\t")) return null;
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const eco = parts[0].trim();
  const name = parts[1].trim();
  const pgn = parts.slice(2).join("\t").trim();
  if (!eco || !name || !pgn) return null;
  return { eco, name, pgn };
}

function loadBook() {
  if (loaded) return;
  loaded = true;
  const started = Date.now();
  let lines = 0;
  let applied = 0;

  for (const file of FILES) {
    const full = path.join(OPENINGS_DIR, file);
    if (!fs.existsSync(full)) {
      loadError = `Missing ${file}`;
      console.warn(`[OpeningBook] ${loadError}`);
      continue;
    }
    const text = fs.readFileSync(full, "utf8");
    for (const raw of text.split(/\n/)) {
      const row = parseTsvLine(raw);
      if (!row) continue;
      lines += 1;
      const chess = new Chess();
      try {
        chess.loadPgn(row.pgn);
      } catch (_e) {
        continue;
      }
      const sans = chess.history();
      if (!sans.length) continue;
      const replay = new Chess();
      let lastFen = null;
      for (let ply = 0; ply < sans.length; ply++) {
        const mv = replay.move(sans[ply]);
        if (!mv) {
          lastFen = null;
          break;
        }
        applied += 1;
        lastFen = replay.fen();
        for (const key of epdKeysFromFen(lastFen)) {
          bookEpds.add(key);
        }
      }
      // Named opening is the line's terminal position (Lichess: walk back to a named EPD).
      if (lastFen) {
        const ply = sans.length;
        for (const key of epdKeysFromFen(lastFen)) {
          const prev = epdToOpening.get(key);
          if (!prev || ply < prev.ply) {
            epdToOpening.set(key, { eco: row.eco, name: row.name, ply });
          }
        }
      }
    }
  }

  console.log(
    `[OpeningBook] ${lines} lines, ${bookEpds.size} book EPDs, ${applied} prefix plies, ${Date.now() - started}ms` +
      (loadError ? ` (${loadError})` : "")
  );
}

function ensureLoaded() {
  if (!loaded) loadBook();
}

function isBookFen(fen) {
  ensureLoaded();
  return epdKeysFromFen(fen).some((k) => bookEpds.has(k));
}

/** Named opening at this exact position, or null if it is only a prefix. */
function lookupOpeningAtFen(fen) {
  ensureLoaded();
  for (const key of epdKeysFromFen(fen)) {
    const hit = epdToOpening.get(key);
    if (hit) return { name: hit.name, eco: hit.eco };
  }
  return null;
}

/**
 * After each UCI ply: last named ECO position on the path so far
 * (1.e4 → King's Pawn Game, 1.e4 c5 → Sicilian Defense).
 */
function annotateOpeningsFromUci(uciMoves) {
  ensureLoaded();
  if (!Array.isArray(uciMoves) || uciMoves.length === 0) return [];
  const chess = new Chess();
  const perPly = [];
  let lastHit = null;
  for (const uci of uciMoves) {
    const mv = chess.move(uci);
    if (!mv) {
      perPly.push(lastHit);
      continue;
    }
    const named = lookupOpeningAtFen(chess.fen());
    if (named) lastHit = named;
    perPly.push(lastHit);
  }
  return perPly;
}

/** Deepest named opening on the full move list (Lichess classify convention). */
function lookupOpeningFromUci(uciMoves) {
  const annotated = annotateOpeningsFromUci(uciMoves);
  for (let i = annotated.length - 1; i >= 0; i--) {
    if (annotated[i]) return annotated[i];
  }
  return { name: "Unknown", eco: null };
}

module.exports = {
  loadBook,
  isBookFen,
  lookupOpeningAtFen,
  annotateOpeningsFromUci,
  lookupOpeningFromUci,
  fenToEpd,
};
