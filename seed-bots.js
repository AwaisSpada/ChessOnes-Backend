/* Seeder for initial Bot documents used in Bot Battles.
 *
 * Usage:
 *   NODE_ENV=development node seed-bots.js
 *
 * This script deletes all existing bots and then creates fresh bot records
 * based on BOT_DEFINITIONS below.
 */

const mongoose = require("mongoose");
require("dotenv").config();

const Bot = require("./models/Bot");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/chess-app";

/**
 * Helper function to determine difficulty level based on ELO
 * @param {number} elo - Bot's ELO rating
 * @returns {string} - "easy", "medium", or "hard"
 */
function getDifficultyFromElo(elo) {
  if (elo <= 800) {
    return "easy"; // Beginner
  } else if (elo <= 1200) {
    return "medium"; // Intermediate
  } else if (elo <= 1800) {
    return "medium"; // Advanced
  } else if (elo <= 2400) {
    return "hard"; // Expert
  } else {
    return "hard"; // Master
  }
}

// 15 Bots from the redesign (chessones-redesign/js/bots.js)
// Images are copied from chessones-redesign/assets/bots/ to public/botimages/
const BOT_DEFINITIONS = [
  {
    key: "pawnish",
    name: "Pawnish",
    elo: 500,
    difficulty: "easy", // Beginner (0-800)
    subtitle: "Friendly",
    photoUrl: "/botimages/bot_pawnish.jpg",
    description:
      "Pawnish just learned that the \"little guys\" can move two squares on their first turn and he's thrilled. He's prone to \"hope chess,\" so if you keep your pieces defended, you'll do just fine.",
  },
  {
    key: "blunderbot",
    name: "Blunderbot",
    elo: 750,
    difficulty: "easy", // Beginner (0-800)
    subtitle: "Merciful",
    photoUrl: "/botimages/bot_blunderbot.jpg",
    description:
      "Blunderbot plays with a lot of heart but a bit too much speed. She loves a good trade, even if she forgets to recapture every now and then.",
  },
  {
    key: "knight_knight",
    name: "Knighty Knight",
    elo: 900,
    difficulty: "medium", // Intermediate (801-1200)
    subtitle: "Sharp",
    photoUrl: "/botimages/bot_knight_knight.jpg",
    description:
      "Knighty Knight has read exactly one chapter of a chess book and thinks he's a strategist. He will try to Scholar's Mate you, but once that fails, he starts to panic.",
  },
  {
    key: "casual_castle",
    name: "Casual Castle",
    elo: 1100,
    difficulty: "medium", // Intermediate (801-1200)
    subtitle: "Solid",
    photoUrl: "/botimages/bot_casual_castle.jpg",
    description:
      "A solid hobbyist who prioritizes king safety above all else. They won't fall for simple traps, but they tend to play a bit too passively in the endgame.",
  },
  {
    key: "steady_eddie",
    name: "Steady Eddie",
    elo: 1250,
    difficulty: "medium", // Advanced (1201-1800)
    subtitle: "Watchful",
    photoUrl: "/botimages/bot_steady_eddie.jpg",
    description:
      "Eddie is obsessed with long-range bishops. He'll tuck his bishops in the corners and wait for you to walk into a discovery—stay alert on the diagonals!",
  },
  {
    key: "tactical_tina",
    name: "Tactical Tina",
    elo: 1400,
    difficulty: "medium", // Advanced (1201-1800)
    subtitle: "Sharp",
    photoUrl: "/botimages/bot_tactical_tina.jpg",
    description:
      "Tina has been grinding puzzles all day. She's looking for every fork and pin possible; if you leave a piece \"hanging\" for even a second, she'll snatch it.",
  },
  {
    key: "gambit_ghost",
    name: "Gambit Ghost",
    elo: 1550,
    difficulty: "medium", // Advanced (1201-1800)
    subtitle: "Aggressive",
    photoUrl: "/botimages/bot_gambit_ghost.jpg",
    description:
      "This bot hates boring draws. It will sacrifice a pawn (or a knight) just to make the position messy and haunt your king.",
  },
  {
    key: "the_defender",
    name: "The Defender",
    elo: 1700,
    difficulty: "medium", // Advanced (1201-1800)
    subtitle: "Ruff",
    photoUrl: "/botimages/bot_the_defender.jpg",
    description:
      "The Defender plays \"by the book.\" She knows her theory 12 moves deep and won't give you any easy weaknesses to exploit.",
  },
  {
    key: "coach_carbon",
    name: "Coach Carbon",
    elo: 1900,
    difficulty: "hard", // Expert (1801-2400)
    subtitle: "Instructive",
    photoUrl: "/botimages/bot_coach_carbon.jpg",
    description:
      "Carbon plays a balanced, instructional style. He punishes positional mistakes ruthlessly but occasionally allows a tactical escape if you're clever.",
  },
  {
    key: "professor_sly",
    name: "Professor Sly",
    elo: 2100,
    difficulty: "hard", // Expert (1801-2400)
    subtitle: "Cunning",
    photoUrl: "/botimages/bot_professor_sly.jpg",
    description:
      "If you reach a 5-piece endgame against Sly, you've already lost. He moves with the precision of a falling glacier—slow, steady, and inevitable.",
  },
  {
    key: "maximus",
    name: "Maximus",
    elo: 2300,
    difficulty: "hard", // Expert (1801-2400)
    subtitle: "Focused",
    photoUrl: "/botimages/bot_maximus.jpg",
    description:
      "A high-level AI that mimics a human Super-GM. It plays nearly perfectly but has \"human\" tendencies, like over-pressing in an equal position.",
  },
  {
    key: "fort_knox",
    name: "Fort Knox",
    elo: 2450,
    difficulty: "hard", // Master (2400+)
    subtitle: "Solid",
    photoUrl: "/botimages/bot_fort_knox.jpg",
    description:
      "Named after its impenetrable defense. This bot specializes in prophylactic moves—stopping your plans before you even think of them.",
  },
  {
    key: "octave",
    name: "Octave",
    elo: 2600,
    difficulty: "hard", // Master (2400+)
    subtitle: "Deep",
    photoUrl: "/botimages/bot_octave.jpg",
    description:
      "Octave sees the board in patterns of energy and flow. Its moves often look strange at first, only to reveal their genius 10 turns later.",
  },
  {
    key: "nebula",
    name: "Nebula",
    elo: 2750,
    difficulty: "hard", // Master (2400+)
    subtitle: "Cosmic",
    photoUrl: "/botimages/bot_nebula.jpg",
    description:
      "A cosmic force of calculation. It evaluates millions of lines per second, playing with a cold, terrifying efficiency that leaves no room for error.",
  },
  {
    key: "the_singularity",
    name: "The Singularity",
    elo: 2800,
    difficulty: "hard", // Master (2400+)
    subtitle: "Transcendent",
    photoUrl: "/botimages/bot_the_singularity.jpg",
    description:
      "The final boss. It doesn't just play chess; it solves it. To beat the Singularity, you must play the game of your life—and even then, it might not be enough.",
  },
];

