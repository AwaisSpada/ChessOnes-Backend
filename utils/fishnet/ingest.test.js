const assert = require("assert");
const { analysisToResults, resultsToAnalysis } = require("./ingest");
const queue = require("./queue");

const results = [
  { bestMove: "e2e4", evaluation: { cp: 24 }, pv: ["e2e4", "e7e5"], depth: 18, nodes: 1000 },
  { bestMove: "e7e5", evaluation: { cp: 20 }, pv: ["e7e5"], depth: 16, nodes: 900 },
];
const analysis = resultsToAnalysis(results);
assert.strictEqual(analysis[0].score.cp, 24);
assert.strictEqual(analysis[0].pv, "e2e4 e7e5");
const back = analysisToResults(analysis, 1);
assert.strictEqual(back[0].evaluation.cp, 24);
assert.strictEqual(back[1].bestMove, "e7e5");

const job = queue.enqueue(["e2e4"], { nodes: 1000000 });
const acquired = queue.acquire();
assert.strictEqual(acquired.id, job.id);
const payload = queue.toAcquirePayload(acquired);
assert.strictEqual(payload.work.type, "analysis");
assert.strictEqual(payload.work.nodes.sf16, 1000000);
assert.ok(payload.position.includes("rnbqkbnr"));
queue.complete(job.id, analysis);

const skippedMate = analysisToResults([{ skipped: true, score: { mate: 0 } }], 0);
assert.strictEqual(skippedMate[0].evaluation.mate, 0);
assert.ok(!skippedMate[0].error);

const skippedDraw = analysisToResults([{ skipped: true, score: { cp: 0 } }], 0);
assert.strictEqual(skippedDraw[0].evaluation.cp, 0);
assert.ok(!skippedDraw[0].error);

const multi = resultsToAnalysis([
  {
    bestMove: "e2e4",
    evaluation: { cp: 30 },
    pv: ["e2e4", "e7e5"],
    depth: 16,
    nodes: 1000,
    alternativeLines: [
      { multipv: 1, move: "e2e4", pv: ["e2e4", "e7e5"], evaluation: { cp: 30 } },
      { multipv: 2, move: "d2d4", pv: ["d2d4", "d7d5"], evaluation: { cp: 18 } },
      { multipv: 3, move: "c2c4", pv: ["c2c4"], evaluation: { cp: 10 } },
    ],
  },
]);
assert.strictEqual(multi[0].pvs.length, 3);
assert.strictEqual(multi[0].pvs[1].pv, "d2d4 d7d5");
const multiBack = analysisToResults(multi, 0);
assert.strictEqual(multiBack[0].alternativeLines.length, 3);
assert.strictEqual(multiBack[0].alternativeLines[2].move, "c2c4");

console.log("fishnet ingest/queue tests ok");
