import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AGENT_SCORING } from "../config/scoring/mandate-v2.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { generateDemoData } from "../lib/pitch-lab/demo-data.js";
import { ADJUSTMENT_RULES, ADJUSTMENT_VERSION, buildMandateAdjustments } from "../lib/pitch-lab/mandate-adjustments.js";
import { REVIEW_MATRIX_WEEKS, generateMandateReview } from "../lib/pitch-lab/mandate-review.js";
import { formatMandateReviewTelegram } from "../lib/pitch-lab/telegram.js";

const agentScoring = AGENT_SCORING["agent-1"];
// Agent 1 weights (points): A revBeat 10, revGrowth 15 · B epsTrajectory 18, estimateRevisions 12 ·
// C marginTrend 12, peerValuation 8, balanceSheet 10 · D instOwnershipDir 9, thirteenF 6.
const ORDER = ["revBeat", "revGrowth", "epsTrajectory", "estimateRevisions", "marginTrend", "peerValuation", "balanceSheet", "instOwnershipDir", "thirteenF"];
const CATEGORY = { revBeat: "A", revGrowth: "A", epsTrajectory: "B", estimateRevisions: "B", marginTrend: "C", peerValuation: "C", balanceSheet: "C", instOwnershipDir: "D", thirteenF: "D" };

/** One matrix row. `verdict` null = the metric was never ranked. */
function metric(id, { verdict = "inconclusive", rho = 0.01, q = 0.6, positive = 5, negative = 5, used = 10, relative = "in_line" } = {}) {
  const has = verdict != null;
  return {
    id, label: `Label ${id}`,
    aggregate: { n: has ? 300 : 0, weeks: has ? 10 : 0, rho: has ? rho : null, ci95: has ? [rho - 0.1, rho + 0.1] : null, excessReturnPerSd: has ? { estimate: rho / 10, qValue: q } : null, verdict },
    weeksPositive: positive, weeksNegative: negative, weeksUsed: used,
    consistency: { score: 1 }, spread: { overall: rho / 5, sdWeekly: 0.01 },
    relative: { status: relative, difference: relative === "below_others" ? -0.2 : 0, ci95: relative === "below_others" ? [-0.3, -0.05] : [-0.1, 0.1] },
  };
}
const matrix = (overrides = {}, horizonDays = 10) => ({ horizons: [{ horizonDays, metrics: ORDER.map((id) => metric(id, overrides[id])) }] });
const POSITIVE = { verdict: "positive", rho: 0.2, q: 0.01, positive: 9, negative: 1 };
const rowOf = (adjustments, id) => adjustments.rows.find((row) => row.metricId === id);
function assertBalanced(adjustments) {
  assert.equal(adjustments.netChangeBps, 0, "the mandate total stays at 100 points");
  assert.equal(adjustments.currentTotalBps, 10_000);
  for (const category of ["A", "B", "C", "D"]) {
    const net = adjustments.rows.filter((row) => row.category === category).reduce((sum, row) => sum + row.changeBps, 0);
    assert.equal(net, 0, `category ${category} keeps its total`);
  }
  for (const row of adjustments.rows) {
    assert.equal(Math.abs(row.changeBps) % ADJUSTMENT_RULES.roundBps, 0, `${row.metricId} moves in 50 bps steps`);
    assert.ok(Math.abs(row.changeBps) <= ADJUSTMENT_RULES.maxStepBps, `${row.metricId} moves at most 100 bps a review`);
    assert.equal(row.suggestedBps, row.currentBps + row.changeBps);
    assert.ok(row.suggestedBps >= 0);
  }
}

test("every mandate metric is listed, in mandate order, with its weight in bps", () => {
  const adjustments = buildMandateAdjustments(matrix(), agentScoring);
  assert.equal(adjustments.version, ADJUSTMENT_VERSION);
  assert.equal(adjustments.horizonDays, 10);
  assert.deepEqual(adjustments.rows.map((row) => row.metricId), ORDER);
  assert.deepEqual(adjustments.rows.map((row) => row.category), ORDER.map((id) => CATEGORY[id]));
  assert.deepEqual(adjustments.rows.map((row) => row.currentBps), [1000, 1500, 1800, 1200, 1200, 800, 1000, 900, 600]);
  assert.ok(adjustments.rows.every((row) => row.direction === "no_change" && row.changeBps === 0 && row.basis === "no_clear_effect"));
  assertBalanced(adjustments);
});

