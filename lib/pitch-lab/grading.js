/**
 * Pitch Lab grading — how did a pitch do versus the market at each fixed
 * holding period? Pure: the caller supplies daily bars.
 *
 * Definitions (fixed in advance; changing them is a new GRADING_VERSION):
 *   - Entry: the first daily close that happens AFTER the pitch was made. A
 *     pitch made before 16:00 ET on a trading day enters at that day's close;
 *     otherwise at the next session's close. The pitch's own reference price
 *     is recorded but never used for grading (it could be stale).
 *   - Exit: the close exactly `horizon` trading sessions after entry.
 *   - Success = excess return: the stock's return after round-trip costs,
 *     minus the benchmark's return over the same two sessions.
 */
import { applyTransactionCosts } from "../../backtest/metrics.js";
import { etDateString } from "../market-calendar.js";

export const GRADING_VERSION = "pitch-lab.grading.v1";
export const DEFAULT_HORIZONS = Object.freeze([5, 10, 20]); // trading days; the horizon decision (D-1) is still open
export const DEFAULT_BENCHMARK = "SPY";
export const DEFAULT_COST_PER_SIDE = 0.001; // 10 bps each way — an assumption, stated in every report

const MARKET_CLOSE_MINUTES_ET = 16 * 60;

function etMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

/** Normalize bars to [{date: "YYYY-MM-DD" (ET), close}] sorted, deduped, finite closes only. */
export function normalizeBars(bars) {
  const byDate = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    const close = bar?.close;
    if (!(typeof close === "number" && Number.isFinite(close) && close > 0)) continue;
    const raw = bar.date instanceof Date ? bar.date : new Date(bar.date);
    if (Number.isNaN(raw.getTime())) continue;
    // Yahoo daily bars are stamped at the session's open (13:30/14:30 UTC) or
    // midnight ET; either way the ET calendar date is the session date. A plain
    // "YYYY-MM-DD" string is taken as that session date directly.
    const date = typeof bar.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bar.date) ? bar.date : etDateString(raw);
    byDate.set(date, close);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, close]) => ({ date, close }));
}

/** Index of the entry session in normalized bars, or -1 if it hasn't happened yet. */
export function entryIndexFor(pitchedAt, normalizedBars) {
  const at = new Date(pitchedAt);
  const pitchDate = etDateString(at);
  const beforeClose = etMinutes(at) < MARKET_CLOSE_MINUTES_ET;
  return normalizedBars.findIndex((bar) => (beforeClose ? bar.date >= pitchDate : bar.date > pitchDate));
}

/**
 * Grade one pitch at each horizon.
 * @returns {Array<{pitchId, horizonDays, status: "matured"|"immature"|"unavailable", ...}>}
 *   Only "matured" rows are final and should be stored; the rest are retried later.
 */
export function gradePitch({ pitch, bars, benchmarkBars, horizons = DEFAULT_HORIZONS, benchmark = DEFAULT_BENCHMARK, costPerSide = DEFAULT_COST_PER_SIDE, now = new Date() }) {
  const stock = normalizeBars(bars);
  const bench = new Map(normalizeBars(benchmarkBars).map((bar) => [bar.date, bar.close]));
  const entryIdx = entryIndexFor(pitch.pitchedAt, stock);
  const base = { pitchId: pitch.id, ticker: pitch.ticker, benchmark, costPerSide, gradingVersion: GRADING_VERSION, gradedAt: new Date(now).toISOString() };

  return horizons.map((horizonDays) => {
    if (entryIdx < 0) return { ...base, horizonDays, status: "immature", reason: "entry_session_not_available_yet" };
    const exitIdx = entryIdx + horizonDays;
    if (exitIdx >= stock.length) return { ...base, horizonDays, status: "immature", reason: "horizon_not_reached" };
    const entry = stock[entryIdx];
    const exit = stock[exitIdx];
    const benchEntry = bench.get(entry.date);
    const benchExit = bench.get(exit.date);
    if (benchEntry == null || benchExit == null) {
      return { ...base, horizonDays, status: "unavailable", reason: "benchmark_bar_missing", entryDate: entry.date, exitDate: exit.date };
    }
    const grossReturn = exit.close / entry.close - 1;
    const netReturn = applyTransactionCosts({ grossReturn, entryCostRate: costPerSide, exitCostRate: costPerSide });
    const benchmarkReturn = benchExit / benchEntry - 1;
    return {
      ...base,
      horizonDays,
      status: "matured",
      entryDate: entry.date,
      exitDate: exit.date,
      entryPrice: entry.close,
      exitPrice: exit.close,
      benchmarkEntryPrice: benchEntry,
      benchmarkExitPrice: benchExit,
      grossReturn,
      netReturn,
      benchmarkReturn,
      excessReturn: netReturn - benchmarkReturn,
    };
  });
}
