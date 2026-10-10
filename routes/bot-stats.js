const express = require("express");
const mongoose = require("mongoose");
const Game = require("../models/Game");
const Bot = require("../models/Bot");
const auth = require("../middleware/auth");
const requirePoliciesAccepted = require("../middleware/requirePoliciesAccepted");

const router = express.Router();

/**
 * Completed bot games that count toward the user's training record.
 * Excludes abandoned / first-move abandon shells (same spirit as web history filters).
 */
function isCountableBotGame(game) {
  if (!game || String(game.type) !== "bot") return false;
  const status = String(game.status || "").toLowerCase();
  if (status === "abandoned") return false;
  if (status !== "completed") return false;

  const reason = String(game?.result?.reason || "")
    .toLowerCase()
    .trim()
    .replace(/_/g, "-");
  if (reason === "first-move-abandon") return false;
  if (reason.includes("first-move") && reason.includes("abandon")) return false;

  const winner = game?.result?.winner;
  return winner === "white" || winner === "black" || winner === "draw";
}

function resolveUserSide(game, userId) {
  const uid = String(userId);
  const whiteId = game?.players?.white ? String(game.players.white) : null;
  const blackId = game?.players?.black ? String(game.players.black) : null;
  if (whiteId === uid) return "white";
  if (blackId === uid) return "black";

  // Fallback from botSide when only one seat is filled
  const botSide = game?.botSide === "white" || game?.botSide === "black" ? game.botSide : null;
  if (botSide === "white") return "black";
  if (botSide === "black") return "white";
  return null;
}

function resolveOpponent(game) {
  if (game?.bot && typeof game.bot === "object") {
    const elo = Number(game.bot.elo);
    return {
      botId: game.bot._id ? String(game.bot._id) : null,
      key: typeof game.bot.key === "string" ? game.bot.key : null,
      name: String(game.bot.name || "Bot").trim() || "Bot",
      elo: Number.isFinite(elo) ? Math.round(elo) : null,
      isCustom: false,
    };
  }

  const custom = game?.customBot;
  if (custom && (custom.name || custom.elo != null)) {
    const elo = Number(custom.elo);
    return {
      botId: null,
      key: "custom-bot",
      name: String(custom.name || "Custom Bot").trim() || "Custom Bot",
      elo: Number.isFinite(elo) ? Math.round(elo) : null,
      isCustom: true,
    };
  }

  return {
    botId: game?.bot ? String(game.bot) : null,
    key: null,
    name: "Bot",
    elo: null,
    isCustom: false,
  };
}

function outcomeForUser(game, userId) {
  const side = resolveUserSide(game, userId);
  if (!side) return null;
  const winner = game?.result?.winner;
  if (winner === "draw") return { side, outcome: "draw", opponent: resolveOpponent(game) };
  if (winner === "white" || winner === "black") {
    return {
      side,
      outcome: winner === side ? "win" : "loss",
      opponent: resolveOpponent(game),
    };
  }
  return null;
}

function formatBotRef(ref) {
  if (!ref || !ref.name) return null;
  return {
    botId: ref.botId || null,
    key: ref.key || null,
    name: ref.name,
    elo: typeof ref.elo === "number" ? ref.elo : null,
    isCustom: Boolean(ref.isCustom),
    label:
      typeof ref.elo === "number" ? `${ref.name} · ${ref.elo}` : String(ref.name),
  };
}

/**
 * GET /api/bot-stats/me
 * Lifetime bot-training record for the authenticated user.
 * New endpoint — does not modify /api/bots, /api/bot-games, or /api/games.
 */
router.get("/me", auth, requirePoliciesAccepted, async (req, res) => {
  try {
    const userId = req.user._id;
    const uidObj =
      userId instanceof mongoose.Types.ObjectId
        ? userId
        : new mongoose.Types.ObjectId(String(userId));

    const games = await Game.find({
      type: "bot",
      status: "completed",
      $or: [{ "players.white": uidObj }, { "players.black": uidObj }],
    })
      .select(
        "type status result players bot botSide customBot createdAt updatedAt endTime"
      )
      .populate("bot", "name elo photoUrl key enabled")
      .lean();

    let wins = 0;
    let losses = 0;
    let draws = 0;
    let toughestBeaten = null;

    for (const game of games) {
      if (!isCountableBotGame(game)) continue;
      const row = outcomeForUser(game, userId);
      if (!row) continue;

      if (row.outcome === "win") {
        wins += 1;
        const opp = row.opponent;
        const elo = typeof opp.elo === "number" ? opp.elo : -1;
        const prevElo =
          toughestBeaten && typeof toughestBeaten.elo === "number"
            ? toughestBeaten.elo
            : -1;
        if (elo > prevElo) {
          toughestBeaten = opp;
        }
      } else if (row.outcome === "loss") {
        losses += 1;
      } else {
        draws += 1;
      }
    }

    const gamesPlayed = wins + losses + draws;
    const winRate =
      gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 1000) / 10 : 0;

    // Next stretch target: weakest enabled roster bot above toughest beaten (else top bot).
    const roster = await Bot.find({ enabled: true })
      .select("name elo key photoUrl")
      .sort({ elo: 1 })
      .lean();

    let currentTarget = null;
    if (roster.length > 0) {
      const floor =
        toughestBeaten && typeof toughestBeaten.elo === "number"
          ? toughestBeaten.elo
          : -1;
      const next = roster.find((b) => Number(b.elo) > floor) || roster[roster.length - 1];
      if (next) {
        currentTarget = {
          botId: String(next._id),
          key: next.key || null,
          name: next.name,
          elo: Math.round(Number(next.elo) || 0),
          isCustom: false,
        };
      }
    }

    res.json({
      success: true,
      data: {
        gamesPlayed,
        wins,
        losses,
        draws,
        winRate,
        toughestBeaten: formatBotRef(toughestBeaten),
        currentTarget: formatBotRef(currentTarget),
      },
    });
  } catch (error) {
    console.error("[bot-stats/me] error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load bot stats",
    });
  }
});

module.exports = router;
