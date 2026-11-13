import { test } from "node:test";
import assert from "node:assert/strict";

import { assembleMandateInputs } from "../lib/mandate-evidence.js";
import { scoreMandateCandidate } from "../lib/mandate-score.js";
import { MANDATE_SCORE_VERSION, computeMandateScore, mandateTotalFor, normalizeMandateInputs } from "../lib/pitch-lab/mandate-score.js";
import { PITCH_SCHEMA_VERSION, PitchValidationError, buildPitch } from "../lib/pitch-lab/pitch.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { computePeerRanks, computePeerRanksDetailed } from "../lib/pitch-lab/peer-rank.js";
import { consensusForPitch } from "../lib/pitch-lab-peer-bridge.js";

const derived = {
  revYoY: 0.22, revAccel: 0.06, epsYoY: 0.25, epsAccel: 0.04, grossMarginTrendYoY: 0.025,
  interestCoverage: 12, cashRunwayQuarters: 999, ttmOperatingIncome: 5_000_000_000, isProfitable: true,
  ebitda: 6_000_000_000, totalDebt: 1_000_000_000, netCash: true, netDebtEbitda: 0.5, _asOf: "2026-03-31",
};
const metrics = { revGrowth: 0.22, epsTrajectory: 0.25, marginTrend: 0.025, balanceSheet: 12, peerValuation: 14 };
const twelve = (lo, hi) => Array.from({ length: 12 }, (_, i) => lo + ((hi - lo) * i) / 11);
const peerDistributions = {
  revGrowth: twelve(0.02, 0.3), epsTrajectory: twelve(-0.1, 0.4), marginTrend: twelve(-0.03, 0.04),
  balanceSheet: twelve(1, 20), peerValuation: twelve(10, 60),
};
const mandateInputs = (over = {}) => ({ metrics, derived, consensus: null, peerDistributions, peerSetUsed: { level: "industry", key: "software", mode: "peer_relative", peerCount: 12 }, ...over });

function pitchInput(over = {}) {
  return {
    ticker: "NET",
    pitchedAt: "2026-09-21T14:00:00Z",
    conviction: 7,
    entryReference: { price: 100, asOf: "2026-09-21T13:59:00Z" },
    rationale: {
      thesis: "Revenue growth is re-accelerating while the multiple sits below peers.",
      reasons: [{ claim: "Revenue growth accelerated two quarters running.", features: ["revGrowth"] }],
      risks: ["Guidance could disappoint."],
      killCriteria: [],
    },
    features: { revGrowth: { value: 0.3, asOf: "2026-09-20T00:00:00Z" } },
    provenance: { source: "manual" },
    ...over,
  };
}

test("Pitch Lab's score equals the live scorer on identical inputs (golden)", () => {
  const block = computeMandateScore({ agentId: "agent-1", inputs: normalizeMandateInputs(mandateInputs(), Date.parse("2026-09-21T14:00:00Z"), []) });
  const assembled = assembleMandateInputs({ agentId: "agent-1", metrics, derived, sector: null });
  const live = scoreMandateCandidate({
    agentId: "agent-1",
    metricVector: assembled.metricVector,
    peerDistributions,
    absoluteEvidence: assembled.absoluteEvidence,
    valuationEvidence: assembled.valuationEvidence,
    sector: null,
    peerSetUsed: mandateInputs().peerSetUsed,
  });
  assert.equal(block.version, MANDATE_SCORE_VERSION);
  assert.equal(block.status, "scored");
  assert.equal(block.total, live.total);
  assert.equal(block.uncappedTotal, live.uncappedTotal);
  assert.equal(block.maxAvailable, live.maxAvailable);
  assert.equal(block.actionable, live.actionable);
  assert.deepEqual(block.missingMetrics, live.missingMetrics);
  assert.ok(block.total >= 0 && block.total <= 100);
});

test("buildPitch stores mandateInputs and a derived mandateScore on a v4 record", () => {
  const pitch = buildPitch(pitchInput({ mandateInputs: mandateInputs() }));
  assert.equal(pitch.schemaVersion, PITCH_SCHEMA_VERSION);
  assert.equal(pitch.mandateScore.status, "scored");
  assert.equal(mandateTotalFor(pitch), pitch.mandateScore.total);
  assert.deepEqual(pitch.mandateInputs.peerDistributions.revGrowth, peerDistributions.revGrowth);
  // 4 of 9 metrics are unbound without consensus/13F, so the model-facing coverage is honest
  assert.ok(pitch.mandateScore.missingMetrics.includes("thirteenF"));
});

