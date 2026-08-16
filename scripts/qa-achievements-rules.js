/**
 * QA harness for achievement unlock rules (no DB required).
 * Run: node scripts/qa-achievements-rules.js
 */
const assert = require("assert");
const {
  ruleSatisfied,
  resolveStatValue,
  isRatingConfirmed,
  shouldRetainUnlock,
  RATING_CONFIRM_GAMES,
} = require("../services/achievementUnlockService");
const { ACHIEVEMENTS } = require("../constants/achievementsCatalog");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log("\n=== Achievements QA ===\n");
console.log(`Confirm threshold: ${RATING_CONFIRM_GAMES} rated games / TC`);
console.log(`Catalog size: ${ACHIEVEMENTS.length}\n`);

const provisionalUser = {
  createdAt: new Date(),
  ratings: {
    bullet: { rating: 1500, gamesPlayed: 0 },
    blitz: { rating: 1500, gamesPlayed: 3 },
    rapid: { rating: 1500, gamesPlayed: 4 },
  },
};

const confirmed1600 = {
  createdAt: new Date("2020-01-01"),
  ratings: {
    bullet: { rating: 1600, gamesPlayed: 5 },
    blitz: { rating: 1350, gamesPlayed: 12 },
    rapid: { rating: 980, gamesPlayed: 8 },
  },
};

const droppedFrom1200 = {
  createdAt: new Date("2020-01-01"),
  ratings: {
    bullet: { rating: 1000, gamesPlayed: 20 },
  },
  // already unlocked list is separate — rule check for NEW unlock at 1200 should fail
};

console.log("1) Provisional ★ gate");
test("0 games → not confirmed", () => {
  assert.strictEqual(isRatingConfirmed(provisionalUser, "bullet"), false);
});
test("4 games → still provisional", () => {
  assert.strictEqual(isRatingConfirmed(provisionalUser, "rapid"), false);
});
test("5 games → confirmed", () => {
  assert.strictEqual(isRatingConfirmed(confirmed1600, "bullet"), true);
});
test("provisional 1500 does NOT unlock rating_bullet_1000", () => {
  const rule = { type: "stat", path: "ratings.bullet", op: "gte", value: 1000 };
  assert.strictEqual(ruleSatisfied(rule, {}, provisionalUser, {}), false);
});
test("provisional 1500 does NOT unlock rating_bullet_1500", () => {
  const rule = { type: "stat", path: "ratings.bullet", op: "gte", value: 1500 };
  assert.strictEqual(ruleSatisfied(rule, {}, provisionalUser, {}), false);
});

console.log("\n2) Confirmed rating — cross only, no lower-badge pile");
test("first confirm at 1600 (no watermark) does NOT grant 1000/1200/1500", () => {
  for (const v of [1000, 1200, 1500]) {
    const rule = { type: "stat", path: "ratings.bullet", op: "gte", value: v };
    assert.strictEqual(
      ruleSatisfied(rule, {}, confirmed1600, {}),
      false,
      `must not backfill ${v}`,
    );
  }
});
test("first confirm at exact 1500 grants only 1500", () => {
  const user = {
    ratings: { bullet: { rating: 1500, gamesPlayed: 5 } },
  };
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1500 }, {}, user, {}),
    true,
  );
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1200 }, {}, user, {}),
    false,
  );
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1800 }, {}, user, {}),
    false,
  );
});
test("confirm at 1820 then climb to 2000 grants only 2000", () => {
  const user = {
    ratings: { bullet: { rating: 2000, gamesPlayed: 12 } },
    ratingAchievementWatermark: { bullet: 1820 },
  };
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 2000 }, {}, user, {}),
    true,
  );
  for (const v of [1000, 1200, 1500, 1800]) {
    assert.strictEqual(
      ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: v }, {}, user, {}),
      false,
      `must not grant ${v} on the way to 2000`,
    );
  }
});
test("drop to 1440 then recross 1500 grants only 1500", () => {
  const user = {
    ratings: { bullet: { rating: 1510, gamesPlayed: 20 } },
    ratingAchievementWatermark: { bullet: 1440 },
  };
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1500 }, {}, user, {}),
    true,
  );
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1200 }, {}, user, {}),
    false,
  );
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1800 }, {}, user, {}),
    false,
  );
});
test("one jump 1440 → 1850 crosses 1500 and 1800", () => {
  const user = {
    ratings: { bullet: { rating: 1850, gamesPlayed: 20 } },
    ratingAchievementWatermark: { bullet: 1440 },
  };
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1500 }, {}, user, {}),
    true,
  );
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1800 }, {}, user, {}),
    true,
  );
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 1000 }, {}, user, {}),
    false,
  );
  assert.strictEqual(
    ruleSatisfied({ type: "stat", path: "ratings.bullet", op: "gte", value: 2000 }, {}, user, {}),
    false,
  );
});
test("confirmed rapid 980 with no watermark unlocks nothing", () => {
  assert.strictEqual(
    ruleSatisfied(
      { type: "stat", path: "ratings.rapid", op: "gte", value: 1000 },
      {},
      confirmed1600,
      {},
    ),
    false,
  );
});

