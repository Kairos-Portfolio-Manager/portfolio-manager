/**
 * Pure derivations of the v2.1 EDGAR-sourced metrics from parsed XBRL series
 * (lib/edgar-facts.js). No I/O. See docs/MANDATE-V2-INGESTION.md.
 *
 * These compute the raw quantities; peer-relative ranking happens later in
 * lib/peer-scoring.js against the industry distribution. First-cut definitions are
 * marked; the per-agent metric definitions (Agent One = acceleration, Two = YoY,
 * Three = multi-year consistency) bind to these via config in a follow-up — this
 * module exposes all variants so that binding needs no recompute.
 */
import {
  CONCEPTS,
  quarterlySeries,
  annualSeries,
  latestInstant,
} from "./edgar-facts.js";

const DAY = 86400000;
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Trailing-twelve-month sum of the last 4 quarterly values, or null if <4. */
export function ttm(series) {
  if (!series || series.length < 4) return null;
  return series.slice(-4).reduce((s, f) => s + f.val, 0);
}

/**
 * NON-OVERLAPPING trailing-twelve-month windows at 4-quarter strides, anchored on the
 * newest quarter and walking backwards. Oldest→newest.
 *
 * Non-overlapping is the whole point: adjacent 1-quarter-stride windows share three of
 * four quarters, so one bad quarter contaminates four comparisons and any consistency
 * test (Agent 3's maxAnnualGrowthSpreadPoints) reads far smoother than reality. With a
 * 4-quarter stride each window is independent, so the year-over-year comparisons between
 * them are independent too.
 *
 * A window is emitted only when it holds exactly 4 quarters whose period ends span a
 * plausible year (3 gaps of ~90d). A gap in the filing history therefore truncates the
 * history instead of silently splicing two distant quarters into one "year".
 *
 * @param {{end:string,val:number}[]} quarters  oldest→newest quarterly duration facts
 * @param {number} [maxWindows]
 * @returns {{end:string, startEnd:string, val:number, quarters:number}[]} oldest→newest
 */
export function ttmWindows(quarters = [], maxWindows = 4) {
  if (!Array.isArray(quarters)) return [];
  const clean = quarters.filter((q) => q && Number.isFinite(q.val) && Number.isFinite(Date.parse(q.end)));
  const out = [];
  for (let i = 0; i < maxWindows; i++) {
    const end = clean.length - i * 4;
    const group = clean.slice(end - 4, end);
    if (group.length < 4) break;
    // 3 quarterly gaps ≈ 270d. Allow calendar drift but reject a spliced hole.
    const spanDays = (Date.parse(group[3].end) - Date.parse(group[0].end)) / DAY;
    if (!(spanDays >= 240 && spanDays <= 310)) break;
    out.push({
      end: group[3].end,
      startEnd: group[0].end,
      val: group.reduce((s, q) => s + q.val, 0),
      quarters: 4,
    });
  }
  return out.reverse();
}

/** Mean of the 4 quarterly values in each window — for weighted-average share counts. */
export function ttmWindowMeans(quarters = [], maxWindows = 4) {
  return ttmWindows(quarters, maxWindows).map((w) => ({ ...w, val: w.val / 4 }));
}

/** Pair two window series by window end → [{ end, a, b }] oldest→newest. */
export function alignWindows(windowsA = [], windowsB = []) {
  const bByEnd = new Map(windowsB.map((w) => [w.end, w.val]));
  return windowsA.filter((w) => bByEnd.has(w.end)).map((w) => ({ end: w.end, a: w.val, b: bByEnd.get(w.end) }));
}

/**
 * Year-over-year growth BETWEEN adjacent non-overlapping windows, as fractions,
 * oldest→newest. N windows yield N-1 comparisons — so Agent 3's `positiveGrowthYears == 3`
 * needs 4 windows, i.e. 16 clean quarters.
 *
 * A non-positive base is skipped rather than scored: growth off a zero or negative
 * base is not a percentage, and signing it would invert the comparison.
 */
export function windowGrowthSeries(windows = []) {
  const out = [];
  for (let i = 1; i < windows.length; i++) {
    const prior = windows[i - 1];
    const current = windows[i];
    if (!(prior.val > 0)) continue;
    out.push({ end: current.end, growth: (current.val - prior.val) / prior.val });
  }
  return out;
}

