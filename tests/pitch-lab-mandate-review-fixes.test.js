import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMandateReview, reviewPeriod } from "../lib/pitch-lab/mandate-review.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { generateDemoData } from "../lib/pitch-lab/demo-data.js";
import { AGENT_SCORING } from "../config/scoring/mandate-v2.js";
import { openPostgresPitchStore } from "../lib/pg/pitch-lab-store.js";
import { runPitchLabMandateReview } from "../jobs/pitch-lab-daily.js";

const agentScoring = AGENT_SCORING["agent-1"];
const NOW = new Date("2026-10-03T15:00:00Z");
const METRIC_ID = Object.values(agentScoring.categories).flatMap((cat) => Object.keys(cat.metrics))[0];
const HIGHER_IS_BETTER = Object.values(agentScoring.categories).flatMap((cat) => Object.entries(cat.metrics)).find(([id]) => id === METRIC_ID)[1].higherIsBetter ?? true;

function makeReport() {
  const { pitches, outcomes } = generateDemoData({ now: new Date("2026-10-01T00:00:00Z") });
  return analyzePitchLab({ pitches, outcomes, now: new Date("2026-10-01T00:00:00Z") });
}

/** Give METRIC_ID exactly the supplied per-horizon blocks (by index); other horizons carry no block for it. */
function withMetricBlocks(report, blocks) {
  return {
    ...report,
    periods: report.periods.map((p) => p.id !== "all" ? p : {
      ...p,
      horizons: p.horizons.map((h, i) => ({
        ...h,
        metrics: [
          ...(h.metrics ?? []).filter((m) => m?.id !== METRIC_ID),
          ...(blocks[i] ? [{ id: METRIC_ID, label: "Test metric", ...blocks[i] }] : []),
        ],
      })),
    }),
  };
}

const sig = (label, qValue = 0.01) => ({ verdict: { label }, excessReturnPerSd: { estimate: label === "negative" ? -0.2 : 0.2, ci95: [-0.1, 0.4], qValue } });
const metricOf = (review) => review.metrics.find((m) => m.metricId === METRIC_ID);

// ─── Finding 1: opposite directions are never a recommendation ───────────────

test("two significant horizons pointing opposite ways are a conflict, not a recommendation", () => {
  const report = withMetricBlocks(makeReport(), [sig("positive"), sig("negative")]);
  const metric = metricOf(generateMandateReview(report, agentScoring, { now: NOW }));
  assert.equal(metric.confidenceLabel, "no_change");
  assert.equal(metric.suggestedDirection, null);
  assert.equal(metric.directionConflict, true);
});

test("a conflict is not rescued by a third agreeing horizon", () => {
  const report = withMetricBlocks(makeReport(), [sig("positive"), sig("positive"), sig("negative")]);
  const horizons = report.periods.find((p) => p.id === "all").horizons;
  assert.ok(horizons.length >= 3, "demo data has at least three horizons");
  const metric = metricOf(generateMandateReview(report, agentScoring, { now: NOW }));
  assert.equal(metric.confidenceLabel, "no_change");
  assert.equal(metric.suggestedDirection, null);
});

test("two significant horizons that agree are still recommended, with a direction", () => {
  const report = withMetricBlocks(makeReport(), [sig("positive"), sig("positive")]);
  const metric = metricOf(generateMandateReview(report, agentScoring, { now: NOW }));
  assert.equal(metric.confidenceLabel, "recommended");
  assert.equal(metric.suggestedDirection, HIGHER_IS_BETTER ? "more" : "review_direction");
  assert.equal(metric.directionConflict, undefined);
});

test("one significant horizon stays a watch", () => {
  const report = withMetricBlocks(makeReport(), [sig("positive"), sig("positive", 0.5)]);
  const metric = metricOf(generateMandateReview(report, agentScoring, { now: NOW }));
  assert.equal(metric.confidenceLabel, "watch");
});

test("conviction summary does not recommend when horizons disagree", () => {
  const report = makeReport();
  const labels = ["positive", "negative"];
  const patched = {
    ...report,
    periods: report.periods.map((p) => p.id !== "all" ? p : {
      ...p,
      horizons: p.horizons.map((h, i) => ({ ...h, conviction: { ...h.conviction, verdict: { label: labels[i] ?? "inconclusive" } } })),
    }),
  };
  const { conviction } = generateMandateReview(patched, agentScoring, { now: NOW });
  assert.equal(conviction.confidenceLabel, "no_change");
  assert.equal(conviction.overallVerdict, "inconclusive");
});

// ─── Finding 4: malformed evidence is unavailable, never "no change" ─────────

