import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { MandateScoreObservationSchema } from "../contracts/research-observation.js";
import {
  agentOneScoringConfigVersion,
  buildAgentOneObservation,
  buildAgentOneUniverseSnapshot,
  resolveResearchCodeRevision,
} from "../lib/mandate-observation.js";
import { peerSetId } from "../lib/research-version.js";

const OBSERVED_AT = "2026-07-13T20:00:00.000Z";
const EARLIER = "2026-07-13T19:00:00.000Z";
const LATER = "2026-07-13T21:00:00.000Z";

const METRIC_MAX_POINTS = {
  revBeat: 10,
  revGrowth: 15,
  epsTrajectory: 18,
  estimateRevisions: 12,
  marginTrend: 12,
  peerValuation: 8,
  balanceSheet: 10,
  instOwnershipDir: 9,
  thirteenF: 6,
};

function candidate(overrides = {}) {
  return {
    ticker: "AAA",
    industry: "Software - Application",
    sector: "Technology",
    subVertical: "Software/SaaS",
    marketCap: 2_000_000_000,
    avgDollarVolume: 15_000_000,
    retrievedAt: EARLIER,
    src: "edgar+yfinance",
    metrics: {
      revGrowth: 0.22,
      epsTrajectory: 0.25,
      marginTrend: 0.025,
      peerValuation: 14,
    },
    derived: {
      revYoY: 0.22,
      revAccel: 0.06,
      epsYoY: 0.25,
      epsAccel: 0.04,
      grossMarginTrendYoY: 0.025,
      _asOf: "2026-03-31",
    },
    ...overrides,
  };
}

function peer(overrides = {}) {
  return {
    ticker: "BBB",
    retrievedAt: EARLIER,
    src: "edgar+yfinance",
    metrics: { revGrowth: 0.15, epsTrajectory: 0.1, marginTrend: 0.01, peerValuation: 20 },
    derived: { revYoY: 0.15 },
    ...overrides,
  };
}

function recordArgs(overrides = {}) {
  const vector = {
    revBeat: null,
    revGrowth: 0.22,
    epsTrajectory: 0.25,
    estimateRevisions: null,
    marginTrend: 0.025,
    peerValuation: 14,
    balanceSheet: null,
    instOwnershipDir: null,
    thirteenF: null,
  };
  const perMetric = Object.fromEntries(Object.entries(METRIC_MAX_POINTS).map(([metricId, maxPoints]) => [metricId, {
    points: vector[metricId] == null ? null : maxPoints,
    maxPoints,
    peerCount: 1,
    fallbackMethod: "absolute",
  }]));
  return {
    runId: "shared-run-1",
    observedAt: OBSERVED_AT,
    codeRevision: "9d44eaf1d31a4bda8ece57ccadbd5eea",
    universeSnapshot: { id: "universe:fixture" },
    candidate: candidate(),
    resolvedPeerSet: { level: "none", key: "absolute", peerCount: 1, peers: [peer()] },
    inputs: {
      metricVector: vector,
      absoluteEvidence: {
        revGrowth: { currentGrowthPct: 22, accelerationPoints: 6 },
        epsTrajectory: { epsGrowthPct: 25, accelerationPoints: 4 },
        marginTrend: { marginChangeBps: 250, documentedInvestmentExplanation: false },
      },
      valuationEvidence: { value: 14 },
      boundMetrics: ["epsTrajectory", "marginTrend", "peerValuation", "revGrowth"],
    },
    scoreResult: {
      total: 84,
      fallbackMethod: "absolute",
      thinPeerSet: true,
      perMetric,
    },
    ...overrides,
  };
}

