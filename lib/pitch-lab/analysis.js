/**
 * Pitch Lab analysis — "how influential was conviction (and each metric) in
 * driving success?", over several time periods, with honest uncertainty.
 *
 * Pure: takes stored pitches + matured outcomes, returns a JSON-serializable
 * report (REPORT_SCHEMA_VERSION) that the website renders as-is.
 *
 * For every period × horizon it reports:
 *   conviction  — Spearman rank correlation with excess return (+ cluster
 *                 bootstrap 95% CI), the excess return per conviction point
 *                 (clustered-SE regression, p-value, 95% CI), and a per-level
 *                 table (mean/median excess return, hit rate + Wilson CI).
 *   metrics     — the same correlation for every feature in the catalog,
 *                 with the slope per one standard deviation (so metrics are
 *                 comparable), coverage, the missing-vs-present gap, and
 *                 Benjamini–Hochberg q-values across the metric family.
 * A relationship can come out negative — that is a finding, not an error.
 */
import { wilsonInterval } from "../../backtest/metrics.js";
import { FEATURE_CATALOG } from "./features.js";
import { CONVICTION_MAX, CONVICTION_MIN, CONVICTION_RUBRIC } from "./pitch.js";
import { GRADING_VERSION } from "./grading.js";
import {
  benjaminiHochberg, clusterBootstrapInterval, clusteredSlope, mean, median, round, spearman, variance,
} from "./stats.js";

export const REPORT_SCHEMA_VERSION = "pitch-lab.report.v1";

export const DEFAULT_ANALYSIS_OPTIONS = Object.freeze({
  minSample: 30, // below this many graded pitches a verdict is "insufficient_data"
  minClusters: 8, // ...or below this many independent weeks
  alpha: 0.05, // conviction significance level
  fdr: 0.10, // metric false-discovery rate (Benjamini–Hochberg)
  clusterBy: "week", // "week" (ISO week of entry) or "day" (entry session)
  bootstrapIterations: 1000,
  seed: 20260929,
});

const DAY_MS = 86_400_000;

/** ISO-8601 week key ("2026-W40") for a YYYY-MM-DD date. */
export function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function clusterKey(outcome, clusterBy) {
  return clusterBy === "day" ? outcome.entryDate : isoWeekKey(outcome.entryDate);
}

/**
 * Default reporting periods: all time, trailing 30/90/180 days, and each
 * calendar month that has pitches. Periods select pitches by pitchedAt.
 */
export function defaultPeriods(pitches, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const periods = [
    { id: "all", label: "All time", from: null, to: null },
    { id: "trailing-30d", label: "Last 30 days", from: new Date(nowMs - 30 * DAY_MS).toISOString(), to: null },
    { id: "trailing-90d", label: "Last 90 days", from: new Date(nowMs - 90 * DAY_MS).toISOString(), to: null },
    { id: "trailing-180d", label: "Last 180 days", from: new Date(nowMs - 180 * DAY_MS).toISOString(), to: null },
  ];
  const months = [...new Set(pitches.map((p) => p.pitchedAt.slice(0, 7)))].sort();
  for (const month of months) {
    const [y, m] = month.split("-").map(Number);
    periods.push({
      id: `month-${month}`,
      label: month,
      from: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
      to: new Date(Date.UTC(y, m, 1)).toISOString(),
    });
  }
  return periods;
}

function inPeriod(pitch, period) {
  const t = Date.parse(pitch.pitchedAt);
  if (period.from && t < Date.parse(period.from)) return false;
  if (period.to && t >= Date.parse(period.to)) return false;
  return true;
}

function verdictFor({ n, clusters, estimate, ci, significant, options, subject }) {
  if (n < options.minSample || clusters < options.minClusters) {
    return {
      label: "insufficient_data",
      summary: `Only ${n} graded pitch${n === 1 ? "" : "es"} across ${clusters} independent week${clusters === 1 ? "" : "s"} — need at least ${options.minSample} and ${options.minClusters} before drawing a conclusion.`,
    };
  }
  const ciAgrees = ci && Number.isFinite(ci[0]) && Number.isFinite(ci[1]) && (ci[0] > 0 || ci[1] < 0);
  if (significant && ciAgrees) {
    const positive = estimate > 0;
    return {
      label: positive ? "positive" : "negative",
      summary: positive
        ? `Higher ${subject} has gone with better results vs the benchmark, and the effect is larger than chance would explain.`
        : `Higher ${subject} has gone with WORSE results vs the benchmark, and the effect is larger than chance would explain.`,
    };
  }
  return { label: "inconclusive", summary: `No relationship between ${subject} and results that is distinguishable from chance yet.` };
}

