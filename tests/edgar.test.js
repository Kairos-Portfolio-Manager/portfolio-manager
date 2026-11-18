import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rawFacts,
  quarterlySeries,
  annualSeries,
  instantSeries,
  latestInstant,
  CONCEPTS,
} from "../lib/edgar-facts.js";
import { ttm, yoyGrowthSeries, deriveFundamentalMetrics, edgarMetricSubset, cagrFromSeries, marginHistory, interestCoverageHistory, deriveHistoryPrimitives } from "../lib/edgar-metrics.js";

// --- synthetic companyfacts fixture -----------------------------------------
const QUARTER_ENDS = [
  "2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31",
  "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31",
];
const startFor = (end) => new Date(Date.parse(end) - 91 * 86400000).toISOString().slice(0, 10);
const flow = (end, val, fp = "Q1", form = "10-Q") => ({ start: startFor(end), end, val, fy: Number(end.slice(0, 4)), fp, form, filed: end, frame: null });
const instant = (end, val) => ({ end, val, fy: Number(end.slice(0, 4)), fp: "Q4", form: "10-Q", filed: end });

function facts(overrides = {}) {
  const rev = QUARTER_ENDS.map((e, i) => flow(e, [100, 100, 100, 100, 110, 120, 130, 140][i]));
  // A 6-month YTD fact for the same period — must be EXCLUDED by the duration filter.
  rev.push({ start: "2024-01-01", end: "2024-06-30", val: 230, fy: 2024, fp: "Q2", form: "10-Q", filed: "2024-07-01", frame: null });
  const gp = QUARTER_ENDS.map((e, i) => flow(e, [40, 40, 40, 40, 55, 60, 65, 70][i])); // 0.4× then 0.5× revenue
  const eps = QUARTER_ENDS.map((e, i) => flow(e, [1, 1, 1, 1, 1.1, 1.2, 1.3, 1.4][i]));
  const opInc = QUARTER_ENDS.map((e) => flow(e, 25));
  const intExp = QUARTER_ENDS.map((e) => flow(e, 5));
  const ocf = QUARTER_ENDS.map((e) => flow(e, 30));
  const g = {
    Revenues: { units: { USD: rev } }, // 2nd in the chain → tests fallback past the 1st
    GrossProfit: { units: { USD: gp } },
    EarningsPerShareDiluted: { units: { "USD/shares": eps } },
    OperatingIncomeLoss: { units: { USD: opInc } },
    InterestExpense: { units: { USD: intExp } },
    NetCashProvidedByUsedInOperatingActivities: { units: { USD: ocf } },
    Assets: { units: { USD: [instant("2024-12-31", 1000)] } },
    StockholdersEquity: { units: { USD: [instant("2024-12-31", 400)] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instant("2024-12-31", 200)] } },
    ...overrides,
  };
  return { cik: 1, entityName: "Test Co", facts: { "us-gaap": g } };
}

test("rawFacts falls through the concept chain to the first with data", () => {
  const r = rawFacts(facts(), CONCEPTS.revenue);
  assert.equal(r.concept, "Revenues"); // 1st (RevenueFromContract…) absent → falls to Revenues
  assert.ok(r.facts.length);
});

test("quarterlySeries keeps 3-month facts and drops the YTD fact", () => {
  const q = quarterlySeries(facts(), CONCEPTS.revenue);
  assert.equal(q.length, 8); // 8 quarters; the 181-day YTD fact excluded
  assert.ok(!q.some((f) => f.end === "2024-06-30" && f.val === 230));
  assert.deepEqual(q.map((f) => f.val), [100, 100, 100, 100, 110, 120, 130, 140]);
});

test("quarterlySeries dedups a restated period, keeping the latest filed", () => {
  const restated = facts();
  restated.facts["us-gaap"].Revenues.units.USD.push({ start: startFor("2024-12-31"), end: "2024-12-31", val: 145, fy: 2024, fp: "Q4", form: "10-K", filed: "2025-02-01", frame: null });
  const q = quarterlySeries(restated, CONCEPTS.revenue);
  assert.equal(q.find((f) => f.end === "2024-12-31").val, 145); // restatement (later filed) wins
});

test("instant vs latestInstant", () => {
  assert.equal(instantSeries(facts(), CONCEPTS.assets).length, 1);
  assert.equal(latestInstant(facts(), CONCEPTS.assets).val, 1000);
});