test("production-universe snapshot preserves every catalog member and stable exclusion reasons", () => {
  const catalog = {
    AAA: { t: "AAA", n: "Alpha", ea: "2026-07-13", v: "Software/SaaS", s: "Technology", i: "Software - Application", mc: 2e9, advd: 15e6 },
    KO: { t: "KO", n: "Consumer", ea: "2026-07-13", v: "Retail", s: "Consumer Defensive", i: "Beverages", mc: 2e9, advd: 15e6 },
    LEG: { t: "LEG", n: "Legacy", ea: "2026-07-13", v: "Software/SaaS", s: "Technology", i: "Software - Application", mc: 2e9, advd: 15e6 },
  };
  const { snapshot, eligibleCandidates } = buildAgentOneUniverseSnapshot({
    catalog,
    peerMetrics: {
      AAA: { metrics: candidate().metrics, retrievedAt: EARLIER, src: "edgar+yfinance" },
      LEG: { metrics: candidate().metrics, ts: "2026-07-13", src: "edgar+yfinance" },
    },
    observedAt: OBSERVED_AT,
    sourceRevision: "9d44eaf1d31a4bda8ece57ccadbd5eea",
    limits: { allowedSubVerticals: ["Software/SaaS"], microCapMinAvgDollarVolume: 3_000_000 },
  });
  assert.deepEqual(snapshot.membership.map((item) => item.ticker), ["AAA", "KO", "LEG"]);
  assert.equal(snapshot.catalogCount, 3);
  assert.equal(snapshot.eligibleCount, 2);
  assert.deepEqual(snapshot.membership.find((item) => item.ticker === "KO").eligibilityReasonCodes, ["outside_approved_subvertical"]);
  assert.deepEqual(snapshot.membership.find((item) => item.ticker === "LEG").scoringExclusionReasonCodes, ["legacy_peer_metric_retrieval_time_unavailable"]);
  assert.deepEqual(eligibleCandidates.map((item) => item.ticker), ["AAA"]);
  assert.match(snapshot.id, /^universe:[0-9a-f]{64}$/);
  assert.match(snapshot.contentHash, /^[0-9a-f]{64}$/);
});

test("Agent 1 adapter emits a schema-valid partial observation with canonical identities and unresolved provenance", () => {
  const { observation, evidenceSnapshot } = buildAgentOneObservation(recordArgs());
  assert.doesNotThrow(() => MandateScoreObservationSchema.parse(observation));
  assert.equal(observation.runId, "shared-run-1");
  assert.equal(observation.mandateId, "agent_one");
  assert.equal(observation.mandateVersion, "3.0");
  assert.equal(observation.mandateUniverseVersion, "eligible-us-operating-common-equities-v3");
  assert.equal(observation.productionUniversePolicyVersion, "agent-1-sector-agnostic-velocity-catalog-v1");
  assert.equal(observation.scoringConfigVersion, agentOneScoringConfigVersion());
  assert.equal(observation.peerSetId, peerSetId({ level: "none", key: "absolute", tickers: ["BBB"], asOf: EARLIER }));
  assert.match(observation.id, /^[0-9a-f]{64}$/);
  assert.match(evidenceSnapshot.id, /^evidence:[0-9a-f]{64}$/);
  assert.equal(evidenceSnapshot.observedAt, OBSERVED_AT);
  assert.equal(observation.maxAvailablePoints, 53);
  assert.equal(observation.complete, false);
  assert.equal(observation.actionable, false);

  const byId = Object.fromEntries(observation.metrics.map((metric) => [metric.metricId, metric]));
  assert.equal(byId.revGrowth.unit, "decimal_ratio");
  assert.equal(byId.revGrowth.source, "sec_edgar_companyfacts");
  assert.equal(byId.revGrowth.sourceFiledAt, null);
  assert.equal(byId.revGrowth.freshnessState, "policy_unresolved");
  assert.equal(byId.peerValuation.unit, "multiple");
  assert.equal(byId.peerValuation.freshnessState, "policy_unresolved");
  assert.equal(byId.balanceSheet.points, null);
  assert.equal(byId.balanceSheet.freshnessState, "policy_unresolved");
  assert.equal(byId.balanceSheet.missingReason, "q001_balance_sheet_definition_unresolved");
  assert.equal(byId.estimateRevisions.freshnessState, "unavailable");
  assert.equal(byId.thirteenF.freshnessState, "unavailable");
  assert.ok(observation.criticalMissingMetrics.includes("peerValuation"));
  // Q-004: 13F/institutional-ownership metrics are accepted policy as "required
  // for full coverage but never blocking" — a missing/non-fresh 13F metric must
  // not veto actionability the way it did before thesisCritical was per-metric.
  assert.equal(byId.instOwnershipDir.thesisCritical, false);
  assert.equal(byId.thirteenF.thesisCritical, false);
  assert.ok(!observation.criticalMissingMetrics.includes("instOwnershipDir"));
  assert.ok(!observation.criticalMissingMetrics.includes("thirteenF"));
});

