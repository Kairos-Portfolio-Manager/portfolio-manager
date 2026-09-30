// Pure adapter from the current Agent 1 peer-metric cache into the immutable
// point-in-time research-record contract. It intentionally has no Redis,
// Postgres, proposal, ledger, broker, or execution dependencies.

import { ABSOLUTE_RULE_TABLES, SPECIAL_SECTOR_RULE_TABLES } from "../config/scoring/absolute-thresholds.js";
import { AGENT_SCORING, ABSOLUTE_VALUATION_TABLES, METRIC_IDS } from "../config/scoring/mandate-v2.js";
import { MandateScoreObservationSchema } from "../contracts/research-observation.js";
import { contentHash, mandateMetadataFor, observationId, peerSetId, scoringConfigVersion as versionForScoring } from "./research-version.js";
import { screenUniverse } from "./screener.js";
import { toScreenerCandidates } from "./universe.js";
import { isThesisCritical, resolveConsensusFreshness, resolveQuoteFreshness } from "./freshness-policy.js";

// Which decided policy (if any) resolves freshness for a metric's source
// family. Metrics absent from this map keep their existing
// missingFreshnessState / "policy_unresolved" behavior untouched — there is
// no freshness rule for them yet (four EDGAR-companyfacts metrics, and 13F's
// own freshness separate from its now-decided non-critical status).
const FRESHNESS_RESOLVER_BY_METRIC = Object.freeze({
  revBeat: "consensus",
  estimateRevisions: "consensus",
  peerValuation: "quote",
});

const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/;
const PLACEHOLDER_REVISIONS = new Set(["unknown", "unset", "none", "null", "placeholder", "development", "dev", "local", "main", "master", "head"]);

export const RESEARCH_CODE_REVISION_ENV_KEYS = Object.freeze([
  "RESEARCH_CODE_REVISION",
  "GIT_COMMIT",
  "VERCEL_GIT_COMMIT_SHA",
]);

const AGENT_ONE_UNIVERSE_LIMIT_KEYS = Object.freeze([
  "allowedSubVerticals",
  "microCapMinAvgDollarVolume",
]);

const METRIC_PROVENANCE = Object.freeze({
  balanceSheet: {
    unit: "multiple",
    source: "sec_edgar_companyfacts",
    missingReason: "q001_balance_sheet_definition_unresolved",
    missingFreshnessState: "policy_unresolved",
    pendingCalculationMethod: "policy_pending_q001_balance_sheet_definition",
  },
  epsTrajectory: {
    unit: "decimal_ratio",
    source: "sec_edgar_companyfacts",
    missingReason: "edgar_eps_history_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "edgar_eps_yoy_acceleration",
  },
  estimateRevisions: {
    unit: "percentage_points",
    source: "consensus_snapshot_store",
    missingReason: "consensus_revision_history_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "consensus_revision_history_pending",
  },
  instOwnershipDir: {
    unit: "percentage_points",
    source: "sec_edgar_13f",
    missingReason: "edgar_13f_ownership_history_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "edgar_13f_ownership_direction_pending",
  },
  marginTrend: {
    unit: "decimal_ratio",
    source: "sec_edgar_companyfacts",
    missingReason: "edgar_margin_history_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "edgar_gross_margin_yoy_change",
  },
  peerValuation: {
    unit: "multiple",
    source: "yahoo_quote_summary",
    missingReason: "valuation_quote_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "peer_valuation_percentile",
  },
  revBeat: {
    unit: "percentage_points",
    source: "consensus_snapshot_store",
    missingReason: "consensus_revenue_beat_snapshot_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "revenue_beat_vs_consensus_pending",
  },
  revGrowth: {
    unit: "decimal_ratio",
    source: "sec_edgar_companyfacts",
    missingReason: "edgar_revenue_history_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "edgar_revenue_yoy_acceleration",
  },
  thirteenF: {
    unit: "percentage_points",
    source: "sec_edgar_13f",
    missingReason: "edgar_13f_accumulation_history_unavailable",
    missingFreshnessState: "unavailable",
    pendingCalculationMethod: "edgar_13f_accumulation_pending",
  },
});

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function sortUnique(values) {
  return [...new Set(values)].sort();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validRevision(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || PLACEHOLDER_REVISIONS.has(normalized.toLowerCase())) return null;
  return normalized;
}

