const assert = require("assert");
const { gameOverEval, fenFromMoves } = require("./lite-review-pool");

const scholars = [
  "e2e4",
  "e7e5",
  "f1c4",
  "b8c6",
  "d1h5",
  "g8f6",
  "h5f7",
];
assert.deepStrictEqual(gameOverEval(scholars), { mate: 0 });
assert.ok(fenFromMoves(scholars).includes(" b "));
assert.strictEqual(gameOverEval(["e2e4"]), null);
assert.ok(fenFromMoves(["e2e4"]).startsWith("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"));

console.log("lite-review-pool gameOver/fen tests ok");