test("a significant, week-consistent aggregate is +100 bps, paired inside its category", () => {
  const adjustments = buildMandateAdjustments(matrix({ revGrowth: POSITIVE }), agentScoring);
  const up = rowOf(adjustments, "revGrowth");
  assert.deepEqual({ direction: up.direction, confidence: up.confidenceLabel, basis: up.basis, change: up.changeBps, suggested: up.suggestedBps }, { direction: "more", confidence: "recommended", basis: "aggregate_positive", change: 100, suggested: 1600 });
  // The only other metric in category A funds it.
  const funder = rowOf(adjustments, "revBeat");
  assert.deepEqual({ direction: funder.direction, basis: funder.basis, change: funder.changeBps }, { direction: "offset", basis: "offset", change: -100 });
  assert.deepEqual(adjustments.summary, { more: 1, less: 0, offset: 1, noChange: 7, unavailable: 0 });
  assertBalanced(adjustments);
});

test("one bad week does not downgrade a metric; an unstable sign does", () => {
  const nineOfTen = buildMandateAdjustments(matrix({ revGrowth: { ...POSITIVE, positive: 9, negative: 1 } }), agentScoring);
  assert.equal(rowOf(nineOfTen, "revGrowth").confidenceLabel, "recommended");
  const flipFlop = buildMandateAdjustments(matrix({ revGrowth: { ...POSITIVE, positive: 5, negative: 5 } }), agentScoring);
  assert.deepEqual({ confidence: rowOf(flipFlop, "revGrowth").confidenceLabel, change: rowOf(flipFlop, "revGrowth").changeBps }, { confidence: "watch", change: 50 });
  // Too few usable weeks to judge consistency: the aggregate still counts, as a watch.
  const thin = buildMandateAdjustments(matrix({ revGrowth: { ...POSITIVE, positive: 2, negative: 0, used: 2 } }), agentScoring);
  assert.equal(rowOf(thin, "revGrowth").confidenceLabel, "watch");
  for (const adjustments of [nineOfTen, flipFlop, thin]) assertBalanced(adjustments);
});

test("the weekly columns alone never create a suggestion", () => {
  // Positive in every single week, but the aggregate did not survive the false-discovery control.
  const adjustments = buildMandateAdjustments(matrix({ revGrowth: { verdict: "inconclusive", rho: 0.08, q: 0.3, positive: 10, negative: 0 } }), agentScoring);
  assert.deepEqual({ direction: rowOf(adjustments, "revGrowth").direction, change: rowOf(adjustments, "revGrowth").changeBps }, { direction: "no_change", change: 0 });
  // A positive verdict whose q-value is above the threshold is not acted on either.
  const loose = buildMandateAdjustments(matrix({ revGrowth: { ...POSITIVE, q: 0.2 } }), agentScoring);
  assert.equal(rowOf(loose, "revGrowth").direction, "no_change");
});

test("a significantly negative aggregate is less weight, flagged for a direction check", () => {
  const adjustments = buildMandateAdjustments(matrix({ balanceSheet: { verdict: "negative", rho: -0.2, q: 0.02, positive: 1, negative: 9 } }), agentScoring);
  const down = rowOf(adjustments, "balanceSheet");
  assert.deepEqual({ direction: down.direction, confidence: down.confidenceLabel, basis: down.basis, change: down.changeBps, flag: down.reviewDirection }, { direction: "less", confidence: "recommended", basis: "aggregate_negative", change: -100, flag: true });
  // The freed weight is spread one step at a time over the category's other metrics.
  assert.equal(rowOf(adjustments, "marginTrend").changeBps + rowOf(adjustments, "peerValuation").changeBps, 100);
  assert.equal(rowOf(adjustments, "marginTrend").direction, "offset");
  assertBalanced(adjustments);
});

