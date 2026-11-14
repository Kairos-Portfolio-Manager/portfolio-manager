/**
 * Pitch Lab dashboard snapshot — a small, read-only projection for the website.
 *
 * Pure: pitches and outcomes in, one JSON object out. No I/O, no model call, no
 * Redis. The canonical evidence stays in the append-only Postgres tables; this is
 * only the presentation view a Vercel app (which cannot reach Postgres) can read.
 *
 * Contract (`schemaVersion: "pitch-lab.snapshot.v2"`): adding fields is fine;
 * renaming or removing one is a new schemaVersion. Returns are decimals
 * (0.012 = 1.2%), as in the weekly report. Everything shown is paper-only.
 *
 * v2: conviction is 1-10 (pitch v3). Older 1-5 pitches keep their own scale and are
 * counted separately (`legacyConvictionMix`, `legacyConvictionBuckets`), never
 * rescaled. Every pitch shown carries its Mandate Score /10 breakdown, `recent`
 * lists pitches with their graded results, and `schedule` gives the next weekly
 * report and Mandate Review times from lib/pitch-lab/schedule.js.
 *
 * `performers` (additive): the best and worst pitches by RAW return — the stock's own
 * close-to-close change (grossReturn: before costs, no benchmark) over the longest
 * holding period that has matured for that pitch. Each pitch is its own row, with the
 * session we got in (entryDate). Pitches with no matured period are not ranked.
 */
import { etDateString } from "../market-calendar.js";
// One definition of "an independent week": the analysis clusters on the ISO week of each outcome's ENTRY date
// (a Friday-evening pitch enters on Monday). Importing it, rather than copying it, keeps the dashboard's
// evidence bar from drifting away from the statistics it summarizes.
import { isoWeekKey } from "./analysis.js";
export { isoWeekKey };
import { FEATURE_CATALOG } from "./features.js";
import { CONVICTION_SCALE, LEGACY_CONVICTION_SCALE, convictionScaleOf } from "./pitch.js";
import { nextMandateReviewAt, nextWeeklyReportAt } from "./schedule.js";
import { buildJudgment } from "./judgment.js";
import { scoreBreakdownFor } from "./score-breakdown.js";

export const SNAPSHOT_SCHEMA_VERSION = "pitch-lab.snapshot.v2";
export const EVIDENCE_BAR = Object.freeze({ minGraded: 30, minWeeks: 8 }); // mirrors analysis.js DEFAULTS.minSample / minClusters
const HORIZONS = [5, 10, 20];
const DAY_MS = 86_400_000;
const MAX_DAYS = 30;
const MAX_LATEST = 20;
const MAX_RECENT = 40;
export const PERFORMERS_SHOWN = 5;
const LABELS = new Map(FEATURE_CATALOG.map((feature) => [feature.id, feature.label]));
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

/** Graded results per conviction level, on one scale only (scales are never mixed). */
function convictionBuckets(rows, pitchById, scale) {
  const buckets = [];
  for (let conviction = 1; conviction <= scale; conviction += 1) {
    const inBucket = rows.filter((o) => {
      const pitch = pitchById.get(o.pitchId);
      return convictionScaleOf(pitch) === scale && pitch.conviction === conviction;
    });
    if (!inBucket.length) continue;
    const xs = inBucket.map((o) => o.excessReturn);
    buckets.push({ conviction, n: xs.length, meanExcess: round(mean(xs)), hitRate: round(xs.filter((x) => x > 0).length / xs.length) });
  }
  return buckets;
}

function convictionMixFor(pitches, scale) {
  const counts = Object.fromEntries(Array.from({ length: scale }, (_, i) => [i + 1, 0]));
  for (const pitch of pitches) if (convictionScaleOf(pitch) === scale && counts[pitch.conviction] !== undefined) counts[pitch.conviction] += 1;
  return counts;
}

/** The website's view of a pitch's Mandate Score: totals, categories, and every metric with its label. */
export function compactBreakdown(pitch) {
  const b = scoreBreakdownFor(pitch);
  return {
    score: b.score,
    scale: b.scale,
    status: b.status,
    source: b.source,
    earned: b.earned,
    scorable: b.scorable,
    metricsScored: b.metricsScored,
    metricsTotal: b.metricsTotal,
    categories: b.categories.map(({ id, label, earned, scorable, max }) => ({ id, label, earned, scorable, max })),
    metrics: b.metrics.map(({ id, category, status, percentile, peerCount, band, points, maxPoints }) => ({
      id, label: LABELS.get(id) ?? id, category, status, percentile, peerCount, band, points, maxPoints,
    })),
  };
}

function scoreboardFor(horizon, pitches, outcomes, pitchById) {
  const rows = outcomes.filter((o) => o.horizonDays === horizon && Number.isFinite(o.excessReturn) && pitchById.has(o.pitchId));
  const excess = rows.map((o) => o.excessReturn);
  const weeks = new Set(rows.filter((o) => typeof o.entryDate === "string" && o.entryDate).map((o) => isoWeekKey(o.entryDate)));
  const buckets = convictionBuckets(rows, pitchById, CONVICTION_SCALE);
  const legacyBuckets = convictionBuckets(rows, pitchById, LEGACY_CONVICTION_SCALE);
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
    legacyConvictionBuckets: legacyBuckets,
  };
}

