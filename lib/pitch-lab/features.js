/**
 * Pitch Lab feature catalog — the fixed list of metrics every pitch records.
 *
 * Every pitch stores a value (or an explicit "missing") for EVERY feature here,
 * whether or not the rationale cites it. That is what lets the analysis ask
 * "does this metric predict success?" instead of only "did the pitches that
 * mentioned it do well?".
 *
 * Rules (docs/PITCH-LAB.md):
 *   - Never change a feature's definition in place. A new definition is a new
 *     id (e.g. revGrowth_v2), so old pitches stay comparable to themselves.
 *   - Missing data is recorded as missing, never filled in.
 *   - The nine fundamental ids are the mandate's own metric ids
 *     (config/scoring/mandate-v2.js METRIC_IDS), so this stays in step with
 *     the scoring engine automatically.
 */
import { METRIC_IDS } from "../../config/scoring/mandate-v2.js";
import { extractMetricVector } from "../mandate-metrics.js";
import { rsi } from "../indicators.js";

const FUNDAMENTAL_LABELS = Object.freeze({
  revBeat: "Revenue beat vs consensus",
  revGrowth: "Revenue growth (YoY)",
  epsTrajectory: "EPS trajectory (YoY)",
  estimateRevisions: "Analyst estimate revisions",
  marginTrend: "Gross-margin trend",
  peerValuation: "Forward P/E (lower = cheaper)",
  balanceSheet: "Balance-sheet strength",
  instOwnershipDir: "Institutional ownership direction",
  thirteenF: "Latest 13F accumulation",
});

const FUNDAMENTAL_FEATURES = METRIC_IDS.map((id) => ({
  id,
  label: FUNDAMENTAL_LABELS[id] ?? id,
  group: "fundamental",
}));

const MARKET_FEATURES = [
  { id: "momentum1m", label: "Price momentum, 1 month", group: "price" },
  { id: "momentum3m", label: "Price momentum, 3 months", group: "price" },
  { id: "priceVs200dma", label: "Price vs 200-day average", group: "price" },
  { id: "relativeVolume", label: "Volume vs 30-day average", group: "price" },
  { id: "rsi14", label: "RSI (14-day)", group: "price" },
  { id: "logMarketCap", label: "Company size (log market cap)", group: "context" },
];

export const FEATURE_CATALOG = Object.freeze([...FUNDAMENTAL_FEATURES, ...MARKET_FEATURES].map(Object.freeze));
export const FEATURE_IDS = Object.freeze(FEATURE_CATALOG.map((feature) => feature.id));
const FEATURE_ID_SET = new Set(FEATURE_IDS);

export function isKnownFeature(id) {
  return FEATURE_ID_SET.has(id);
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Why a metric is missing. Recorded next to every missing value so the analysis
 * (and the fill-rate report) can tell "no data exists" from "Pitch Lab is not
 * wired to that source yet". A missing value is still never filled in.
 */
export const MISSING_REASONS = Object.freeze([
  "not_supplied_to_pitch_lab", // consensus / 13F metrics: the main scan has them, Pitch Lab is not handed them yet
  "no_fundamentals_supplied", // caller passed neither Yahoo fundamentals nor EDGAR facts
  "no_edgar_facts", // EDGAR-sourced metric, no companyfacts supplied
  "not_reported", // sources were supplied but do not carry this metric for the company
  "no_pe_ratio", // no forward or trailing P/E (e.g. unprofitable company)
  "insufficient_price_history", // not enough daily bars for the window
  "no_market_cap",
]);

// Metrics the main pipeline fills from consensus snapshots / 13F, which Pitch Lab is not given.
const NOT_SUPPLIED_METRICS = new Set(["revBeat", "estimateRevisions", "instOwnershipDir", "thirteenF"]);

function closesOf(bars) {
  return (Array.isArray(bars) ? bars : []).map((bar) => finite(bar?.close)).filter((close) => close != null);
}

/**
 * Price features from daily bars that END at or before the pitch time
 * (the caller must not pass bars from after the pitch — no look-ahead).
 * Needs ~200 bars for priceVs200dma; shorter history leaves that one missing.
 */
export function marketFeaturesFromBars(bars) {
  const rows = (Array.isArray(bars) ? bars : []).filter((bar) => finite(bar?.close) != null);
  const closes = closesOf(rows);
  const last = closes.at(-1) ?? null;
  const change = (sessionsBack) => {
    if (last == null || closes.length <= sessionsBack) return null;
    const base = closes[closes.length - 1 - sessionsBack];
    return base > 0 ? last / base - 1 : null;
  };
  let priceVs200dma = null;
  if (closes.length >= 200) {
    const window = closes.slice(-200);
    const average = window.reduce((sum, value) => sum + value, 0) / window.length;
    priceVs200dma = average > 0 ? last / average - 1 : null;
  }
  let relativeVolume = null;
  const volumes = rows.map((bar) => finite(bar.volume));
  if (volumes.length >= 31 && volumes.slice(-31).every((v) => v != null)) {
    const prior = volumes.slice(-31, -1);
    const average = prior.reduce((sum, value) => sum + value, 0) / prior.length;
    relativeVolume = average > 0 ? volumes.at(-1) / average : null;
  }
  return {
    momentum1m: change(21),
    momentum3m: change(63),
    priceVs200dma,
    relativeVolume,
    rsi14: closes.length >= 15 ? finite(rsi(closes, 14)) : null,
  };
}

/**
 * Build the full feature map for a pitch from data the research scan already
 * fetches: Yahoo fundamentals (lib/yahoo.js fetchFundamentals), optional EDGAR
 * companyfacts, and daily bars up to the pitch time.
 *
 * @returns {{[featureId]: {value:number|null, asOf:string|null, missingReason?:string}}}
 */
export function buildFeatures({ fundamentals = null, companyfacts = null, bars = [], marketCap = null, asOf }) {
  if (!asOf || !Number.isFinite(Date.parse(asOf))) throw new TypeError("buildFeatures requires an ISO asOf timestamp");
  const vector = fundamentals || companyfacts ? extractMetricVector(fundamentals, companyfacts) : {};
  const market = marketFeaturesFromBars(bars);
  const cap = finite(marketCap);
  const values = {
    ...Object.fromEntries(METRIC_IDS.map((id) => [id, finite(vector[id])])),
    ...market,
    logMarketCap: cap != null && cap > 0 ? Math.log10(cap) : null,
  };
  const missingReason = (id) => {
    if (NOT_SUPPLIED_METRICS.has(id)) return "not_supplied_to_pitch_lab";
    if (id === "logMarketCap") return "no_market_cap";
    if (!METRIC_IDS.includes(id)) return "insufficient_price_history";
    if (!fundamentals && !companyfacts) return "no_fundamentals_supplied";
    if (id === "peerValuation") return "no_pe_ratio";
    return companyfacts ? "not_reported" : "no_edgar_facts";
  };
  return Object.fromEntries(
    FEATURE_IDS.map((id) => [
      id,
      values[id] == null
        ? { value: null, asOf: null, missingReason: missingReason(id) }
        : { value: values[id], asOf },
    ]),
  );
}
