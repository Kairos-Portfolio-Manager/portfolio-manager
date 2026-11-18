import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { buildReviewExport } from "../lib/pitch-lab/review-export.js";
import { generateMandateReview } from "../lib/pitch-lab/mandate-review.js";
import { formatMandateReviewTelegram, formatPitchLabDailyTelegram } from "../lib/pitch-lab/telegram.js";
import { AGENT_SCORING } from "../config/scoring/mandate-v2.js";
import { buildVendorRevisionShadow, revisionBand, selfMeasuredRevision, vendorRevisionFromSnapshot } from "../lib/pitch-lab/vendor-revisions.js";

const day = (n) => new Date(Date.parse("2026-11-01T12:00:00Z") + n * 86_400_000).toISOString();
const Q4 = "2026-12-31T00:00:00.000Z";
const Q1 = "2027-03-31T00:00:00.000Z";
const snap = (n, epsAvg, { period = Q4, days30 = null, current = epsAvg } = {}) => ({
  retrievedAt: day(n), periodEndDate: period, epsAvg, revenueAvg: 1e9,
  vendorEpsTrend: { current, days7: null, days30, days60: null, days90: null },
  vendorEpsRevisions: { up30: 3, down30: 1, up7: 0, down7: 0 },
});

test("the vendor-reported 30-day change and the mandate bands", () => {
  assert.deepEqual(vendorRevisionFromSnapshot(snap(0, 1.05, { days30: 1.0 })).changePct, 5);
  assert.equal(vendorRevisionFromSnapshot(snap(0, 1.05, { days30: 1.0 })).band, "up_5_plus");
  assert.equal(vendorRevisionFromSnapshot(snap(0, 0.97, { days30: 1.0 })).band, "down");
  assert.equal(vendorRevisionFromSnapshot(snap(0, 1.0)), null, "no 30-days-ago figure, no vendor change");
  assert.equal(vendorRevisionFromSnapshot(null), null);
  assert.deepEqual([4.99, 2, 1.99, 0, -0.01, NaN].map(revisionBand), ["up_2_to_5", "up_2_to_5", "up_0_to_2", "up_0_to_2", "down", null]);
});

test("our own 30-day change uses a same-quarter pair 25-40 days apart, closest to 30", () => {
  const history = [snap(0, 1.0), snap(2, 1.01), snap(9, 1.02), snap(31, 1.04)];
  const self = selfMeasuredRevision(history);
  // Base is the snapshot 29 days before the newest (day 2), not the oldest (day 0, 31 days) — both qualify, 29 is closer to 30.
  assert.deepEqual({ from: self.fromAt, days: self.days, band: self.band }, { from: day(2), days: 29, band: "up_2_to_5" });
  assert.ok(Math.abs(self.changePct - (1.04 / 1.01 - 1) * 100) < 1e-3);
  // Not long enough yet.
  assert.equal(selfMeasuredRevision([snap(0, 1.0), snap(10, 1.1)]), null);
  // A quarter rollover is never a revision: the only 30-day-old snapshot is for a different quarter.
  assert.equal(selfMeasuredRevision([snap(0, 0.5, { period: Q4 }), snap(30, 1.2, { period: Q1 })]), null);
  // Too far apart is not a 30-day change either.
  assert.equal(selfMeasuredRevision([snap(0, 1.0), snap(60, 1.1)]), null);
});

const pitch = (ticker, pitchedDay, history) => ({ ticker, pitchedAt: day(pitchedDay), mandateInputs: { consensus: { snapshot: history.at(-1), history } } });