test("a metric clearly weaker than the others gets less weight even when none of the others is strong, capped at watch", () => {
  const adjustments = buildMandateAdjustments(matrix({
    marginTrend: { rho: 0.06 }, peerValuation: { rho: 0.02 },
    balanceSheet: { verdict: "inconclusive", rho: -0.09, q: 0.4, positive: 0, negative: 10, relative: "below_others" },
  }), agentScoring);
  const weak = rowOf(adjustments, "balanceSheet");
  assert.deepEqual({ direction: weak.direction, confidence: weak.confidenceLabel, basis: weak.basis, change: weak.changeBps }, { direction: "less", confidence: "watch", basis: "weaker_than_other_metrics", change: -50 });
  assert.equal(weak.reviewDirection, undefined, "weaker is not the same as backwards");
  // Its 50 bps go to the strongest of the category's no-clear-effect metrics.
  assert.equal(rowOf(adjustments, "marginTrend").changeBps, 50);
  assert.equal(rowOf(adjustments, "peerValuation").changeBps, 0);
  assert.ok(adjustments.rows.every((row) => row.confidenceLabel !== "recommended"));
  assertBalanced(adjustments);
});

test("opposite suggestions in one category pair with each other before any offset", () => {
  const adjustments = buildMandateAdjustments(matrix({
    marginTrend: POSITIVE,
    balanceSheet: { verdict: "negative", rho: -0.2, q: 0.02, positive: 1, negative: 9 },
  }), agentScoring);
  assert.equal(rowOf(adjustments, "marginTrend").changeBps, 100);
  assert.equal(rowOf(adjustments, "balanceSheet").changeBps, -100);
  assert.deepEqual({ direction: rowOf(adjustments, "peerValuation").direction, change: rowOf(adjustments, "peerValuation").changeBps }, { direction: "no_change", change: 0 });
  assertBalanced(adjustments);
});

test("metrics without data or without enough data are never the other side of a move", () => {
  // Category A: revBeat has never been ranked, so nothing can fund revGrowth.
  const noData = buildMandateAdjustments(matrix({ revGrowth: POSITIVE, revBeat: { verdict: null } }), agentScoring);
  const up = rowOf(noData, "revGrowth");
  assert.deepEqual({ direction: up.direction, change: up.changeBps, wanted: up.wantedBps, sized: up.sized }, { direction: "more", change: 0, wanted: 100, sized: "not_sized" });
  assert.deepEqual({ direction: rowOf(noData, "revBeat").direction, basis: rowOf(noData, "revBeat").basis, change: rowOf(noData, "revBeat").changeBps }, { direction: "unavailable", basis: "no_data", change: 0 });
  assertBalanced(noData);
  const thin = buildMandateAdjustments(matrix({ revGrowth: POSITIVE, revBeat: { verdict: "insufficient_data" } }), agentScoring);
  assert.equal(rowOf(thin, "revBeat").basis, "not_enough_data");
  assert.equal(rowOf(thin, "revBeat").changeBps, 0);
  assert.equal(rowOf(thin, "revGrowth").sized, "not_sized");
  assertBalanced(thin);
});

test("a move is scaled back, weakest evidence first, when its category cannot pair all of it", () => {
  // Category C: two increases (one recommended, one watch) and one partner that can give at most 100 bps.
  const adjustments = buildMandateAdjustments(matrix({
    marginTrend: POSITIVE,
    peerValuation: { ...POSITIVE, rho: 0.12, positive: 5, negative: 5 },
  }), agentScoring);
  assert.equal(rowOf(adjustments, "balanceSheet").changeBps, -100);
  assert.equal(rowOf(adjustments, "marginTrend").changeBps, 100);
  assert.deepEqual({ change: rowOf(adjustments, "peerValuation").changeBps, wanted: rowOf(adjustments, "peerValuation").wantedBps, sized: rowOf(adjustments, "peerValuation").sized }, { change: 0, wanted: 50, sized: "not_sized" });
  assertBalanced(adjustments);
});

