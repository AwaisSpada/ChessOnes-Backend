/**
 * Unique index on games.clientGameId must be sparse.
 * `default: null` previously wrote explicit nulls, so the unique index
 * rejected every additional invite/friend/online game (dup key null).
 */
async function ensureClientGameIdIndex(Game) {
  const col = Game.collection;

  const unsetResult = await col.updateMany(
    { clientGameId: null },
    { $unset: { clientGameId: "" } },
  );
  if (unsetResult.modifiedCount > 0) {
    console.log(
      `[Game] unset null clientGameId on ${unsetResult.modifiedCount} document(s)`,
    );
  }

  const indexes = await col.indexes();
  const existing = indexes.find((idx) => idx.name === "clientGameId_1");
  const isSparseUnique =
    existing && existing.unique === true && existing.sparse === true;

  if (existing && !isSparseUnique) {
    await col.dropIndex("clientGameId_1");
    console.log("[Game] dropped non-sparse clientGameId_1 index");
  }

  if (!isSparseUnique) {
    await col.createIndex(
      { clientGameId: 1 },
      { unique: true, sparse: true, name: "clientGameId_1" },
    );
    console.log("[Game] ensured sparse unique clientGameId_1 index");
  }
}

module.exports = { ensureClientGameIdIndex };
