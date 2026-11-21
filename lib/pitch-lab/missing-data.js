/**
 * Why did a pitch say "no data" for revenue growth, gross-margin trend or revenue beat — and
 * does the current SEC-data code fill it? Read-only diagnosis.
 *
 *   before  from the inputs frozen on the pitch (what the scorer saw at pitch time)
 *   now     from the company's SEC filings re-read today with the current code, compared with
 *           the old rules (first revenue tag with any data; 3-month figures only; no
 *           cost-of-revenue fallback) to say WHICH change fills the gap.
 *
 * "now" reads today's filings, so a later filing can also explain a change; the counts are a
 * guide to which cause matters most, not a re-score.
 *
 * Pure: pitches and companyfacts in, counts out. scripts/pitch-lab-missing-data.js does the I/O.
 */
import { CONCEPTS, quarterlySeries, rawFacts } from "../edgar-facts.js";
import { grossMarginTrend, yoyGrowthSeries } from "../edgar-metrics.js";
import { selectRevenueBeatPair } from "../consensus-snapshot.js";

export const DIAGNOSED_METRICS = Object.freeze(["revGrowth", "marginTrend", "revBeat"]);

const isMissing = (pitch, id) => {
  const entry = pitch?.mandateScore?.status === "scored" ? pitch.mandateScore.perMetric?.[id] : null;
  return Boolean(entry && (entry.missing || !Number.isFinite(entry.points)));
};

/** Why a metric was missing on this pitch, from what the scorer saw at pitch time. */
export function reasonBefore(pitch, metricId) {
  const inputs = pitch?.mandateInputs;
  if (!inputs) return "no_frozen_inputs";
  const derived = inputs.derived;
  const entry = pitch.mandateScore?.perMetric?.[metricId] ?? {};
  if (metricId === "revBeat") {
    const history = inputs.consensus?.history ?? [];
    if (!history.length) return "no_consensus_history";
    const quarters = derived?._revenueQuarterSeries ?? [];
    if (!quarters.length) return "no_reported_quarter";
    const pair = selectRevenueBeatPair({ history, revenueQuarters: quarters, asOf: pitch.pitchedAt });
    return pair.snapshot ? "other" : "no_pre_report_consensus";
  }
  if (!derived) return "no_sec_data";
  if (metricId === "revGrowth") {
    if (derived.revYoY == null) return "no_revenue_series";
    if (entry.fallbackMethod && entry.fallbackMethod !== "peer_relative" && derived.revAccel == null) return "no_acceleration";
    return "other";
  }
  if (metricId === "marginTrend") return derived.grossMarginTrendYoY == null ? "no_margin_series" : "other";
  return "other";
}

const latestYoY = (series) => {
  const yoy = yoyGrowthSeries(series);
  const last = yoy.at(-1)?.growth ?? null;
  const prev = yoy.at(-2)?.growth ?? null;
  return { yoy: Number.isFinite(last) ? last : null, accel: Number.isFinite(last) && Number.isFinite(prev) ? last - prev : null };
};

/** The four combinations of the two SEC-data changes, so a fix can be attributed to one of them. */
function revenueVariants(facts) {
  const variant = (latestWins, deriveQuarters) => quarterlySeries(facts, CONCEPTS.revenue, "USD", { latestWins, deriveQuarters });
  return { old: variant(false, false), tagOnly: variant(true, false), quartersOnly: variant(false, true), now: variant(true, true) };
}

function secShape(facts) {
  if (!facts) return "no_sec_data";
  const usGaap = facts?.facts?.["us-gaap"];
  if (!usGaap || !Object.keys(usGaap).length) return facts?.facts?.["ifrs-full"] ? "ifrs_filer" : "no_sec_data";
  if (!rawFacts(facts, CONCEPTS.revenue).concept) return "no_revenue_tag";
  return null;
}

/**
 * What today's code does for this company and metric.
 * @returns {string} "fixed_by_<change>" | "already_available" | "still_missing_<reason>"
 */