/**
 * Year-over-year growth for each quarter that has a match ~365 days earlier.
 * @returns [{ end, growth }] oldest→newest (growth as a fraction, e.g. 0.25)
 */
export function yoyGrowthSeries(quarters) {
  const out = [];
  for (const q of quarters) {
    const target = Date.parse(q.end) - 365 * DAY;
    const prior = quarters.find((p) => Math.abs(Date.parse(p.end) - target) <= 20 * DAY);
    if (prior && prior.val !== 0) out.push({ end: q.end, growth: (q.val - prior.val) / Math.abs(prior.val) });
  }
  return out;
}

const last = (a) => (a.length ? a[a.length - 1] : null);
const prev = (a) => (a.length >= 2 ? a[a.length - 2] : null);

/** Align two quarterly series by end date → [{ end, a, b }]. */
function alignByEnd(seriesA, seriesB) {
  const bByEnd = new Map(seriesB.map((f) => [f.end, f.val]));
  return seriesA.filter((f) => bByEnd.has(f.end)).map((f) => ({ end: f.end, a: f.val, b: bByEnd.get(f.end) }));
}

/**
 * Annualized compound growth between two positive observations. The elapsed
 * time is taken from the filed period ends, never from array position, so
 * irregular reporting calendars do not manufacture a three-year result.
 */
export function cagrFromSeries(series, years = 3) {
  if (!Array.isArray(series) || series.length < 2 || !Number.isFinite(years) || years <= 0) return null;
  const end = series[series.length - 1];
  const target = Date.parse(end?.end) - years * 365.25 * DAY;
  let start = null;
  for (const point of series) {
    const date = Date.parse(point?.end);
    if (Number.isFinite(date) && date <= target) start = point;
  }
  if (!start || !Number.isFinite(end?.val) || !Number.isFinite(start.val) || start.val <= 0 || end.val <= 0) return null;
  const elapsedYears = (Date.parse(end.end) - Date.parse(start.end)) / (365.25 * DAY);
  if (!Number.isFinite(elapsedYears) || elapsedYears <= 0) return null;
  return (end.val / start.val) ** (1 / elapsedYears) - 1;
}

/** Alias with a compact name for callers building mandate history records. */
export const cagr = cagrFromSeries;

/**
 * Gross-margin history aligned by period end. This is deliberately only a
 * margin calculation; it does not infer profitability or a sector rule.
 */
export function marginHistory(grossProfitSeries = [], revenueSeries = []) {
  const revenueByEnd = new Map(revenueSeries.map((row) => [row.end, row]));
  return grossProfitSeries
    .filter((row) => revenueByEnd.has(row.end) && Number.isFinite(row.val) && Number.isFinite(revenueByEnd.get(row.end).val) && revenueByEnd.get(row.end).val !== 0)
    .map((row) => {
      const revenue = revenueByEnd.get(row.end);
      return {
        end: row.end,
        margin: row.val / revenue.val,
        filed: [row.filed, revenue.filed].filter(Boolean).sort().at(-1) ?? null,
        source: "sec_xbrl",
      };
    });
}

/** Latest quarter's margin minus the margin ~one year earlier, from ONE margin series. */
function yoyMarginChange(marginQ) {
  if (!marginQ.length) return null;
  const cur = last(marginQ);
  const target = Date.parse(cur.end) - 365 * DAY;
  const yearAgo = marginQ.find((m) => Math.abs(Date.parse(m.end) - target) <= 20 * DAY);
  return yearAgo ? cur.margin - yearAgo.margin : null;
}

/**
 * Gross-margin trend (YoY change in quarterly gross margin, in pp) and where it came from.
 *
 * Many companies never file the GrossProfit line; they file revenue and cost of revenue
 * instead, and gross profit is simply the difference. So:
 *   1. GrossProfit, when it covers both the latest quarter and the one a year earlier.
 *   2. Otherwise revenue minus cost of revenue, for both quarters.
 * The two are NEVER mixed within one comparison: a year-on-year change computed across a
 * change of source would measure the source switch, not the business.
 * A company with neither (airlines, banks and many service firms report no cost-of-revenue
 * line) stays null — the mandate's rescale leaves it out rather than scoring it zero.
 *
 * @returns {{ value: number|null, source: "gross_profit"|"revenue_minus_cost_of_revenue"|null }}
 */