function scoringMethod(metric) {
  switch (metric?.fallbackMethod) {
    case "peer_relative": return "peer_percentile_band";
    case "blended_50_50": return "peer_percentile_absolute_blend";
    case "absolute": return "agent_one_absolute_threshold";
    default: return "not_scored";
  }
}

function isCovered(metric) {
  return metric.points !== null && metric.value !== null && !["unavailable", "unsupported"].includes(metric.freshnessState);
}

function asFullIso(value) {
  const normalized = String(value ?? "").trim();
  return ISO_WITH_OFFSET_RE.test(normalized) && !Number.isNaN(Date.parse(normalized)) ? normalized : null;
}

function requirePointInTimeRetrieval(retrievedAt, observedAt, label) {
  if (!retrievedAt) throw new TypeError(`legacy_${label}_retrieval_time_unavailable`);
  if (Date.parse(retrievedAt) > Date.parse(observedAt)) {
    throw new TypeError(`future_${label}_retrieval_time`);
  }
  return retrievedAt;
}

function limitedUniverseSettings(limits) {
  return Object.fromEntries(
    AGENT_ONE_UNIVERSE_LIMIT_KEYS
      .filter((key) => limits?.[key] !== undefined)
      .map((key) => [key, limits[key]]),
  );
}

function sourceSummary(metrics) {
  return {
    metrics: metrics.map((metric) => ({
      metricId: metric.metricId,
      source: metric.source,
      sourceDocumentId: metric.sourceDocumentId,
      sourceFiledAt: metric.sourceFiledAt,
      sourceAsOf: metric.sourceAsOf,
      retrievedAt: metric.retrievedAt,
    })),
  };
}

function freshnessSummary(metrics) {
  return {
    metrics: metrics.map((metric) => ({ metricId: metric.metricId, freshnessState: metric.freshnessState })),
  };
}

/**
 * Resolve only an explicit deployment code revision. Branch names, mtimes,
 * timestamps, and unmarked placeholders are intentionally never considered.
 */
export function resolveResearchCodeRevision({ codeRevision, env = process.env } = {}) {
  const injected = validRevision(codeRevision);
  if (injected) return injected;
  for (const key of RESEARCH_CODE_REVISION_ENV_KEYS) {
    const revision = validRevision(env?.[key]);
    if (revision) return revision;
  }
  return null;
}

/** True only for an exact retrieval instant, never a legacy YYYY-MM-DD row. */
export function peerMetricRetrievedAt(row) {
  return asFullIso(row?.retrievedAt);
}

export function agentOneScoringConfigVersion() {
  return versionForScoring({
    semanticVersion: "mandate-v3-scoring-1",
    scoringTables: {
      AGENT_SCORING,
      ABSOLUTE_RULE_TABLES,
      SPECIAL_SECTOR_RULE_TABLES,
      ABSOLUTE_VALUATION_TABLES,
    },
  });
}

/**
 * Build a deterministic full-catalog universe snapshot, applying only Agent 1's
 * active production screen. Catalog membership remains visible even when a name
 * has no peer-metric row or cannot yet be scored.
 */