test("Q-002/Q-003: real per-metric provenance resolves freshnessState instead of staying policy_unresolved", () => {
  const { observation } = buildAgentOneObservation(recordArgs({
    metricProvenance: {
      peerValuation: { quoteTimestamp: "2026-07-13T19:58:00.000Z", now: OBSERVED_AT, inRegularSession: true },
    },
  }));
  const byId = Object.fromEntries(observation.metrics.map((metric) => [metric.metricId, metric]));
  assert.equal(byId.peerValuation.freshnessState, "fresh");
  // Fresh + thesis-critical + covered means peerValuation no longer blocks actionability on its own.
  assert.ok(!observation.criticalMissingMetrics.includes("peerValuation"));
  // A metric with no resolver policy (revGrowth) is unaffected by unrelated provenance.
  assert.equal(byId.revGrowth.freshnessState, "policy_unresolved");
});

test("Q-002/Q-003: stale provenance is reported honestly, not upgraded to fresh", () => {
  const { observation } = buildAgentOneObservation(recordArgs({
    metricProvenance: {
      peerValuation: { quoteTimestamp: "2026-07-13T19:00:00.000Z", now: OBSERVED_AT, inRegularSession: true }, // 60 min old, over the 5-min Q-003 limit
    },
  }));
  const byId = Object.fromEntries(observation.metrics.map((metric) => [metric.metricId, metric]));
  assert.equal(byId.peerValuation.freshnessState, "stale");
  assert.ok(observation.criticalMissingMetrics.includes("peerValuation"));
});

test("adapter fails closed for invalid point-in-time retrieval timestamps", () => {
  assert.throws(
    () => buildAgentOneObservation(recordArgs({ candidate: candidate({ retrievedAt: LATER }) })),
    /future_candidate_retrieval_time/,
  );
  assert.throws(
    () => buildAgentOneObservation(recordArgs({ resolvedPeerSet: { level: "none", key: "absolute", peerCount: 1, peers: [peer({ retrievedAt: undefined, ts: "2026-07-13" })] } })),
    /legacy_peer_retrieval_time_unavailable/,
  );
  assert.throws(
    () => buildAgentOneObservation(recordArgs({ resolvedPeerSet: { level: "none", key: "absolute", peerCount: 1, peers: [peer({ retrievedAt: LATER })] } })),
    /future_peer_retrieval_time/,
  );
  assert.throws(() => buildAgentOneObservation(recordArgs({ observedAt: "2026-07-13" })), /observedAt must be a zoned ISO timestamp/);
});

test("adapter rejects duplicate or self-contradictory resolved peer memberships", () => {
  assert.throws(
    () => buildAgentOneObservation(recordArgs({ resolvedPeerSet: { level: "none", key: "absolute", peerCount: 0, peers: [peer()] } })),
    /resolved_peer_count_mismatch/,
  );
  assert.throws(
    () => buildAgentOneObservation(recordArgs({ resolvedPeerSet: { level: "none", key: "absolute", peerCount: 2, peers: [peer(), peer()] } })),
    /resolved_peer_membership_duplicate/,
  );
});

test("code revision must be explicitly injected or sourced from a deployment-revision environment field", () => {
  assert.equal(resolveResearchCodeRevision({ env: { GIT_COMMIT: "abc123" } }), "abc123");
  assert.equal(resolveResearchCodeRevision({ codeRevision: "deploy-42", env: { GIT_COMMIT: "other" } }), "deploy-42");
  assert.equal(resolveResearchCodeRevision({ env: { GIT_COMMIT: "main" } }), null);
  assert.equal(resolveResearchCodeRevision({ env: {} }), null);
});

test("observation adapter remains isolated from proposal and money paths", () => {
  const source = readFileSync(new URL("../lib/mandate-observation.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:proposal|ledger|broker|execution)[^"']*["']/);
});
