/**
 * Pitch Lab peer ranks — where each mandate metric sits among the company's
 * industry peers at pitch time.
 *
 * Pure. No I/O: the peer table (`pm:peer-metrics`, ticker → peerMetricsRow) is
 * passed IN by lib/pitch-lab-peer-bridge.js, so Pitch Lab itself still imports
 * no database. The ranking maths is the main pipeline's own (resolvePeerSet's
 * industry → sector widening, percentileRank, the same metric directions), not a
 * second implementation.
 *
 * Percentile convention: the fraction of peers the company BEATS on that metric,
 * in [0,1], where "beats" respects direction (a lower forward P/E is better).
 * 0.9 therefore always means "better than 90% of peers".
 *
 * Rules:
 *   - Peer data stamped after the pitch time is ignored (no look-ahead), as are
 *     legacy rows without a full-instant retrieval timestamp.
 *   - A rank is only recorded when there are at least `minPeers` peers WITH a
 *     value for that metric; otherwise the status says why and percentile is null.
 *   - Nothing is filled in or guessed. Only the nine mandate fundamentals are
 *     ranked: peer rows carry no price or market-cap fields.
 */
import { AGENT_SCORING, METRIC_IDS } from "../../config/scoring/mandate-v2.js";
import { PEER_RELATIVE_MIN, distributionFromPeers, resolvePeerSet } from "../peer-resolve.js";
import { COVERAGE_CORE_METRICS } from "../peer-coverage.js";
import { percentileRank } from "../peer-scoring.js";

export const PEER_RANK_VERSION = "pitch-lab.peer-rank.v1";

export const PEER_RANK_STATUSES = Object.freeze([
  "ranked", // enough peers with a value; percentile recorded
  "thin_peers", // fewer than minPeers peers have this metric; percentile left null
  "no_peers", // no usable peers for this company at all
  "missing_value", // the company's own value is missing, so there is nothing to rank
  "peer_data_unavailable", // the peer table could not be read (distinct from "no peers")
]);
export const PEER_LEVELS = Object.freeze(["industry", "sector", "none"]);
export const PEER_MODES = Object.freeze(["peer_relative", "blended_50_50", "absolute"]);
export const PEER_SET_REASONS = Object.freeze(["peer_data_unavailable", "no_classification", "no_peers_in_cohort"]);

/** Direction per metric, from Agent One's own scoring spec (peerValuation: lower is better). */
const HIGHER_IS_BETTER = Object.freeze(
  Object.fromEntries(
    Object.values(AGENT_SCORING["agent-1"].categories).flatMap((category) =>
      Object.entries(category.metrics).map(([id, spec]) => [id, spec.higherIsBetter !== false]),
    ),
  ),
);

const round4 = (value) => Math.round(value * 10_000) / 10_000;
const isInstant = (value) => typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));

function usablePeerRows(peerMetrics, asOfMs) {
  const rows = [];
  let excluded = 0;
  for (const [ticker, row] of Object.entries(peerMetrics ?? {})) {
    const stamp = row?.retrievedAt ?? row?.ts;
    if (!isInstant(stamp) || Date.parse(stamp) > asOfMs) {
      excluded += 1;
      continue;
    }
    rows.push({ ticker, industry: row.industry ?? null, sector: row.sector ?? null, metrics: row.metrics ?? {}, retrievedAt: stamp });
  }
  return { rows, excluded };
}

const emptyRanks = (status, features = null) =>
  Object.fromEntries(
    METRIC_IDS.map((id) => [id, { status: features && features[id]?.value == null ? "missing_value" : status, percentile: null, peerCount: 0 }]),
  );

/**
 * @param {object} args
 * @param {string} args.ticker
 * @param {{[id]: {value:number|null}}} args.features  buildFeatures output (the company's own values)
 * @param {object|null} args.peerMetrics  the peer table, ticker → peerMetricsRow; null/empty = unreadable
 * @param {string} args.asOf  ISO pitch time — peer rows retrieved after it are ignored
 * @param {string|null} [args.industry]  defaults to the company's own row in the peer table
 * @param {string|null} [args.sector]
 * @param {number} [args.minPeers]
 * @returns {object} the `peers` block stored on the pitch (validated by pitch.js)
 */
export function computePeerRanks({ ticker, features = {}, peerMetrics = null, asOf, industry = null, sector = null, minPeers = PEER_RELATIVE_MIN } = {}) {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) throw new TypeError("computePeerRanks requires an ISO asOf timestamp");
  const symbol = String(ticker ?? "").trim().toUpperCase();

  const base = {
    version: PEER_RANK_VERSION,
    industry: industry ?? null,
    sector: sector ?? null,
    level: "none",
    key: null,
    peerCount: 0,
    mode: "absolute",
    peerDataAsOf: null,
    excludedPeers: 0,
    reason: null,
  };

  if (!peerMetrics || typeof peerMetrics !== "object" || !Object.keys(peerMetrics).length) {
    return { ...base, reason: "peer_data_unavailable", ranks: emptyRanks("peer_data_unavailable", features) };
  }

  const { rows, excluded } = usablePeerRows(peerMetrics, asOfMs);
  const own = peerMetrics[symbol];
  const candidate = { ticker: symbol, industry: industry ?? own?.industry ?? null, sector: sector ?? own?.sector ?? null };
  const classified = { ...base, industry: candidate.industry, sector: candidate.sector, excludedPeers: excluded };

  if (!candidate.industry && !candidate.sector) {
    return { ...classified, reason: "no_classification", ranks: emptyRanks("no_peers", features) };
  }

  const resolved = resolvePeerSet(candidate, rows, { coreMetrics: COVERAGE_CORE_METRICS, minPeers });
  const peerStamps = resolved.peers.map((peer) => peer.retrievedAt).sort();
  const block = {
    ...classified,
    level: resolved.level,
    key: resolved.key,
    peerCount: resolved.peerCount,
    mode: resolved.mode,
    peerDataAsOf: peerStamps.at(-1) ?? null,
    reason: resolved.peerCount === 0 ? "no_peers_in_cohort" : null,
  };

  const ranks = {};
  for (const id of METRIC_IDS) {
    const value = features[id]?.value ?? null;
    const peerValues = distributionFromPeers(resolved.peers, id);
    if (value == null) ranks[id] = { status: "missing_value", percentile: null, peerCount: peerValues.length };
    else if (resolved.peerCount === 0) ranks[id] = { status: "no_peers", percentile: null, peerCount: 0 };
    else if (peerValues.length < minPeers) ranks[id] = { status: "thin_peers", percentile: null, peerCount: peerValues.length };
    else {
      // percentileRank treats one equal value in the list as the candidate itself, so append it.
      const percentile = percentileRank(value, [...peerValues, value], HIGHER_IS_BETTER[id]);
      ranks[id] = percentile == null
        ? { status: "thin_peers", percentile: null, peerCount: peerValues.length }
        : { status: "ranked", percentile: round4(percentile), peerCount: peerValues.length };
    }
  }
  return { ...block, ranks };
}

/** Statuses that mean "more peer coverage would let this metric be ranked". */
export const COVERAGE_GAP_STATUSES = Object.freeze(["thin_peers", "no_peers"]);

export function hasCoverageGap(peers) {
  return Object.values(peers?.ranks ?? {}).some((rank) => COVERAGE_GAP_STATUSES.includes(rank.status));
}

/** The peer-rank "metrics" the analysis tests: one per ranked mandate fundamental. */
export const PEER_RANK_METRIC_IDS = METRIC_IDS;