test("a supplied mandateScore that does not match the inputs is rejected", () => {
  const good = buildPitch(pitchInput({ mandateInputs: mandateInputs() })).mandateScore;
  assert.throws(() => buildPitch(pitchInput({ mandateInputs: mandateInputs(), mandateScore: { ...good, total: 99 } })), PitchValidationError);
  assert.throws(() => buildPitch(pitchInput({ mandateScore: good })), /requires mandateInputs/);
  assert.doesNotThrow(() => buildPitch(pitchInput({ mandateInputs: mandateInputs(), mandateScore: good })));
});

test("a pitch without mandateInputs still builds, with no mandate score", () => {
  const pitch = buildPitch(pitchInput());
  assert.equal(pitch.mandateInputs, null);
  assert.equal(pitch.mandateScore, null);
  assert.equal(mandateTotalFor(pitch), null);
});

test("consensus rows retrieved after the pitch are rejected as look-ahead", () => {
  const late = { snapshot: null, history: [{ retrievedAt: "2026-09-22T00:00:00Z", epsAvg: 1 }], actualRevenue: null };
  assert.throws(() => buildPitch(pitchInput({ mandateInputs: mandateInputs({ consensus: late }) })), /look-ahead/);
});

test("no EDGAR bundle yields an unsupported score with a null total, never zero", () => {
  const pitch = buildPitch(pitchInput({ mandateInputs: mandateInputs({ derived: null }) }));
  assert.equal(pitch.mandateScore.status, "unsupported");
  assert.equal(pitch.mandateScore.total, null);
  assert.equal(mandateTotalFor(pitch), null);
});

test("thin peer sets take the fallback path and are flagged", () => {
  const thin = Object.fromEntries(Object.entries(peerDistributions).map(([id, values]) => [id, values.slice(0, 4)]));
  const pitch = buildPitch(pitchInput({ mandateInputs: mandateInputs({ peerDistributions: thin }) }));
  assert.equal(pitch.mandateScore.thinPeerSet, true);
  assert.notEqual(pitch.mandateScore.fallbackMethod, "peer_relative");
});

test("the analysis tests the 0-100 total as its own family; pitches without one are missing", () => {
  const withScore = buildPitch(pitchInput({ mandateInputs: mandateInputs() }));
  const without = buildPitch(pitchInput({ ticker: "DDOG" }));
  const outcome = (pitch, excessReturn) => ({ pitchId: pitch.id, horizonDays: 5, status: "matured", entryDate: "2026-09-21", excessReturn, benchmark: "SPY", costPerSide: 0.001 });
  const report = analyzePitchLab({
    pitches: [withScore, without],
    outcomes: [outcome(withScore, 0.02), outcome(without, -0.01)],
    now: new Date("2026-10-30T00:00:00Z"),
  });
  const horizon = report.periods[0].horizons[0];
  assert.equal(horizon.mandateTotal.id, "mandateTotal");
  assert.deepEqual(horizon.mandateTotal.coverage, { present: 1, missing: 1 });
  assert.ok(horizon.mandateScore, "the legacy /10 family is still reported");
});

test("computePeerRanks is unchanged and the detailed variant returns the raw distributions", () => {
  const peerMetrics = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`P${i}`, {
    industry: "Software", sector: "Technology", retrievedAt: "2026-09-20T00:00:00.000Z",
    metrics: { revGrowth: 0.05 * i, peerValuation: 10 + i },
  }]));
  const args = { ticker: "NET", features: { revGrowth: { value: 0.3 }, peerValuation: { value: 20 } }, peerMetrics, asOf: "2026-09-21T14:00:00Z", industry: "Software", sector: "Technology" };
  const detailed = computePeerRanksDetailed(args);
  assert.deepEqual(computePeerRanks(args), detailed.peers);
  assert.equal(detailed.distributions.revGrowth.length, 10);
  assert.deepEqual(computePeerRanksDetailed({ ...args, peerMetrics: null }).distributions, {});
});

test("consensusForPitch returns a point-in-time bundle, or null on no history or a failed read", async () => {
  const history = [{ retrievedAt: "2026-09-01T00:00:00Z", epsAvg: 1 }, { retrievedAt: "2026-09-15T00:00:00Z", epsAvg: 1.1 }];
  const seen = [];
  const ok = await consensusForPitch({
    ticker: "net", derived, asOf: "2026-09-21T14:00:00Z",
    readHistories: async (args) => { seen.push(args); return new Map([["NET", history]]); },
  });
  assert.deepEqual(seen[0], { tickers: ["NET"], asOf: "2026-09-21T14:00:00Z" });
  assert.equal(ok.history.length, 2);
  assert.equal(await consensusForPitch({ ticker: "NET", asOf: "2026-09-21T14:00:00Z", readHistories: async () => new Map() }), null);
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await consensusForPitch({ ticker: "NET", asOf: "2026-09-21T14:00:00Z", readHistories: async () => { throw new Error("db down"); } }), null);
  } finally {
    console.error = original;
  }
});
