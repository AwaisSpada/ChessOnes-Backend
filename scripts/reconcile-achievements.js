/**
 * One-time reconciliation: strip unlocks that do not meet current rules,
 * then silently grant any missing unlocks that do qualify.
 *
 * Policy:
 *   - Win badges  → rated multiplayer/friend wins only
 *   - Rating badges → remove if TC never confirmed (gamesPlayed < 5);
 *                     keep if confirmed (even after a rating drop)
 *   - Puzzles / anniversary → real solves / account age
 *   - Unknown catalog ids → remove
 *
 * Usage:
 *   node scripts/reconcile-achievements.js              # dry-run (default)
 *   node scripts/reconcile-achievements.js --apply      # write to DB
 *   node scripts/reconcile-achievements.js --user=alice # one user, dry-run
 *   node scripts/reconcile-achievements.js --user=alice --apply
 *   node scripts/reconcile-achievements.js --limit=50
 */

require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const {
  reconcileUserAchievements,
} = require("../services/achievementUnlockService");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";

function parseArgs(argv) {
  const opts = {
    apply: false,
    user: null,
    limit: null,
    verbose: false,
  };
  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg.startsWith("--user=")) opts.user = arg.slice("--user=".length).trim();
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) opts.limit = Math.floor(n);
    }
  }
  return opts;
}

async function findTargetUsers(opts) {
  if (opts.user) {
    const q = opts.user.toLowerCase();
    const user = await User.findOne({
      $or: [
        { username: new RegExp(`^${q}$`, "i") },
        { email: q },
        ...(mongoose.isValidObjectId(opts.user) ? [{ _id: opts.user }] : []),
      ],
    }).select("_id username email unlockedAchievements");
    return user ? [user] : [];
  }

  let query = User.find({
    "unlockedAchievements.0": { $exists: true },
  }).select("_id username email unlockedAchievements");

  if (opts.limit) query = query.limit(opts.limit);
  return query;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.apply ? "APPLY" : "DRY-RUN";

  console.log(`\n=== Reconcile achievements (${mode}) ===\n`);
  if (!opts.apply) {
    console.log("No DB writes. Pass --apply to persist changes.\n");
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB\n");

  const users = await findTargetUsers(opts);
  if (opts.user && users.length === 0) {
    console.error(`User not found: ${opts.user}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Users to scan: ${users.length}\n`);

  let usersChanged = 0;
  let totalRemoved = 0;
  let totalAdded = 0;
  const removeCounts = new Map();
  const addCounts = new Map();

  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const label = user.username || user.email || String(user._id);

    try {
      const result = await reconcileUserAchievements(user._id, {
        persist: opts.apply,
      });

      if (result.missing) continue;

      if (result.changed) {
        usersChanged += 1;
        totalRemoved += result.removed.length;
        totalAdded += result.added.length;

        for (const id of result.removed) {
          removeCounts.set(id, (removeCounts.get(id) || 0) + 1);
        }
        for (const id of result.added) {
          addCounts.set(id, (addCounts.get(id) || 0) + 1);
        }

        if (opts.verbose || opts.user) {
          console.log(`— ${label}`);
          if (result.removed.length) {
            console.log(`  remove: ${result.removed.join(", ")}`);
          }
          if (result.added.length) {
            console.log(`  add:    ${result.added.join(", ")}`);
          }
        } else if (usersChanged <= 25 || i === users.length - 1) {
          console.log(
            `— ${label}: -${result.removed.length} +${result.added.length}`,
          );
        }
      }
    } catch (err) {
      console.error(`ERROR ${label}: ${err.message}`);
    }

    if ((i + 1) % 100 === 0) {
      console.log(`… processed ${i + 1}/${users.length}`);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Mode:            ${mode}`);
  console.log(`Users scanned:   ${users.length}`);
  console.log(`Users changed:   ${usersChanged}`);
  console.log(`Unlocks removed: ${totalRemoved}`);
  console.log(`Unlocks added:   ${totalAdded}`);

  if (removeCounts.size) {
    console.log("\nTop removals:");
    [...removeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([id, n]) => console.log(`  ${n}× ${id}`));
  }

  if (addCounts.size) {
    console.log("\nTop additions:");
    [...addCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([id, n]) => console.log(`  ${n}× ${id}`));
  }

  if (!opts.apply && usersChanged > 0) {
    console.log("\nLooks good? Re-run with --apply to write changes.");
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
