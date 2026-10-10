/** Port of mobile `src/bot/BotOpeningBook.ts` */

const { personalityOpeningWeight } = require("./personality");

const OPENING_TREE = {
  "": {
    moves: {
      e4: ["e2e4"],
      d4: ["d2d4"],
      c4: ["c2c4"],
      nf3: ["g1f3"],
      irregular: ["b2b3", "g2g3", "b1c3"],
      balanced: ["e2e4", "d2d4", "g1f3"],
    },
  },
  e2e4: {
    moves: {
      e4: ["e7e5", "c7c5", "e7e6"],
      balanced: ["e7e5", "c7c5"],
      irregular: ["g8f6", "d7d6"],
    },
  },
  "e2e4,e7e5": {
    moves: {
      e4: ["g1f3", "f1c4", "b1c3"],
      balanced: ["g1f3"],
    },
  },
  "e2e4,c7c5": {
    moves: {
      e4: ["g1f3", "b1c3"],
      irregular: ["b2b3"],
      balanced: ["g1f3"],
    },
  },
  d2d4: {
    moves: {
      d4: ["d7d5", "g8f6", "e7e6"],
      balanced: ["d7d5", "g8f6"],
    },
  },
  "d2d4,d7d5": {
    moves: {
      d4: ["c2c4", "g1f3", "e2e3"],
      balanced: ["c2c4", "g1f3"],
    },
  },
  "d2d4,g8f6": {
    moves: {
      d4: ["c2c4", "g1f3"],
      balanced: ["c2c4"],
    },
  },
  c2c4: {
    moves: {
      c4: ["e7e5", "g8f6", "c7c5"],
      balanced: ["e7e5", "g8f6"],
    },
  },
  g1f3: {
    moves: {
      nf3: ["d7d5", "g8f6", "c7c5"],
      balanced: ["d7d5", "g8f6"],
    },
  },
};

const MAX_BOOK_PLY = 8;

const shuffle = (items) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const pickWeighted = (candidates, weight) => {
  if (candidates.length === 0) return "";
  if (candidates.length === 1) return candidates[0];
  const favoredCount = Math.max(1, Math.round(candidates.length * Math.min(1.2, weight)));
  const pool = shuffle(candidates).slice(0, favoredCount);
  return pool[Math.floor(Math.random() * pool.length)];
};

function tryOpeningBookMove(profile, context) {
  if (context.moveNumber > MAX_BOOK_PLY) return null;

  const key = context.uciHistory.join(",");
  const node = OPENING_TREE[key];
  if (!node) return null;

  const pref = profile.personality.openingPreference;
  const preferred = node.moves[pref] || node.moves.balanced || [];
  const weight = personalityOpeningWeight(pref, pref);
  const move = pickWeighted(preferred, weight);
  return move || null;
}

module.exports = {
  tryOpeningBookMove,
  MAX_BOOK_PLY,
};
