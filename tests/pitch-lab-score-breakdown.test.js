import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AGENT_SCORING, METRIC_IDS } from "../config/scoring/mandate-v2.js";
import { BAND_LABELS, SCORE_SCALE, SCORE_VERSION, computeScoreBreakdown, scoreBreakdownFor } from "../lib/pitch-lab/score-breakdown.js";
import {
  CONVICTION_MAX, CONVICTION_RUBRIC, CONVICTION_SCALE, LEGACY_CONVICTION_SCALE, PITCH_SCHEMA_VERSION, PitchValidationError, buildPitch, convictionScaleOf,
} from "../lib/pitch-lab/pitch.js";
import { PITCH_PROMPT_VERSION, PITCH_RESPONSE_SCHEMA, buildPitchPrompt } from "../lib/pitch-lab/pitch-prompt.js";
import { PEER_RANK_VERSION } from "../lib/pitch-lab/peer-rank.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { isMandateReviewDay, nextMandateReviewAt, nextWeeklyReportAt } from "../lib/pitch-lab/schedule.js";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !~ ${b}`);

const rank = (status, percentile = null, peerCount = 12) => ({ status, percentile, peerCount: status === "ranked" || status === "thin_peers" ? peerCount : 0 });

/** Five metrics ranked (one per band), three with no value, one with too few peers. */
function peersFixture() {
  return {
    version: PEER_RANK_VERSION,
    industry: "Software—Infrastructure",
    sector: "Technology",
    level: "industry",
    key: "software-infrastructure",
    peerCount: 12,
    mode: "peer_relative",
    peerDataAsOf: "2026-09-20T00:00:00.000Z",
    excludedPeers: 0,
    reason: null,
    ranks: {
      revBeat: rank("missing_value"),
      revGrowth: rank("ranked", 0.92), // top 10% → full 1.5
      epsTrajectory: rank("ranked", 0.8), // top 25% → 0.75 × 1.8 = 1.35
      estimateRevisions: rank("missing_value"),
      marginTrend: rank("ranked", 0.7), // top third → 0.5 × 1.2 = 0.6
      peerValuation: rank("ranked", 0.55), // above median → 0.25 × 0.8 = 0.2
      balanceSheet: rank("ranked", 0.3), // bottom half → 0 of 1.0
      instOwnershipDir: rank("missing_value"),
      thirteenF: rank("thin_peers", null, 3),
    },
  };
}

function pitchInput(overrides = {}) {
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
    peers: peersFixture(),
    provenance: { source: "manual" },
    ...overrides,
  };
}

// --- the score itself ------------------------------------------------------

test("agent-1 categories are the mandate's 100 points divided by 10", () => {
  const b = computeScoreBreakdown({ peers: peersFixture() });
  assert.deepEqual(b.categories.map((c) => [c.id, c.max]), [["A", 2.5], ["B", 3], ["C", 3], ["D", 1.5]]);
  close(b.categories.reduce((sum, c) => sum + c.max, 0), SCORE_SCALE);
  close(b.metrics.reduce((sum, m) => sum + m.maxPoints, 0), SCORE_SCALE);
  assert.equal(b.metrics.length, METRIC_IDS.length);
});

test("every point traces to a percentile and a mandate band; missing is unscored, not zero", () => {
  const b = computeScoreBreakdown({ peers: peersFixture() });
  const byId = Object.fromEntries(b.metrics.map((m) => [m.id, m]));
  assert.deepEqual([byId.revGrowth.band, byId.revGrowth.points, byId.revGrowth.maxPoints], ["top 10%", 1.5, 1.5]);
  assert.deepEqual([byId.epsTrajectory.band, byId.epsTrajectory.points], ["top 25%", 1.35]);
  assert.deepEqual([byId.marginTrend.band, byId.marginTrend.points], ["top third", 0.6]);
  assert.deepEqual([byId.peerValuation.band, byId.peerValuation.points], ["above median", 0.2]);
  assert.deepEqual([byId.balanceSheet.band, byId.balanceSheet.points], ["bottom half", 0]);
  for (const id of ["revBeat", "estimateRevisions", "instOwnershipDir", "thirteenF"]) {
    assert.equal(byId[id].points, null, `${id} must be unscored`);
    assert.equal(byId[id].band, null);
  }
  assert.equal(byId.thirteenF.status, "thin_peers");

  close(b.earned, 3.65);
  close(b.scorable, 6.3);
  assert.equal(b.score, 5.8); // 3.65 / 6.3 × 10, rescaled over what could be scored
  assert.equal(b.metricsScored, 5);
  assert.equal(b.status, "scored");
  assert.equal(b.version, SCORE_VERSION);
  const cats = Object.fromEntries(b.categories.map((c) => [c.id, c]));
  assert.deepEqual([cats.A.earned, cats.A.scorable], [1.5, 1.5]);
  assert.deepEqual([cats.B.earned, cats.B.scorable], [1.35, 1.8]);
  assert.deepEqual([cats.C.earned, cats.C.scorable], [0.8, 3]);
  assert.deepEqual([cats.D.earned, cats.D.scorable], [0, 0]);
  close(b.categories.reduce((sum, c) => sum + c.earned, 0), b.earned);
});

