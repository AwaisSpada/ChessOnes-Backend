const assert = require("assert");
const {
  winningChances,
  winPercentFromCentiPawns,
  accuracyFromWinPercents,
  adviseMove,
  adviseMoveFull,
  makeComment,
  gameAccuracy,
  accuracyCpMean,
  accuracyCpDiffs,
  plyCentipawnLoss,
  CP_CEILING,
  qualityLabel,
  moverWinChanceDelta,
} = require("./lichess-accuracy");

// Win% at 0cp is 50
assert.ok(Math.abs(winPercentFromCentiPawns(0) - 50) < 1e-9);

// winningChances is odd: f(-x) = -f(x)
assert.ok(Math.abs(winningChances(100) + winningChances(-100)) < 1e-9);

// Docs example shape: 100cp is a modest white edge (~59%)
const wp100 = winPercentFromCentiPawns(100);
assert.ok(wp100 > 58 && wp100 < 61, `expected ~59, got ${wp100}`);

// Perfect / improving move → 100 accuracy
assert.strictEqual(accuracyFromWinPercents(50, 50), 100);
assert.strictEqual(accuracyFromWinPercents(50, 60), 100);

// ~10 Win% drop is a mid accuracy (formula +1 bonus)
const acc10 = accuracyFromWinPercents(60, 50);
assert.ok(acc10 > 64 && acc10 < 70, `got ${acc10}`);

// CpAdvice: white eval 0 → -400 is a huge WC drop → blunder
assert.strictEqual(adviseMove({ cp: 0 }, { cp: -400 }, true), "blunder");
// Small drop 0 → -20 should not annotate
assert.strictEqual(adviseMove({ cp: 0 }, { cp: -20 }, true), null);
// ~0.12 WC drop (~70cp) → inaccuracy
assert.strictEqual(adviseMove({ cp: 0 }, { cp: -80 }, true), "inaccuracy");

// Black: white eval 0 → +400 means black blundered
assert.strictEqual(adviseMove({ cp: 0 }, { cp: 400 }, false), "blunder");

// Mate lost for white (had +M2, now 0)
assert.strictEqual(adviseMove({ mate: 2 }, { cp: 0 }, true), "blunder");

// Equal quiet game → high accuracy both sides
const equalCps = Array.from({ length: 41 }, () => 10);
const acc = gameAccuracy("white", equalCps);
assert.ok(acc.white != null && acc.white > 99, `white ${acc.white}`);
assert.ok(acc.black != null && acc.black > 99, `black ${acc.black}`);

// White blunders 0 → -500 and the eval stays there (black does not give it back)
const withBlunder = Array.from({ length: 41 }, (_, i) => (i === 0 ? 0 : -500));
const acc2 = gameAccuracy("white", withBlunder);
assert.ok(acc2.white < 95, `white ${acc2.white}`);
assert.ok(acc2.black > acc2.white, `white ${acc2.white} black ${acc2.black}`);

const advice = adviseMoveFull({ cp: 0 }, { cp: -400 }, true);
assert.strictEqual(advice.judgement, "blunder");
const comment = makeComment(advice, { cp: 0 }, { cp: -400 }, "Nf3");
assert.ok(comment.includes("Blunder"), comment);
assert.ok(comment.includes("Nf3 was best"), comment);
assert.ok(comment.includes("+0.00 → -4.00"), comment);

const excellentComment = makeComment(
  { judgement: "excellent", sequence: null },
  { cp: 40 },
  { cp: 28 },
  "Nfd2"
);
assert.ok(excellentComment.includes("Excellent"), excellentComment);
assert.ok(excellentComment.includes("Nfd2 was best"), excellentComment);
assert.ok(excellentComment.includes("+0.40 → +0.28"), excellentComment);

// AccuracyCP: consecutive ceiled evals, not best-vs-played, mate = ±1000
assert.strictEqual(plyCentipawnLoss(0, -80, true), 80);
assert.strictEqual(plyCentipawnLoss(0, 80, false), 80);
assert.strictEqual(plyCentipawnLoss(0, 50, true), 0); // improved for white
assert.strictEqual(plyCentipawnLoss(1500, 400, true), 600); // 1000-400, not 1100
assert.strictEqual(plyCentipawnLoss(1000, 1000, true), 0); // still mate
assert.strictEqual(plyCentipawnLoss(1000, 0, true), 1000); // mate lost, capped
assert.strictEqual(CP_CEILING, 1000);

const equalCpl = accuracyCpMean("white", Array.from({ length: 9 }, () => 15));
assert.strictEqual(equalCpl.white, 0);
assert.strictEqual(equalCpl.black, 0);

// White blunders 0 → -500, black holds: white ACPL 500, black 0
const whiteBlunderCps = [0, -500, -500, -500];
assert.deepStrictEqual(accuracyCpDiffs("white", "white", whiteBlunderCps), [500, 0]);
assert.deepStrictEqual(accuracyCpDiffs("white", "black", whiteBlunderCps), [0]);
const whiteBlunderAcpl = accuracyCpMean("white", whiteBlunderCps);
assert.strictEqual(whiteBlunderAcpl.white, 250);
assert.strictEqual(whiteBlunderAcpl.black, 0);

// Missing eval skipped (flatten), leftover unpaired ply dropped
assert.deepStrictEqual(accuracyCpDiffs("white", "white", [0, null, 10, 10]), [null, 0]);
assert.strictEqual(accuracyCpMean("white", [0, null, 10, 10]).white, 0);

// Lichess glyphs unchanged
assert.strictEqual(adviseMove({ cp: 0 }, { cp: -80 }, true), "inaccuracy");
assert.strictEqual(adviseMove({ cp: 0 }, { cp: -400 }, true), "blunder");
assert.strictEqual(
  qualityLabel({ judgement: "inaccuracy", isBestMove: true, isBookMove: true, delta: 0.02 }),
  "inaccuracy"
);
assert.strictEqual(
  qualityLabel({ judgement: "blunder", isBestMove: true, isBookMove: false, delta: 0.4 }),
  "blunder"
);
assert.strictEqual(
  qualityLabel({ judgement: null, isBestMove: true, isBookMove: true, delta: 0.02 }),
  "book"
);
assert.strictEqual(
  qualityLabel({ judgement: null, isBestMove: false, isBookMove: true, delta: 0.02 }),
  "book"
);
const d40 = moverWinChanceDelta({ cp: 0 }, { cp: -40 }, true);
assert.ok(d40 != null && d40 >= 0.005 && d40 < 0.1, `delta 40cp ${d40}`);
assert.strictEqual(
  qualityLabel({ judgement: null, isBestMove: false, isBookMove: false, delta: d40 }),
  "excellent"
);
const d80 = moverWinChanceDelta({ cp: 0 }, { cp: -80 }, true);
assert.ok(d80 != null && d80 >= 0.1, `delta 80cp ${d80}`);
assert.strictEqual(
  qualityLabel({
    judgement: adviseMove({ cp: 0 }, { cp: -80 }, true),
    isBestMove: false,
    isBookMove: false,
    delta: d80,
  }),
  "inaccuracy"
);

console.log("lichess-accuracy tests ok");
console.log({ wp100, acc10, equal: acc, blunderGame: acc2, whiteBlunderAcpl });
