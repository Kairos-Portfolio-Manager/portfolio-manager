/**
 * Pure parser for SEC EDGAR XBRL `companyfacts` JSON (Mandate v2.1 §8: EDGAR/XBRL is
 * the primary, free fundamentals source). Turns the raw fact soup into tidy quarterly
 * / annual / instant series the metric derivations (lib/edgar-metrics.js) consume.
 *
 * Grounded against live SEC data (AAPL, 2026-07). Key facts about the shape:
 *  - facts live at `companyfacts.facts["us-gaap"][Concept].units[unit]` (unit "USD"
 *    for money, "USD/shares" for EPS).
 *  - each fact: { start?, end, val, accn, fy, fp, form, filed, frame? }.
 *  - FLOW concepts (revenue, EPS, income) have start+end. A 10-Q reports BOTH the
 *    3-month quarter AND the 6-/9-month year-to-date for the same filing, so we
 *    isolate the clean quarter by DURATION (~90 days). 10-K adds the 12-month annual.
 *  - INSTANT concepts (Assets, Cash, Equity) have no `start` (balance-sheet snapshots).
 *  - the same period can be restated across filings → dedup by period, keep latest `filed`.
 *
 * Pure and NOT wired live. See docs/MANDATE-V2-INGESTION.md.
 */

/**
 * us-gaap concept fallback chains. The first concept in a chain that has data wins, except for
 * the chains in LATEST_WINS_CHAINS (below), where the concept with the most recent period wins.
 */
export const CONCEPTS = Object.freeze({
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "RevenuesNetOfInterestExpense",
  ],
  grossProfit: ["GrossProfit"],
  costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss"],
  epsDiluted: ["EarningsPerShareDiluted"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  interestExpense: ["InterestExpense", "InterestExpenseNonoperating"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  // --- Q-001 balance-sheet concepts (see docs/human-inputs/Q-001-...md) ---
  // Deliberately EXCLUDES RestrictedCash*: cash a company cannot deploy must not
  // offset debt. Note the `cash` chain above falls back to a restricted-inclusive
  // tag, so netCash uses `unrestrictedCash` below rather than reusing it.
  unrestrictedCash: ["CashAndCashEquivalentsAtCarryingValue"],
  shortTermInvestments: ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  currentDebt: ["LongTermDebtCurrent", "DebtCurrent", "ShortTermBorrowings"],
  // Operating leases are intentionally NOT part of the debt chain — see Q-001 D2.
  depreciationAmortization: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization",
    "Depreciation",
  ],
  // --- 13F denominator (unit "shares", INSTANT) ---
  // Period-END share count, so the ratio lands on the same date as the 13F holdings.
  // dei:EntityCommonStockSharesOutstanding is deliberately NOT in this chain: it is a
  // cover-page figure measured at FILING date, and that few-week skew against the 13F
  // period end makes a buyback read as institutional accumulation.
  sharesOutstanding: ["CommonStockSharesOutstanding"],
  // --- Agent 3 normalized EPS denominator (unit "shares", DURATION) ---
  dilutedShares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
});

/**
 * Chains where the concept with the MOST RECENT period wins (ties keep the chain order).
 * Companies switch revenue tags over the years (e.g. "Revenues" before ASC 606, then
 * "RevenueFromContractWithCustomer…"); taking the first tag with ANY data picked a series
 * that stopped years ago. Limited to the revenue/cost lines on purpose: for balance-sheet
 * chains (cash, debt) the order encodes a definition and must not be overridden by recency.
 * One series is never stitched together from two concepts.
 */
export const LATEST_WINS_CHAINS = new Set([CONCEPTS.revenue, CONCEPTS.costOfRevenue]);

/**
 * Flow lines whose missing quarters may be derived from the company's own cumulative figures
 * (see quarterlySeries). Excludes per-share and weighted-average figures (EPS, diluted shares),
 * which do not subtract.
 */
export const DERIVABLE_QUARTER_CHAINS = new Set([
  CONCEPTS.revenue,
  CONCEPTS.grossProfit,
  CONCEPTS.costOfRevenue,
  CONCEPTS.operatingIncome,
  CONCEPTS.netIncome,
  CONCEPTS.operatingCashFlow,
  CONCEPTS.interestExpense,
  CONCEPTS.depreciationAmortization,
]);
/** Lines that can never be negative: a negative derived quarter is a filing inconsistency, not data. */
const NON_NEGATIVE_CHAINS = new Set([CONCEPTS.revenue, CONCEPTS.costOfRevenue]);