async function seed() {
  try {
    console.log("🔌 Connecting to MongoDB:", MONGODB_URI);
    await mongoose.connect(MONGODB_URI);
    console.log("✅ MongoDB connected\n");

    // Delete all existing bots before seeding
    const deleteResult = await Bot.deleteMany({});
    console.log(`🗑️  Deleted ${deleteResult.deletedCount} existing bot(s) from database\n`);

    // Create all bots fresh
    console.log("🌱 Creating 15 new bots...\n");
    for (const def of BOT_DEFINITIONS) {
      // Ensure difficulty matches ELO (double-check)
      const calculatedDifficulty = getDifficultyFromElo(def.elo);
      if (def.difficulty !== calculatedDifficulty) {
        console.warn(
          `⚠️  Warning: Bot "${def.name}" has difficulty "${def.difficulty}" but ELO ${def.elo} suggests "${calculatedDifficulty}". Using "${def.difficulty}".`
        );
      }

      await Bot.create(def);
      console.log(`✅ Created bot: ${def.name} (${def.elo} ELO, ${def.difficulty})`);
    }

    console.log("\n" + "=".repeat(60));
    console.log("✨ Bot seeding complete!");
    console.log(`   Total bots created: ${BOT_DEFINITIONS.length}`);
    console.log("=".repeat(60));
  } catch (err) {
    console.error("❌ Bot seeding error:", err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB.");
    process.exit(0);
  }
}

if (require.main === module) {
  seed();
}
