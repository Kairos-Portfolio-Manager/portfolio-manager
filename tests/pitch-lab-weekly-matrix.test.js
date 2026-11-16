import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzePitchLab, isoWeekKey } from "../lib/pitch-lab/analysis.js";
import { FEATURE_CATALOG } from "../lib/pitch-lab/features.js";
import { PEER_RANK_METRIC_IDS } from "../lib/pitch-lab/peer-rank.js";
import { seededRandom } from "../lib/pitch-lab/stats.js";
import { WEEKLY_MATRIX_VERSION, buildWeeklyMatrix, isoWeekKey as matrixWeekKey, trimWeeklyMatrix } from "../lib/pitch-lab/weekly-matrix.js";

const DAY_MS = 86_400_000;
// Every stored pitch records every catalog feature; here they are all "missing" so only the peer ranks carry signal.
const NO_FEATURES = Object.fromEntries(FEATURE_CATALOG.map((feature) => [feature.id, { value: null, missing: true }]));
const addDays = (dateStr, days) => new Date(Date.parse(`${dateStr}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Synthetic graded pitches: `weeks` ISO weeks from Monday 2026-01-05, `perWeek` pitches each.
 * `effects` maps a metric id to how strongly its peer percentile drives the excess return
 * (may be a function of the week index); every other ranked metric is pure noise.
 */
function synthetic({ weeks = 10, perWeek = 30, effects = {}, ranked = ["revGrowth", "epsTrajectory", "marginTrend", "peerValuation", "balanceSheet"], seed = 7, horizons = [10] } = {}) {
  const random = seededRandom(seed);
  const pitches = [];
  const outcomes = [];
  for (let w = 0; w < weeks; w += 1) {
    for (let i = 0; i < perWeek; i += 1) {
      const id = `p-${w}-${i}`;
      const entryDate = addDays("2026-01-05", w * 7 + (i % 5));
      const ranks = {};
      let signal = 0;
      for (const metricId of ranked) {
        const percentile = random();
        ranks[metricId] = { status: "ranked", percentile, peerCount: 12 };
        const effect = typeof effects[metricId] === "function" ? effects[metricId](w) : effects[metricId] ?? 0;
        signal += effect * (percentile - 0.5);
      }
      pitches.push({ id, ticker: `T${w}${i}`, pitchedAt: `${addDays(entryDate, -1)}T23:40:00Z`, conviction: 5, convictionScale: 10, features: NO_FEATURES, peers: { ranks } });
      for (const horizonDays of horizons) {
        outcomes.push({ pitchId: id, horizonDays, status: "matured", entryDate, excessReturn: signal + (random() - 0.5) * 0.04, benchmarkReturn: 0.01, benchmark: "SPY", costPerSide: 0.001 });
      }
    }
  }
  return { pitches, outcomes };
}
const row = (matrix, id, horizonDays = 10) => matrix.horizons.find((h) => h.horizonDays === horizonDays).metrics.find((m) => m.id === id);

test("the matrix always has the nine mandate metrics, in mandate order, and one column per entry week", () => {
  const { pitches, outcomes } = synthetic({ weeks: 4 });
  const matrix = buildWeeklyMatrix({ pitches, outcomes });
  assert.equal(matrix.version, WEEKLY_MATRIX_VERSION);
  const [horizon] = matrix.horizons;
  assert.deepEqual(horizon.metrics.map((m) => m.id), [...PEER_RANK_METRIC_IDS]);
  assert.deepEqual(horizon.weeks.map((w) => w.week), ["2026-W02", "2026-W03", "2026-W04", "2026-W05"]);
  assert.deepEqual(horizon.weeks.map((w) => w.weekStart), ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"]);
  assert.equal(horizon.weeks[0].graded, 30);
  assert.equal(horizon.weeks[0].meanBenchmarkReturn, 0.01);
  for (const metric of horizon.metrics) assert.equal(metric.cells.length, 4);
  // A metric nobody ranked is still listed, with empty cells and no numbers.
  const never = row(matrix, "thirteenF");
  assert.equal(never.aggregate.n, 0);
  assert.equal(never.aggregate.rho, null);
  assert.ok(never.cells.every((cell) => cell.n === 0 && cell.rho === null && cell.spread === null));
  assert.equal(never.consistency.score, null);
  assert.equal(matrixWeekKey("2026-01-05"), isoWeekKey("2026-01-05"));
});

test("a pitch belongs to the week of its ENTRY date, not the week it was pitched", () => {
  // Pitched Friday evening 2026-01-09, entered Monday 2026-01-12 → week 3.
  const pitches = [{ id: "fri", pitchedAt: "2026-01-09T23:40:00Z", peers: { ranks: { revGrowth: { status: "ranked", percentile: 0.8 } } } }];
  const outcomes = [{ pitchId: "fri", horizonDays: 5, status: "matured", entryDate: "2026-01-12", excessReturn: 0.02, benchmarkReturn: 0 }];
  const matrix = buildWeeklyMatrix({ pitches, outcomes });
  assert.deepEqual(matrix.horizons[0].weeks.map((w) => w.week), ["2026-W03"]);
});

test("planted effects come out with the right sign, weekly tally and consistency", () => {
  const { pitches, outcomes } = synthetic({ effects: { revGrowth: 0.08, peerValuation: -0.08 } });
  const matrix = buildWeeklyMatrix({ pitches, outcomes });
  const strong = row(matrix, "revGrowth");
  assert.ok(strong.aggregate.rho > 0.4, `positive metric: ${strong.aggregate.rho}`);
  assert.equal(strong.weeksUsed, 10);
  assert.equal(strong.weeksPositive, 10);
  assert.ok(strong.consistency.score > 2, `reliable week to week: ${strong.consistency.score}`);
  assert.ok(strong.cells.some((cell) => cell.significant));
  assert.ok(strong.spread.overall > 0.03, "the top fifth beat the bottom fifth");
  assert.equal(strong.spread.weeksUsed, 10);
  assert.ok(strong.spread.sdWeekly < strong.spread.meanWeekly, "a stable spread varies less than its own size");

  const backwards = row(matrix, "peerValuation");
  assert.ok(backwards.aggregate.rho < -0.4);
  assert.equal(backwards.weeksNegative, 10);
  assert.ok(backwards.consistency.score < -2);
  assert.ok(backwards.spread.overall < -0.03);

  const noise = row(matrix, "marginTrend");
  assert.ok(Math.abs(noise.aggregate.rho) < 0.15, `noise stays near zero: ${noise.aggregate.rho}`);
  assert.ok(noise.weeksPositive < 10 && noise.weeksNegative < 10);
});

test("one bad week does not sink a metric: the aggregate holds and the tally shows the week", () => {
  const { pitches, outcomes } = synthetic({ effects: { revGrowth: (week) => (week === 4 ? -0.08 : 0.08) } });
  const metric = row(buildWeeklyMatrix({ pitches, outcomes }), "revGrowth");
  assert.ok(metric.cells[4].rho < 0, "the bad week is visible in its own column");
  assert.equal(metric.weeksPositive, 9);
  assert.equal(metric.weeksNegative, 1);
  assert.ok(metric.aggregate.rho > 0.25, `aggregate still clearly positive: ${metric.aggregate.rho}`);
  assert.ok(metric.consistency.score > 0);
});

test("a thin weekly cell reports its count and no correlation; immature outcomes are left out", () => {
  const { pitches, outcomes } = synthetic({ weeks: 3, perWeek: 12, effects: { revGrowth: 0.08 } });
  // Week 2: all but 6 pitches have not matured yet.
  const thinned = outcomes.map((o) => {
    const [, week, index] = o.pitchId.split("-").map(Number);
    return week === 1 && index >= 6 ? { ...o, status: "immature", excessReturn: undefined } : o;
  });
  const matrix = buildWeeklyMatrix({ pitches, outcomes: thinned });
  const metric = row(matrix, "revGrowth");
  assert.equal(matrix.horizons[0].weeks[1].graded, 6);
  assert.deepEqual({ n: metric.cells[1].n, rho: metric.cells[1].rho, spread: metric.cells[1].spread, significant: metric.cells[1].significant }, { n: 6, rho: null, spread: null, significant: false });
  assert.equal(metric.cells[0].n, 12);
  assert.notEqual(metric.cells[0].rho, null);
  assert.equal(metric.weeksUsed, 2);
  assert.equal(metric.consistency.score, null, "two usable weeks are not enough for a consistency score");
});

test("the top-vs-bottom spread is the top fifth's mean excess return minus the bottom fifth's", () => {
  const percentiles = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 0.95];
  const returns = [-0.03, -0.01, 0, 0.01, 0, 0.02, 0.01, 0, 0.04, 0.06];
  const pitches = percentiles.map((percentile, i) => ({ id: `s${i}`, pitchedAt: "2026-01-05T23:40:00Z", peers: { ranks: { revGrowth: { status: "ranked", percentile } } } }));
  const outcomes = returns.map((excessReturn, i) => ({ pitchId: `s${i}`, horizonDays: 5, status: "matured", entryDate: "2026-01-06", excessReturn, benchmarkReturn: 0 }));
  const metric = row(buildWeeklyMatrix({ pitches, outcomes }), "revGrowth", 5);
  // top fifth = 0.9, 0.95 → mean 0.05; bottom fifth = 0.05, 0.1 → mean -0.02.
  assert.equal(metric.cells[0].spread, 0.07);
  assert.equal(metric.spread.overall, 0.07);
  assert.equal(metric.spread.sdWeekly, null, "one week has no week-to-week variation to report");
});

test("a metric clearly weaker than the others is flagged even when the others are only modest", () => {
  const { pitches, outcomes } = synthetic({
    weeks: 12, perWeek: 40,
    effects: { revGrowth: 0.02, epsTrajectory: 0.02, marginTrend: 0.02, peerValuation: 0.02, balanceSheet: -0.03 },
  });
  const matrix = buildWeeklyMatrix({ pitches, outcomes });
  const weak = row(matrix, "balanceSheet");
  assert.equal(weak.relative.status, "below_others");
  assert.ok(weak.relative.ci95[1] < 0, "the whole interval of the difference sits below zero");
  assert.equal(weak.relative.comparedWith, 4);
  assert.equal(row(matrix, "revGrowth").relative.status, "in_line");
  // A metric with no data is never compared.
  assert.deepEqual({ status: row(matrix, "thirteenF").relative.status, reason: row(matrix, "thirteenF").relative.reason }, { status: "unavailable", reason: "no_data_for_metric" });
  // Deterministic: the same inputs give the same intervals.
  assert.deepEqual(buildWeeklyMatrix({ pitches, outcomes }), matrix);
});

test("the weaker/stronger test is withheld below the sample minimums", () => {
  const { pitches, outcomes } = synthetic({ weeks: 3, perWeek: 12, effects: { balanceSheet: -0.08 } });
  const weak = row(buildWeeklyMatrix({ pitches, outcomes }), "balanceSheet");
  assert.deepEqual({ status: weak.relative.status, reason: weak.relative.reason, ci95: weak.relative.ci95 }, { status: "unavailable", reason: "not_enough_graded_pitches", ci95: null });
});

test("the report carries the matrix, and its Aggregate column is the report's own peer-rank block", () => {
  const { pitches, outcomes } = synthetic({ weeks: 9, perWeek: 12, effects: { revGrowth: 0.08 }, horizons: [5, 10] });
  const report = analyzePitchLab({ pitches, outcomes, now: new Date("2026-04-01T00:00:00Z"), options: { bootstrapIterations: 200, matrix: { relativeIterations: 100 } } });
  assert.deepEqual(report.weeklyMatrix.horizons.map((h) => h.horizonDays), [5, 10]);
  const all = report.periods.find((p) => p.id === "all");
  for (const horizon of all.horizons) {
    for (const block of horizon.peerMetrics) {
      const metric = row(report.weeklyMatrix, block.id, horizon.horizonDays);
      assert.equal(metric.aggregate.rho, block.spearman.rho);
      assert.deepEqual(metric.aggregate.ci95, block.spearman.ci95);
      assert.equal(metric.aggregate.verdict, block.verdict.label);
      assert.equal(metric.aggregate.excessReturnPerSd.qValue, block.excessReturnPerSd.qValue);
      assert.equal(metric.aggregate.n, block.coverage.present);
    }
  }
  assert.equal(row(report.weeklyMatrix, "revGrowth", 10).aggregate.verdict, "positive");
  assert.doesNotThrow(() => JSON.stringify(report.weeklyMatrix));
});

test("trimWeeklyMatrix keeps the most recent weeks and leaves the aggregate alone", () => {
  const { pitches, outcomes } = synthetic({ weeks: 6, perWeek: 12, effects: { revGrowth: 0.08 } });
  const matrix = buildWeeklyMatrix({ pitches, outcomes });
  const trimmed = trimWeeklyMatrix(matrix, 4);
  assert.deepEqual(trimmed.horizons[0].weeks.map((w) => w.week), ["2026-W04", "2026-W05", "2026-W06", "2026-W07"]);
  assert.equal(trimmed.horizons[0].weeksOmitted, 2);
  assert.equal(row(trimmed, "revGrowth").cells.length, 4);
  assert.deepEqual(row(trimmed, "revGrowth").aggregate, row(matrix, "revGrowth").aggregate);
  assert.equal(row(trimmed, "revGrowth").weeksUsed, 6, "the tally still counts every week");
  assert.equal(matrix.horizons[0].weeks.length, 6, "the original is not modified");
  assert.equal(trimWeeklyMatrix(null, 4), null);
});
