import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { diagnoseMissingData, reasonBefore, reasonNow, tickersToRecheck } from "../lib/pitch-lab/missing-data.js";

const fact = (start, end, val, filed = end, form = "10-Q") => ({ start, end, val, filed, form, fy: Number(end.slice(0, 4)), fp: null, frame: null });
const company = (concepts) => ({ facts: { "us-gaap": Object.fromEntries(Object.entries(concepts).map(([name, rows]) => [name, { units: { USD: rows } }])) } });
const quarters = (year, vals, { tag = "q" } = {}) => [
  fact(`${year}-01-01`, `${year}-03-31`, vals[0]), fact(`${year}-04-01`, `${year}-06-30`, vals[1]), fact(`${year}-07-01`, `${year}-09-30`, vals[2]),
  ...(vals[3] == null ? [] : [fact(`${year}-01-01`, `${year}-12-31`, vals[0] + vals[1] + vals[2] + vals[3], `${year + 1}-02-20`, "10-K")]),
];

// A company that files Q4 only inside its 10-K: the latest quarter is a fourth quarter.
const tenKSeason = company({
  Revenues: [...quarters(2024, [100, 100, 100, 100]), ...quarters(2025, [110, 120, 130, 160])],
  CostOfRevenue: [...quarters(2024, [60, 60, 60, 60]), ...quarters(2025, [60, 60, 60, 70])],
});
// A company whose first revenue tag stopped in 2018.
const switchedTag = company({
  RevenueFromContractWithCustomerExcludingAssessedTax: quarters(2018, [5, 5, 5]),
  Revenues: [...quarters(2024, [100, 100, 100]), ...quarters(2025, [110, 120, 130])],
});
// Airline-style: revenue but no gross-profit or cost line.
const noCost = company({ Revenues: [...quarters(2024, [100, 100, 100]), ...quarters(2025, [110, 120, 130])] });

const pitch = (ticker, perMetric, inputs = {}) => ({
  ticker, pitchedAt: "2026-03-01T23:40:00Z",
  mandateScore: { status: "scored", perMetric: { revGrowth: { points: 5, maxPoints: 15 }, marginTrend: { points: 5, maxPoints: 12 }, revBeat: { points: 5, maxPoints: 10 }, ...perMetric } },
  mandateInputs: { derived: { revYoY: 0.1, revAccel: null, grossMarginTrendYoY: null, _revenueQuarterSeries: [] }, consensus: null, ...inputs },
});
const missing = (fallbackMethod = "absolute") => ({ points: null, maxPoints: 15, missing: true, fallbackMethod });

test("before: the reason each metric was missing at pitch time, from the frozen inputs", () => {
  assert.equal(reasonBefore(pitch("A", { revGrowth: missing() }), "revGrowth"), "no_acceleration");
  assert.equal(reasonBefore(pitch("A", { revGrowth: missing() }, { derived: { revYoY: null } }), "revGrowth"), "no_revenue_series");
  assert.equal(reasonBefore(pitch("A", { revGrowth: missing() }, { derived: null }), "revGrowth"), "no_sec_data");
  assert.equal(reasonBefore(pitch("A", { marginTrend: missing() }), "marginTrend"), "no_margin_series");
  assert.equal(reasonBefore({ ticker: "OLD", mandateScore: { status: "scored", perMetric: {} } }, "revGrowth"), "no_frozen_inputs");
  assert.equal(reasonBefore(pitch("A", { revBeat: missing() }), "revBeat"), "no_consensus_history");
  // History exists but every snapshot was taken AFTER the latest report was filed.
  const late = { consensus: { history: [{ retrievedAt: "2026-02-25T12:00:00Z", periodEndDate: "2025-12-31T00:00:00Z", revenueAvg: 100 }] }, derived: { _revenueQuarterSeries: [{ end: "2025-12-31", val: 110, filed: "2026-02-20" }] } };
  assert.equal(reasonBefore(pitch("A", { revBeat: missing() }, late), "revBeat"), "no_pre_report_consensus");
  assert.equal(reasonBefore(pitch("A", { revBeat: missing() }, { consensus: late.consensus, derived: { _revenueQuarterSeries: [] } }), "revBeat"), "no_reported_quarter");
});