export function reasonNow(companyfacts, metricId, { needsAcceleration = true } = {}) {
  if (metricId === "revBeat") return "needs_consensus_history"; // filled by the consensus collector over time, not by SEC data
  const shape = secShape(companyfacts);
  if (shape) return `still_missing_${shape}`;
  const revenue = revenueVariants(companyfacts);
  if (metricId === "revGrowth") {
    const ok = (series) => {
      const { yoy, accel } = latestYoY(series);
      return yoy != null && (!needsAcceleration || accel != null);
    };
    if (ok(revenue.old)) return "already_available";
    if (!ok(revenue.now)) return latestYoY(revenue.now).yoy == null ? "still_missing_no_year_ago_quarter" : "still_missing_no_acceleration";
    if (ok(revenue.tagOnly)) return "fixed_by_latest_revenue_tag";
    if (ok(revenue.quartersOnly)) return "fixed_by_derived_quarters";
    return "fixed_by_both";
  }
  if (metricId === "marginTrend") {
    const gpOld = quarterlySeries(companyfacts, CONCEPTS.grossProfit, "USD", { deriveQuarters: false });
    const gpNow = quarterlySeries(companyfacts, CONCEPTS.grossProfit);
    const costOld = quarterlySeries(companyfacts, CONCEPTS.costOfRevenue, "USD", { deriveQuarters: false, latestWins: false });
    const costNow = quarterlySeries(companyfacts, CONCEPTS.costOfRevenue);
    if (grossMarginTrend(gpOld, revenue.old, []).value != null) return "already_available";
    const now = grossMarginTrend(gpNow, revenue.now, costNow);
    if (now.value == null) {
      const anyCost = rawFacts(companyfacts, CONCEPTS.grossProfit).concept || rawFacts(companyfacts, CONCEPTS.costOfRevenue).concept;
      return anyCost ? "still_missing_no_year_ago_quarter" : "still_missing_no_cost_line";
    }
    if (grossMarginTrend(gpOld, revenue.old, costOld).value != null) return "fixed_by_cost_of_revenue_fallback";
    return "fixed_by_derived_quarters_or_revenue_tag";
  }
  return "unknown_metric";
}

const bump = (counts, key, ticker) => {
  counts[key] ??= { count: 0, tickers: [] };
  counts[key].count += 1;
  if (ticker && !counts[key].tickers.includes(ticker)) counts[key].tickers.push(ticker);
};

/**
 * @param {object[]} pitches  stored pitches (with mandateScore + mandateInputs)
 * @param {Map<string,object|null>} factsByTicker  companyfacts re-read today (null when unavailable)
 * @returns {{ pitches: number, metrics: Record<string,{ missing:number, before:object, now:object }> }}
 */
export function diagnoseMissingData(pitches = [], factsByTicker = new Map()) {
  const scored = pitches.filter((pitch) => pitch?.mandateScore?.status === "scored");
  const metrics = {};
  for (const id of DIAGNOSED_METRICS) {
    const summary = { missing: 0, before: {}, now: {} };
    for (const pitch of scored) {
      if (!isMissing(pitch, id)) continue;
      summary.missing += 1;
      bump(summary.before, reasonBefore(pitch, id), pitch.ticker);
      const entry = pitch.mandateScore.perMetric[id];
      const needsAcceleration = entry.fallbackMethod !== "peer_relative";
      const facts = factsByTicker.has(pitch.ticker) ? factsByTicker.get(pitch.ticker) : undefined;
      bump(summary.now, facts === undefined && id !== "revBeat" ? "not_rechecked" : reasonNow(facts ?? null, id, { needsAcceleration }), pitch.ticker);
    }
    metrics[id] = summary;
  }
  return { pitches: scored.length, metrics };
}

/** Tickers worth re-reading from SEC (missing at least one SEC-sourced metric). */
export function tickersToRecheck(pitches = []) {
  return [...new Set(pitches.filter((p) => isMissing(p, "revGrowth") || isMissing(p, "marginTrend")).map((p) => p.ticker))].sort();
}
