/**
 * Pitch Lab full Mandate Score — the live mandate scorer (lib/mandate-score.js
 * scoreMandateCandidate, 0-100) applied to one pitch from inputs frozen on the pitch.
 *
 * Pure and deterministic. The pitch stores `mandateInputs` (the metric vector, EDGAR
 * `derived` bundle, optional consensus bundle, and the industry-peer distributions at
 * pitch time); this module turns them into `mandateScore`. buildPitch recomputes it
 * and rejects a supplied block that does not match, exactly as for scoreBreakdown.
 * The model never sees the result.
 *
 * Replaces the peer-only /10 breakdown for NEW pitches (score-breakdown.js stays for
 * records that carry it; the two are never mixed in the analysis).
 */
import { METRIC_IDS } from "../../config/scoring/mandate-v2.js";
import { assembleMandateInputs } from "../mandate-evidence.js";
import { scoreMandateCandidate } from "../mandate-score.js";

export const MANDATE_SCORE_VERSION = "pitch-lab.mandate-score.v1";
export const MANDATE_INPUTS_VERSION = "pitch-lab.mandate-inputs.v1";

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const plain = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/**
 * Normalize the caller-supplied inputs into the frozen, JSON-safe block stored on the
 * pitch. Pushes human-readable problems instead of throwing.
 * @returns {object|null}
 */
export function normalizeMandateInputs(raw, pitchedAtMs, problems) {
  if (raw == null) return null;
  if (!plain(raw)) {
    problems.push("mandateInputs must be an object or null");
    return null;
  }
  const metrics = {};
  if (!plain(raw.metrics)) problems.push("mandateInputs.metrics is required");
  else {
    for (const id of Object.keys(raw.metrics)) {
      if (!METRIC_IDS.includes(id)) problems.push(`mandateInputs.metrics has unknown metric "${id}"`);
      else metrics[id] = finite(raw.metrics[id]);
    }
  }
  if (raw.derived != null && !plain(raw.derived)) problems.push("mandateInputs.derived must be an object or null");

  const peerDistributions = {};
  if (!plain(raw.peerDistributions)) problems.push("mandateInputs.peerDistributions is required");
  else {
    for (const [id, values] of Object.entries(raw.peerDistributions)) {
      if (!METRIC_IDS.includes(id)) problems.push(`mandateInputs.peerDistributions has unknown metric "${id}"`);
      else if (!Array.isArray(values) || values.some((v) => finite(v) == null)) problems.push(`mandateInputs.peerDistributions.${id} must be an array of finite numbers`);
      else peerDistributions[id] = [...values];
    }
  }

  // Look-ahead: every consensus observation must predate the pitch.
  const consensus = raw.consensus ?? null;
  if (consensus != null) {
    if (!plain(consensus)) problems.push("mandateInputs.consensus must be an object or null");
    else {
      const observations = [consensus.snapshot, ...(Array.isArray(consensus.history) ? consensus.history : [])].filter(Boolean);
      for (const row of observations) {
        const at = Date.parse(row?.retrievedAt ?? "");
        if (!Number.isFinite(at)) problems.push("mandateInputs.consensus rows need an ISO retrievedAt");
        else if (Number.isFinite(pitchedAtMs) && at > pitchedAtMs) problems.push("mandateInputs.consensus has a row retrieved after pitchedAt (look-ahead)");
      }
    }
  }

  const peerSetUsed = raw.peerSetUsed ?? null;
  if (peerSetUsed != null && !plain(peerSetUsed)) problems.push("mandateInputs.peerSetUsed must be an object or null");

  return {
    version: MANDATE_INPUTS_VERSION,
    metrics,
    derived: raw.derived ?? null,
    consensus,
    peerDistributions,
    peerSetUsed,
  };
}

/** Compact, stable view of scoreMandateCandidate's result (what is stored on the pitch). */
function compact(result) {
  return {
    version: MANDATE_SCORE_VERSION,
    status: "scored",
    total: result.total,
    uncappedTotal: result.uncappedTotal,
    rawPoints: result.rawPoints,
    maxAvailable: result.maxAvailable,
    complete: result.complete,
    actionable: result.actionable,
    noTradeReason: result.noTradeReason,
    scoringBasis: result.scoringBasis,
    thinPeerSet: result.thinPeerSet,
    fallbackMethod: result.fallbackMethod,
    peerCount: result.peerCount,
    missingMetrics: result.missingMetrics,
    categories: result.categories,
    perMetric: Object.fromEntries(
      Object.entries(result.perMetric).map(([id, m]) => [id, {
        points: m.points,
        maxPoints: m.maxPoints,
        peerCount: m.peerCount,
        fallbackMethod: m.fallbackMethod,
        percentile: m.peer?.percentile ?? null,
        absoluteSource: m.absolute?.source ?? null,
        missing: m.missing,
      }]),
    ),
  };
}

/**
 * @param {object} args
 * @param {string} args.agentId
 * @param {object} args.inputs  normalized mandateInputs (see normalizeMandateInputs)
 * @returns {object} `status: "scored"` block, or `status: "unsupported"` with `total: null`
 */
export function computeMandateScore({ agentId = "agent-1", inputs } = {}) {
  const assembled = assembleMandateInputs({
    agentId,
    metrics: inputs?.metrics ?? {},
    derived: inputs?.derived ?? null,
    sector: null,
    consensus: inputs?.consensus ?? null,
  });
  if (!assembled.supported) {
    return { version: MANDATE_SCORE_VERSION, status: "unsupported", total: null, reason: assembled.unsupportedReason };
  }
  const result = scoreMandateCandidate({
    agentId,
    metricVector: assembled.metricVector,
    peerDistributions: inputs.peerDistributions ?? {},
    absoluteEvidence: assembled.absoluteEvidence,
    valuationEvidence: assembled.valuationEvidence,
    sector: null,
    peerSetUsed: inputs.peerSetUsed ?? null,
  });
  return compact(result);
}

/** The 0-100 total for any stored pitch, or null when it has none (older pitches). */
export function mandateTotalFor(pitch) {
  const block = pitch?.mandateScore;
  return block?.status === "scored" && Number.isFinite(block.total) ? block.total : null;
}