/** Best and worst pitches by raw return over each pitch's longest matured holding period. */
export function performersFor(valid, outcomes, pitchById, shown = PERFORMERS_SHOWN) {
  const longest = new Map();
  for (const o of outcomes) {
    if (!pitchById.has(o.pitchId) || !Number.isFinite(o.grossReturn) || !Number.isFinite(o.horizonDays)) continue;
    const held = longest.get(o.pitchId);
    if (!held || o.horizonDays > held.horizonDays) longest.set(o.pitchId, o);
  }
  const rows = [...longest.values()].map((o) => {
    const pitch = pitchById.get(o.pitchId);
    return {
      ticker: pitch.ticker,
      pitchDate: pitchDate(pitch),
      entryDate: typeof o.entryDate === "string" ? o.entryDate : null,
      exitDate: typeof o.exitDate === "string" ? o.exitDate : null,
      horizonDays: o.horizonDays,
      rawReturn: round(o.grossReturn),
      excessReturn: round(o.excessReturn),
    };
  });
  const tie = (a, b) => String(a.entryDate).localeCompare(String(b.entryDate)) || a.ticker.localeCompare(b.ticker);
  const best = [...rows].sort((a, b) => b.rawReturn - a.rawReturn || tie(a, b)).slice(0, shown);
  const taken = new Set(best);
  // Worst excludes anything already listed as best, so a short history never shows a pitch twice.
  const worst = [...rows].sort((a, b) => a.rawReturn - b.rawReturn || tie(a, b)).filter((r) => !taken.has(r)).slice(0, shown);
  return { basis: "raw_return_longest_matured_horizon", ranked: rows.length, best, worst };
}

/**
 * @param {object} args
 * @param {Array}  args.pitches   stored pitch records ({ id, ticker, conviction, convictionScale?, pitchedAt, rationale, peers, scoreBreakdown? })
 * @param {Array}  args.outcomes  stored matured outcomes ({ pitchId, horizonDays, excessReturn, grossReturn, gradedAt, entryDate, exitDate })
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

  const hasLegacy = valid.some((p) => convictionScaleOf(p) === LEGACY_CONVICTION_SCALE);
  const scoreOf = new Map(valid.map((p) => [p.id, scoreBreakdownFor(p).score]));
  const avgScore = (list) => round(mean(list.map((p) => scoreOf.get(p.id)).filter(Number.isFinite)), 2);
  const avgConviction = (list) => round(mean(list.filter((p) => convictionScaleOf(p) === CONVICTION_SCALE).map((p) => p.conviction)), 2);
  const outcomesByPitch = new Map();
  for (const o of outcomes) {
    if (!Number.isFinite(o.excessReturn) || !pitchById.has(o.pitchId)) continue;
    if (!outcomesByPitch.has(o.pitchId)) outcomesByPitch.set(o.pitchId, {});
    outcomesByPitch.get(o.pitchId)[String(o.horizonDays)] = round(o.excessReturn);
  }

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
    convictionScale: CONVICTION_SCALE,
    schedule: { nextWeeklyReportAt: nextWeeklyReportAt(now), nextMandateReviewAt: nextMandateReviewAt(now) },
    program: {
      firstPitchDate: dates[0] ?? null,
      lastPitchDate: lastDate,
      pitchDays: dates.length,
      totalPitches: valid.length,
      distinctTickers: tickerStats.size,
      convictionMix: convictionMixFor(valid, CONVICTION_SCALE),
      legacyConvictionMix: hasLegacy ? convictionMixFor(valid, LEGACY_CONVICTION_SCALE) : null,
      avgMandateScore: avgScore(valid),
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
        .sort((a, b) => (scoreOf.get(b.id) ?? -1) - (scoreOf.get(a.id) ?? -1) || b.conviction - a.conviction || a.ticker.localeCompare(b.ticker))
        .slice(0, MAX_LATEST)
        .map((p) => ({
          ticker: p.ticker,
          conviction: p.conviction,
          convictionScale: convictionScaleOf(p),
          thesis: compact(p.rationale?.thesis, THESIS_CHARS),
          risk: compact(p.rationale?.risks?.[0], RISK_CHARS),
          mandateScore: compactBreakdown(p),
        })),
    },
    recent: [...valid]
      .sort((a, b) => Date.parse(b.pitchedAt) - Date.parse(a.pitchedAt) || a.ticker.localeCompare(b.ticker))
      .slice(0, MAX_RECENT)
      .map((p) => {
        const b = scoreBreakdownFor(p);
        return {
          ticker: p.ticker,
          date: pitchDate(p),
          conviction: p.conviction,
          convictionScale: convictionScaleOf(p),
          mandateScore: b.score,
          metricsScored: b.metricsScored,
          metricsTotal: b.metricsTotal,
          categories: b.categories.map(({ id, earned, scorable, max }) => ({ id, earned, scorable, max })),
          excessReturn: Object.fromEntries(horizons.map((h) => [String(h), outcomesByPitch.get(p.id)?.[String(h)] ?? null])),
        };
      }),
    days: dates.slice(-MAX_DAYS).map((date) => {
      const day = byDate.get(date);
      return { date, pitched: day.length, avgConviction: avgConviction(day), avgMandateScore: avgScore(day) };
    }),
    scoreboard,
    performers: performersFor(valid, outcomes, pitchById),
    // Is the rating telling us anything? Higher- vs lower-rated pitches, both ways (judgment.js).
    judgment: buildJudgment({ pitches: valid, outcomes, horizons, evidenceBar: EVIDENCE_BAR, scoreOf }),
  };
}
