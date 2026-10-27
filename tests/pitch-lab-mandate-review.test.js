import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { generateMandateReview, MANDATE_REVIEW_SCHEMA_VERSION } from "../lib/pitch-lab/mandate-review.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { generateDemoData } from "../lib/pitch-lab/demo-data.js";
import { AGENT_SCORING } from "../config/scoring/mandate-v2.js";
import { formatMandateReviewTelegram } from "../lib/pitch-lab/telegram.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const agentScoring = AGENT_SCORING["agent-1"];

function makeReport(overrides = {}) {
  const { pitches, outcomes } = generateDemoData({ now: new Date("2026-10-01T00:00:00Z") });
  return analyzePitchLab({ pitches, outcomes, now: new Date("2026-10-01T00:00:00Z"), ...overrides });
}

// ─── Schema ──────────────────────────────────────────────────────────────────

test("generateMandateReview returns the expected schemaVersion", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  assert.equal(review.schemaVersion, MANDATE_REVIEW_SCHEMA_VERSION);
});

test("throws if report schemaVersion is wrong", () => {
  assert.throws(
    () => generateMandateReview({ schemaVersion: "bad.v0" }, agentScoring),
    /schemaVersion/,
  );
});

test("throws if report is not an object", () => {
  assert.throws(() => generateMandateReview(null, agentScoring), /object/);
});

// ─── Data gate ───────────────────────────────────────────────────────────────

test("returns insufficient_data when the report has too few graded pitches", () => {
  const report = makeReport();
  // Patch the all-period to look like there are only 10 graded pitches.
  const patched = {
    ...report,
    periods: report.periods.map((p) =>
      p.id === "all"
        ? {
            ...p,
            horizons: p.horizons.map((h) => ({
              ...h,
              graded: 10,
              conviction: { ...h.conviction, n: 10, clusters: 3 },
            })),
          }
        : p,
    ),
  };
  const review = generateMandateReview(patched, agentScoring);
  assert.equal(review.status, "insufficient_data");
  assert.ok(review.insufficientData, "insufficientData block present");
  assert.ok(review.insufficientData.moreNeeded.pitches > 0);
  assert.equal(review.metrics.length, 0, "no metric suggestions when insufficient");
});

test("insufficient_data review has no conviction block", () => {
  const report = makeReport();
  const patched = {
    ...report,
    periods: report.periods.map((p) =>
      p.id === "all"
        ? { ...p, horizons: p.horizons.map((h) => ({ ...h, graded: 5, conviction: { ...h.conviction, n: 5, clusters: 2 } })) }
        : p,
    ),
  };
  const review = generateMandateReview(patched, agentScoring);
  assert.equal(review.conviction, null);
});

// ─── Sufficient data ─────────────────────────────────────────────────────────

test("demo data produces a review with status has_suggestions or no_suggestions (not insufficient_data)", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  assert.ok(["has_suggestions", "no_suggestions"].includes(review.status), `unexpected status: ${review.status}`);
});

test("review includes all mandate metric ids", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  const mandateIds = Object.values(agentScoring.categories).flatMap((cat) => Object.keys(cat.metrics));
  for (const id of mandateIds) {
    assert.ok(review.metrics.some((m) => m.metricId === id), `missing metric ${id}`);
  }
});

test("every metric has a confidenceLabel", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  const valid = new Set(["recommended", "watch", "no_change", "unavailable"]);
  for (const m of review.metrics) {
    assert.ok(valid.has(m.confidenceLabel), `invalid confidenceLabel "${m.confidenceLabel}" on ${m.metricId}`);
  }
});

test("suggestedDirection is only set when confidenceLabel is recommended or watch", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  for (const m of review.metrics) {
    if (m.confidenceLabel === "recommended" || m.confidenceLabel === "watch") {
      assert.ok(
        m.suggestedDirection === "more" || m.suggestedDirection === "less" || m.suggestedDirection === "review_direction",
        `expected a direction for ${m.metricId}, got ${m.suggestedDirection}`,
      );
    } else {
      assert.equal(m.suggestedDirection, null, `${m.metricId} should have no direction when ${m.confidenceLabel}`);
    }
  }
});

test("review always includes caveats", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  assert.ok(Array.isArray(review.caveats) && review.caveats.length > 0, "caveats must be present");
});

test("caveats are present even when insufficient_data", () => {
  const report = makeReport();
  const patched = { ...report, periods: report.periods.map((p) => p.id === "all" ? { ...p, horizons: p.horizons.map((h) => ({ ...h, graded: 0, conviction: { ...h.conviction, n: 0, clusters: 0 } })) } : p) };
  const review = generateMandateReview(patched, agentScoring);
  assert.ok(Array.isArray(review.caveats) && review.caveats.length > 0);
});

// ─── Fail-closed on malformed fields ────────────────────────────────────────

test("a metric with missing evidence blocks gets confidenceLabel unavailable (not a crash)", () => {
  const report = makeReport();
  // Strip all metrics from every horizon of the "all" period.
  const patched = {
    ...report,
    periods: report.periods.map((p) =>
      p.id === "all"
        ? { ...p, horizons: p.horizons.map((h) => ({ ...h, metrics: [] })) }
        : p,
    ),
  };
  const review = generateMandateReview(patched, agentScoring);
  // All mandate metrics should be present but unavailable (they were in mandateWeights).
  for (const m of review.metrics) {
    assert.equal(m.confidenceLabel, "unavailable", `expected unavailable for ${m.metricId}`);
  }
});

// ─── Conviction ───────────────────────────────────────────────────────────────

test("conviction block is present when data is sufficient", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  if (review.status !== "insufficient_data") {
    assert.ok(review.conviction, "conviction block should be present");
    assert.ok(Array.isArray(review.conviction.horizons));
  }
});

// ─── Money-path import guard ─────────────────────────────────────────────────

test("mandate-review module does not import money-path modules", () => {
  // Read the source file and look for forbidden import paths.
  const src = readFileSync(new URL("../lib/pitch-lab/mandate-review.js", import.meta.url), "utf8");
  const forbidden = [
    "contracts/",
    "redis.js",
    "investor-ledger",
    "proposal",
    "ledger",
    "mcp-accounting",
    "robinhood",
    "order",
    "broker",
  ];
  for (const pattern of forbidden) {
    assert.ok(!src.includes(`"${pattern}`) && !src.includes(`'${pattern}`), `mandate-review.js must not import "${pattern}"`);
  }
});

// ─── Telegram formatter ───────────────────────────────────────────────────────

test("formatMandateReviewTelegram includes paper-only footer", () => {
  const report = makeReport();
  const review = generateMandateReview(report, agentScoring);
  const msg = formatMandateReviewTelegram(review);
  assert.ok(typeof msg === "string" && msg.length > 0);
  assert.ok(msg.includes("no mandate change"), "must clarify no mandate change was made");
  assert.ok(msg.includes("Paper research only"), "must have paper research footer");
});

test("formatMandateReviewTelegram handles insufficient_data without crashing", () => {
  const msg = formatMandateReviewTelegram({ status: "insufficient_data", insufficientData: { gradedPitches: 5, independentWeeks: 2, moreNeeded: { pitches: 25, weeks: 6 } } });
  assert.ok(msg.includes("insufficient_data") || msg.includes("Not enough"), "should mention insufficient data");
  assert.ok(msg.includes("Paper research only"));
});

test("formatMandateReviewTelegram handles null input without crashing", () => {
  const msg = formatMandateReviewTelegram(null);
  assert.ok(typeof msg === "string");
});
