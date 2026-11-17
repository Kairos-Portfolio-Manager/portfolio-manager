/**
 * Pitch Lab weekly matrix — for each mandate metric, how it went with beating the
 * benchmark week by week, and over everything graded so far.
 *
 *   rows     the nine mandate metrics (always all nine, data or not)
 *   columns  one per ISO week of ENTRY (the same week rule the analysis clusters on),
 *            then the aggregate
 *   cell     Spearman correlation between the metric's industry-peer percentile and
 *            the pitch's excess return at one holding period
 *
 * The percentile is already direction-adjusted (0.9 = better than 90% of peers, for
 * lower-is-better metrics too), so a POSITIVE number always means "the metric worked
 * the way the mandate expects".
 *
 * How to read it (docs/PITCH-LAB.md "Weekly matrix"):
 *   - The AGGREGATE is the evidence. It is the analysis's own pooled peer-rank block
 *     (weeks as the clustering unit, Benjamini-Hochberg across the nine), passed in so
 *     the two can never disagree.
 *   - A weekly cell is ~15-75 pitches: descriptive, noisy, and only `significant`
 *     when its own interval excludes zero. One bad week changes nothing by itself.
 *   - `consistency` is the mean weekly correlation divided by its week-to-week
 *     standard deviation (an information ratio): higher = more reliable.
 *   - `spread` is the mean excess return of the top fifth of pitches by the metric
 *     minus the bottom fifth. It should be large and positive, and its week-to-week
 *     variation (`sd`) small.
 *   - `relative` asks whether a metric is clearly WEAKER (or stronger) than the other
 *     metrics, even when none of them is strong: the cluster-bootstrap interval of its
 *     correlation minus the median of the others'.
 *
 * Pure: no I/O. Undersized inputs give null fields, never a made-up number.
 */
import { FEATURE_CATALOG } from "./features.js";
import { PEER_RANK_METRIC_IDS } from "./peer-rank.js";
import { mean, median, quantile, round, seededRandom, spearman, variance } from "./stats.js";

export const WEEKLY_MATRIX_VERSION = "pitch-lab.weekly-matrix.v1";

export const DEFAULT_MATRIX_OPTIONS = Object.freeze({
  minCellSample: 10, // a weekly cell with fewer usable pitches shows no correlation
  spreadFraction: 0.2, // top fifth vs bottom fifth
  minSpreadSample: 10, // at least two pitches in each fifth
  minWeeksForConsistency: 3, // weeks with a correlation needed before a consistency score
  relativeIterations: 500, // cluster-bootstrap replicates for the weaker/stronger test
  peerBasisShare: 0.5, // peers must cover this share of the scorable pitches to be the basis
  overlapMinSample: 30, // pitches where both metrics have a value before a pair is compared
  overlapThreshold: 0.6, // |Spearman| at or above this is reported as overlap
});

const DAY_MS = 86_400_000;

/** ISO-8601 week key ("2026-W40") for a YYYY-MM-DD date. The one definition; analysis.js re-exports it. */
export function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday (YYYY-MM-DD) of the ISO week a date falls in. */
function weekStartOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const MATRIX_METRICS = Object.freeze(
  FEATURE_CATALOG.filter((feature) => PEER_RANK_METRIC_IDS.includes(feature.id)).map((feature) => Object.freeze({ id: feature.id, label: feature.label })),
);

/** The metric's peer percentile on a pitch, or null when it was not ranked. */
function percentileOf(pitch, metricId) {
  const rank = pitch?.peers?.ranks?.[metricId];
  return rank?.status === "ranked" && Number.isFinite(rank.percentile) ? rank.percentile : null;
}

/**
 * The share of the metric's own mandate points the live scorer gave this pitch (0-1), or
 * null when the metric was not scored. Used for metrics that have no industry-peer rank
 * (revenue beat, estimate revisions, the 13F pair are scored on fixed bands): without it
 * they could never appear in the matrix. Also direction-adjusted: higher = better.
 */
function pointsShareOf(pitch, metricId) {
  const score = pitch?.mandateScore;
  if (score?.status !== "scored") return null;
  const entry = score.perMetric?.[metricId];
  if (!entry || entry.missing || !Number.isFinite(entry.points) || !(entry.maxPoints > 0)) return null;
  return entry.points / entry.maxPoints;
}

/** Which value a metric's row is built on. One basis per metric per holding period, never mixed. */
export const MATRIX_BASES = Object.freeze(["peer_percentile", "points_share"]);

/**
 * Approximate 95% interval for a Spearman correlation from one week's pitches
 * (Fisher z with the 1.06 Spearman variance factor). Only used to decide whether a
 * weekly cell may be shaded; the aggregate uses the cluster bootstrap.
 */