test("blocks with a missing or non-numeric q-value are unavailable", () => {
  const report = withMetricBlocks(makeReport(), [
    { verdict: { label: "positive" }, excessReturnPerSd: { qValue: Number.NaN } },
    { verdict: { label: "positive" }, excessReturnPerSd: { qValue: "0.01" } },
  ]);
  const metric = metricOf(generateMandateReview(report, agentScoring, { now: NOW }));
  assert.equal(metric.confidenceLabel, "unavailable");
  assert.equal(metric.suggestedDirection, null);
});

test("blocks with no verdict label or an unknown one are unavailable", () => {
  const report = withMetricBlocks(makeReport(), [{ excessReturnPerSd: { qValue: 0.01 } }, { verdict: { label: "maybe" }, excessReturnPerSd: { qValue: 0.01 } }]);
  const metric = metricOf(generateMandateReview(report, agentScoring, { now: NOW }));
  assert.equal(metric.confidenceLabel, "unavailable");
});

test("a well-formed inconclusive metric is still no_change", () => {
  const report = withMetricBlocks(makeReport(), [{ verdict: { label: "inconclusive" } }, { verdict: { label: "inconclusive" } }]);
  assert.equal(metricOf(generateMandateReview(report, agentScoring, { now: NOW })).confidenceLabel, "no_change");
});

test("a malformed block cannot create a recommendation alongside one good block", () => {
  const report = withMetricBlocks(makeReport(), [sig("positive"), { verdict: { label: "positive" }, excessReturnPerSd: { qValue: null } }]);
  assert.equal(metricOf(generateMandateReview(report, agentScoring, { now: NOW })).confidenceLabel, "watch");
});

// ─── Finding 2: one identity per period and content ──────────────────────────

test("reviewPeriod is the US Eastern calendar month", () => {
  assert.equal(reviewPeriod(new Date("2026-11-01T03:00:00Z")), "2026-10"); // 23:00 ET on Oct 31
  assert.equal(reviewPeriod(new Date("2026-11-01T06:00:00Z")), "2026-11");
  assert.equal(generateMandateReview(makeReport(), agentScoring, { now: NOW }).period, "2026-10");
});

function fakePool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      if (sql.startsWith("INSERT INTO pitch_lab_mandate_reviews")) {
        if (rows.has(params[0])) throw Object.assign(new Error("duplicate key"), { code: "23505" });
        rows.set(params[0], params[4]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM pitch_lab_mandate_reviews")) return { rows: [...rows.values()].map((record) => ({ record })) };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test("a retry on identical data a minute later maps to the same id and is rejected as a duplicate", async () => {
  const pool = fakePool();
  const store = openPostgresPitchStore({ pool });
  const report = makeReport();
  const first = await store.appendMandateReview(generateMandateReview(report, agentScoring, { now: NOW }));
  await assert.rejects(
    () => store.appendMandateReview(generateMandateReview(report, agentScoring, { now: new Date(NOW.getTime() + 60_000) })),
    (error) => error.code === "mandate_review_already_recorded" && error.reviewId === first.id,
  );
  assert.equal(pool.rows.size, 1);
});

test("different content in the same period is a new row (a correction)", async () => {
  const pool = fakePool();
  const store = openPostgresPitchStore({ pool });
  const report = makeReport();
  const a = await store.appendMandateReview(generateMandateReview(report, agentScoring, { now: NOW }));
  const changed = withMetricBlocks(report, [sig("positive"), sig("positive")]);
  const b = await store.appendMandateReview(generateMandateReview(changed, agentScoring, { now: NOW }));
  assert.notEqual(a.id, b.id);
  assert.equal(pool.rows.size, 2);
});

test("the store refuses a review without a YYYY-MM period", async () => {
  const store = openPostgresPitchStore({ pool: fakePool() });
  const { period: _period, ...noPeriod } = generateMandateReview(makeReport(), agentScoring, { now: NOW });
  await assert.rejects(() => store.appendMandateReview(noPeriod), /period/);
});

test("running the monthly job twice stores one row and sends one Telegram digest", async () => {
  const { pitches, outcomes } = generateDemoData({ now: new Date("2026-10-01T00:00:00Z") });
  const pool = fakePool();
  const store = { ...openPostgresPitchStore({ pool }), listPitches: async () => pitches, listOutcomes: async () => outcomes };
  const values = new Map();
  const redis = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, options = {}) { if (options.nx && values.has(key)) return null; values.set(key, value); return "OK"; },
    async del(key) { values.delete(key); },
  };
  let sends = 0;
  const env = { PITCH_LAB_ENABLED: "1" };
  const send = async () => { sends += 1; };
  const first = await runPitchLabMandateReview({ env, now: () => NOW, store, redis, send });
  const second = await runPitchLabMandateReview({ env, now: () => new Date(NOW.getTime() + 300_000), store, redis, send });
  assert.equal(first.stored, true);
  assert.equal(second.stored, true);
  assert.equal(pool.rows.size, 1, "a rerun must not append a second review");
  assert.equal(sends, 1, "a rerun must not send a second digest");
});
