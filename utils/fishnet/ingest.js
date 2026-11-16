/**
 * Fishnet analysis JSON → lite-review-pool result rows (STM evals).
 * protocol.md: signed mate/cp from side to move. mate 0 = STM lost.
 */

function scoreToEvaluation(score) {
  if (!score || typeof score !== "object") return { cp: 0 };
  if (typeof score.mate === "number") return { mate: score.mate };
  if (typeof score.cp === "number") return { cp: score.cp };
  return { cp: 0 };
}

function parsePvString(pv) {
  return typeof pv === "string" ? pv.trim().split(/\s+/).filter(Boolean) : [];
}

function analysisEntryToResult(entry) {
  if (!entry) {
    return {
      error: "missing",
      bestMove: null,
      evaluation: { cp: 0 },
      pv: [],
      depth: 0,
      nodes: 0,
      alternativeLines: [],
    };
  }
  const evaluation = scoreToEvaluation(entry.score);
  const pv = parsePvString(entry.pv);
  let alternativeLines = [];
  if (Array.isArray(entry.pvs) && entry.pvs.length) {
    alternativeLines = entry.pvs
      .map((line, idx) => {
        const linePv = parsePvString(line && line.pv);
        const lineEval = scoreToEvaluation(line && line.score);
        const move = linePv[0] || null;
        if (!move) return null;
        return {
          multipv: typeof line.multipv === "number" ? line.multipv : idx + 1,
          move,
          pv: linePv,
          evaluation: lineEval,
        };
      })
      .filter(Boolean);
  } else if (pv[0]) {
    alternativeLines = [{ multipv: 1, move: pv[0], pv, evaluation }];
  }
  return {
    bestMove: pv[0] || (alternativeLines[0] && alternativeLines[0].move) || null,
    evaluation,
    pv,
    depth: entry.depth || 0,
    nodes: entry.nodes || 0,
    alternativeLines,
    fishnetSkippedSearch: Boolean(entry.skipped),
  };
}

function analysisToResults(analysis, moveCount) {
  const expected = moveCount + 1;
  const rows = Array.isArray(analysis) ? analysis : [];
  const results = [];
  for (let i = 0; i < expected; i++) {
    results.push(analysisEntryToResult(rows[i]));
  }
  return results;
}

function resultToAnalysisEntry(result) {
  if (!result || result.error) {
    return { skipped: true };
  }
  const evaluation = result.evaluation || { cp: 0 };
  const score =
    typeof evaluation.mate === "number" ? { mate: evaluation.mate } : { cp: evaluation.cp || 0 };
  const pv = Array.isArray(result.pv) ? result.pv.join(" ") : "";
  const entry = {
    depth: result.depth || 0,
    score,
    nodes: result.nodes || 0,
  };
  if (pv) entry.pv = pv;
  const alts = Array.isArray(result.alternativeLines) ? result.alternativeLines : [];
  if (alts.length) {
    entry.pvs = alts.slice(0, 3).map((line, idx) => {
      const linePv = Array.isArray(line.pv) ? line.pv.join(" ") : "";
      const lineEval = line.evaluation || { cp: 0 };
      const lineScore =
        typeof lineEval.mate === "number" ? { mate: lineEval.mate } : { cp: lineEval.cp || 0 };
      const row = {
        multipv: typeof line.multipv === "number" ? line.multipv : idx + 1,
        score: lineScore,
      };
      if (linePv) row.pv = linePv;
      return row;
    });
  }
  if (result.fishnetSkippedSearch) {
    entry.depth = 0;
  }
  return entry;
}

function resultsToAnalysis(results) {
  return (results || []).map(resultToAnalysisEntry);
}

module.exports = {
  analysisToResults,
  resultsToAnalysis,
  analysisEntryToResult,
  resultToAnalysisEntry,
};