test("malformed evidence fails closed, and a weight can never go below zero", () => {
  const malformed = buildMandateAdjustments(matrix({ revGrowth: { ...POSITIVE, q: null } }), agentScoring);
  assert.deepEqual({ direction: rowOf(malformed, "revGrowth").direction, basis: rowOf(malformed, "revGrowth").basis, change: rowOf(malformed, "revGrowth").changeBps }, { direction: "unavailable", basis: "malformed_evidence", change: 0 });
  const unknown = buildMandateAdjustments(matrix({ revGrowth: { verdict: "amazing", rho: 0.5 } }), agentScoring);
  assert.equal(rowOf(unknown, "revGrowth").direction, "unavailable");

  const tiny = { categories: { A: { metrics: { revBeat: { points: 0.5 }, revGrowth: { points: 24.5 } } } } };
  const cut = buildMandateAdjustments(matrix({ revBeat: { verdict: "negative", rho: -0.2, q: 0.01, positive: 0, negative: 10 } }), tiny);
  assert.deepEqual({ change: rowOf(cut, "revBeat").changeBps, suggested: rowOf(cut, "revBeat").suggestedBps }, { change: -50, suggested: 0 });
  assert.equal(rowOf(cut, "revGrowth").changeBps, 50);
});

test("no matrix, or no row for the review's holding period, means no table at all", () => {
  assert.equal(buildMandateAdjustments(null, agentScoring), null);
  assert.equal(buildMandateAdjustments({ horizons: [] }, agentScoring), null);
  assert.equal(buildMandateAdjustments(matrix({}, 5), agentScoring), null, "only 5-day results: nothing to read the suggestions from");
  assert.equal(buildMandateAdjustments(matrix(), {}), null);
});

