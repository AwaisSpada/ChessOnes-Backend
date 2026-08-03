/**
 * Code-owned achievements catalog — matches Profile / Achievements UI.
 * Base art lives in assets/badges:
 * win-bullet/blitz/rapid, rating-bullet/blitz/rapid, puzzle, anniversary.
 * Pill labels (1st, 50, 1000, 1Y…) are rendered by the client.
 */

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "wins", label: "Wins" },
  { id: "ratings", label: "Ratings" },
  { id: "puzzles", label: "Puzzles" },
  { id: "milestones", label: "Milestones" },
];

const RATING_THRESHOLDS = [1000, 1200, 1500, 1800, 2000, 2200, 2500];
const WIN_THRESHOLDS = [
  { value: 1, pill: "1st", titlePrefix: "First" },
  { value: 50, pill: "50", titlePrefix: "50" },
  { value: 100, pill: "100", titlePrefix: "100" },
];

/** @typedef {{ type: 'stat', path: string, op: 'gte', value: number }} StatRule */

/**
 * @type {Array<{
 *   id: string,
 *   category: 'wins' | 'ratings' | 'puzzles' | 'milestones',
 *   title: string,
 *   description: string,
 *   assetKey: string,
 *   pill: string,
 *   rule: StatRule
 * }>}
 */
const ACHIEVEMENTS = [];

function pushWin(tc, assetKey, label) {
  for (const t of WIN_THRESHOLDS) {
    const isFirst = t.value === 1;
    ACHIEVEMENTS.push({
      id: `${tc}_wins_${t.value}`,
      category: "wins",
      title: isFirst ? `First ${label} Win` : `${t.value} ${label} Wins`,
      description: isFirst
        ? `Win your first ${label.toLowerCase()} game`
        : `Win ${t.value} ${label.toLowerCase()} games`,
      assetKey,
      pill: t.pill,
      rule: { type: "stat", path: `wins.${tc}`, op: "gte", value: t.value },
    });
  }
}

function pushRatings(tc, assetKey, label) {
  for (const value of RATING_THRESHOLDS) {
    ACHIEVEMENTS.push({
      id: `rating_${tc}_${value}`,
      category: "ratings",
      title: `${label} ${value}`,
      description: `Reach ${value} ${label.toLowerCase()} rating`,
      assetKey,
      pill: String(value),
      rule: { type: "stat", path: `ratings.${tc}`, op: "gte", value },
    });
  }
}

pushWin("bullet", "win-bullet", "Bullet");
pushWin("blitz", "win-blitz", "Blitz");
pushWin("rapid", "win-rapid", "Rapid");

pushRatings("bullet", "rating-bullet", "Bullet");
pushRatings("blitz", "rating-blitz", "Blitz");
pushRatings("rapid", "rating-rapid", "Rapid");

ACHIEVEMENTS.push(
  {
    id: "puzzles_50",
    category: "puzzles",
    title: "50 Puzzles Solved",
    description: "Solve 50 puzzles",
    assetKey: "puzzle",
    pill: "50",
    rule: { type: "stat", path: "puzzles.solved", op: "gte", value: 50 },
  },
  {
    id: "puzzles_100",
    category: "puzzles",
    title: "100 Puzzles Solved",
    description: "Solve 100 puzzles",
    assetKey: "puzzle",
    pill: "100",
    rule: { type: "stat", path: "puzzles.solved", op: "gte", value: 100 },
  },
  {
    id: "puzzles_500",
    category: "puzzles",
    title: "500 Puzzles Solved",
    description: "Solve 500 puzzles",
    assetKey: "puzzle",
    pill: "500",
    rule: { type: "stat", path: "puzzles.solved", op: "gte", value: 500 },
  },
  {
    id: "anniversary_1y",
    category: "milestones",
    title: "1 Year on Chessones",
    description: "Be a Chessones member for 1 year",
    assetKey: "anniversary",
    pill: "1Y",
    rule: { type: "stat", path: "account.years", op: "gte", value: 1 },
  },
  {
    id: "anniversary_2y",
    category: "milestones",
    title: "2 Years on Chessones",
    description: "Be a Chessones member for 2 years",
    assetKey: "anniversary",
    pill: "2Y",
    rule: { type: "stat", path: "account.years", op: "gte", value: 2 },
  },
  {
    id: "anniversary_3y",
    category: "milestones",
    title: "3 Years on Chessones",
    description: "Be a Chessones member for 3 years",
    assetKey: "anniversary",
    pill: "3Y",
    rule: { type: "stat", path: "account.years", op: "gte", value: 3 },
  },
);

module.exports = {
  CATEGORIES,
  ACHIEVEMENTS,
};