export function buildAgentOneUniverseSnapshot({
  catalog = {},
  peerMetrics = {},
  observedAt,
  sourceRevision,
  limits = {},
} = {}) {
  const normalizedCatalog = asObject(catalog);
  const candidateByTicker = new Map(
    toScreenerCandidates(normalizedCatalog).map((candidate) => [String(candidate.ticker).toUpperCase(), candidate]),
  );
  const screened = screenUniverse([...candidateByTicker.values()], limitedUniverseSettings(limits));
  const passed = new Map(screened.passed.map((candidate) => [String(candidate.ticker).toUpperCase(), candidate]));
  const rejected = new Map(screened.rejected.map((candidate) => [String(candidate.ticker).toUpperCase(), candidate]));
  const membership = Object.keys(normalizedCatalog)
    .map((ticker) => String(ticker).trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .map((ticker) => {
      const candidate = candidateByTicker.get(ticker);
      const eligible = passed.has(ticker);
      const row = peerMetrics?.[ticker];
      const scoringExclusionReasonCodes = [];
      if (!eligible) {
        const rejectedRow = rejected.get(ticker);
        scoringExclusionReasonCodes.push(rejectedRow?.reasonCode ?? "classification_unavailable");
      } else if (!row) {
        scoringExclusionReasonCodes.push("peer_metrics_not_cached");
      } else if (!peerMetricRetrievedAt(row)) {
        scoringExclusionReasonCodes.push("legacy_peer_metric_retrieval_time_unavailable");
      }
      return {
        ticker,
        eligible,
        eligibilityReasonCodes: eligible
          ? []
          : [rejected.get(ticker)?.reasonCode ?? (candidate ? "production_universe_rejected" : "classification_unavailable")],
        scoringEligible: scoringExclusionReasonCodes.length === 0,
        scoringExclusionReasonCodes: sortUnique(scoringExclusionReasonCodes),
      };
    });
  const snapshotPayload = {
    observedAt: asFullIso(observedAt),
    sourceRevision: String(sourceRevision ?? "").trim(),
    catalogCount: membership.length,
    eligibleCount: membership.filter((item) => item.eligible).length,
    membership,
  };
  if (!snapshotPayload.observedAt) throw new TypeError("observedAt must be a zoned ISO timestamp");
  if (!snapshotPayload.sourceRevision) throw new TypeError("sourceRevision must be a non-empty code revision");
  const fingerprint = contentHash(snapshotPayload);
  const eligibleCandidates = membership
    .filter((item) => item.scoringEligible)
    .map((item) => {
      const candidate = passed.get(item.ticker);
      const row = peerMetrics[item.ticker];
      return {
        ...candidate,
        ticker: item.ticker,
        metrics: asObject(row?.metrics),
        derived: row?.derived ?? null,
        retrievedAt: peerMetricRetrievedAt(row),
        src: String(row?.src ?? "peer_metrics_cache").trim() || "peer_metrics_cache",
      };
    });
  return {
    snapshot: { id: `universe:${fingerprint}`, ...snapshotPayload, contentHash: fingerprint },
    eligibleCandidates,
  };
}

/**
 * Resolve freshnessState for a covered metric using the decided Q-002/Q-003
 * policy when one applies to this metric's source family, else fall back to
 * the previous, unchanged "policy_unresolved". `metricProvenance` is an
 * optional per-metric bundle: `{ retrievedAt, quoteTimestamp, now,
 * inRegularSession, eventInvalidated, nextSessionOpenAfterEvent }`.
 *
 * When no provenance object is supplied at all for a resolvable metric, this
 * returns "policy_unresolved" rather than "unavailable" — the metric is
 * genuinely covered (it has a scored value), we just haven't been given the
 * timestamp needed to judge its freshness in this call. Once a caller threads
 * real per-metric provenance through, "unavailable" becomes possible and
 * means the timestamp itself was missing/invalid, which is a different,
 * correct signal from "no data was given to resolve this yet".
 */
function resolveCoveredFreshness(metricId, metricProvenance) {
  const resolver = FRESHNESS_RESOLVER_BY_METRIC[metricId];
  if (!resolver || !metricProvenance) return "policy_unresolved";
  const p = metricProvenance;
  if (resolver === "consensus") {
    return resolveConsensusFreshness({
      retrievedAt: p.retrievedAt,
      now: p.now,
      nextSessionOpenAfterEvent: p.nextSessionOpenAfterEvent ?? null,
    });
  }
  return resolveQuoteFreshness({
    quoteTimestamp: p.quoteTimestamp,
    now: p.now,
    inRegularSession: Boolean(p.inRegularSession),
    eventInvalidated: Boolean(p.eventInvalidated),
  });
}

function metricObservation({ metricId, scoreMetric, metricVector, retrievedAt, metricProvenance }) {
  const provenance = METRIC_PROVENANCE[metricId];
  const value = metricVector?.[metricId] ?? null;
  const covered = scoreMetric?.points !== null && scoreMetric?.points !== undefined && value !== null;
  const thesisCritical = isThesisCritical(metricId);
  if (!covered) {
    return {
      metricId,
      value: null,
      unit: provenance.unit,
      points: null,
      maxPoints: Number(scoreMetric?.maxPoints ?? 0),
      source: provenance.source,
      sourceDocumentId: null,
      sourceFiledAt: null,
      sourceAsOf: null,
      retrievedAt,
      freshnessState: provenance.missingFreshnessState,
      peerCount: Number(scoreMetric?.peerCount ?? 0),
      calculationMethod: provenance.pendingCalculationMethod,
      thesisCritical,
      missingReason: provenance.missingReason,
    };
  }
  return {
    metricId,
    value,
    unit: provenance.unit,
    points: round2(scoreMetric.points),
    maxPoints: Number(scoreMetric.maxPoints),
    source: provenance.source,
    // The current cache carries no accepted-filing accession/timestamp and no
    // quote timestamp. Do not promote a date-only as-of field into either one.
    sourceDocumentId: null,
    sourceFiledAt: null,
    sourceAsOf: null,
    retrievedAt,
    freshnessState: resolveCoveredFreshness(metricId, metricProvenance),
    peerCount: Number(scoreMetric.peerCount ?? 0),
    calculationMethod: scoringMethod(scoreMetric),
    thesisCritical,
    missingReason: null,
  };
}

/**
 * Produce one immutable evidence snapshot and its schema-valid, research-only
 * Agent 1 observation. The caller assigns scoreCause after loading a prior
 * durable observation and running classifyScoreDelta.
 */
export function buildAgentOneObservation({
  runId,
  observedAt,
  codeRevision,
  universeSnapshot,
  candidate,
  resolvedPeerSet,
  inputs,
  scoreResult,
  scoringConfig = agentOneScoringConfigVersion(),
  metricProvenance = {},
} = {}) {
  const normalizedObservedAt = asFullIso(observedAt);
  if (!normalizedObservedAt) throw new TypeError("observedAt must be a zoned ISO timestamp");
  const retrievedAt = requirePointInTimeRetrieval(
    peerMetricRetrievedAt(candidate),
    normalizedObservedAt,
    "candidate",
  );
  const metadata = mandateMetadataFor("agent-1");
  const metrics = [...METRIC_IDS]
    .sort()
    .map((metricId) => metricObservation({
      metricId,
      scoreMetric: scoreResult?.perMetric?.[metricId],
      metricVector: inputs?.metricVector,
      retrievedAt,
      metricProvenance: metricProvenance?.[metricId],
    }));
  const coverageMask = metrics.filter(isCovered).map((metric) => metric.metricId);
  const missingMetrics = metrics.filter((metric) => !isCovered(metric)).map((metric) => metric.metricId);
  const criticalMissingMetrics = metrics
    .filter((metric) => metric.thesisCritical && (!isCovered(metric) || metric.freshnessState !== "fresh"))
    .map((metric) => metric.metricId);
  const rawPoints = round2(metrics.reduce((total, metric) => total + (metric.points ?? 0), 0));
  const maxAvailablePoints = round2(metrics.filter(isCovered).reduce((total, metric) => total + metric.maxPoints, 0));
  const uncappedScore = maxAvailablePoints > 0 ? round2((rawPoints / maxAvailablePoints) * 100) : 0;
  const peerLevel = ["industry", "sector", "none"].includes(resolvedPeerSet?.level) ? resolvedPeerSet.level : "none";
  const resolvedPeers = Array.isArray(resolvedPeerSet?.peers) ? resolvedPeerSet.peers : [];
  const peerTickers = resolvedPeers.map((peer) => String(peer?.ticker ?? "").trim().toUpperCase());
  if (peerTickers.some((ticker) => !ticker)) throw new TypeError("resolved_peer_ticker_missing");
  const canonicalPeerTickers = sortUnique(peerTickers);
  if (canonicalPeerTickers.length !== peerTickers.length) throw new TypeError("resolved_peer_membership_duplicate");
  const declaredPeerCount = Number(resolvedPeerSet?.peerCount);
  if (!Number.isInteger(declaredPeerCount) || declaredPeerCount < 0) throw new TypeError("resolved_peer_count_invalid");
  if (declaredPeerCount !== canonicalPeerTickers.length) throw new TypeError("resolved_peer_count_mismatch");
  const peerId = peerSetId({
    level: peerLevel,
    key: resolvedPeerSet?.key ?? "absolute",
    tickers: canonicalPeerTickers,
    asOf: retrievedAt,
  });
  const peerEvidence = resolvedPeers
    .map((peer) => ({
      ticker: String(peer.ticker).toUpperCase(),
      metrics: asObject(peer.metrics),
      derived: peer.derived ?? null,
      source: peer.src ?? "peer_metrics_cache",
      retrievedAt: requirePointInTimeRetrieval(
        peerMetricRetrievedAt(peer),
        normalizedObservedAt,
        "peer",
      ),
    }))
    .sort((left, right) => left.ticker.localeCompare(right.ticker));
  const evidencePayload = {
    candidate: {
      ticker: String(candidate?.ticker ?? "").toUpperCase(),
      industry: candidate?.industry ?? null,
      sector: candidate?.sector ?? null,
      subVertical: candidate?.subVertical ?? null,
      marketCap: candidate?.marketCap ?? null,
      avgDollarVolume: candidate?.avgDollarVolume ?? null,
      metrics: asObject(candidate?.metrics),
      derived: candidate?.derived ?? null,
      source: candidate?.src ?? "peer_metrics_cache",
      retrievedAt,
    },
    peerSet: {
      id: peerId,
      level: peerLevel,
      key: resolvedPeerSet?.key ?? "absolute",
      peerCount: Number(resolvedPeerSet?.peerCount ?? 0),
      peers: peerEvidence,
    },
    scoringInputs: {
      metricVector: asObject(inputs?.metricVector),
      absoluteEvidence: asObject(inputs?.absoluteEvidence),
      valuationEvidence: inputs?.valuationEvidence ?? null,
      boundMetrics: sortUnique(inputs?.boundMetrics ?? []),
    },
  };
  const sources = sourceSummary(metrics);
  const freshness = freshnessSummary(metrics);
  const evidenceFingerprint = contentHash({
    ticker: String(candidate?.ticker ?? "").toUpperCase(),
    observedAt: normalizedObservedAt,
    payload: evidencePayload,
    sourceSummary: sources,
    freshnessSummary: freshness,
  });
  const evidenceSnapshot = {
    id: `evidence:${evidenceFingerprint}`,
    ticker: String(candidate?.ticker ?? "").toUpperCase(),
    observedAt: normalizedObservedAt,
    payload: evidencePayload,
    sourceSummary: sources,
    freshnessSummary: freshness,
    contentHash: evidenceFingerprint,
  };
  const fallbackMethod = maxAvailablePoints === 0 ? "none" : scoreResult?.fallbackMethod;
  const observation = {
    id: observationId({ runId, agentId: "agent-1", ticker: candidate?.ticker }),
    runId: String(runId ?? "").trim(),
    observedAt: normalizedObservedAt,
    agentId: "agent-1",
    mandateId: metadata.mandateId,
    mandateVersion: metadata.mandateVersion,
    mandateUniverseVersion: metadata.targetUniversePolicyVersion,
    productionUniversePolicyVersion: metadata.productionUniversePolicyVersion,
    scoringConfigVersion: String(scoringConfig ?? "").trim(),
    codeRevision: String(codeRevision ?? "").trim(),
    ticker: String(candidate?.ticker ?? "").trim().toUpperCase(),
    universeSnapshotId: universeSnapshot?.id,
    eligible: true,
    eligibilityReasonCodes: [],
    score: maxAvailablePoints === 0 ? 0 : Number(scoreResult?.total ?? 0),
    uncappedScore,
    rawPoints,
    maxAvailablePoints,
    complete: missingMetrics.length === 0 && criticalMissingMetrics.length === 0 && maxAvailablePoints === 100,
    // This adapter is intentionally research-only: unresolved critical
    // freshness and open Q-001/Q-002/Q-003/Q-004 policy cannot become action.
    actionable: false,
    coverageMask,
    missingMetrics,
    criticalMissingMetrics,
    fallbackMethod,
    thinPeerSet: maxAvailablePoints === 0 ? true : Boolean(scoreResult?.thinPeerSet),
    peerSetId: peerId,
    peerSetLevel: peerLevel,
    peerCount: Number(resolvedPeerSet?.peerCount ?? 0),
    specialSectorKey: null,
    scoreCause: "initial",
    inputSnapshotId: evidenceSnapshot.id,
    metrics,
  };
  return { evidenceSnapshot, observation: MandateScoreObservationSchema.parse(observation) };
}
