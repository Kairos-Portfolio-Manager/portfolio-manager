import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  averageRanks, benjaminiHochberg, clusterBootstrapInterval, clusteredSlope, spearman, tCritical, tTwoSidedP,
} from "../lib/pitch-lab/stats.js";
import { FEATURE_IDS, buildFeatures, marketFeaturesFromBars } from "../lib/pitch-lab/features.js";
import { PitchValidationError, buildPitch } from "../lib/pitch-lab/pitch.js";
import { entryIndexFor, gradePitch, normalizeBars } from "../lib/pitch-lab/grading.js";
import { analyzePitchLab, isoWeekKey } from "../lib/pitch-lab/analysis.js";
import { generateDemoData } from "../lib/pitch-lab/demo-data.js";
import { openPitchStore } from "../lib/pitch-lab/store.js";
import { PITCH_RESPONSE_SCHEMA, buildPitchPrompt, pitchFromModelResponse } from "../lib/pitch-lab/pitch-prompt.js";
import { renderReportHtml } from "../lib/pitch-lab/render-html.js";
import { PEER_RANK_VERSION, computePeerRanks, hasCoverageGap } from "../lib/pitch-lab/peer-rank.js";
import { METRIC_IDS } from "../config/scoring/mandate-v2.js";
import { buildDataCoverage } from "../lib/pitch-lab/analysis.js";
import { peerCheck, peersForPitch } from "../lib/pitch-lab-peer-bridge.js";