test("the shadow collects vendor figures first, then compares like with like", () => {
  // Before 30 days of our own history: vendor figures only.
  const early = buildVendorRevisionShadow([pitch("AAA", 5, [snap(0, 1.0), snap(5, 1.03, { days30: 1.0 })])]);
  assert.deepEqual({ status: early.status, vendor: early.tickersWithVendor, pairs: early.pairsCompared, verdict: early.verdict }, { status: "collecting", vendor: 1, pairs: 0, verdict: null });
  assert.equal(early.rows[0].vendorChangePct, 3);

  // After: the vendor figure from the SAME day as our newest snapshot is compared with our own change.
  const agreeing = buildVendorRevisionShadow([pitch("AAA", 31, [snap(1, 1.0), snap(31, 1.04, { days30: 1.0 })])]);
  assert.equal(agreeing.status, "comparing");
  const row = agreeing.rows[0];
  assert.deepEqual({ self: row.selfChangePct, vendor: row.vendorChangePctSameWindow, gap: row.differencePoints, sameBand: row.sameBand }, { self: 4, vendor: 4, gap: 0, sameBand: true });

  // Only the latest pitch per ticker counts; an older pitch of the same ticker is ignored.
  const twice = buildVendorRevisionShadow([pitch("AAA", 2, [snap(2, 1.0, { days30: 2.0 })]), pitch("AAA", 31, [snap(1, 1.0), snap(31, 1.04, { days30: 1.0 })])]);
  assert.equal(twice.rows.length, 1);
  assert.equal(twice.rows[0].vendorChangePct, 4);
  assert.deepEqual(buildVendorRevisionShadow([{ ticker: "X", pitchedAt: day(0) }]).status, "no_vendor_data");
});

test("with enough tickers the shadow gives a verdict on whether the vendor figure can be trusted", () => {
  const tickers = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, "0")}`);
  const matching = buildVendorRevisionShadow(tickers.map((t) => pitch(t, 31, [snap(1, 1.0), snap(31, 1.03, { days30: 1.0 })])));
  assert.deepEqual({ status: matching.status, verdict: matching.verdict, pairs: matching.agreement.pairs, same: matching.agreement.shareSameBand }, { status: "verdict", verdict: "vendor_matches", pairs: 20, same: 1 });
  // The vendor says +6% where we measured +3% on every ticker: a different band, a 3-point gap.
  const differing = buildVendorRevisionShadow(tickers.map((t) => pitch(t, 31, [snap(1, 1.0), snap(31, 1.03, { days30: 1.03 / 1.06 })])));
  assert.equal(differing.verdict, "vendor_differs");
  assert.equal(differing.agreement.shareSameBand, 0);
  assert.ok(Math.abs(differing.agreement.medianAbsDifferencePoints - 3) < 1e-3);
});

test("the shadow rides on the report, the review, the export and both Telegram messages, and is never scored", () => {
  const history = [snap(0, 1.0), snap(4, 1.02, { days30: 1.0 })];
  const p = {
    id: "p1", ticker: "AAA", pitchedAt: day(4), conviction: 6, convictionScale: 10, features: {}, peers: null,
    mandateInputs: { consensus: { snapshot: history.at(-1), history } },
    mandateScore: { status: "scored", total: 50, uncappedTotal: 50, rawPoints: 7.5, maxAvailable: 15, perMetric: { revGrowth: { points: 7.5, maxPoints: 15, percentile: 0.7, fallbackMethod: "peer_relative", missing: false }, estimateRevisions: { points: null, maxPoints: 12, missing: true } } },
  };
  const daily = formatPitchLabDailyTelegram({ date: "2026-11-05", pitches: [p] });
  assert.match(daily, /Analyst estimate revisions: building history \(2 of 3 snapshots, 4 of 30 days\), not scored; vendor-reported 30-day change \+2\.0% \(shadow only\)/);

  const report = analyzePitchLab({ pitches: [p], outcomes: [], now: new Date(day(5)) });
  assert.equal(report.vendorRevisionShadow.status, "collecting");
  const review = generateMandateReview(report, AGENT_SCORING["agent-1"], { now: new Date(day(5)) });
  assert.equal(review.status, "insufficient_data");
  assert.equal(review.vendorRevisionShadow.tickersWithVendor, 1);
  assert.match(formatMandateReviewTelegram(review), /Estimate revisions check \(vendor vs our own 30-day change; shadow, not scored\)\nVendor figures on 1 pitched tickers; our own 30-day history is not long enough to compare yet\./);
  const sheet = buildReviewExport({ review, report, pitches: [p], outcomes: [] }).find((s) => s.name === "Revisions check");
  assert.ok(sheet.rows.some((row) => row[0] === "AAA" && row[2] === 2));
  // The score itself is untouched: still unscored, no points.
  assert.equal(p.mandateScore.perMetric.estimateRevisions.points, null);
  for (const file of ["../lib/pitch-lab/vendor-revisions.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.deepEqual([...src.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)], [], "pure, no imports");
    assert.doesNotMatch(src, /mandateScore\s*=|perMetric\[.*\]\s*=/, "never writes a score");
  }
});
