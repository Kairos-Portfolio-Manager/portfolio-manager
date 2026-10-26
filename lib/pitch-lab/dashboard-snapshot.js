/**
 * Pitch Lab dashboard snapshot — a small, read-only projection for the website.
 *
 * Pure: pitches and outcomes in, one JSON object out. No I/O, no model call, no
 * Redis. The canonical evidence stays in the append-only Postgres tables; this is
 * only the presentation view a Vercel app (which cannot reach Postgres) can read.
 *
 * Contract (`schemaVersion: "pitch-lab.snapshot.v1"`): adding fields is fine;
 * renaming or removing one is a new schemaVersion. Returns are decimals
 * (0.012 = 1.2%), as in the weekly report. Everything shown is paper-only.
 */
import { etDateString } from "../market-calendar.js";
// One definition of "an independent week": the analysis clusters on the ISO week of each outcome's ENTRY date
// (a Friday-evening pitch enters on Monday). Importing it, rather than copying it, keeps the dashboard's
// evidence bar from drifting away from the statistics it summarizes.
import { isoWeekKey } from "./analysis.js";
export { isoWeekKey };

export const SNAPSHOT_SCHEMA_VERSION = "pitch-lab.snapshot.v1";
export const EVIDENCE_BAR = Object.freeze({ minGraded: 30, minWeeks: 8 }); // mirrors analysis.js DEFAULTS.minSample / minClusters
const HORIZONS = [5, 10, 20];
const DAY_MS = 86_400_000;
const MAX_DAYS = 30;
const MAX_LATEST = 20;
const THESIS_CHARS = 240;
const RISK_CHARS = 160;

const compact = (text, limit) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
};

const round = (value, places = 4) => (Number.isFinite(value) ? Number(value.toFixed(places)) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pitchDate = (pitch) => etDateString(new Date(pitch.pitchedAt));

function scoreboardFor(horizon, pitches, outcomes, pitchById) {
  const rows = outcomes.filter((o) => o.horizonDays === horizon && Number.isFinite(o.excessReturn) && pitchById.has(o.pitchId));
  const excess = rows.map((o) => o.excessReturn);
  const weeks = new Set(rows.filter((o) => typeof o.entryDate === "string" && o.entryDate).map((o) => isoWeekKey(o.entryDate)));
  const buckets = [];
  for (let conviction = 1; conviction <= 5; conviction += 1) {
    const inBucket = rows.filter((o) => pitchById.get(o.pitchId)?.conviction === conviction);
    if (!inBucket.length) continue;
    const xs = inBucket.map((o) => o.excessReturn);
    buckets.push({ conviction, n: xs.length, meanExcess: round(mean(xs)), hitRate: round(xs.filter((x) => x > 0).length / xs.length) });
  }
  const gradedDates = rows.map((o) => String(o.gradedAt ?? "").slice(0, 10)).filter(Boolean).sort();
  return {
    horizonDays: horizon,
    graded: rows.length,
    pending: Math.max(0, pitches.length - rows.length),
    beat: rows.filter((o) => o.excessReturn > 0).length,
    hitRate: rows.length ? round(rows.filter((o) => o.excessReturn > 0).length / rows.length) : null,
    meanExcess: round(mean(excess)),
    medianExcess: round(median(excess)),
    independentWeeks: weeks.size,
    firstGradedDate: gradedDates[0] ?? null,
    convictionBuckets: buckets,
  };
}

/**
 * @param {object} args
 * @param {Array}  args.pitches   stored pitch records ({ id, ticker, conviction, pitchedAt, rationale })
 * @param {Array}  args.outcomes  stored matured outcomes ({ pitchId, horizonDays, excessReturn, gradedAt, entryDate })
 * @param {object} [args.run]     the latest daily-run summary ({ status, date, selected, pitched, failedCount, shortfall })
 * @param {Date}   [args.now]
 */
export function buildPitchLabSnapshot({ pitches = [], outcomes = [], run = null, now = new Date(), horizons = HORIZONS, benchmark = "SPY" } = {}) {
  const valid = pitches.filter((p) => p && p.id && p.ticker && Number.isFinite(p.conviction) && Number.isFinite(Date.parse(p.pitchedAt)));
  const byDate = new Map();
  for (const pitch of valid) {
    const date = pitchDate(pitch);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(pitch);
  }
  const dates = [...byDate.keys()].sort();
  const lastDate = dates.at(-1) ?? null;
  const latest = lastDate ? byDate.get(lastDate) : [];
  const pitchById = new Map(valid.map((p) => [p.id, p]));

  const convictionMix = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const pitch of valid) if (convictionMix[pitch.conviction] !== undefined) convictionMix[pitch.conviction] += 1;

  const tickerStats = new Map();
  for (const pitch of valid) {
    const entry = tickerStats.get(pitch.ticker) ?? { ticker: pitch.ticker, pitches: 0, days: new Set() };
    entry.pitches += 1;
    entry.days.add(pitchDate(pitch));
    tickerStats.set(pitch.ticker, entry);
  }
  const repeats = [...tickerStats.values()]
    .filter((entry) => entry.days.size > 1)
    .sort((a, b) => b.days.size - a.days.size || a.ticker.localeCompare(b.ticker))
    .slice(0, 6)
    .map((entry) => ({ ticker: entry.ticker, days: entry.days.size }));

  const scoreboard = {};
  for (const horizon of horizons) scoreboard[String(horizon)] = scoreboardFor(horizon, valid, outcomes, pitchById);

  const runForLatest = run && run.date === lastDate ? run : null;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    benchmark,
    horizons,
    evidenceBar: EVIDENCE_BAR,
    program: {
      firstPitchDate: dates[0] ?? null,
      lastPitchDate: lastDate,
      pitchDays: dates.length,
      totalPitches: valid.length,
      distinctTickers: tickerStats.size,
      convictionMix,
      repeatedTickers: repeats,
    },
    latest: {
      date: lastDate,
      pitched: latest.length,
      selected: runForLatest?.selected ?? null,
      dropped: runForLatest?.failedCount ?? null,
      shortfall: runForLatest?.shortfall ?? null,
      // Unknown (null), never a guess: without the matching run summary we cannot say it was clean.
      status: runForLatest?.status ?? null,
      pitches: [...latest]
        .sort((a, b) => b.conviction - a.conviction || a.ticker.localeCompare(b.ticker))
        .slice(0, MAX_LATEST)
        .map((p) => ({
          ticker: p.ticker,
          conviction: p.conviction,
          thesis: compact(p.rationale?.thesis, THESIS_CHARS),
          risk: compact(p.rationale?.risks?.[0], RISK_CHARS),
        })),
    },
    days: dates.slice(-MAX_DAYS).map((date) => {
      const day = byDate.get(date);
      return { date, pitched: day.length, avgConviction: round(mean(day.map((p) => p.conviction)), 2) };
    }),
    scoreboard,
  };
}
