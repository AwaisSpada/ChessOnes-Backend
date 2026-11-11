/**
 * Game Review strength presets (nodes per position).
 * Search command is always `go nodes N`. Depth/movetime are legacy request fields only.
 */

const PRESETS = [
  { id: "fast", label: "Fast", nodes: 300000 },
  { id: "standard", label: "Standard", nodes: 500000 },
  { id: "deep", label: "Deep", nodes: 1000000 },
  { id: "extra_deep", label: "Extra deep", nodes: 1500000 },
  { id: "maximum", label: "Maximum", nodes: 2000000 },
];

const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
const PRESET_NODES = PRESETS.map((p) => p.nodes);
const DEFAULT_NODES = 300000;

function snapToPresetNodes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_NODES;
  let best = PRESET_NODES[0];
  for (const p of PRESET_NODES) {
    if (Math.abs(p - n) < Math.abs(best - n)) best = p;
  }
  return best;
}

function presetFromNodes(nodes) {
  const snapped = snapToPresetNodes(nodes);
  return PRESETS.find((p) => p.nodes === snapped) || PRESETS[0];
}

/** Keep depth/movetime populated so older clients still display something. */
function legacyKnobsFromNodes(nodes) {
  const n = snapToPresetNodes(nodes);
  if (n <= 300000) return { depth: 12, movetime: 600 };
  if (n <= 500000) return { depth: 14, movetime: 800 };
  if (n <= 1000000) return { depth: 16, movetime: 2000 };
  if (n <= 1500000) return { depth: 18, movetime: 2000 };
  return { depth: 20, movetime: 2000 };
}

function nodesFromLegacyDepthMovetime(depth, movetime) {
  const d = Math.max(6, Math.min(20, Math.round(Number(depth) || 12)));
  const t = Math.max(300, Math.min(8000, Math.round(Number(movetime) || 600)));
  const raw = Math.round(300000 * (d / 12) * Math.sqrt(t / 600));
  return snapToPresetNodes(Math.max(100000, Math.min(2000000, raw)));
}

/**
 * Resolve a request body / options bag to a preset.
 * Prefers `preset` or `nodes`; else maps old depth+movetime.
 */
function resolveReviewEngine(options = {}) {
  const presetId =
    typeof options.preset === "string" ? options.preset.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  let nodes;
  if (PRESET_BY_ID[presetId]) {
    nodes = PRESET_BY_ID[presetId].nodes;
  } else if (options.nodes != null && Number.isFinite(Number(options.nodes))) {
    nodes = snapToPresetNodes(options.nodes);
  } else if (options.depth != null || options.movetime != null) {
    nodes = nodesFromLegacyDepthMovetime(options.depth, options.movetime);
  } else {
    nodes = DEFAULT_NODES;
  }
  const preset = presetFromNodes(nodes);
  const knobs = legacyKnobsFromNodes(preset.nodes);
  return {
    nodes: preset.nodes,
    preset: preset.id,
    label: preset.label,
    depth: knobs.depth,
    movetime: knobs.movetime,
  };
}

module.exports = {
  PRESETS,
  DEFAULT_NODES,
  snapToPresetNodes,
  presetFromNodes,
  resolveReviewEngine,
  nodesFromLegacyDepthMovetime,
  legacyKnobsFromNodes,
};