function fisherInterval(rho, n) {
  if (!Number.isFinite(rho) || n < 5 || Math.abs(rho) >= 1) return null;
  const z = Math.atanh(rho);
  const se = Math.sqrt(1.06 / (n - 3));
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

/** Top fraction minus bottom fraction, by mean y. Null when either group would be under two pitches. */
function topBottomSpread(xs, ys, { spreadFraction, minSpreadSample }) {
  if (xs.length < minSpreadSample) return null;
  const k = Math.floor(xs.length * spreadFraction);
  if (k < 2) return null;
  const order = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b] || a - b);
  const bottom = order.slice(0, k).map((i) => ys[i]);
  const top = order.slice(-k).map((i) => ys[i]);
  return { value: mean(top) - mean(bottom), perGroup: k };
}

function correlationCell(xs, ys, options) {
  const n = xs.length;
  const rho = n >= options.minCellSample ? spearman(xs, ys) : null;
  const usable = Number.isFinite(rho);
  const ci = usable ? fisherInterval(rho, n) : null;
  const spread = topBottomSpread(xs, ys, options);
  return {
    n,
    rho: usable ? round(rho, 4) : null,
    ci95: ci ? [round(ci[0], 4), round(ci[1], 4)] : null,
    significant: Boolean(ci && (ci[0] > 0 || ci[1] < 0)),
    spread: spread ? round(spread.value) : null,
  };
}

/**
 * Is each metric clearly weaker or stronger than the others? Resamples whole weeks,
 * and on every replicate takes each metric's correlation minus the median of the
 * other metrics' correlations. A metric is `below_others` only when the 95% interval
 * of that difference sits entirely below zero.
 */
function relativeStanding(seriesByMetric, weeks, { iterations, seed }) {
  const ids = Object.keys(seriesByMetric);
  const observed = Object.fromEntries(ids.map((id) => [id, spearman(seriesByMetric[id].xs, seriesByMetric[id].ys)]));
  const usableIds = ids.filter((id) => Number.isFinite(observed[id]));
  const blank = (reason) => Object.fromEntries(ids.map((id) => [id, { status: "unavailable", reason, difference: null, ci95: null, comparedWith: 0 }]));
  if (usableIds.length < 3) return blank("fewer_than_three_metrics_with_data");
  if (weeks.length < 2) return blank("fewer_than_two_weeks");

  // Row indexes per metric per week, so a replicate is just a list of weeks.
  const byWeek = Object.fromEntries(usableIds.map((id) => {
    const groups = new Map(weeks.map((week) => [week, []]));
    seriesByMetric[id].weeks.forEach((week, i) => groups.get(week)?.push(i));
    return [id, groups];
  }));
  const random = seededRandom(seed);
  const replicates = Object.fromEntries(usableIds.map((id) => [id, []]));
  for (let b = 0; b < iterations; b += 1) {
    const draw = weeks.map(() => weeks[Math.floor(random() * weeks.length)]);
    const stats = {};
    for (const id of usableIds) {
      const xs = [];
      const ys = [];
      for (const week of draw) {
        for (const i of byWeek[id].get(week)) {
          xs.push(seriesByMetric[id].xs[i]);
          ys.push(seriesByMetric[id].ys[i]);
        }
      }
      stats[id] = spearman(xs, ys);
    }
    for (const id of usableIds) {
      const others = usableIds.filter((other) => other !== id).map((other) => stats[other]).filter(Number.isFinite);
      if (Number.isFinite(stats[id]) && others.length >= 2) replicates[id].push(stats[id] - median(others));
    }
  }

  const out = blank("no_data_for_metric");
  for (const id of usableIds) {
    const others = usableIds.filter((other) => other !== id).map((other) => observed[other]);
    const difference = observed[id] - median(others);
    const sorted = replicates[id].sort((a, b) => a - b);
    if (sorted.length < iterations * 0.5) {
      out[id] = { status: "unavailable", reason: "too_few_valid_resamples", difference: round(difference, 4), ci95: null, comparedWith: others.length };
      continue;
    }
    const lower = quantile(sorted, 0.025);
    const upper = quantile(sorted, 0.975);
    out[id] = {
      status: upper < 0 ? "below_others" : lower > 0 ? "above_others" : "in_line",
      reason: null,
      difference: round(difference, 4),
      ci95: [round(lower, 4), round(upper, 4)],
      comparedWith: others.length,
    };
  }
  return out;
}