test("now: which change fills the gap, from today's filings", () => {
  // Revenue growth with acceleration needs two year-on-year points; the fourth quarter makes it possible.
  assert.equal(reasonNow(tenKSeason, "revGrowth"), "already_available", "three reported quarters a year already give two YoY points here");
  const onlyQ3AndYear = company({ Revenues: [fact("2024-07-01", "2024-09-30", 100), fact("2024-01-01", "2024-12-31", 400, "2025-02-20", "10-K"), fact("2024-01-01", "2024-09-30", 300, "2024-11-01"), fact("2025-07-01", "2025-09-30", 120), fact("2025-01-01", "2025-09-30", 330, "2025-11-01"), fact("2025-01-01", "2025-12-31", 470, "2026-02-20", "10-K")] });
  assert.equal(reasonNow(onlyQ3AndYear, "revGrowth"), "fixed_by_derived_quarters");
  assert.equal(reasonNow(switchedTag, "revGrowth"), "fixed_by_latest_revenue_tag");
  assert.equal(reasonNow(switchedTag, "revGrowth", { needsAcceleration: false }), "fixed_by_latest_revenue_tag");
  // Gross margin: cost of revenue fallback (from the previous release) vs no cost line at all.
  assert.equal(reasonNow(tenKSeason, "marginTrend"), "fixed_by_cost_of_revenue_fallback");
  assert.equal(reasonNow(noCost, "marginTrend"), "still_missing_no_cost_line");
  // Foreign and absent filers.
  assert.equal(reasonNow({ facts: { "ifrs-full": { Revenue: {} } } }, "revGrowth"), "still_missing_ifrs_filer");
  assert.equal(reasonNow(null, "marginTrend"), "still_missing_no_sec_data");
  assert.equal(reasonNow(company({ Assets: [fact("2025-01-01", "2025-03-31", 1)] }), "revGrowth"), "still_missing_no_revenue_tag");
  assert.equal(reasonNow(tenKSeason, "revBeat"), "needs_consensus_history");
});

test("the diagnosis counts each missing metric once per pitch, with tickers per reason", () => {
  const pitches = [
    pitch("TAG", { revGrowth: missing() }),
    pitch("AIR", { marginTrend: missing() }),
    pitch("BEAT", { revBeat: missing() }),
    pitch("FINE", {}),
    { ticker: "UNSCORED", mandateScore: { status: "unsupported" } },
  ];
  assert.deepEqual(tickersToRecheck(pitches), ["AIR", "TAG"]);
  const report = diagnoseMissingData(pitches, new Map([["TAG", switchedTag], ["AIR", noCost]]));
  assert.equal(report.pitches, 4);
  assert.deepEqual(report.metrics.revGrowth, { missing: 1, before: { no_acceleration: { count: 1, tickers: ["TAG"] } }, now: { fixed_by_latest_revenue_tag: { count: 1, tickers: ["TAG"] } } });
  assert.deepEqual(report.metrics.marginTrend.now, { still_missing_no_cost_line: { count: 1, tickers: ["AIR"] } });
  assert.deepEqual(report.metrics.revBeat, { missing: 1, before: { no_consensus_history: { count: 1, tickers: ["BEAT"] } }, now: { needs_consensus_history: { count: 1, tickers: ["BEAT"] } } });
  // A ticker that was not re-read is reported as such, never guessed.
  assert.deepEqual(diagnoseMissingData([pitch("TAG", { revGrowth: missing() })], new Map()).metrics.revGrowth.now, { not_rechecked: { count: 1, tickers: ["TAG"] } });
});

test("the diagnostic is read-only", () => {
  const script = readFileSync(new URL("../scripts/pitch-lab-missing-data.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /append|insert|sendMessage|writeFile|redis|publish/i);
  const lib = readFileSync(new URL("../lib/pitch-lab/missing-data.js", import.meta.url), "utf8");
  assert.deepEqual([...lib.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]), ["../edgar-facts.js", "../edgar-metrics.js", "../consensus-snapshot.js"]);
});