const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} !~ ${b}`);

function validInput(overrides = {}) {
  return {
    ticker: "NET",
    pitchedAt: "2026-09-21T14:00:00Z", // 10:00 ET, before the close
    conviction: 4,
    entryReference: { price: 100, asOf: "2026-09-21T13:59:00Z" },
    rationale: {
      thesis: "Revenue growth is re-accelerating while the multiple sits below peers.",
      reasons: [{ claim: "Revenue growth accelerated two quarters running.", features: ["revGrowth"] }],
      risks: ["Guidance could disappoint."],
      killCriteria: ["Revenue growth decelerates next quarter."],
    },
    features: { revGrowth: { value: 0.3, asOf: "2026-09-20T00:00:00Z" }, peerValuation: 25 },
    provenance: { source: "manual" },
    ...overrides,
  };
}

// --- stats ---------------------------------------------------------------

test("t distribution matches reference values", () => {
  close(tTwoSidedP(2.228, 10), 0.05, 1e-3);
  close(tTwoSidedP(2.0, 10), 0.0734, 1e-3);
  close(tTwoSidedP(1.96, 100000), 0.05, 1e-3);
  close(tCritical(10), 2.228, 1e-3);
  close(tCritical(30), 2.042, 1e-3);
});

test("spearman handles ties, monotone and inverse series", () => {
  assert.deepEqual(averageRanks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  close(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25]), 1);
  close(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null); // constant input has no correlation
});

test("clustered slope recovers the slope and widens with clustering", () => {
  const xs = [];
  const ys = [];
  const clusters = [];
  for (let g = 0; g < 20; g += 1) {
    const shock = (g % 2 ? 1 : -1) * 0.05;
    for (let i = 1; i <= 5; i += 1) {
      xs.push(i);
      ys.push(0.01 * i + shock + (((g * 7 + i * 3) % 5) - 2) * 0.004);
      clusters.push(`w${g}`);
    }
  }
  const r = clusteredSlope(xs, ys, clusters);
  close(r.slope, 0.01, 1e-3);
  assert.equal(r.clusters, 20);
  assert.equal(r.df, 19);
  assert.ok(r.p < 0.05);
  assert.ok(r.ci95[0] < 0.01 && r.ci95[1] > 0.01);
});

test("cluster bootstrap is deterministic for a seed", () => {
  const xs = Array.from({ length: 60 }, (_, i) => i % 5);
  const ys = xs.map((x, i) => x * 0.01 + ((i * 7) % 11) / 100);
  const cl = xs.map((_, i) => `c${Math.floor(i / 5)}`);
  const a = clusterBootstrapInterval(xs, ys, cl, spearman, { iterations: 200, seed: 3 });
  const b = clusterBootstrapInterval(xs, ys, cl, spearman, { iterations: 200, seed: 3 });
  assert.deepEqual(a, b);
  assert.ok(a.lower < a.upper);
});

test("Benjamini-Hochberg q-values", () => {
  const q = benjaminiHochberg([0.01, 0.04, 0.03, null, 0.5]);
  close(q[0], 0.04);
  close(q[1], 0.0533, 1e-3);
  close(q[2], 0.0533, 1e-3);
  assert.equal(q[3], null);
  close(q[4], 0.5);
});

// --- pitch record --------------------------------------------------------

test("a valid pitch is normalized, frozen, and gets a stable content id", () => {
  const a = buildPitch(validInput());
  const b = buildPitch(validInput());
  assert.equal(a.id, b.id);
  assert.match(a.id, /^pitch_[0-9a-f]{20}$/);
  assert.equal(a.action, "BUY");
  assert.deepEqual(Object.keys(a.features), FEATURE_IDS);
  assert.deepEqual(a.features.revGrowth, { value: 0.3, missing: false, asOf: "2026-09-20T00:00:00Z" });
  assert.deepEqual(a.features.revBeat, { value: null, missing: true, asOf: null });
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.rationale.reasons[0]));
  assert.notEqual(buildPitch(validInput({ conviction: 3 })).id, a.id);
});

test("pitches without a rationale are rejected", () => {
  assert.throws(() => buildPitch(validInput({ rationale: undefined })), PitchValidationError);
  assert.throws(() => buildPitch(validInput({ rationale: { thesis: "too short", reasons: [], risks: [] } })), (error) => {
    assert.ok(error.problems.some((p) => p.includes("thesis")));
    assert.ok(error.problems.some((p) => p.includes("reasons")));
    assert.ok(error.problems.some((p) => p.includes("risks")));
    return true;
  });
});

test("pitch validation fails closed on conviction, action, features and look-ahead", () => {
  for (const conviction of [0, 6, 3.5, "4", null]) {
    assert.throws(() => buildPitch(validInput({ conviction })), PitchValidationError, `conviction ${conviction}`);
  }
  assert.throws(() => buildPitch(validInput({ action: "SELL" })), /action/);
  assert.throws(() => buildPitch(validInput({ features: { madeUpMetric: 1 } })), /unknown feature/);
  assert.throws(() => buildPitch(validInput({ features: { revGrowth: { value: 0.3, asOf: "2026-09-22T00:00:00Z" } } })), /look-ahead/);
  assert.throws(() => buildPitch(validInput({ entryReference: { price: 100, asOf: "2026-09-22T00:00:00Z" } })), /look-ahead/);
  assert.throws(() => buildPitch(validInput({ features: { revGrowth: Number.NaN } })), /finite number/);
  assert.throws(() => buildPitch(validInput({ provenance: {} })), /provenance.source/);
  const cited = validInput();
  cited.rationale.reasons[0].features = ["notAFeature"];
  assert.throws(() => buildPitch(cited), /unknown feature/);
});

// --- features ------------------------------------------------------------

test("market features use only the bars supplied and leave short history missing", () => {
  const bars = Array.from({ length: 70 }, (_, i) => ({ close: 100 + i, volume: 1000 }));
  const f = marketFeaturesFromBars(bars);
  close(f.momentum1m, 169 / 148 - 1);
  close(f.momentum3m, 169 / 106 - 1);
  assert.equal(f.priceVs200dma, null);
  close(f.relativeVolume, 1);
  const all = buildFeatures({ bars, marketCap: 5e9, asOf: "2026-09-21T14:00:00Z" });
  assert.deepEqual(Object.keys(all), FEATURE_IDS);
  close(all.logMarketCap.value, Math.log10(5e9));
  assert.equal(all.revBeat.value, null);
});

// --- grading -------------------------------------------------------------

const sessions = ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"];

test("entry is the first close after the pitch", () => {
  const bars = normalizeBars(sessions.map((date) => ({ date, close: 1 })));
  assert.equal(bars[entryIndexFor("2026-09-21T14:00:00Z", bars)].date, "2026-09-21"); // 10:00 ET → same-day close
  assert.equal(bars[entryIndexFor("2026-09-21T20:30:00Z", bars)].date, "2026-09-22"); // 16:30 ET → next close
  assert.equal(entryIndexFor("2026-09-29T14:00:00Z", bars), -1);
});

test("grading computes net excess return vs the benchmark", () => {
  const pitch = buildPitch(validInput());
  const bars = sessions.map((date, i) => ({ date, close: 100 + i * 2 })); // entry 102 on 09-21
  const bench = sessions.map((date, i) => ({ date, close: 400 + i * 4 })); // entry 404
  const [h2, h5, h9] = gradePitch({ pitch, bars, benchmarkBars: bench, horizons: [2, 5, 9], costPerSide: 0.001, now: new Date("2026-09-29T00:00:00Z") });
  assert.equal(h2.status, "matured");
  assert.equal(h2.entryDate, "2026-09-21");
  assert.equal(h2.exitDate, "2026-09-23");
  close(h2.grossReturn, 106 / 102 - 1, 1e-9);
  close(h2.netReturn, 0.999 * (106 / 102) * 0.999 - 1, 1e-9);
  close(h2.benchmarkReturn, 412 / 404 - 1, 1e-9);
  close(h2.excessReturn, h2.netReturn - h2.benchmarkReturn, 1e-12);
  assert.equal(h5.status, "matured");
  assert.equal(h9.status, "immature");
  const missingBench = gradePitch({ pitch, bars, benchmarkBars: bench.filter((b) => b.date !== "2026-09-23"), horizons: [2] });
  assert.equal(missingBench[0].status, "unavailable");
});

// --- analysis ------------------------------------------------------------

test("analysis recovers planted effects (positive and negative) and ignores noise", () => {
  const { pitches, outcomes } = generateDemoData({ horizons: [5] });
  const report = analyzePitchLab({ pitches, outcomes, horizons: [5], periods: [{ id: "all", label: "All", from: null, to: null }], options: { bootstrapIterations: 300 } });
  assert.equal(report.isSyntheticDemo, true);
  const h = report.periods[0].horizons[0];
  assert.equal(h.conviction.verdict.label, "positive");
  assert.ok(h.conviction.excessReturnPerPoint.estimate > 0);
  const byId = Object.fromEntries(h.metrics.map((m) => [m.id, m]));
  assert.equal(byId.revGrowth.verdict.label, "positive");
  assert.equal(byId.peerValuation.verdict.label, "negative");
  assert.ok(byId.peerValuation.spearman.rho < 0);
  const noisy = h.metrics.filter((m) => !["revGrowth", "peerValuation"].includes(m.id) && ["positive", "negative"].includes(m.verdict.label));
  assert.ok(noisy.length <= 1, `too many false discoveries: ${noisy.map((m) => m.id)}`);
  assert.equal(h.conviction.buckets.length, 5);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test("small samples are reported as insufficient, never as a finding", () => {
  const { pitches, outcomes } = generateDemoData({ pitchCount: 12, horizons: [5] });
  const report = analyzePitchLab({ pitches, outcomes, horizons: [5], periods: [{ id: "all", label: "All", from: null, to: null }] });
  const h = report.periods[0].horizons[0];
  assert.equal(h.conviction.verdict.label, "insufficient_data");
  assert.equal(h.conviction.spearman.ci95, null);
  assert.ok(h.metrics.every((m) => m.verdict.label === "insufficient_data"));
});

test("only matured outcomes for known pitches are analyzed", () => {
  const pitch = buildPitch(validInput());
  const report = analyzePitchLab({
    pitches: [pitch],
    outcomes: [
      { pitchId: pitch.id, horizonDays: 5, status: "immature" },
      { pitchId: "pitch_unknown", horizonDays: 5, status: "matured", excessReturn: 0.1, entryDate: "2026-09-21" },
    ],
    horizons: [5],
  });
  assert.equal(report.periods[0].horizons[0].graded, 0);
});

test("ISO week keys", () => {
  assert.equal(isoWeekKey("2026-09-28"), "2026-W40");
  assert.equal(isoWeekKey("2027-01-01"), "2026-W53");
  assert.equal(isoWeekKey("2025-12-29"), "2026-W01");
});

// --- store ---------------------------------------------------------------

test("store is append-only and refuses rewrites", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pitch-lab-"));
  try {
    const store = openPitchStore(dir);
    const pitch = store.appendPitch(validInput());
    assert.throws(() => store.appendPitch(validInput()), /already recorded/);
    assert.throws(() => store.appendPitch(validInput({ rationale: null })), PitchValidationError);
    const outcome = { pitchId: pitch.id, horizonDays: 5, status: "matured", excessReturn: 0.01, entryDate: "2026-09-21" };
    store.appendOutcome(outcome);
    assert.throws(() => store.appendOutcome(outcome), /already recorded/);
    assert.throws(() => store.appendOutcome({ ...outcome, horizonDays: 10, status: "immature" }), /only matured/);
    assert.throws(() => store.appendOutcome({ ...outcome, pitchId: "pitch_x" }), /unknown pitch/);
    assert.equal(openPitchStore(dir).listPitches()[0].id, pitch.id);
    assert.equal(store.listOutcomes().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- model contract ------------------------------------------------------

test("model reply becomes a pitch; system-supplied features are not model-editable", () => {
  const features = buildFeatures({ bars: [], marketCap: 2e9, asOf: "2026-09-21T13:00:00Z" });
  const prompt = buildPitchPrompt({ ticker: "NET", features, entryReference: { price: 100, asOf: "2026-09-21T13:00:00Z" } });
  assert.match(prompt, /revGrowth \(Revenue growth \(YoY\)\): MISSING/);
  assert.match(prompt, /5 = Very high/);
  assert.ok(PITCH_RESPONSE_SCHEMA.required.includes("conviction"));
  const reply = {
    conviction: 2,
    intended_holding_days: 10,
    thesis: "Small-cap with improving unit economics, but the evidence is thin so far.",
    reasons: [{ claim: "Company is small and under-covered.", features: ["logMarketCap"] }],
    risks: ["Illiquid."],
    kill_criteria: ["Breaks below the 50-day low."],
    features: { revGrowth: { value: 9 } }, // a model trying to inject data is ignored
  };
  const pitch = pitchFromModelResponse(reply, { ticker: "NET", pitchedAt: "2026-09-21T14:00:00Z", features, entryReference: { price: 100, asOf: "2026-09-21T13:00:00Z" } });
  assert.equal(pitch.conviction, 2);
  assert.equal(pitch.features.revGrowth.missing, true);
  assert.equal(pitch.provenance.promptVersion, "pitch-lab.prompt.v2");
  assert.throws(() => pitchFromModelResponse({ ...reply, conviction: 9 }, { ticker: "NET", pitchedAt: "2026-09-21T14:00:00Z", features, entryReference: { price: 100, asOf: "2026-09-21T13:00:00Z" } }), PitchValidationError);
});

test("preview page embeds the report safely", () => {
  const html = renderReportHtml({ ...analyzePitchLab({ pitches: [], outcomes: [] }), note: "</script><b>x" });
  assert.ok(!html.includes("</script><b>x"));
  assert.match(html, /<title>Pitch Lab Report<\/title>/);
});

// --- peer ranks ----------------------------------------------------------

const ASOF = "2026-09-21T14:00:00Z";

/** A peer table: `count` Software peers (revGrowth .05…, P/E 10…) retrieved before ASOF. */
function peerTable({ count = 10, industry = "Software - Infrastructure", sector = "Technology", retrievedAt = "2026-09-21T01:00:00Z", extra = {} } = {}) {
  const table = {};
  for (let i = 1; i <= count; i += 1) {
    table[`P${i}`] = {
      industry,
      sector,
      metrics: { revGrowth: i * 0.05, peerValuation: i * 10, ...(i <= 3 ? { marginTrend: i * 0.01 } : {}) },
      retrievedAt,
      ts: retrievedAt,
    };
  }
  return { ...table, ...extra };
}
const candidateFeatures = (overrides = {}) => ({
  revGrowth: { value: 0.45 },
  peerValuation: { value: 25 },
  marginTrend: { value: 0.02 },
  ...overrides,
});

test("peer ranks are the share of peers beaten, and a lower P/E counts as better", () => {
  const peers = computePeerRanks({ ticker: "NET", industry: "Software - Infrastructure", sector: "Technology", features: candidateFeatures(), peerMetrics: peerTable(), asOf: ASOF });
  assert.equal(peers.version, PEER_RANK_VERSION);
  assert.equal(peers.level, "industry");
  assert.equal(peers.peerCount, 10);
  assert.equal(peers.mode, "peer_relative");
  assert.deepEqual(peers.ranks.revGrowth, { status: "ranked", percentile: 0.85, peerCount: 10 });
  assert.deepEqual(peers.ranks.peerValuation, { status: "ranked", percentile: 0.8, peerCount: 10 });
  assert.equal(peers.peerDataAsOf, "2026-09-21T01:00:00.000Z".replace(".000Z", "Z"));
  assert.deepEqual(Object.keys(peers.ranks), [...METRIC_IDS]);
});

test("a metric most peers lack is thin_peers with no percentile; a missing own value is missing_value", () => {
  const peers = computePeerRanks({ ticker: "NET", industry: "Software - Infrastructure", features: candidateFeatures({ epsTrajectory: { value: null } }), peerMetrics: peerTable(), asOf: ASOF });
  assert.deepEqual(peers.ranks.marginTrend, { status: "thin_peers", percentile: null, peerCount: 3 });
  assert.equal(peers.ranks.epsTrajectory.status, "missing_value");
  assert.equal(peers.ranks.revBeat.status, "missing_value"); // never supplied → nothing to rank
  assert.ok(hasCoverageGap(peers));
});

test("a small industry widens to its sector, like the main pipeline", () => {
  const table = {
    ...peerTable({ count: 3, industry: "Narrow Industry", sector: "Technology" }),
    ...Object.fromEntries(Object.entries(peerTable({ count: 10, industry: "Other Industry", sector: "Technology" })).map(([k, v]) => [`S${k}`, v])),
  };
  const peers = computePeerRanks({ ticker: "NET", industry: "Narrow Industry", sector: "Technology", features: candidateFeatures(), peerMetrics: table, asOf: ASOF });
  assert.equal(peers.level, "sector");
  assert.equal(peers.key, "Technology");
  assert.equal(peers.peerCount, 13);
});

test("peer data newer than the pitch, or without a full timestamp, is ignored (no look-ahead)", () => {
  const table = peerTable({ count: 8 });
  table.LATE = { ...table.P1, retrievedAt: "2026-09-22T01:00:00Z", ts: "2026-09-22T01:00:00Z" };
  table.LEGACY = { ...table.P2, retrievedAt: undefined, ts: "2026-09-20" }; // date-only
  const peers = computePeerRanks({ ticker: "NET", industry: "Software - Infrastructure", features: candidateFeatures(), peerMetrics: table, asOf: ASOF });
  assert.equal(peers.peerCount, 8);
  assert.equal(peers.excludedPeers, 2);
  assert.ok(Date.parse(peers.peerDataAsOf) <= Date.parse(ASOF));
});

test("the company's own row is never one of its peers, and its classification is read from it", () => {
  const table = peerTable({ count: 9 });
  table.NET = { industry: "Software - Infrastructure", sector: "Technology", metrics: { revGrowth: 0.45, peerValuation: 25 }, retrievedAt: "2026-09-21T01:00:00Z" };
  const peers = computePeerRanks({ ticker: "NET", features: candidateFeatures(), peerMetrics: table, asOf: ASOF });
  assert.equal(peers.industry, "Software - Infrastructure");
  assert.equal(peers.peerCount, 9);
});

test("an unreadable peer table, an unclassified company, and an empty cohort are three different statuses", () => {
  const down = computePeerRanks({ ticker: "NET", features: candidateFeatures(), peerMetrics: {}, asOf: ASOF });
  assert.equal(down.reason, "peer_data_unavailable");
  assert.equal(down.ranks.revGrowth.status, "peer_data_unavailable");
  assert.equal(computePeerRanks({ ticker: "NET", features: candidateFeatures(), peerMetrics: null, asOf: ASOF }).reason, "peer_data_unavailable");

  const unclassified = computePeerRanks({ ticker: "NET", features: candidateFeatures(), peerMetrics: peerTable(), asOf: ASOF });
  assert.equal(unclassified.reason, "no_classification");
  assert.equal(unclassified.ranks.revGrowth.status, "no_peers");

  const empty = computePeerRanks({ ticker: "NET", industry: "Nothing Like It", sector: "Elsewhere", features: candidateFeatures(), peerMetrics: peerTable(), asOf: ASOF });
  assert.equal(empty.reason, "no_peers_in_cohort");
  assert.equal(empty.ranks.revGrowth.status, "no_peers");
  assert.throws(() => computePeerRanks({ ticker: "NET", features: {}, peerMetrics: peerTable(), asOf: "nope" }), TypeError);
});

test("a pitch stores the peers block and fails closed on a malformed one", () => {
  const peers = computePeerRanks({ ticker: "NET", industry: "Software - Infrastructure", features: candidateFeatures(), peerMetrics: peerTable(), asOf: "2026-09-21T13:00:00Z" });
  const pitch = buildPitch(validInput({ peers }));
  assert.equal(pitch.peers.ranks.revGrowth.percentile, 0.85);
  assert.ok(Object.isFrozen(pitch.peers.ranks.revGrowth));
  assert.equal(buildPitch(validInput()).peers, null); // recorded without peer data

  const broken = (mutate) => {
    const copy = JSON.parse(JSON.stringify(peers));
    mutate(copy);
    return validInput({ peers: copy });
  };
  assert.throws(() => buildPitch(broken((p) => { p.ranks.marginTrend.percentile = 0.5; })), /percentile must be null unless status is ranked/);
  assert.throws(() => buildPitch(broken((p) => { p.ranks.revGrowth.percentile = 1.5; })), /percentile must be a number in \[0,1\]/);
  assert.throws(() => buildPitch(broken((p) => { delete p.ranks.thirteenF; })), /peers.ranks.thirteenF is required/);
  assert.throws(() => buildPitch(broken((p) => { p.ranks.bogus = { status: "ranked", percentile: 0.1, peerCount: 9 }; })), /unknown metric/);
  assert.throws(() => buildPitch(broken((p) => { p.ranks.revGrowth.status = "great"; })), /status must be one of/);
  assert.throws(() => buildPitch(broken((p) => { p.peerDataAsOf = "2026-09-22T00:00:00Z"; })), /look-ahead/);
  assert.throws(() => buildPitch(broken((p) => { p.version = "other"; })), /peers.version/);
  assert.notEqual(buildPitch(validInput({ peers })).id, buildPitch(validInput()).id);
});

test("missing values carry a reason code, and only missing values may", () => {
  const f = buildFeatures({ fundamentals: null, companyfacts: null, bars: [], asOf: ASOF });
  assert.equal(f.revBeat.missingReason, "not_supplied_to_pitch_lab");
  assert.equal(f.revGrowth.missingReason, "no_fundamentals_supplied");
  assert.equal(f.rsi14.missingReason, "insufficient_price_history");
  assert.equal(f.logMarketCap.missingReason, "no_market_cap");
  const yahooOnly = buildFeatures({ fundamentals: { raw: { financialData: {}, summaryDetail: {} } }, bars: [], asOf: ASOF });
  assert.equal(yahooOnly.peerValuation.missingReason, "no_pe_ratio");
  assert.equal(yahooOnly.epsTrajectory.missingReason, "no_edgar_facts");

  const pitch = buildPitch(validInput({ features: { ...f, revGrowth: { value: 0.3, asOf: "2026-09-20T00:00:00Z" } } }));
  assert.equal(pitch.features.revBeat.missingReason, "not_supplied_to_pitch_lab");
  assert.equal(pitch.features.revGrowth.missingReason, undefined);
  assert.throws(() => buildPitch(validInput({ features: { revBeat: { value: null, missingReason: "because" } } })), /not recognised/);
  assert.throws(() => buildPitch(validInput({ features: { revGrowth: { value: 0.3, missingReason: "not_reported" } } })), /only valid when the value is missing/);
});

test("the prompt shows peer ranks and says when there is none, so the model cannot invent peer claims", () => {
  const features = candidateFeatures();
  const peers = computePeerRanks({ ticker: "NET", industry: "Software - Infrastructure", features, peerMetrics: peerTable(), asOf: ASOF });
  const prompt = buildPitchPrompt({ ticker: "NET", features, peers, entryReference: { price: 100, asOf: ASOF } });
  assert.match(prompt, /revGrowth .*industry-peer rank: 85th percentile of 10 peers/);
  assert.match(prompt, /marginTrend .*industry-peer rank: unavailable \(thin_peers\)/);
  assert.match(prompt, /Only describe a metric as above or below its industry peers when an industry-peer/);
  assert.ok(!/industry-peer rank/.test(buildPitchPrompt({ ticker: "NET", features, entryReference: { price: 100, asOf: ASOF } }).split("Rate your conviction")[0].split("Data available")[1].split("\n").slice(3).join("\n")));
});

test("analysis recovers planted peer-rank effects and reports coverage", () => {
  const { pitches, outcomes } = generateDemoData({ horizons: [5] });
  const report = analyzePitchLab({ pitches, outcomes, horizons: [5], periods: [{ id: "all", label: "All", from: null, to: null }], options: { bootstrapIterations: 300 } });
  const h = report.periods[0].horizons[0];
  const byId = Object.fromEntries(h.peerMetrics.map((m) => [m.id, m]));
  assert.equal(byId.revGrowth.verdict.label, "positive");
  assert.equal(byId.peerValuation.verdict.label, "positive"); // cheaper than peers → better
  assert.match(byId.revGrowth.label, /rank vs industry peers/);
  const noisy = h.peerMetrics.filter((m) => !["revGrowth", "peerValuation"].includes(m.id) && ["positive", "negative"].includes(m.verdict.label));
  assert.ok(noisy.length <= 1, `too many false discoveries: ${noisy.map((m) => m.id)}`);
  assert.equal(report.dataCoverage.pitches, pitches.length);
  assert.equal(report.dataCoverage.pitchesWithPeerData, pitches.length);
  assert.ok(report.dataCoverage.peerRankStatus.revGrowth.ranked > 0);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test("pitches recorded before peer ranks existed count as not_recorded, never as ranked", () => {
  const { pitches } = generateDemoData({ pitchCount: 6, horizons: [5] });
  const legacy = buildPitch(validInput());
  const coverage = buildDataCoverage([...pitches, legacy]);
  assert.equal(coverage.pitches, 7);
  assert.equal(coverage.pitchesWithPeerData, 6);
  assert.equal(coverage.peerRankStatus.revGrowth.not_recorded, 1);
  assert.equal(coverage.missingReasons.revBeat.missing.unrecorded, 1 + pitches.filter((p) => p.features.revBeat.missing && !p.features.revBeat.missingReason).length);
});

test("the preview page renders the peer sections", () => {
  const { pitches, outcomes } = generateDemoData({ pitchCount: 60, horizons: [5] });
  const html = renderReportHtml(analyzePitchLab({ pitches, outcomes, horizons: [5], options: { bootstrapIterations: 50 } }));
  assert.match(html, /id="peermetrics"/);
  assert.match(html, /Peer coverage/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});

// --- peer bridge ---------------------------------------------------------

const quietConsole = async (fn) => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
};

test("the bridge files a coverage request only for a real gap, and only when enabled", async () => {
  const filed = [];
  const requestCoverage = async (request) => { filed.push(request); return { ...request }; };
  const base = { ticker: "NET", asOf: ASOF, industry: "Software - Infrastructure", sector: "Technology", getMetrics: async () => peerTable(), requestCoverage };

  const gap = await peersForPitch({ ...base, features: candidateFeatures(), requestsEnabled: true });
  assert.equal(gap.request.filed, true);
  assert.deepEqual(filed, [{ ticker: "NET", industry: "Software - Infrastructure", sector: "Technology", source: "pitch-lab" }]);

  filed.length = 0;
  const off = await peersForPitch({ ...base, features: candidateFeatures(), requestsEnabled: false });
  assert.deepEqual(off.request, { filed: false, reason: "requests_disabled" });

  const full = await peersForPitch({ ...base, features: { revGrowth: { value: 0.45 }, peerValuation: { value: 25 } }, requestsEnabled: true });
  assert.deepEqual(full.request, { filed: false, reason: null });
  assert.equal(filed.length, 0);

  const unclassified = await peersForPitch({ ...base, industry: null, sector: null, features: candidateFeatures(), requestsEnabled: true });
  assert.deepEqual(unclassified.request, { filed: false, reason: "no_classification" });
  assert.equal(filed.length, 0);
});

test("a peer-table outage is recorded as an outage and does not queue requests", async () => {
  const filed = [];
  const { result, logged } = await quietConsole(() => peersForPitch({
    ticker: "NET", asOf: ASOF, industry: "Software - Infrastructure", features: candidateFeatures(), requestsEnabled: true,
    getMetrics: async () => { throw new Error("redis down"); },
    requestCoverage: async (request) => { filed.push(request); return request; },
  }));
  assert.equal(result.peers.reason, "peer_data_unavailable");
  assert.equal(result.peers.ranks.revGrowth.status, "peer_data_unavailable");
  assert.deepEqual(result.request, { filed: false, reason: "peer_data_unavailable" });
  assert.equal(filed.length, 0);
  assert.ok(logged.some((line) => line.includes("redis down")), "failure must be loud");
});

test("a failed coverage request is loud and reported, and still returns the ranks", async () => {
  const { result, logged } = await quietConsole(() => peersForPitch({
    ticker: "NET", asOf: ASOF, industry: "Software - Infrastructure", features: candidateFeatures(), requestsEnabled: true,
    getMetrics: async () => peerTable(),
    requestCoverage: async () => { throw new Error("write refused"); },
  }));
  assert.deepEqual(result.request, { filed: false, reason: "request_failed" });
  assert.equal(result.peers.ranks.revGrowth.status, "ranked");
  assert.ok(logged.some((line) => line.includes("write refused")));
  const notStored = await peersForPitch({ ticker: "NET", asOf: ASOF, industry: "Software - Infrastructure", features: candidateFeatures(), requestsEnabled: true, getMetrics: async () => peerTable(), requestCoverage: async () => null });
  assert.deepEqual(notStored.request, { filed: false, reason: "request_not_stored" });
});

test("the dry run fetches like the scan, ranks, and files nothing by default", async () => {
  const bars = Array.from({ length: 260 }, (_, i) => ({ close: 100 + i * 0.1, volume: 1000 }));
  const filed = [];
  const result = await peerCheck({
    ticker: "net",
    now: () => new Date(ASOF),
    getFundamentals: async (t) => ({ ticker: t, industry: "Software - Infrastructure", sector: "Technology", marketCap: 3e10, raw: { financialData: { revenueGrowth: 0.45 }, summaryDetail: { forwardPE: 25 } } }),
    getCompanyFacts: async () => null,
    getBars: async () => bars,
    getMetrics: async () => peerTable(),
    requestCoverage: async (r) => { filed.push(r); return r; },
  });
  assert.equal(result.ticker, "NET");
  assert.equal(result.peers.ranks.revGrowth.percentile, 0.85);
  assert.equal(result.features.logMarketCap.value > 10, true);
  assert.equal(result.features.epsTrajectory.missingReason, "no_edgar_facts");
  assert.deepEqual(result.request, { filed: false, reason: null }); // every metric it has was ranked, so nothing to request
  assert.equal(filed.length, 0);
  await assert.rejects(() => peerCheck({ ticker: "NET", getFundamentals: async () => ({ error: "boom" }), getCompanyFacts: async () => null, getBars: async () => [], getMetrics: async () => ({}) }), /fundamentals unavailable/);
});

test("only the bridge touches the database; Pitch Lab and its CLI never import it", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const libDir = new URL("../lib/pitch-lab/", import.meta.url);
  const files = [
    ...readdirSync(libDir).filter((f) => f.endsWith(".js")).map((f) => new URL(f, libDir)),
    new URL("../scripts/pitch-lab.js", import.meta.url),
  ];
  for (const file of files) assert.ok(!/from\s+["'][^"']*pitch-lab-peer-bridge/.test(readFileSync(file, "utf8")), `${file.pathname} must not import the bridge`);
  const bridge = readFileSync(new URL("../lib/pitch-lab-peer-bridge.js", import.meta.url), "utf8");
  const redisNames = [...bridge.matchAll(/\b(getPeerMetrics|requestPeerCoverage|set[A-Z]\w*|append\w*|delete\w*)\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(redisNames)].sort(), ["getPeerMetrics", "requestPeerCoverage"], "the bridge may only read the peer table and file coverage requests");
});

test("pitch lab never imports production write paths", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const libDir = new URL("../lib/pitch-lab/", import.meta.url);
  const files = [
    ...readdirSync(libDir).filter((f) => f.endsWith(".js")).map((f) => new URL(f, libDir)),
    new URL("../scripts/pitch-lab.js", import.meta.url),
  ];
  const forbidden = /from\s+["'][^"']*(redis|sheets|robinhood|fill-processing|proposal-signature|research-scan|telegram|pg\/)[^"']*["']|createProposal|@upstash/;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.ok(!forbidden.test(source), `${file.pathname} imports a production write path`);
  }
});
