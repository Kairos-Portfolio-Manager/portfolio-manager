/**
 * Pitch Lab grade runner — grade every stored pitch whose holding period has
 * matured and append the outcomes. Shared by the CLI (`pitch-lab grade`) and the
 * daily job so they cannot drift. Pure orchestration: price bars come in through
 * `fetchBars`, outcomes go out through the append-only store.
 *
 * Only "matured" rows are stored (immature/unavailable rows are retried next
 * run). A missing benchmark throws: with no benchmark nothing can be graded and
 * a silent no-op would look like "nothing matured".
 */
import { DEFAULT_BENCHMARK, DEFAULT_COST_PER_SIDE, DEFAULT_HORIZONS, gradePitch } from "./grading.js";

export async function gradeMaturedPitches({
  store,
  fetchBars,
  horizons = DEFAULT_HORIZONS,
  benchmark = DEFAULT_BENCHMARK,
  costPerSide = DEFAULT_COST_PER_SIDE,
  now = () => new Date(),
  log = console,
} = {}) {
  const pitches = store.listPitches();
  const done = new Set(store.listOutcomes().map((o) => `${o.pitchId}:${o.horizonDays}`));
  const pending = pitches.filter((p) => horizons.some((h) => !done.has(`${p.id}:${h}`)));
  if (!pending.length) {
    log.log("[pitch-lab] nothing to grade");
    return { pending: 0, stored: 0, failedTickers: [] };
  }

  const earliest = new Date(Math.min(...pending.map((p) => Date.parse(p.pitchedAt))) - 7 * 86_400_000);
  const benchmarkBars = await fetchBars(benchmark, { period1: earliest });
  if (!benchmarkBars.length) throw new Error(`no ${benchmark} bars returned — cannot grade anything (check network / ticker)`);

  const barsByTicker = new Map();
  const failedTickers = [];
  let stored = 0;
  for (const pitch of pending) {
    if (!barsByTicker.has(pitch.ticker)) {
      const bars = await fetchBars(pitch.ticker, { period1: earliest });
      if (!bars.length) {
        log.error(`[pitch-lab] no price data for ${pitch.ticker}; its pitches stay ungraded`);
        failedTickers.push(pitch.ticker);
      }
      barsByTicker.set(pitch.ticker, bars);
    }
    const rows = gradePitch({ pitch, bars: barsByTicker.get(pitch.ticker), benchmarkBars, horizons, benchmark, costPerSide, now: now() });
    for (const row of rows) {
      if (row.status !== "matured" || done.has(`${row.pitchId}:${row.horizonDays}`)) continue;
      store.appendOutcome(row);
      done.add(`${row.pitchId}:${row.horizonDays}`);
      stored += 1;
    }
  }
  log.log(`[pitch-lab] graded ${stored} new outcome(s) across ${pending.length} pitch(es)${failedTickers.length ? `; ${failedTickers.length} ticker(s) had no data` : ""}`);
  return { pending: pending.length, stored, failedTickers };
}
