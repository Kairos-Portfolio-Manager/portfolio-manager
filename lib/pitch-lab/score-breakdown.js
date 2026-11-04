/**
 * Pitch Lab Mandate Score — the mandate's own points table applied to one pitch,
 * shown on a 10-point scale with every point traceable to its source.
 *
 * Pure and deterministic: the inputs are the pitch's stored industry-peer ranks
 * and the agent's category weights (config/scoring/mandate-v2.js AGENT_SCORING).
 * No model is involved; the model never sees this score (it stays an independent
 * check on the model's own conviction).
 *
 *   metric → peer percentile → mandate band (lib/peer-scoring.js BANDS) → points
 *
 * The mandate's 100 points are divided by 10, so Agent One's categories are worth
 * A 2.5 · B 3.0 · C 3.0 · D 1.5. Missing is never zero (mandate §9 vendor-lag rule):
 * the headline `score` is points earned ÷ points that could be scored, × 10, and
 * `scorable` / `metricsScored` always travel with it so a 9/10 on two metrics
 * cannot pass for a 9/10 on nine. A metric that is not `ranked` is unscored and
 * says why; nothing is filled in.
 */
import { AGENT_SCORING, METRIC_IDS } from "../../config/scoring/mandate-v2.js";
import { contentHash } from "../research-version.js";
import { bandFraction } from "../peer-scoring.js";

export const SCORE_VERSION = "pitch-lab.score.v1";
export const SCORE_SCALE = 10;
const MANDATE_POINTS = 100;
const TO_SCALE = SCORE_SCALE / MANDATE_POINTS;

/** Mandate band → plain-language label, keyed by the band's point fraction. */
export const BAND_LABELS = Object.freeze({
  1: "top 10%",
  0.75: "top 25%",
  0.5: "top third",
  0.25: "above median",
  0: "bottom half",
});

const round = (value, places) => Number(value.toFixed(places));
const points = (value) => round(value, 3);

/** Identifies the exact weights a breakdown was computed with. */
export function weightsFingerprint(agentScoring) {
  return contentHash(agentScoring?.categories ?? null).slice(0, 12);
}

/**
 * @param {object} args
 * @param {object|null} args.peers  the pitch's `peers` block (peer-rank.js computePeerRanks output)
 * @param {string} [args.agentId]
 * @param {object} [args.agentScoring]  defaults to AGENT_SCORING[agentId]
 * @returns {object} the breakdown; `status: "unavailable"` with `score: null` when nothing could be scored
 */
export function computeScoreBreakdown({ peers = null, agentId = "agent-1", agentScoring = AGENT_SCORING[agentId] } = {}) {
  if (!agentScoring?.categories) throw new TypeError(`computeScoreBreakdown: no scoring config for ${agentId}`);
  const ranks = peers?.ranks ?? {};
  const categories = [];
  const metrics = [];
  let earned = 0;
  let scorable = 0;

  for (const [categoryId, category] of Object.entries(agentScoring.categories)) {
    const row = { id: categoryId, label: category.label, max: points(category.maxPoints * TO_SCALE), earned: 0, scorable: 0 };
    for (const [metricId, spec] of Object.entries(category.metrics)) {
      if (!METRIC_IDS.includes(metricId)) throw new TypeError(`computeScoreBreakdown: unknown mandate metric ${metricId}`);
      const maxPoints = points(spec.points * TO_SCALE);
      const rank = ranks[metricId];
      const status = peers ? rank?.status ?? "not_recorded" : "no_peer_data";
      const fraction = status === "ranked" ? bandFraction(rank.percentile) : null;
      if (fraction == null) {
        metrics.push({ id: metricId, category: categoryId, status, percentile: null, peerCount: rank?.peerCount ?? 0, band: null, points: null, maxPoints });
        continue;
      }
      const earnedPoints = points(fraction * maxPoints);
      metrics.push({ id: metricId, category: categoryId, status, percentile: rank.percentile, peerCount: rank.peerCount, band: BAND_LABELS[fraction], points: earnedPoints, maxPoints });
      row.earned += earnedPoints;
      row.scorable += maxPoints;
    }
    row.earned = points(row.earned);
    row.scorable = points(row.scorable);
    earned += row.earned;
    scorable += row.scorable;
    categories.push(row);
  }

  earned = points(earned);
  scorable = points(scorable);
  const metricsScored = metrics.filter((m) => m.points != null).length;
  return {
    version: SCORE_VERSION,
    scale: SCORE_SCALE,
    agentId,
    weights: weightsFingerprint(agentScoring),
    status: metricsScored ? "scored" : "unavailable",
    score: metricsScored ? round((earned / scorable) * SCORE_SCALE, 1) : null,
    earned,
    scorable,
    metricsScored,
    metricsTotal: metrics.length,
    categories,
    metrics,
  };
}

/**
 * The breakdown for any stored pitch: the one recorded on it at pitch time, or —
 * for pitches recorded before breakdowns existed — one derived now from the same
 * stored peer ranks and marked `source: "derived"`.
 */
export function scoreBreakdownFor(pitch) {
  if (pitch?.scoreBreakdown) return { ...pitch.scoreBreakdown, source: "at_pitch" };
  return { ...computeScoreBreakdown({ peers: pitch?.peers ?? null, agentId: pitch?.agentId || "agent-1" }), source: "derived" };
}