const DAY = 86400000;
const durationDays = (f) => (f.start && f.end ? Math.round((Date.parse(f.end) - Date.parse(f.start)) / DAY) : null);
const isQuarter = (f) => { const d = durationDays(f); return d != null && d >= 80 && d <= 100; };
const isAnnual = (f) => { const d = durationDays(f); return d != null && d >= 350 && d <= 380; };
const isInstant = (f) => !f.start && !!f.end;

function normalizeSeriesOptions(unitOrOptions = "USD", options = {}) {
  const asOf = unitOrOptions && typeof unitOrOptions === "object" ? unitOrOptions.asOf ?? null : options?.asOf ?? null;
  if (asOf != null && (typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf)))) throw new RangeError(`Invalid asOf cutoff: ${String(asOf)}`);
  return unitOrOptions && typeof unitOrOptions === "object"
    ? { unit: unitOrOptions.unit ?? "USD", asOf }
    : { unit: unitOrOptions, asOf };
}

function filedOnOrBefore(fact, asOf) {
  if (!asOf) return true;
  const cutoff = Date.parse(asOf);
  const filed = Date.parse(fact.filed);
  return Number.isFinite(cutoff) && Number.isFinite(filed) && filed <= cutoff;
}

/**
 * Raw facts for one concept of a chain under `unit`: the first concept with data, or — for
 * LATEST_WINS_CHAINS, unless `options.latestWins === false` — the concept whose newest period
 * ends latest (ties keep the chain order).
 */
export function rawFacts(companyfacts, conceptChain, unit = "USD", options = {}) {
  const { unit: normalizedUnit, asOf } = normalizeSeriesOptions(unit, options);
  const latestWins = LATEST_WINS_CHAINS.has(conceptChain) && (unit && typeof unit === "object" ? unit.latestWins : options?.latestWins) !== false;
  const g = companyfacts?.facts?.["us-gaap"] ?? {};
  let best = null;
  for (const name of conceptChain) {
    const arr = g[name]?.units?.[normalizedUnit];
    if (!Array.isArray(arr) || !arr.length) continue;
    const available = arr.filter((fact) => filedOnOrBefore(fact, asOf));
    if (!available.length) continue;
    if (!latestWins) return { concept: name, facts: available };
    const newest = Math.max(...available.map((fact) => Date.parse(fact.end)).filter(Number.isFinite));
    if (!best || newest > best.newest) best = { concept: name, facts: available, newest };
  }
  return best ? { concept: best.concept, facts: best.facts } : { concept: null, facts: [] };
}

/** Dedup facts sharing a period key, keeping the latest-`filed`; sorted ascending by `end`. */
function dedupByPeriod(facts, keyFn) {
  const best = new Map();
  for (const f of facts) {
    const k = keyFn(f);
    const prev = best.get(k);
    if (!prev || Date.parse(f.filed) > Date.parse(prev.filed)) best.set(k, f);
  }
  return [...best.values()].sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
}

const tidy = (f, concept) => ({ end: f.end, start: f.start ?? null, val: f.val, fy: f.fy, fp: f.fp, form: f.form, filed: f.filed, frame: f.frame ?? null, concept });

/** Clean single-quarter series (3-month flows), deduped by end date, oldest→newest. */
export function quarterlySeries(companyfacts, conceptChain, unit = "USD", options = {}) {
  const { concept, facts } = rawFacts(companyfacts, conceptChain, unit, options);
  const reported = dedupByPeriod(facts.filter(isQuarter), (f) => f.end).map((f) => tidy(f, concept));
  const derive = (unit && typeof unit === "object" ? unit.deriveQuarters : options?.deriveQuarters) !== false;
  if (!derive || !DERIVABLE_QUARTER_CHAINS.has(conceptChain)) return reported;
  const derived = deriveMissingQuarters(facts, reported, { nonNegative: NON_NEGATIVE_CHAINS.has(conceptChain) })
    .map((q) => ({ ...tidy(q, concept), derived: q.derived }));
  return [...reported, ...derived].sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
}

const addDaysIso = (iso, days) => new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
const nearDays = (a, b, days) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;
const laterFiled = (a, b) => (Date.parse(a ?? "") >= Date.parse(b ?? "") ? a : b);

/**
 * Standalone quarters the company never filed as a 3-month figure, derived from its own
 * cumulative figures for the SAME fiscal year:
 *   - year-to-date differences: facts sharing a start date (3, 6, 9, 12 months) give each
 *     quarter as the difference of consecutive cumulative figures (cash-flow lines are filed
 *     year-to-date in every 10-Q; the fourth quarter only exists inside the 10-K's full year);
 *   - otherwise, fourth quarter = full year minus three contiguous quarters inside it.
 * A derived quarter must be 80-100 days long, is only used where no reported 3-month figure
 * ends within 10 days, carries the LATER filing date of its inputs (so it is never visible
 * before the filing that completes it), and is marked `derived`.
 */