function correlationBlock(xs, ys, clusters, options, seed) {
  const rho = spearman(xs, ys);
  // Below the minimum sample the verdict is "insufficient_data" regardless, so
  // skip the (expensive) bootstrap rather than print an interval nobody should read.
  const enough = xs.length >= options.minSample && new Set(clusters).size >= options.minClusters;
  const ci = rho == null || !enough ? null : clusterBootstrapInterval(xs, ys, clusters, spearman, { iterations: options.bootstrapIterations, seed });
  return { rho: round(rho, 4), ci95: ci && ci.lower != null ? [round(ci.lower, 4), round(ci.upper, 4)] : null };
}

function analyzeConviction(rows, options) {
  const xs = rows.map((r) => r.pitch.conviction);
  const ys = rows.map((r) => r.outcome.excessReturn);
  const clusters = rows.map((r) => r.cluster);
  const nClusters = new Set(clusters).size;
  const correlation = correlationBlock(xs, ys, clusters, options, options.seed);
  const reg = clusteredSlope(xs, ys, clusters);
  const buckets = [];
  for (let level = CONVICTION_MIN; level <= CONVICTION_MAX; level += 1) {
    const bucket = rows.filter((r) => r.pitch.conviction === level).map((r) => r.outcome.excessReturn);
    const hits = bucket.filter((y) => y > 0).length;
    const ci = bucket.length ? wilsonInterval(hits, bucket.length) : null;
    buckets.push({
      conviction: level,
      meaning: CONVICTION_RUBRIC[level],
      n: bucket.length,
      meanExcessReturn: round(mean(bucket)),
      medianExcessReturn: round(median(bucket)),
      hitRate: bucket.length ? round(hits / bucket.length, 4) : null,
      hitRateCi95: ci ? [ci.lower, ci.upper] : null,
    });
  }
  const slopeCi = reg?.ci95 ? [round(reg.ci95[0]), round(reg.ci95[1])] : null;
  return {
    n: rows.length,
    clusters: nClusters,
    spearman: correlation,
    excessReturnPerPoint: {
      estimate: round(reg?.slope),
      se: round(reg?.se),
      ci95: slopeCi,
      pValue: round(reg?.p, 6),
      df: reg?.df ?? null,
    },
    buckets,
    verdict: verdictFor({
      n: rows.length,
      clusters: nClusters,
      estimate: reg?.slope,
      ci: correlation.ci95,
      significant: reg?.p != null && reg.p < options.alpha,
      options,
      subject: "conviction",
    }),
  };
}