/**
 * @param {object} args
 * @param {object[]} args.pitches   stored pitches
 * @param {object[]} args.outcomes  graded outcomes (only matured rows with a finite excess return are used)
 * @param {number[]|null} [args.horizons]  holding periods to build; default: every graded one
 * @param {object|null} [args.aggregates]  { [horizonDays]: peerMetrics blocks from analyzeMetrics } — the
 *        pooled evidence shown in the Aggregate column. Without it the column carries the
 *        plain pooled correlation and no verdict.
 * @param {object|null} [args.shareAggregates]  the same, for the points-share family (metrics
 *        without a peer rank are read on this basis).
 * @param {object} [args.options]   DEFAULT_MATRIX_OPTIONS overrides, plus minSample / minClusters / seed
 */
export function buildWeeklyMatrix({ pitches = [], outcomes = [], horizons = null, aggregates = null, shareAggregates = null, options = {} } = {}) {
  const opts = { ...DEFAULT_MATRIX_OPTIONS, minSample: 30, minClusters: 8, seed: 20260929, ...options };
  const pitchById = new Map(pitches.map((pitch) => [pitch.id, pitch]));
  const matured = outcomes.filter((o) => o.status === "matured" && Number.isFinite(o.excessReturn) && o.entryDate && pitchById.has(o.pitchId));
  const horizonList = horizons ?? [...new Set(matured.map((o) => o.horizonDays))].sort((a, b) => a - b);

  return {
    version: WEEKLY_MATRIX_VERSION,
    options: {
      minCellSample: opts.minCellSample,
      spreadFraction: opts.spreadFraction,
      minSpreadSample: opts.minSpreadSample,
      minWeeksForConsistency: opts.minWeeksForConsistency,
    },
    horizons: horizonList.map((horizonDays, horizonIndex) => {
      const rows = matured
        .filter((o) => o.horizonDays === horizonDays)
        .map((o) => ({ outcome: o, pitch: pitchById.get(o.pitchId), week: isoWeekKey(o.entryDate) }));
      const weekKeys = [...new Set(rows.map((row) => row.week))].sort();
      const weeks = weekKeys.map((week) => {
        const inWeek = rows.filter((row) => row.week === week);
        const benchmark = inWeek.map((row) => row.outcome.benchmarkReturn).filter(Number.isFinite);
        return {
          week,
          weekStart: weekStartOf(inWeek.map((row) => row.outcome.entryDate).sort()[0]),
          graded: inWeek.length,
          meanExcessReturn: round(mean(inWeek.map((row) => row.outcome.excessReturn))),
          // The benchmark's return over these pitches' own holding periods (not the calendar week).
          meanBenchmarkReturn: round(mean(benchmark)),
        };
      });

      const seriesByMetric = {};
      for (const { id } of MATRIX_METRICS) {
        const ranked = rows.map((row) => ({ row, x: percentileOf(row.pitch, id) })).filter((entry) => entry.x != null);
        const shared = rows.map((row) => ({ row, x: pointsShareOf(row.pitch, id) })).filter((entry) => entry.x != null);
        // The peer percentile is the finer measure, so it is used wherever peers cover at least
        // half of what the scorer could score; otherwise the metric is read on its points share.
        const basis = ranked.length > 0 && ranked.length >= shared.length * opts.peerBasisShare ? "peer_percentile" : shared.length > 0 ? "points_share" : "peer_percentile";
        const present = basis === "peer_percentile" ? ranked : shared;
        seriesByMetric[id] = {
          basis,
          xs: present.map((entry) => entry.x),
          ys: present.map((entry) => entry.row.outcome.excessReturn),
          weeks: present.map((entry) => entry.row.week),
          pitchIds: present.map((entry) => entry.row.pitch.id),
        };
      }
      const enoughOverall = rows.length >= opts.minSample && weekKeys.length >= opts.minClusters;
      const relative = enoughOverall
        ? relativeStanding(seriesByMetric, weekKeys, { iterations: opts.relativeIterations, seed: opts.seed + 7000 + horizonIndex })
        : null;
      const peerBlocks = new Map((aggregates?.[horizonDays] ?? []).map((block) => [block.id, block]));
      const shareBlocks = new Map((shareAggregates?.[horizonDays] ?? []).map((block) => [block.id, block]));

      const metrics = MATRIX_METRICS.map(({ id, label }) => {
        const series = seriesByMetric[id];
        const cells = weekKeys.map((week) => {
          const idx = series.weeks.map((w, i) => (w === week ? i : -1)).filter((i) => i >= 0);
          return { week, ...correlationCell(idx.map((i) => series.xs[i]), idx.map((i) => series.ys[i]), opts) };
        });
        const weeklyRhos = cells.map((cell) => cell.rho).filter(Number.isFinite);
        const weeklySpreads = cells.map((cell) => cell.spread).filter(Number.isFinite);
        const rhoSd = weeklyRhos.length >= 2 ? Math.sqrt(variance(weeklyRhos)) : null;
        const enoughWeeks = weeklyRhos.length >= opts.minWeeksForConsistency;
        const pooled = (series.basis === "points_share" ? shareBlocks : peerBlocks).get(id) ?? null;
        const pooledRho = pooled ? pooled.spearman?.rho ?? null : round(spearman(series.xs, series.ys), 4);
        const overallSpread = topBottomSpread(series.xs, series.ys, opts);
        return {
          id,
          label,
          // "peer_percentile" (rank among industry peers) or "points_share" (share of the
          // metric's mandate points, for metrics scored on fixed bands). Positive = worked either way.
          basis: series.basis,
          cells,
          aggregate: {
            n: series.xs.length,
            weeks: new Set(series.weeks).size,
            rho: Number.isFinite(pooledRho) ? pooledRho : null,
            ci95: pooled?.spearman?.ci95 ?? null,
            excessReturnPerSd: pooled?.excessReturnPerSd ?? null,
            verdict: pooled?.verdict?.label ?? null,
          },
          weeksPositive: weeklyRhos.filter((rho) => rho > 0).length,
          weeksNegative: weeklyRhos.filter((rho) => rho < 0).length,
          weeksUsed: weeklyRhos.length,
          consistency: {
            meanWeeklyRho: enoughWeeks ? round(mean(weeklyRhos), 4) : null,
            sdWeeklyRho: enoughWeeks ? round(rhoSd, 4) : null,
            // mean / sd of the weekly correlations; null until there are enough weeks or when they do not vary
            score: enoughWeeks && rhoSd > 0 ? round(mean(weeklyRhos) / rhoSd, 2) : null,
          },
          spread: {
            overall: overallSpread ? round(overallSpread.value) : null,
            meanWeekly: weeklySpreads.length ? round(mean(weeklySpreads)) : null,
            sdWeekly: weeklySpreads.length >= 2 ? round(Math.sqrt(variance(weeklySpreads))) : null,
            weeksUsed: weeklySpreads.length,
          },
          relative: relative?.[id] ?? { status: "unavailable", reason: "not_enough_graded_pitches", difference: null, ci95: null, comparedWith: 0 },
        };
      });

      return { horizonDays, graded: rows.length, weekCount: weekKeys.length, weeks, metrics, overlaps: metricOverlaps(seriesByMetric, opts) };
    }),
  };
}

