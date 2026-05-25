/**
 * One-off migration: encrypt any plaintext messenger rows that existed
 * before AES-256-GCM at-rest encryption was rolled out.
 *
 * Usage:
 *   node scripts/encrypt-messenger-messages.js          # apply changes
 *   node scripts/encrypt-messenger-messages.js --dry    # report only
 *
 * Idempotent: rows that are already in `enc:v1:` envelope form are skipped,
 * so it's safe to re-run.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const MessengerMessage = require("../models/MessengerMessage");
const MessengerConversation = require("../models/MessengerConversation");
const { encrypt, isEncrypted } = require("../utils/messageCrypto");

const DRY = process.argv.includes("--dry");
const BATCH = 500;

async function migrateMessages() {
  let scanned = 0;
  let updated = 0;
  let lastId = null;

  while (true) {
    const filter = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await MessengerMessage.find(filter)
      .sort({ _id: 1 })
      .limit(BATCH)
      .select("_id body")
      .lean();
    if (batch.length === 0) break;

    const ops = [];
    for (const doc of batch) {
      scanned += 1;
      lastId = doc._id;
      if (!doc.body || isEncrypted(doc.body)) continue;
      const enveloped = encrypt(doc.body);
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { body: enveloped } },
        },
      });
    }

    if (ops.length > 0) {
      updated += ops.length;
      if (!DRY) {
        await MessengerMessage.bulkWrite(ops, { ordered: false });
      }
    }
    console.log(
      `  …scanned ${scanned}, ${updated} to encrypt${DRY ? " (dry-run)" : " (written)"}`
    );
  }

  return { scanned, updated };
}

async function migrateConversationSnippets() {
  let scanned = 0;
  let updated = 0;
  let lastId = null;

  while (true) {
    const filter = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await MessengerConversation.find(filter)
      .sort({ _id: 1 })
      .limit(BATCH)
      .select("_id lastMessageSnippet")
      .lean();
    if (batch.length === 0) break;

    const ops = [];
    for (const doc of batch) {
      scanned += 1;
      lastId = doc._id;
      if (!doc.lastMessageSnippet) continue;
      if (isEncrypted(doc.lastMessageSnippet)) continue;
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { lastMessageSnippet: encrypt(doc.lastMessageSnippet) } },
        },
      });
    }

    if (ops.length > 0) {
      updated += ops.length;
      if (!DRY) {
        await MessengerConversation.bulkWrite(ops, { ordered: false });
      }
    }
    console.log(
      `  …scanned ${scanned} convs, ${updated} snippets to encrypt${DRY ? " (dry-run)" : " (written)"}`
    );
  }

  return { scanned, updated };
}

(async () => {
  const mongoUri =
    process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
  console.log(`🔌 Connecting to MongoDB (${DRY ? "dry-run" : "live"})…`);
  await mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ Connected");

  try {
    console.log("\n→ Encrypting MessengerMessage.body…");
    const m = await migrateMessages();
    console.log(
      `Messages: scanned ${m.scanned}, updated ${m.updated}${DRY ? " (dry-run)" : ""}`
    );

    console.log("\n→ Encrypting MessengerConversation.lastMessageSnippet…");
    const c = await migrateConversationSnippets();
    console.log(
      `Conversations: scanned ${c.scanned}, updated ${c.updated}${DRY ? " (dry-run)" : ""}`
    );

    console.log("\n✅ Done.");
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