test("ttm sums the last four quarters", () => {
  assert.equal(ttm(quarterlySeries(facts(), CONCEPTS.operatingIncome)), 100);
  assert.equal(ttm([{ val: 1 }, { val: 2 }]), null); // <4
});

test("yoyGrowthSeries matches each quarter to ~1 year prior", () => {
  const s = yoyGrowthSeries(quarterlySeries(facts(), CONCEPTS.revenue));
  // 2024 quarters vs 2023 (all 100): 10%, 20%, 30%, 40%
  assert.deepEqual(s.map((x) => Math.round(x.growth * 100)), [10, 20, 30, 40]);
});

test("deriveFundamentalMetrics computes the v2.1 quantities", () => {
  const m = deriveFundamentalMetrics(facts());
  assert.equal(Math.round(m.revYoY * 100), 40); // latest YoY
  assert.equal(Math.round(m.revAccel * 100), 10); // 40% − 30%
  assert.equal(Math.round(m.epsYoY * 100), 40);
  assert.ok(Math.abs(m.grossMarginTrendYoY - 0.1) < 1e-9); // 0.5 − 0.4
  assert.equal(m.interestCoverage, 5); // ttm opInc 100 / ttm intExp 20
  assert.equal(m.cashRunwayQuarters, 999); // positive OCF → sentinel
  assert.equal(m.equityRatio, 0.4);
});

test("gross margin falls back to revenue minus cost of revenue when GrossProfit is not filed", () => {
  // Same economics as the fixture (cost 60% then 50% of revenue), filed as a cost line instead.
  const cost = QUARTER_ENDS.map((e, i) => flow(e, [60, 60, 60, 60, 55, 60, 65, 70][i]));
  const noGrossProfit = facts({ GrossProfit: { units: { USD: [] } }, CostOfRevenue: { units: { USD: cost } } });
  const m = deriveFundamentalMetrics(noGrossProfit);
  assert.ok(Math.abs(m.grossMarginTrendYoY - 0.1) < 1e-9); // (140-70)/140 − (100-60)/100 = 0.5 − 0.4
  assert.equal(m._grossMarginSource, "revenue_minus_cost_of_revenue");
  assert.equal(edgarMetricSubset(noGrossProfit).marginTrend, m.grossMarginTrendYoY, "the scorer's marginTrend picks it up");
  // Second tag in the chain works too.
  const goods = deriveFundamentalMetrics(facts({ GrossProfit: { units: { USD: [] } }, CostOfGoodsAndServicesSold: { units: { USD: cost } } }));
  assert.equal(goods._grossMarginSource, "revenue_minus_cost_of_revenue");
  // A filed GrossProfit always wins.
  assert.equal(deriveFundamentalMetrics(facts({ CostOfRevenue: { units: { USD: cost.map((f) => ({ ...f, val: 1 })) } } }))._grossMarginSource, "gross_profit");
  assert.equal(deriveFundamentalMetrics(facts())._grossMarginSource, "gross_profit");
});

test("gross margin never mixes sources and stays null when neither line is usable", () => {
  // GrossProfit only for the latest year, cost of revenue throughout: the YoY comparison needs
  // both quarters from one source, so the derived series is used for both.
  const gpLate = QUARTER_ENDS.slice(4).map((e, i) => flow(e, [999, 999, 999, 999][i]));
  const cost = QUARTER_ENDS.map((e, i) => flow(e, [60, 60, 60, 60, 55, 60, 65, 70][i]));
  const mixed = deriveFundamentalMetrics(facts({ GrossProfit: { units: { USD: gpLate } }, CostOfRevenue: { units: { USD: cost } } }));
  assert.equal(mixed._grossMarginSource, "revenue_minus_cost_of_revenue");
  assert.ok(Math.abs(mixed.grossMarginTrendYoY - 0.1) < 1e-9);
  // An airline-style filer: no gross profit, no cost of revenue.
  const neither = deriveFundamentalMetrics(facts({ GrossProfit: { units: { USD: [] } } }));
  assert.deepEqual({ value: neither.grossMarginTrendYoY, source: neither._grossMarginSource }, { value: null, source: null });
  // A cost line larger than revenue is a tagging problem, not a negative margin.
  const broken = deriveFundamentalMetrics(facts({ GrossProfit: { units: { USD: [] } }, CostOfRevenue: { units: { USD: cost.map((f) => ({ ...f, val: f.val * 10 })) } } }));
  assert.equal(broken.grossMarginTrendYoY, null);
});