export function deriveMissingQuarters(facts = [], reported = [], { nonNegative = false } = {}) {
  const durations = dedupByPeriod(facts.filter((f) => f.start && f.end && Number.isFinite(f.val)), (f) => `${f.start}|${f.end}`);
  const out = [];
  const have = (end) => reported.some((q) => nearDays(q.end, end, 10)) || out.some((q) => nearDays(q.end, end, 10));
  const accept = (quarter) => {
    const days = durationDays(quarter);
    if (days == null || days < 80 || days > 100) return;
    if (nonNegative && quarter.val < 0) return;
    if (have(quarter.end)) return;
    out.push(quarter);
  };

  // 1. Year-to-date differences within each fiscal year (same start date).
  const byStart = new Map();
  for (const f of durations) {
    const days = durationDays(f);
    if (days == null || days < 80 || days > 380) continue;
    if (!byStart.has(f.start)) byStart.set(f.start, []);
    byStart.get(f.start).push(f);
  }
  for (const group of byStart.values()) {
    group.sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
    for (let i = 1; i < group.length; i += 1) {
      const prior = group[i - 1];
      const current = group[i];
      accept({
        start: addDaysIso(prior.end, 1), end: current.end, val: current.val - prior.val,
        fy: current.fy, fp: current.fp, form: current.form, filed: laterFiled(current.filed, prior.filed), frame: null,
        derived: "year_to_date_difference",
      });
    }
  }

  // 2. Fourth quarter = full year minus three contiguous quarters inside it.
  const quarters = [...reported, ...out].sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
  for (const year of durations.filter(isAnnual)) {
    if (have(year.end)) continue;
    const inside = quarters.filter((q) => Date.parse(q.end) < Date.parse(year.end) - 60 * DAY && Date.parse(q.end) > Date.parse(year.start));
    if (inside.length !== 3) continue;
    const [q1, q2, q3] = inside;
    const contiguous = q1.start && nearDays(q1.start, year.start, 10) && nearDays(q2.start ?? q1.end, addDaysIso(q1.end, 1), 10) && nearDays(q3.start ?? q2.end, addDaysIso(q2.end, 1), 10);
    if (!contiguous) continue;
    accept({
      start: addDaysIso(q3.end, 1), end: year.end, val: year.val - q1.val - q2.val - q3.val,
      fy: year.fy, fp: "Q4", form: year.form, filed: [year.filed, q1.filed, q2.filed, q3.filed].reduce(laterFiled), frame: null,
      derived: "full_year_minus_quarters",
    });
  }
  return out;
}

/** Annual (12-month flow) series, deduped by end date, oldest→newest. */
export function annualSeries(companyfacts, conceptChain, unit = "USD", options = {}) {
  const { concept, facts } = rawFacts(companyfacts, conceptChain, unit, options);
  return dedupByPeriod(facts.filter(isAnnual), (f) => f.end).map((f) => tidy(f, concept));
}

/** Instant (balance-sheet) series, deduped by end date, oldest→newest. */
export function instantSeries(companyfacts, conceptChain, unit = "USD", options = {}) {
  const { concept, facts } = rawFacts(companyfacts, conceptChain, unit, options);
  return dedupByPeriod(facts.filter(isInstant), (f) => f.end).map((f) => tidy(f, concept));
}

/** Most recent instant value (e.g. latest total assets), or null. */
export function latestInstant(companyfacts, conceptChain, unit = "USD", options = {}) {
  const s = instantSeries(companyfacts, conceptChain, unit, options);
  return s.length ? s[s.length - 1] : null;
}

/**
 * Return the chronology-safe series available at a historical observation time.
 * `asOf` filters on filing date, not period end, so later restatements cannot
 * leak into a point-in-time observation.
 */
export function seriesAsOf(companyfacts, conceptChain, { unit = "USD", kind = "quarterly", asOf = null } = {}) {
  if (kind === "annual") return annualSeries(companyfacts, conceptChain, unit, { asOf });
  if (kind === "instant") return instantSeries(companyfacts, conceptChain, unit, { asOf });
  return quarterlySeries(companyfacts, conceptChain, unit, { asOf });
}

/** entityName/cik convenience. */
export const companyMeta = (companyfacts) => ({ cik: companyfacts?.cik ?? null, name: companyfacts?.entityName ?? null });
