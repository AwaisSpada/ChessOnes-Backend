const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const LearnStudyProgress = require("../models/LearnStudyProgress");

const VALID_PHASES = new Set(["new", "learning", "review"]);

function serializeRecord(doc) {
  return {
    studyId: doc.studyId,
    phase: doc.phase,
    ease: doc.ease,
    intervalDays: doc.intervalDays,
    learningStep: doc.learningStep,
    dueAt: doc.dueAt.getTime(),
    reps: doc.reps,
    lapses: doc.lapses,
    lastStudiedAt: doc.lastStudiedAt.getTime(),
  };
}

function parseIncomingRecord(studyId, raw) {
  if (!raw || typeof raw !== "object") return null;

  const phase = VALID_PHASES.has(raw.phase) ? raw.phase : "new";
  const dueAt = new Date(Number(raw.dueAt) || Date.now());
  const lastStudiedAt = new Date(Number(raw.lastStudiedAt) || Date.now());

  if (Number.isNaN(dueAt.getTime()) || Number.isNaN(lastStudiedAt.getTime())) {
    return null;
  }

  return {
    studyId,
    phase,
    ease: Number.isFinite(raw.ease) ? raw.ease : 2.5,
    intervalDays: Number.isFinite(raw.intervalDays) ? raw.intervalDays : 0,
    learningStep: Number.isFinite(raw.learningStep) ? raw.learningStep : 0,
    dueAt,
    reps: Number.isFinite(raw.reps) ? raw.reps : 0,
    lapses: Number.isFinite(raw.lapses) ? raw.lapses : 0,
    lastStudiedAt,
  };
}

/**
 * GET /api/learn/progress
 * Returns all SRS study progress for the authenticated user.
 */
router.get("/progress", auth, async (req, res) => {
  try {
    const rows = await LearnStudyProgress.find({ user: req.user._id }).lean();
    const studies = {};

    for (const row of rows) {
      studies[row.studyId] = serializeRecord(row);
    }

    return res.json({
      success: true,
      data: { studies },
    });
  } catch (error) {
    console.error("Get learn progress error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load learn progress",
    });
  }
});

/**
 * PUT /api/learn/progress
 * Bulk upsert study progress from the mobile client.
 */
router.put("/progress", auth, async (req, res) => {
  try {
    const { studies } = req.body || {};
    if (!studies || typeof studies !== "object") {
      return res.status(400).json({
        success: false,
        message: "studies object is required",
      });
    }

    const ops = [];

    for (const [studyId, raw] of Object.entries(studies)) {
      const parsed = parseIncomingRecord(studyId, raw);
      if (!parsed) continue;

      ops.push({
        updateOne: {
          filter: { user: req.user._id, studyId: parsed.studyId },
          update: {
            $set: {
              phase: parsed.phase,
              ease: parsed.ease,
              intervalDays: parsed.intervalDays,
              learningStep: parsed.learningStep,
              dueAt: parsed.dueAt,
              reps: parsed.reps,
              lapses: parsed.lapses,
              lastStudiedAt: parsed.lastStudiedAt,
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length) {
      await LearnStudyProgress.bulkWrite(ops, { ordered: false });
    }

    const rows = await LearnStudyProgress.find({ user: req.user._id }).lean();
    const merged = {};
    for (const row of rows) {
      merged[row.studyId] = serializeRecord(row);
    }

    return res.json({
      success: true,
      data: { studies: merged },
    });
  } catch (error) {
    console.error("Sync learn progress error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to sync learn progress",
    });
  }
});

module.exports = router;
