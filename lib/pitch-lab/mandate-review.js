/**
 * Mandate Review — turns the Pitch Lab statistical report into SUGGESTED
 * changes to the mandate weights. Suggestions only. Nothing here creates a
 * proposal, modifies the mandate config, writes to the ledger, or calls a
 * broker. Fail-closed: a missing or malformed report field produces
 * "unavailable" for that item, never a fabricated value.
 *
 * Pure: no I/O, no model calls, no DB imports.
 */

export const MANDATE_REVIEW_SCHEMA_VERSION = "pitch-lab.mandate-review.v1";
export const REQUIRED_REPORT_SCHEMA = "pitch-lab.report.v2";

// Thresholds for promoting a finding from "watch" to "recommended".
const MIN_HORIZONS_FOR_RECOMMENDED = 2;

// The FDR threshold the analysis already uses for metric verdicts.
const FDR_THRESHOLD = 0.10;

const CAVEATS = Object.freeze([
  "SPY-only benchmark: a sector rally can inflate a metric's apparent predictive value even when the finding is genuine. Sector-relative grading is a future improvement.",
  "10 bps per-side cost assumption: actual slippage and market impact vary. Metrics that look marginal here may flip at higher realized costs.",
  "Consensus and 13F metrics (revBeat, estimateRevisions, instOwnershipDir, thirteenF) are currently missing from most Pitch Lab pitches because the pipeline does not yet hand them to Pitch Lab. Coverage gaps are shown in dataCoverage.",
  "Shadow and paper evidence does not prove TRUST execution. These findings reflect the agent's research judgment on paper pitches, not live trade outcomes against a real execution record (see portfolio-master-plan.md §10).",
  "Mandate weights are one policy lever. Peer set quality, feature coverage, and model calibration all affect outcomes independently of how the mandate is tuned.",
]);

/** Extract flat { metricId → { points, higherIsBetter } } from AGENT_SCORING[agentId]. */
function flattenMandateWeights(agentScoring) {
  const out = {};
  for (const cat of Object.values(agentScoring?.categories ?? {})) {
    for (const [id, spec] of Object.entries(cat?.metrics ?? {})) {
      out[id] = { points: spec.points ?? null, higherIsBetter: spec.higherIsBetter ?? true };
    }
  }
  return out;
}

