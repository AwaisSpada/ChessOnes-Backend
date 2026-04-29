const express = require("express");
const { body, validationResult } = require("express-validator");
const auth = require("../middleware/auth");
const Bot = require("../models/Bot");

const router = express.Router();

// Public: list enabled bots for Bot Battles
// GET /api/bots
router.get("/", async (req, res) => {
  try {
    const bots = await Bot.find({ enabled: true }).sort({ elo: -1 }).lean();
    res.json({
      success: true,
      data: {
        bots: bots.map((b) => ({
          id: b._id,
          key: b.key,
          name: b.name,
          photoUrl: b.photoUrl,
          difficulty: b.difficulty,
          elo: b.elo,
          subtitle: b.subtitle,
          description: b.description,
        })),
      },
    });
  } catch (error) {
    console.error("List bots error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load bots",
    });
  }
});

// NOTE: The following endpoints are intended for admin use.
// There is currently no explicit role system on User, so they are only auth‑protected.

// POST /api/bots  (admin – create bot)
router.post(
  "/",
  [
    auth,
    body("key").isString().notEmpty(),
    body("name").isString().notEmpty(),
    body("photoUrl").isString().notEmpty(),
    body("difficulty").isIn(["easy", "medium", "hard"]),
    body("elo").isInt({ min: 100, max: 4000 }),
    body("subtitle").optional().isString(),
    body("description").optional().isString(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const { key, name, photoUrl, difficulty, elo, subtitle, description } =
        req.body;

      const existing = await Bot.findOne({ key });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: "Bot with this key already exists",
        });
      }

      const bot = await Bot.create({
        key,
        name,
        photoUrl,
        difficulty,
        elo,
        subtitle: subtitle || "",
        description: description || "",
      });

      res.status(201).json({
        success: true,
        message: "Bot created successfully",
        data: { bot },
      });
    } catch (error) {
      console.error("Create bot error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// PUT /api/bots/:id  (admin – update bot)
router.put(
  "/:id",
  [
    auth,
    body("name").optional().isString(),
    body("photoUrl").optional().isString(),
    body("difficulty").optional().isIn(["easy", "medium", "hard"]),
    body("elo").optional().isInt({ min: 100, max: 4000 }),
    body("subtitle").optional().isString(),
    body("description").optional().isString(),
    body("enabled").optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: errors.array(),
        });
      }

      const update = { ...req.body };
      const bot = await Bot.findByIdAndUpdate(req.params.id, update, {
        new: true,
      });

      if (!bot) {
        return res.status(404).json({
          success: false,
          message: "Bot not found",
        });
      }

      res.json({
        success: true,
        message: "Bot updated successfully",
        data: { bot },
      });
    } catch (error) {
      console.error("Update bot error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// DELETE /api/bots/:id  (admin – soft delete by disabling)
router.delete("/:id", auth, async (req, res) => {
  try {
    const bot = await Bot.findByIdAndUpdate(
      req.params.id,
      { enabled: false },
      { new: true }
    );

    if (!bot) {
      return res.status(404).json({
        success: false,
        message: "Bot not found",
      });
    }

    res.json({
      success: true,
      message: "Bot disabled successfully",
      data: { bot },
    });
  } catch (error) {
    console.error("Delete bot error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;