test("the adjustment and matrix modules import nothing from the mandate config or the money path", () => {
  const forbidden = ["config/", "contracts/", "redis.js", "investor-ledger", "proposal", "ledger", "mcp-accounting", "robinhood", "order", "broker", "/pg/", "node:fs"];
  for (const file of ["mandate-adjustments.js", "weekly-matrix.js", "mandate-review.js"]) {
    const src = readFileSync(new URL(`../lib/pitch-lab/${file}`, import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]);
    for (const path of imports) {
      for (const pattern of forbidden) assert.ok(!path.includes(pattern), `${file} must not import "${path}"`);
    }
    assert.doesNotMatch(src, /writeFile|process\.env|fetch\(/, `${file} stays pure`);
  }
});

// ─── The review carries the table and the matrix ─────────────────────────────

const demo = generateDemoData({ now: new Date("2026-10-01T00:00:00Z") });
const report = analyzePitchLab({ pitches: demo.pitches, outcomes: demo.outcomes, now: new Date("2026-10-01T00:00:00Z") });

test("a review sized from real analysis output is balanced and keeps a bounded number of weeks", () => {
  const review = generateMandateReview(report, agentScoring, { now: new Date("2026-10-02T23:40:00Z") });
  assert.equal(review.period, "2026-10-02", "the period is the Friday the review ran");
  assert.deepEqual(review.adjustments.rows.map((row) => row.metricId), ORDER);
  assertBalanced(review.adjustments);
  // The demo plants revenue growth and a cheaper forward P/E as the two real effects.
  assert.equal(rowOf(review.adjustments, "revGrowth").direction, "more");
  assert.equal(rowOf(review.adjustments, "peerValuation").direction, "more");
  assert.equal(review.status, "has_suggestions");
  for (const horizon of review.weeklyMatrix.horizons) {
    assert.ok(horizon.weeks.length <= REVIEW_MATRIX_WEEKS);
    assert.equal(horizon.metrics.length, 9);
    assert.ok(horizon.metrics.every((m) => m.cells.length === horizon.weeks.length));
  }
  assert.ok(report.weeklyMatrix.horizons[0].weeks.length > REVIEW_MATRIX_WEEKS, "the report itself keeps every week");
  // Same data, same review: the store's content-hash id depends on it.
  const again = generateMandateReview(report, agentScoring, { now: new Date("2026-10-02T23:40:00Z") });
  assert.deepEqual(again, review);
});

test("the review's Telegram message ends with one line per mandate metric", () => {
  const review = generateMandateReview(report, agentScoring, { now: new Date("2026-10-02T23:40:00Z") });
  const lines = formatMandateReviewTelegram(review).split("\n");
  const start = lines.findIndex((line) => line.startsWith("Suggested weight changes (from 10-day results; 100 bps = 1 mandate point)"));
  assert.ok(start > 0);
  const table = lines.slice(start + 1, start + 10);
  assert.deepEqual(table.map((line) => line.split(":")[0]), [
    "Revenue beat vs consensus", "Revenue growth (YoY)", "EPS trajectory (YoY)", "Analyst estimate revisions", "Gross-margin trend",
    "Forward P/E (lower = cheaper)", "Balance-sheet strength", "Institutional ownership direction", "Latest 13F accumulation",
  ]);
  assert.match(table[1], /^Revenue growth \(YoY\): \+\d+ bps, (recommended|watch) \(went with better results; corr \+0\.\d\d/);
  assert.ok(table.some((line) => /: -\d+ bps, offset inside its category/.test(line)));
  assert.ok(table.some((line) => /: no change \(/.test(line)));
  assert.equal(lines.at(-1), "Paper research only — suggestions only; no mandate change has been made.");
  assert.equal(lines[start + 10], "", "the table is exactly nine lines");
});

test("the Telegram table words each kind of row plainly", () => {
  const adjustments = buildMandateAdjustments(matrix({
    revBeat: { verdict: null },
    revGrowth: POSITIVE,
    estimateRevisions: { verdict: "insufficient_data" },
    balanceSheet: { verdict: "negative", rho: -0.2, q: 0.02, positive: 1, negative: 9 },
    thirteenF: { verdict: "inconclusive", rho: -0.09, q: 0.4, positive: 2, negative: 8, relative: "below_others" },
  }), agentScoring);
  const message = formatMandateReviewTelegram({ status: "has_suggestions", gradedPitches: 300, independentWeeks: 10, metrics: [], adjustments });
  assert.match(message, /Label revBeat: no change \(no data yet\)/);
  assert.match(message, /Label revGrowth: more weight, not sized \(nothing in its category to pair it with\), recommended \(went with better results; corr \+0\.20, positive 9 of 10 weeks\)/);
  assert.match(message, /Label estimateRevisions: no change \(not enough graded pitches yet\)/);
  assert.match(message, /Label balanceSheet: -100 bps, recommended \(went with WORSE results, check the metric's direction; corr -0\.20, positive 1 of 10 weeks\)/);
  assert.match(message, /Label thirteenF: -50 bps, watch \(clearly weaker than the other metrics; corr -0\.09, positive 2 of 10 weeks\)/);
  assert.match(message, /Label instOwnershipDir: \+50 bps, offset inside its category \(corr \+0\.01\)/);
  assert.match(message, /Label epsTrajectory: no change \(corr \+0\.01, positive 5 of 10 weeks\)/);
});

test("below the sample minimums there is no table, and an older report without a matrix changes nothing", () => {
  const thin = {
    ...report,
    periods: report.periods.map((p) => (p.id === "all" ? { ...p, horizons: p.horizons.map((h) => ({ ...h, graded: 10, clusters: 3 })) } : p)),
  };
  const insufficient = generateMandateReview(thin, agentScoring);
  assert.equal(insufficient.status, "insufficient_data");
  assert.equal(insufficient.adjustments, null);
  assert.ok(insufficient.weeklyMatrix.horizons.length > 0, "the weeks so far are still shown");
  assert.doesNotMatch(formatMandateReviewTelegram(insufficient), /Suggested weight changes/);

  const { weeklyMatrix: _dropped, ...older } = report;
  const legacy = generateMandateReview(older, agentScoring, { now: new Date("2026-10-02T23:40:00Z") });
  assert.equal(legacy.adjustments, null);
  assert.equal(legacy.weeklyMatrix, null);
  assert.doesNotMatch(formatMandateReviewTelegram(legacy), /Suggested weight changes/);
  assert.deepEqual(legacy.metrics, generateMandateReview(report, agentScoring, { now: new Date("2026-10-02T23:40:00Z") }).metrics, "the original per-metric verdicts are untouched");
});