test("no ranked metric (or no peer data) is unavailable with a null score, never 0/10", () => {
  const none = computeScoreBreakdown({ peers: null });
  assert.equal(none.status, "unavailable");
  assert.equal(none.score, null);
  assert.ok(none.metrics.every((m) => m.status === "no_peer_data" && m.points == null));

  const peers = peersFixture();
  for (const id of METRIC_IDS) peers.ranks[id] = rank("thin_peers", null, 2);
  const thin = computeScoreBreakdown({ peers });
  assert.equal(thin.score, null);
  assert.equal(thin.scorable, 0);
});

test("the breakdown records which weights it used", () => {
  const a = computeScoreBreakdown({ peers: peersFixture() });
  const altered = structuredClone(AGENT_SCORING["agent-1"]);
  altered.categories.A.metrics.revGrowth.points = 14;
  const b = computeScoreBreakdown({ peers: peersFixture(), agentScoring: altered });
  assert.notEqual(a.weights, b.weights);
  assert.deepEqual(Object.values(BAND_LABELS).length, 5);
});

// --- stored on the pitch ---------------------------------------------------

test("a new pitch is 1-10 conviction and carries its Mandate Score breakdown", () => {
  const pitch = buildPitch(pitchInput());
  assert.equal(pitch.schemaVersion, PITCH_SCHEMA_VERSION);
  assert.equal(pitch.convictionScale, CONVICTION_SCALE);
  assert.equal(CONVICTION_MAX, 10);
  assert.equal(Object.keys(CONVICTION_RUBRIC).length, 10);
  assert.deepEqual(pitch.scoreBreakdown, computeScoreBreakdown({ peers: pitch.peers }));
  assert.equal(pitch.scoreBreakdown.score, 5.8);
  // Re-validating a stored pitch (what the stores do) keeps it identical.
  assert.equal(buildPitch(pitch).id, pitch.id);
  assert.equal(buildPitch(JSON.parse(JSON.stringify(pitch))).id, pitch.id);
});

test("conviction outside 1-10, a foreign scale, or a doctored breakdown is rejected", () => {
  assert.throws(() => buildPitch(pitchInput({ conviction: 11 })), PitchValidationError);
  assert.throws(() => buildPitch(pitchInput({ conviction: 0 })), PitchValidationError);
  assert.doesNotThrow(() => buildPitch(pitchInput({ conviction: 10 })));
  assert.throws(() => buildPitch(pitchInput({ convictionScale: 5 })), /convictionScale must be 10/);
  const pitch = buildPitch(pitchInput());
  const doctored = { ...JSON.parse(JSON.stringify(pitch)), scoreBreakdown: { ...pitch.scoreBreakdown, score: 9.9 } };
  assert.throws(() => buildPitch(doctored), /scoreBreakdown does not match/);
});

test("a pitch without peer data still gets an explicit unavailable breakdown", () => {
  const pitch = buildPitch(pitchInput({ peers: null }));
  assert.equal(pitch.scoreBreakdown.status, "unavailable");
  assert.equal(pitch.scoreBreakdown.score, null);
});

test("older 1-5 pitches keep their scale and get a derived breakdown from their stored ranks", () => {
  const legacy = { ...JSON.parse(JSON.stringify(buildPitch(pitchInput()))), schemaVersion: "pitch-lab.pitch.v2", conviction: 4 };
  delete legacy.convictionScale;
  delete legacy.scoreBreakdown;
  assert.equal(convictionScaleOf(legacy), LEGACY_CONVICTION_SCALE);
  const derived = scoreBreakdownFor(legacy);
  assert.equal(derived.source, "derived");
  assert.equal(derived.score, 5.8);
  assert.equal(scoreBreakdownFor(buildPitch(pitchInput())).source, "at_pitch");
});