export function grossMarginTrend(grossProfitQ = [], revenueQ = [], costOfRevenueQ = []) {
  const reported = yoyMarginChange(
    alignByEnd(grossProfitQ, revenueQ).map((r) => ({ end: r.end, margin: r.b !== 0 ? r.a / r.b : null })).filter((r) => r.margin != null),
  );
  if (finite(reported) != null) return { value: reported, source: "gross_profit" };
  const derived = yoyMarginChange(
    alignByEnd(revenueQ, costOfRevenueQ)
      // A cost line larger than revenue, or a non-positive revenue, is a tagging problem, not a margin.
      .filter((r) => Number.isFinite(r.a) && Number.isFinite(r.b) && r.a > 0 && r.b >= 0 && r.b <= r.a)
      .map((r) => ({ end: r.end, margin: (r.a - r.b) / r.a })),
  );
  if (finite(derived) != null) return { value: derived, source: "revenue_minus_cost_of_revenue" };
  return { value: null, source: null };
}

/**
 * Source-safe interest-coverage history. This is operating income divided by
 * absolute interest expense; it is not a net-debt/EBITDA proxy and therefore
 * cannot satisfy the still-open balance-sheet policy gate by itself.
 */
export function interestCoverageHistory(operatingIncomeSeries = [], interestExpenseSeries = []) {
  const interestByEnd = new Map(interestExpenseSeries.map((row) => [row.end, row]));
  return operatingIncomeSeries
    .filter((row) => interestByEnd.has(row.end) && Number.isFinite(row.val) && Number.isFinite(interestByEnd.get(row.end).val))
    .map((row) => {
      const interest = interestByEnd.get(row.end);
      const denominator = Math.abs(interest.val);
      return {
        end: row.end,
        value: denominator === 0 ? null : row.val / denominator,
        policyState: denominator === 0 ? "policy_unresolved" : null,
        definition: "operating_income_to_interest_expense",
        filed: [row.filed, interest.filed].filter(Boolean).sort().at(-1) ?? null,
        source: "sec_xbrl",
      };
    });
}

/**
 * Chronology-safe, advisory history bundle. Missing concepts remain empty/null;
 * no estimates, 13F, dead-money, net-cash, EBITDA, or taxonomy policy is
 * inferred here.
 */
export function deriveHistoryPrimitives(companyfacts, { asOf = null } = {}) {
  const seriesOptions = { asOf };
  const revenueQuarterly = quarterlySeries(companyfacts, CONCEPTS.revenue, "USD", seriesOptions);
  const revenueAnnual = annualSeries(companyfacts, CONCEPTS.revenue, "USD", seriesOptions);
  const grossProfitQuarterly = quarterlySeries(companyfacts, CONCEPTS.grossProfit, "USD", seriesOptions);
  const operatingIncomeQuarterly = quarterlySeries(companyfacts, CONCEPTS.operatingIncome, "USD", seriesOptions);
  const interestExpenseQuarterly = quarterlySeries(companyfacts, CONCEPTS.interestExpense, "USD", seriesOptions);
  const epsQuarterly = quarterlySeries(companyfacts, CONCEPTS.epsDiluted, "USD/shares", seriesOptions);
  return {
    asOf,
    revenueQuarterly,
    revenueAnnual,
    revenueCagr3y: cagrFromSeries(revenueAnnual, 3),
    epsQuarterly,
    epsCagr3y: null,
    epsCagr3yRaw: cagrFromSeries(epsQuarterly, 3),
    marginHistory: marginHistory(grossProfitQuarterly, revenueQuarterly),
    interestCoverageHistory: interestCoverageHistory(operatingIncomeQuarterly, interestExpenseQuarterly),
    gates: Object.freeze({
      estimates: "unavailable",
      consensus: "unavailable",
      thirteenF: "unavailable",
      deadMoney: "unavailable",
      netCash: "policy_unresolved",
      ebitda: "policy_unresolved",
      epsCagr: "normalization_required",
    }),
  };
}

/**
 * Compute the full EDGAR-derived fundamentals bundle for one company.
 * All fields are numbers or null. Nulls flow to the scoring engine's vendor-lag
 * rescale (never scored zero).
 */