/** Safely read a nested value; returns undefined on any null/missing step. */
function dig(obj, ...keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Given the verdict label and whether the mandate expects higher-is-better,
 * derive a suggested direction for the mandate weight:
 *   positive + higherIsBetter     → "more"   (data confirms the metric's direction)
 *   negative + !higherIsBetter    → "more"   (lower raw value went with better returns, consistent)
 *   positive + !higherIsBetter    → "review_direction"  (data contradicts expected direction)
 *   negative + higherIsBetter     → "review_direction"  (data contradicts expected direction)
 */
function suggestedDirection(verdictLabel, higherIsBetter) {
  if (verdictLabel === "positive") return higherIsBetter ? "more" : "review_direction";
  if (verdictLabel === "negative") return higherIsBetter ? "review_direction" : "more";
  return null;
}

/**
 * Summarize a metric's evidence across horizons.
 * A horizon contributes only when it has a clear verdict (positive/negative)
 * AND q-value ≤ FDR_THRESHOLD.
 */
function buildMetricEvidence(metricBlocks) {
  // metricBlocks: array of { horizonDays, block } where block is one entry from horizon.metrics[]
  return metricBlocks.map(({ horizonDays, block }) => ({
    horizonDays,
    verdict: dig(block, "verdict", "label") ?? "unavailable",
    n: dig(block, "coverage", "present") ?? null,
    clusters: block?.clusters ?? null,
    spearman: {
      rho: dig(block, "spearman", "rho") ?? null,
      ci95: dig(block, "spearman", "ci95") ?? null,
    },
    excessReturnPerSd: {
      estimate: dig(block, "excessReturnPerSd", "estimate") ?? null,
      ci95: dig(block, "excessReturnPerSd", "ci95") ?? null,
      qValue: dig(block, "excessReturnPerSd", "qValue") ?? null,
    },
  }));
}

function convictionSummary(horizons) {
  const blocks = horizons.map((h) => ({ horizonDays: h.horizonDays, conviction: h.conviction }));
  const significantHorizons = blocks.filter((b) => {
    const verdict = dig(b, "conviction", "verdict", "label");
    return verdict === "positive" || verdict === "negative";
  });
  const overallLabel = significantHorizons.length >= MIN_HORIZONS_FOR_RECOMMENDED
    ? significantHorizons[0]?.conviction?.verdict?.label
    : significantHorizons.length === 1
      ? significantHorizons[0]?.conviction?.verdict?.label
      : "inconclusive";
  const confidenceLabel = significantHorizons.length >= MIN_HORIZONS_FOR_RECOMMENDED
    ? "recommended"
    : significantHorizons.length === 1
      ? "watch"
      : "no_change";
  return {
    overallVerdict: overallLabel ?? "inconclusive",
    confidenceLabel,
    horizons: blocks.map(({ horizonDays, conviction }) => ({
      horizonDays,
      verdict: dig(conviction, "verdict", "label") ?? "unavailable",
      n: conviction?.n ?? null,
      clusters: conviction?.clusters ?? null,
      spearman: {
        rho: dig(conviction, "spearman", "rho") ?? null,
        ci95: dig(conviction, "spearman", "ci95") ?? null,
      },
      excessReturnPerPoint: {
        estimate: dig(conviction, "excessReturnPerPoint", "estimate") ?? null,
        ci95: dig(conviction, "excessReturnPerPoint", "ci95") ?? null,
        pValue: dig(conviction, "excessReturnPerPoint", "pValue") ?? null,
      },
    })),
  };
}

/**
 * Generate a Mandate Review from a Pitch Lab report and the agent's scoring config.
 *
 * @param {object} report     Return value of analyzePitchLab(); must have schemaVersion "pitch-lab.report.v2".
 * @param {object} agentScoring  The agent's entry from config/scoring/mandate-v2.js AGENT_SCORING
 *                               (e.g. AGENT_SCORING["agent-1"]). Passed as a parameter so this
 *                               module never imports the config file.
 * @param {{ now?: Date, agentId?: string }} options
 * @returns {object} MandateReview
 */
export function generateMandateReview(report, agentScoring, { now = new Date(), agentId = "agent-1" } = {}) {
  if (!report || typeof report !== "object") throw new TypeError("generateMandateReview: report must be an object");
  if (report.schemaVersion !== REQUIRED_REPORT_SCHEMA) {
    throw new TypeError(`generateMandateReview: expected report schemaVersion "${REQUIRED_REPORT_SCHEMA}", got "${report.schemaVersion}"`);
  }

  const generatedAt = new Date(now).toISOString();
  const weights = flattenMandateWeights(agentScoring);

  // Find the "all" period — the basis for the review.
  const allPeriod = Array.isArray(report.periods)
    ? report.periods.find((p) => p?.id === "all")
    : null;

  const horizons = allPeriod?.horizons ?? [];

  // Data gate: use the first horizon's conviction stats since all horizons share the same
  // pitch population (outcomes differ by horizon but pitches do not).
  const firstHorizon = horizons[0];
  const totalGraded = isFiniteNum(firstHorizon?.graded) ? firstHorizon.graded : 0;
  const totalClusters = isFiniteNum(firstHorizon?.conviction?.clusters) ? firstHorizon.conviction.clusters : 0;
  const minSample = report.options?.minSample ?? 30;
  const minClusters = report.options?.minClusters ?? 8;

  if (totalGraded < minSample || totalClusters < minClusters) {
    const morePitches = Math.max(0, minSample - totalGraded);
    const moreWeeks = Math.max(0, minClusters - totalClusters);
    return {
      schemaVersion: MANDATE_REVIEW_SCHEMA_VERSION,
      generatedAt,
      agentId,
      status: "insufficient_data",
      insufficientData: {
        gradedPitches: totalGraded,
        independentWeeks: totalClusters,
        moreNeeded: { pitches: morePitches, weeks: moreWeeks },
        peerCoverageGaps: buildCoverageGaps(report.dataCoverage),
      },
      conviction: null,
      metrics: [],
      caveats: [...CAVEATS],
    };
  }

  // Build per-metric assessments across all horizons.
  // We look at every metric id present in the "all" period, plus every mandate metric.
  const seenMetricIds = new Set();
  for (const h of horizons) {
    for (const m of h.metrics ?? []) {
      if (m?.id) seenMetricIds.add(m.id);
    }
  }
  // Always include all mandate metric ids so weights show even when data is missing.
  for (const id of Object.keys(weights)) seenMetricIds.add(id);

  const metricReviews = [...seenMetricIds].map((metricId) => {
    const mandateWeight = weights[metricId] ?? null;
    // Collect this metric's block from each horizon.
    const metricBlocks = horizons
      .map((h) => {
        const block = (h.metrics ?? []).find((m) => m?.id === metricId);
        return block ? { horizonDays: h.horizonDays, block } : null;
      })
      .filter(Boolean);

    if (!metricBlocks.length) {
      return {
        metricId,
        label: null,
        currentPoints: mandateWeight?.points ?? null,
        higherIsBetter: mandateWeight?.higherIsBetter ?? null,
        confidenceLabel: "unavailable",
        suggestedDirection: null,
        evidence: { horizons: [] },
      };
    }

    // Count horizons with a significant finding (clear verdict + q ≤ FDR).
    const significantHorizons = metricBlocks.filter(({ block }) => {
      const verdict = dig(block, "verdict", "label");
      const q = dig(block, "excessReturnPerSd", "qValue");
      return (verdict === "positive" || verdict === "negative") && isFiniteNum(q) && q <= FDR_THRESHOLD;
    });

    let confidenceLabel = "no_change";
    let direction = null;
    if (significantHorizons.length >= MIN_HORIZONS_FOR_RECOMMENDED) {
      confidenceLabel = "recommended";
      const firstVerdict = dig(significantHorizons[0], "block", "verdict", "label");
      direction = suggestedDirection(firstVerdict, mandateWeight?.higherIsBetter ?? true);
    } else if (significantHorizons.length === 1) {
      confidenceLabel = "watch";
      const firstVerdict = dig(significantHorizons[0], "block", "verdict", "label");
      direction = suggestedDirection(firstVerdict, mandateWeight?.higherIsBetter ?? true);
    }

    const label = metricBlocks[0]?.block?.label ?? null;
    return {
      metricId,
      label,
      currentPoints: mandateWeight?.points ?? null,
      higherIsBetter: mandateWeight?.higherIsBetter ?? null,
      confidenceLabel,
      suggestedDirection: direction,
      evidence: { horizons: buildMetricEvidence(metricBlocks) },
    };
  });

  const hasSuggestions = metricReviews.some((m) => m.confidenceLabel === "recommended" || m.confidenceLabel === "watch");

  return {
    schemaVersion: MANDATE_REVIEW_SCHEMA_VERSION,
    generatedAt,
    agentId,
    status: hasSuggestions ? "has_suggestions" : "no_suggestions",
    gradedPitches: totalGraded,
    independentWeeks: totalClusters,
    conviction: convictionSummary(horizons),
    metrics: metricReviews,
    dataCoverage: report.dataCoverage ?? null,
    caveats: [...CAVEATS],
  };
}

/** Build peer coverage gap list from the report's dataCoverage block. */
function buildCoverageGaps(dataCoverage) {
  if (!dataCoverage || typeof dataCoverage !== "object") return [];
  const gaps = [];
  for (const [metricId, statusCounts] of Object.entries(dataCoverage.peerRankStatus ?? {})) {
    const ranked = statusCounts?.ranked ?? 0;
    const total = (dataCoverage?.pitches ?? 0);
    if (total > 0 && ranked / total < 0.5) {
      gaps.push({ metricId, rankedShare: statusCounts.rankedShare });
    }
  }
  return gaps;
}