function analyzeMetrics(rows, options) {
  const blocks = FEATURE_CATALOG.map((feature, index) => {
    const present = rows.filter((r) => !r.pitch.features[feature.id]?.missing);
    const missing = rows.filter((r) => r.pitch.features[feature.id]?.missing);
    const xsRaw = present.map((r) => r.pitch.features[feature.id].value);
    const ys = present.map((r) => r.outcome.excessReturn);
    const clusters = present.map((r) => r.cluster);
    const sd = xsRaw.length >= 2 ? Math.sqrt(variance(xsRaw)) : null;
    const mx = mean(xsRaw);
    const xs = sd > 0 ? xsRaw.map((x) => (x - mx) / sd) : xsRaw; // per-1-SD slope
    const correlation = sd > 0 ? correlationBlock(xs, ys, clusters, options, options.seed + index + 1) : { rho: null, ci95: null };
    const reg = sd > 0 ? clusteredSlope(xs, ys, clusters) : null;
    const meanPresent = mean(ys);
    const meanMissing = mean(missing.map((r) => r.outcome.excessReturn));
    return {
      id: feature.id,
      label: feature.label,
      group: feature.group,
      coverage: { present: present.length, missing: missing.length },
      clusters: new Set(clusters).size,
      spearman: correlation,
      excessReturnPerSd: {
        estimate: round(reg?.slope),
        se: round(reg?.se),
        ci95: reg?.ci95 ? [round(reg.ci95[0]), round(reg.ci95[1])] : null,
        pValue: round(reg?.p, 6),
      },
      missingVsPresent: {
        meanExcessPresent: round(meanPresent),
        meanExcessMissing: round(meanMissing),
        difference: meanPresent != null && meanMissing != null ? round(meanPresent - meanMissing) : null,
      },
      _p: reg?.p ?? null,
    };
  });
  const q = benjaminiHochberg(blocks.map((b) => b._p));
  return blocks
    .map(({ _p, ...block }, i) => ({
      ...block,
      excessReturnPerSd: { ...block.excessReturnPerSd, qValue: round(q[i], 6) },
      verdict: verdictFor({
        n: block.coverage.present,
        clusters: block.clusters,
        estimate: block.excessReturnPerSd.estimate,
        ci: block.spearman.ci95,
        significant: q[i] != null && q[i] < options.fdr,
        options,
        subject: feature(block.id),
      }),
    }))
    .sort((a, b) => Math.abs(b.spearman.rho ?? 0) - Math.abs(a.spearman.rho ?? 0));
}

function feature(id) {
  return FEATURE_CATALOG.find((f) => f.id === id)?.label.toLowerCase() ?? id;
}

/**
 * Build the full report.
 * @param {object} args
 * @param {object[]} args.pitches  records from buildPitch
 * @param {object[]} args.outcomes rows from gradePitch (only status "matured" are used)
 */
export function analyzePitchLab({ pitches = [], outcomes = [], horizons = null, periods = null, now = new Date(), options = {} } = {}) {
  const opts = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  const pitchById = new Map(pitches.map((p) => [p.id, p]));
  const matured = outcomes.filter((o) => o.status === "matured" && Number.isFinite(o.excessReturn) && pitchById.has(o.pitchId));
  const horizonList = horizons ?? [...new Set(matured.map((o) => o.horizonDays))].sort((a, b) => a - b);
  const periodList = periods ?? defaultPeriods(pitches, now);
  const sources = [...new Set(pitches.map((p) => p.provenance?.source).filter(Boolean))].sort();

  const reportPeriods = periodList.map((period) => ({
    ...period,
    pitchCount: pitches.filter((p) => inPeriod(p, period)).length,
    horizons: horizonList.map((horizonDays) => {
      const rows = matured
        .filter((o) => o.horizonDays === horizonDays)
        .map((o) => ({ outcome: o, pitch: pitchById.get(o.pitchId), cluster: clusterKey(o, opts.clusterBy) }))
        .filter((r) => inPeriod(r.pitch, period));
      const ys = rows.map((r) => r.outcome.excessReturn);
      return {
        horizonDays,
        graded: rows.length,
        meanExcessReturn: round(mean(ys)),
        hitRate: rows.length ? round(ys.filter((y) => y > 0).length / rows.length, 4) : null,
        conviction: analyzeConviction(rows, opts),
        metrics: analyzeMetrics(rows, opts),
      };
    }),
  }));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    gradingVersion: GRADING_VERSION,
    generatedAt: new Date(now).toISOString(),
    dataSources: sources,
    isSyntheticDemo: sources.includes("synthetic_demo"),
    totals: {
      pitches: pitches.length,
      gradedByHorizon: Object.fromEntries(horizonList.map((h) => [h, matured.filter((o) => o.horizonDays === h).length])),
    },
    assumptions: {
      benchmark: [...new Set(matured.map((o) => o.benchmark))],
      costPerSide: [...new Set(matured.map((o) => o.costPerSide))],
      success: "Excess return: the stock's return after round-trip costs minus the benchmark's return over the same sessions.",
    },
    options: opts,
    convictionRubric: CONVICTION_RUBRIC,
    periods: reportPeriods,
  };
}