console.log("\n3) Rated wins only (extras.ratedWins)");
test("bot/stats wins ignored — uses ratedWins extras", () => {
  const stats = { wins: { bullet: 999, blitz: 999, rapid: 999, total: 999 } };
  const extras = { ratedWins: { bullet: 1, blitz: 0, rapid: 0 } };
  assert.strictEqual(
    resolveStatValue("wins.bullet", stats, {}, extras),
    1,
  );
  assert.strictEqual(
    resolveStatValue("wins.total", stats, {}, extras),
    1,
  );
});
test("first bullet win unlocks with ratedWins=1", () => {
  const rule = { type: "stat", path: "wins.bullet", op: "gte", value: 1 };
  assert.strictEqual(
    ruleSatisfied(rule, {}, {}, { ratedWins: { bullet: 1, blitz: 0, rapid: 0 } }),
    true,
  );
  assert.strictEqual(
    ruleSatisfied(rule, {}, {}, { ratedWins: { bullet: 0, blitz: 50, rapid: 50 } }),
    false,
  );
});
test("50 bot wins in Stats do not unlock without ratedWins", () => {
  const rule = { type: "stat", path: "wins.bullet", op: "gte", value: 1 };
  assert.strictEqual(
    ruleSatisfied(
      rule,
      { wins: { bullet: 50 } },
      {},
      { ratedWins: { bullet: 0, blitz: 0, rapid: 0 } },
    ),
    false,
  );
});

console.log("\n4) Permanence (new unlock check after drop)");
test("rating dropped to 1000 cannot newly unlock 1200", () => {
  const rule = { type: "stat", path: "ratings.bullet", op: "gte", value: 1200 };
  assert.strictEqual(ruleSatisfied(rule, {}, droppedFrom1200, {}), false);
});
test("already-unlocked stays via unlockedMap (simulated)", () => {
  // Permanence is storage-side: checkAndUnlock never removes ids.
  // Simulate display: unlockedMap.has(id) || ruleSatisfied
  const unlockedMap = new Set(["rating_bullet_1200"]);
  const stillShown =
    unlockedMap.has("rating_bullet_1200") ||
    ruleSatisfied(
      { type: "stat", path: "ratings.bullet", op: "gte", value: 1200 },
      {},
      droppedFrom1200,
      {},
    );
  assert.strictEqual(stillShown, true);
});

console.log("\n5) Catalog integrity");
test("rating achievements use rating-* assets", () => {
  const ratings = ACHIEVEMENTS.filter((a) => a.category === "ratings");
  assert.ok(ratings.length === 21);
  for (const a of ratings) {
    assert.ok(
      a.assetKey.startsWith("rating-"),
      `${a.id} asset ${a.assetKey}`,
    );
  }
});
test("win achievements use win-* assets", () => {
  const wins = ACHIEVEMENTS.filter((a) => a.category === "wins");
  assert.ok(wins.length === 9);
  for (const a of wins) {
    assert.ok(a.assetKey.startsWith("win-"), `${a.id} asset ${a.assetKey}`);
  }
});
test("no Checkmates category", () => {
  const cats = new Set(ACHIEVEMENTS.map((a) => a.category));
  assert.ok(!cats.has("checkmates"));
});

console.log("\n6) Reconcile retain policy");
test("provisional rating unlocks are revoked", () => {
  const def = ACHIEVEMENTS.find((a) => a.id === "rating_bullet_1500");
  assert.ok(def);
  assert.strictEqual(
    shouldRetainUnlock(def, {}, provisionalUser, {}),
    false,
  );
});
test("confirmed rating unlock kept after drop", () => {
  const def = ACHIEVEMENTS.find((a) => a.id === "rating_bullet_1200");
  assert.ok(def);
  assert.strictEqual(
    shouldRetainUnlock(def, {}, droppedFrom1200, {}),
    true,
  );
});
test("inflated Stats wins do not retain win badge", () => {
  const def = ACHIEVEMENTS.find((a) => a.id === "bullet_wins_50");
  assert.ok(def);
  assert.strictEqual(
    shouldRetainUnlock(
      def,
      { wins: { bullet: 50 } },
      {},
      { ratedWins: { bullet: 2, blitz: 0, rapid: 0 } },
    ),
    false,
  );
});
test("real rated wins retain win badge", () => {
  const def = ACHIEVEMENTS.find((a) => a.id === "bullet_wins_50");
  assert.ok(def);
  assert.strictEqual(
    shouldRetainUnlock(
      def,
      {},
      {},
      { ratedWins: { bullet: 50, blitz: 0, rapid: 0 } },
    ),
    true,
  );
});

console.log("\n=== Summary ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log("");

if (failed > 0) process.exit(1);
