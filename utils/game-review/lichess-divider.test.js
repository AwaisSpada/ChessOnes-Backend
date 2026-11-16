const assert = require("assert");
const { Chess } = require("chess.js");
const {
  divideUci,
  majorsAndMinors,
  backrankSparse,
  mixedness,
  boardsFromUci,
} = require("./lichess-divider");

const start = boardsFromUci([])[0];
assert.strictEqual(majorsAndMinors(start), 14);
assert.strictEqual(backrankSparse(start), false);
assert.ok(mixedness(start) <= 150, `start mixedness ${mixedness(start)}`);

const openingOnly = divideUci([]);
assert.strictEqual(openingOnly.middle, null);

const e4 = divideUci(["e2e4"]);
assert.ok(e4.middle == null || e4.middle > 0);

console.log("lichess-divider.test.js ok", {
  startMix: mixedness(start),
  e4,
});
void Chess;