test("the prompt asks for 1-10 and never shows the model its Mandate Score", () => {
  assert.equal(PITCH_PROMPT_VERSION, "pitch-lab.prompt.v4");
  assert.equal(PITCH_RESPONSE_SCHEMA.properties.conviction.maximum, 10);
  const prompt = buildPitchPrompt({ ticker: "NET", features: {}, entryReference: { price: 1, asOf: "2026-09-21T13:59:00Z" }, peers: peersFixture() });
  assert.match(prompt, /from 1 to 10/);
  assert.match(prompt, /^10 = Exceptional/m);
  assert.doesNotMatch(prompt, /mandate score/i);
  const source = readFileSync(new URL("../lib/pitch-lab/pitch-prompt.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /score-breakdown/, "the prompt must stay independent of the Mandate Score");
});

// --- analysis keeps scales apart -------------------------------------------

test("analysis keeps 1-10 and legacy 1-5 conviction apart and tests the Mandate Score", () => {
  const current = buildPitch(pitchInput({ conviction: 9 }));
  const legacy = { ...JSON.parse(JSON.stringify(buildPitch(pitchInput({ ticker: "DDOG", conviction: 4 })))), schemaVersion: "pitch-lab.pitch.v2" };
  delete legacy.convictionScale;
  delete legacy.scoreBreakdown;
  const outcome = (pitch, excessReturn) => ({ pitchId: pitch.id, horizonDays: 5, status: "matured", entryDate: "2026-09-21", excessReturn, benchmark: "SPY", costPerSide: 0.001 });
  const report = analyzePitchLab({ pitches: [current, legacy], outcomes: [outcome(current, 0.02), outcome(legacy, -0.01)], now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(report.schemaVersion, "pitch-lab.report.v3");
  const h = report.periods.find((p) => p.id === "all").horizons[0];
  assert.equal(h.graded, 2);
  assert.equal(h.clusters, 1);
  assert.equal(h.conviction.scale, 10);
  assert.equal(h.conviction.n, 1);
  assert.equal(h.conviction.buckets.length, 10);
  assert.equal(h.conviction.buckets[8].n, 1); // the 9/10
  assert.equal(h.convictionLegacy.scale, 5);
  assert.equal(h.convictionLegacy.n, 1);
  assert.equal(h.convictionLegacy.buckets[3].n, 1); // the 4/5, never shown as 8/10
  assert.equal(h.mandateScore.id, "mandateScore");
  assert.equal(h.mandateScore.coverage.present, 2);
  assert.equal(report.legacyConvictionRubric[5].startsWith("Very high"), true);
});

// --- review calendar ---------------------------------------------------------

test("next review dates follow the scheduler's own first-Saturday rule, in ET across DST", () => {
  const wed = new Date("2026-11-04T15:00:00Z");
  assert.equal(nextMandateReviewAt(wed), "2026-11-07T16:00:00.000Z"); // 11:00 EST
  assert.equal(nextWeeklyReportAt(wed), "2026-11-07T15:00:00.000Z"); // 10:00 EST
  const afterReview = new Date("2026-11-07T16:30:00Z");
  assert.equal(nextMandateReviewAt(afterReview), "2026-12-05T16:00:00.000Z");
  assert.equal(nextWeeklyReportAt(afterReview), "2026-11-14T15:00:00.000Z");
  assert.equal(nextMandateReviewAt(new Date("2026-10-01T12:00:00Z")), "2026-10-03T15:00:00.000Z"); // 11:00 EDT
  assert.equal(nextMandateReviewAt(new Date("2026-11-07T15:59:00Z")), "2026-11-07T16:00:00.000Z");

  assert.equal(isMandateReviewDay(new Date("2026-11-07T16:00:00Z")), true);
  assert.equal(isMandateReviewDay(new Date("2026-11-14T16:00:00Z")), false); // second Saturday
  assert.equal(isMandateReviewDay(new Date("2026-11-07T03:00:00Z")), false); // still Friday in New York
  const scheduler = readFileSync(new URL("../pitch-lab-scheduler.js", import.meta.url), "utf8");
  assert.match(scheduler, /isMandateReviewDay\(/, "the scheduler must use the same rule the website shows");
});