test("zero-debt company gets the strong interest-coverage sentinel", () => {
  const f = facts({ InterestExpense: { units: { USD: [] } } });
  assert.equal(deriveFundamentalMetrics(f).interestCoverage, 999);
});

test("cash-burning company gets a finite runway", () => {
  const burn = QUARTER_ENDS.map((e) => flow(e, -40)); // −160 TTM → −40/qtr
  const f = facts({ NetCashProvidedByUsedInOperatingActivities: { units: { USD: burn } } });
  assert.equal(deriveFundamentalMetrics(f).cashRunwayQuarters, 200 / 40); // cash 200 / 40 = 5 quarters
});

test("edgarMetricSubset maps to config metric ids (first-cut YoY defaults)", () => {
  const s = edgarMetricSubset(facts());
  assert.equal(Math.round(s.revGrowth * 100), 40);
  assert.equal(Math.round(s.epsTrajectory * 100), 40);
  assert.equal(s.balanceSheet, 5);
  assert.ok(s._derived); // full bundle available for later per-agent binding
});

test("missing concepts degrade to null, never throw", () => {
  assert.doesNotThrow(() => deriveFundamentalMetrics({ facts: { "us-gaap": {} } }));
  const m = deriveFundamentalMetrics({ facts: { "us-gaap": {} } });
  assert.equal(m.revYoY, null);
  assert.equal(m.interestCoverage, null);
});

test("point-in-time series exclude facts filed after the observation cutoff", () => {
  const restated = facts();
  restated.facts["us-gaap"].Revenues.units.USD.push({ start: startFor("2024-12-31"), end: "2024-12-31", val: 999, fy: 2024, fp: "Q4", form: "10-K", filed: "2025-02-01", frame: null });
  const current = quarterlySeries(restated, CONCEPTS.revenue);
  const historical = quarterlySeries(restated, CONCEPTS.revenue, "USD", { asOf: "2025-01-01" });
  assert.equal(current.at(-1).val, 999);
  assert.equal(historical.at(-1).val, 140);
});

test("invalid point-in-time cutoff fails closed and concept fallback remains chronology-safe", () => {
  const companyfacts = facts({
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [{ ...flow("2024-12-31", 999), filed: "2025-02-01" }] } },
  });
  assert.throws(() => quarterlySeries(companyfacts, CONCEPTS.revenue, "USD", { asOf: "not-a-date" }), /Invalid asOf cutoff/);
  const historical = quarterlySeries(companyfacts, CONCEPTS.revenue, "USD", { asOf: "2025-01-01" });
  assert.equal(historical.at(-1).val, 140);
});

test("history primitives expose chronology-safe CAGR, margin, and coverage scaffolding", () => {
  const series = [
    { end: "2021-12-31", val: 100 },
    { end: "2022-12-31", val: 110 },
    { end: "2023-12-31", val: 121 },
    { end: "2024-12-31", val: 133.1 },
  ];
  assert.ok(Math.abs(cagrFromSeries(series, 3) - 0.1) < 0.002);
  assert.deepEqual(marginHistory([{ end: "2024-12-31", val: 50, filed: "2025-02-01" }], [{ end: "2024-12-31", val: 100, filed: "2025-03-01" }])[0], {
    end: "2024-12-31", margin: 0.5, filed: "2025-03-01", source: "sec_xbrl",
  });
  assert.equal(interestCoverageHistory([{ end: "2024-12-31", val: 20 }], [{ end: "2024-12-31", val: -5 }])[0].value, 4);
  assert.equal(interestCoverageHistory([{ end: "2024-12-31", val: 20 }], [{ end: "2024-12-31", val: 0 }])[0].value, null);
  const history = deriveHistoryPrimitives(facts(), { asOf: "2025-01-01" });
  assert.equal(history.revenueQuarterly.at(-1).val, 140);
  assert.equal(history.epsCagr3y, null);
  assert.ok(history.epsCagr3yRaw == null || typeof history.epsCagr3yRaw === "number");
  assert.equal(history.gates.estimates, "unavailable");
});