/**
 * Pairs of metrics that rank the same pitches almost the same way: weighting both mostly
 * counts one signal twice. Spearman across the pitches where both have a value.
 */
function metricOverlaps(seriesByMetric, { overlapMinSample, overlapThreshold }) {
  const ids = Object.keys(seriesByMetric);
  const byPitch = Object.fromEntries(ids.map((id) => [id, new Map(seriesByMetric[id].pitchIds.map((pitchId, i) => [pitchId, seriesByMetric[id].xs[i]]))]));
  const pairs = [];
  for (let a = 0; a < ids.length; a += 1) {
    for (let b = a + 1; b < ids.length; b += 1) {
      const xs = [];
      const ys = [];
      for (const [pitchId, x] of byPitch[ids[a]]) {
        const y = byPitch[ids[b]].get(pitchId);
        if (y != null) { xs.push(x); ys.push(y); }
      }
      if (xs.length < overlapMinSample) continue;
      const rho = spearman(xs, ys);
      if (Number.isFinite(rho) && Math.abs(rho) >= overlapThreshold) pairs.push({ a: ids[a], b: ids[b], rho: round(rho, 4), n: xs.length });
    }
  }
  return pairs.sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho));
}

/** A copy of the matrix keeping only the most recent `maxWeeks` week columns (aggregates untouched). */
export function trimWeeklyMatrix(matrix, maxWeeks) {
  if (!matrix || !Array.isArray(matrix.horizons) || !(maxWeeks > 0)) return matrix ?? null;
  return {
    ...matrix,
    horizons: matrix.horizons.map((horizon) => ({
      ...horizon,
      weeksOmitted: Math.max(0, (horizon.weeks?.length ?? 0) - maxWeeks),
      weeks: (horizon.weeks ?? []).slice(-maxWeeks),
      metrics: (horizon.metrics ?? []).map((metric) => ({ ...metric, cells: (metric.cells ?? []).slice(-maxWeeks) })),
    })),
  };
}