export function deriveFundamentalMetrics(companyfacts) {
  const revQ = quarterlySeries(companyfacts, CONCEPTS.revenue);
  const revA = annualSeries(companyfacts, CONCEPTS.revenue);
  const gpQ = quarterlySeries(companyfacts, CONCEPTS.grossProfit);
  const epsQ = quarterlySeries(companyfacts, CONCEPTS.epsDiluted, "USD/shares");
  const opIncQ = quarterlySeries(companyfacts, CONCEPTS.operatingIncome);
  const intExpQ = quarterlySeries(companyfacts, CONCEPTS.interestExpense);
  const ocfQ = quarterlySeries(companyfacts, CONCEPTS.operatingCashFlow);

  // --- Revenue growth / acceleration (quarterly YoY) ---
  const revYoYSeries = yoyGrowthSeries(revQ);
  const revYoY = finite(last(revYoYSeries)?.growth ?? null);
  const revPrevYoY = finite(prev(revYoYSeries)?.growth ?? null);
  const revAccel = revYoY != null && revPrevYoY != null ? revYoY - revPrevYoY : null;

  // --- Multi-year revenue consistency (annual YoY, mean penalized by variance) ---
  let rev3yrConsistency = null;
  if (revA.length >= 4) {
    const g = [];
    for (let i = 1; i < revA.length; i++) if (revA[i - 1].val !== 0) g.push((revA[i].val - revA[i - 1].val) / Math.abs(revA[i - 1].val));
    const recent = g.slice(-3);
    if (recent.length >= 2) {
      const mean = recent.reduce((s, x) => s + x, 0) / recent.length;
      const variance = recent.reduce((s, x) => s + (x - mean) ** 2, 0) / recent.length;
      rev3yrConsistency = mean - Math.sqrt(variance); // high & steady growth ranks best
    }
  }

  // --- EPS trajectory (quarterly YoY of diluted EPS) ---
  const epsYoYSeries = yoyGrowthSeries(epsQ);
  const epsYoY = finite(last(epsYoYSeries)?.growth ?? null);
  const epsPrevYoY = finite(prev(epsYoYSeries)?.growth ?? null);
  const epsAccel = epsYoY != null && epsPrevYoY != null ? epsYoY - epsPrevYoY : null;

  // --- Gross-margin trend (YoY change in quarterly gross margin, in pp) ---
  const costQ = quarterlySeries(companyfacts, CONCEPTS.costOfRevenue);
  const { value: grossMarginTrendYoY, source: grossMarginSource } = grossMarginTrend(gpQ, revQ, costQ);

  // --- Balance-sheet strength (interest coverage; zero-debt = strong sentinel) ---
  const ttmOpInc = ttm(opIncQ);
  const ttmIntExp = ttm(intExpQ);
  const ttmOcf = ttm(ocfQ);
  let interestCoverage = null;
  if (ttmOpInc != null) {
    if (ttmIntExp == null || ttmIntExp === 0) interestCoverage = 999; // effectively no interest burden
    else interestCoverage = ttmOpInc / Math.abs(ttmIntExp);
  }

  // --- Cash runway (quarters) — only meaningful when burning cash ---
  const cash = finite(latestInstant(companyfacts, CONCEPTS.cash)?.val ?? null);
  let cashRunwayQuarters = null;
  if (cash != null && ttmOcf != null) cashRunwayQuarters = ttmOcf >= 0 ? 999 : cash / (Math.abs(ttmOcf) / 4);

  const assets = finite(latestInstant(companyfacts, CONCEPTS.assets)?.val ?? null);
  const equity = finite(latestInstant(companyfacts, CONCEPTS.equity)?.val ?? null);
  const equityRatio = assets && equity != null ? equity / assets : null;

  // --- Q-001 balance-sheet economics (docs/human-inputs/Q-001-...md) ---
  // D1: profitability is judged on TTM OPERATING income, not net income, so a
  // one-time tax/litigation/impairment item cannot flip a structurally profitable
  // company into the pre-profit track. TTM (not latest quarter) removes seasonality.
  const isProfitable = ttmOpInc == null ? null : ttmOpInc > 0;

  // D2: netCash = (unrestricted cash + short-term investments) - total debt.
  // Restricted cash is excluded; operating leases are not treated as debt.
  const unrestrictedCash = finite(latestInstant(companyfacts, CONCEPTS.unrestrictedCash)?.val ?? null);
  const shortTermInvestments = finite(latestInstant(companyfacts, CONCEPTS.shortTermInvestments)?.val ?? null);
  const longTermDebt = finite(latestInstant(companyfacts, CONCEPTS.longTermDebt)?.val ?? null);
  const currentDebt = finite(latestInstant(companyfacts, CONCEPTS.currentDebt)?.val ?? null);
  // A filer reporting neither debt tag is genuinely debt-free far more often than it
  // is a parsing miss, but we cannot prove that from absence alone. Require at least
  // one debt tag OR a positive equity ratio reading before asserting zero debt.
  const anyDebtReported = longTermDebt != null || currentDebt != null;
  const totalDebt = anyDebtReported ? (longTermDebt ?? 0) + (currentDebt ?? 0) : null;
  const liquidAssets = unrestrictedCash == null && shortTermInvestments == null
    ? null
    : (unrestrictedCash ?? 0) + (shortTermInvestments ?? 0);
  const netCash = liquidAssets != null && totalDebt != null ? liquidAssets - totalDebt > 0 : null;

  // D3: EBITDA fallback order. Never approximate EBITDA with operating income alone —
  // a missing D&A concept yields null, which the rule evaluator rescales out.
  const ttmDA = ttm(quarterlySeries(companyfacts, CONCEPTS.depreciationAmortization));
  const ebitda = ttmOpInc != null && ttmDA != null ? ttmOpInc + ttmDA : null;
  // Negative or zero EBITDA makes the ratio meaningless and, scored naively, would
  // sort as "excellent" — the single most dangerous failure mode in this metric.
  // Such a company is judged on the pre-profit cash-runway path instead.
  const netDebtEbitda = ebitda != null && ebitda > 0 && totalDebt != null && liquidAssets != null
    ? (totalDebt - liquidAssets) / ebitda
    : null;

  return {
    revYoY,
    revAccel,
    rev3yrConsistency,
    epsYoY,
    epsAccel,
    grossMarginTrendYoY,
    // Which filing line the margin came from: "gross_profit" (the company files GrossProfit),
    // "revenue_minus_cost_of_revenue" (it files cost of revenue instead), or null.
    _grossMarginSource: grossMarginSource,
    interestCoverage,
    cashRunwayQuarters,
    equityRatio,
    ttmOperatingIncome: ttmOpInc,
    isProfitable,
    ebitda,
    totalDebt,
    netCash,
    netDebtEbitda,
    // provenance for audit (Agent Four §8 requires source + timestamp on every field)
    _asOf: last(revQ)?.end ?? null,
    _revenueQuarters: revQ.length,
    // Reported quarters retained with their FILING dates, which the scalar fields
    // above cannot express. Pairing a revenue beat against the consensus observed
    // before the print (lib/consensus-snapshot.js selectRevenueBeatPair) needs to
    // know when each quarter became public, not just which period it covers —
    // without `filed` there is no way to tell a pre-report estimate from a
    // post-report one. Bounded to two years because this bundle is persisted per
    // ticker in the Redis peer-metrics cache.
    _revenueQuarterSeries: revQ.slice(-8).map((q) => ({ end: q.end, val: q.val, filed: q.filed })),
    // Agent 2's mandate names adjusted EPS, which cannot be substituted with this
    // GAAP series. Retain the authoritative filings for a future approved adapter,
    // but do not bind them into its evidence until that definition exists.
    _epsQuarterSeries: epsQ.slice(-8).map((q) => ({ end: q.end, val: q.val, filed: q.filed })),
  };
}

/**
 * Map the EDGAR bundle into the current config METRIC_IDS (first-cut, YoY defaults
 * shared across agents). Per-agent definitions (accel / YoY / multi-year) bind here
 * later. Returns only the EDGAR-sourced subset; other ids stay the caller's concern.
 */
export function edgarMetricSubset(companyfacts) {
  const m = deriveFundamentalMetrics(companyfacts);
  return {
    revGrowth: m.revYoY,
    epsTrajectory: m.epsYoY,
    marginTrend: m.grossMarginTrendYoY,
    balanceSheet: m.interestCoverage,
    _derived: m,
  };
}
