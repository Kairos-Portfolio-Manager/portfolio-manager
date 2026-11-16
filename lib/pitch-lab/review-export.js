/**
 * Mandate Review spreadsheet export — the review, the weekly matrix, the spread
 * history and the per-pitch data behind them, laid out as tabs of plain rows.
 *
 * Pure: takes the review, the report it was generated from and the stored pitches
 * and outcomes; returns `[{ name, rows }]`. The caller writes the file
 * (xlsx-writer.js). Every number on the first tabs can be recomputed from the last
 * one, which is the point: nothing in the review has to be taken on trust.
 *
 * Paper research only. No secrets, no account data: tickers, dates, metric ranks,
 * scores and returns.
 */
import { FEATURE_CATALOG } from "./features.js";
import { mandateTotalFor } from "./mandate-score.js";
import { PEER_RANK_METRIC_IDS } from "./peer-rank.js";
import { convictionScaleOf } from "./pitch.js";
import { isoWeekKey } from "./weekly-matrix.js";

const METRICS = FEATURE_CATALOG.filter((feature) => PEER_RANK_METRIC_IDS.includes(feature.id));

const SUGGESTION = {
  more: "more weight",
  less: "less weight",
  offset: "offset inside its category",
  no_change: "no change",
  unavailable: "no change (evidence unavailable)",
};

const BASIS = {
  aggregate_positive: "aggregate went with better results",
  aggregate_negative: "aggregate went with worse results (check the metric's direction)",
  weaker_than_other_metrics: "clearly weaker than the other metrics",
  offset: "keeps its category total unchanged",
  no_clear_effect: "no clear effect",
  not_enough_data: "not enough graded pitches yet",
  no_data: "no data yet",
  malformed_evidence: "evidence unavailable",
  no_current_weight: "no weight in the mandate",
};

function summarySheet(review, report) {
  const insufficient = review.status === "insufficient_data" ? review.insufficientData ?? {} : null;
  const rules = review.adjustments?.rules ?? null;
  return {
    name: "Summary",
    rows: [
      ["Pitch Lab — weekly Mandate Review"],
      ["Paper research only. Suggestions only: no mandate change has been made."],
      [],
      ["Review period", review.period ?? null],
      ["Generated at (UTC)", review.generatedAt ?? null],
      ["Agent", review.agentId ?? null],
      ["Status", review.status ?? null],
      ["Graded pitches", insufficient ? insufficient.gradedPitches ?? null : review.gradedPitches ?? null],
      ["Independent weeks", insufficient ? insufficient.independentWeeks ?? null : review.independentWeeks ?? null],
      ...(insufficient ? [["More pitches needed", insufficient.moreNeeded?.pitches ?? null], ["More weeks needed", insufficient.moreNeeded?.weeks ?? null]] : []),
      ["Benchmark", (report?.assumptions?.benchmark ?? []).join(", ") || null],
      ["Cost per side", (report?.assumptions?.costPerSide ?? []).join(", ") || null],
      ["Success measure", report?.assumptions?.success ?? null],
      [],
      ["How to read the tabs"],
      ["Correlation", "Spearman rank correlation between a metric's industry-peer percentile and the pitch's excess return. Positive = the metric worked the way the mandate expects."],
      ["Week", "The ISO week a pitch ENTERED (the first close after it was pitched). Columns are labelled by that week's Monday."],
      ["Aggregate", "All graded pitches pooled. Only the aggregate can create a suggestion; the weekly columns set its confidence."],
      ["Consistency", "Mean of the weekly correlations divided by their week-to-week standard deviation. Higher = more reliable."],
      ["Spread", "Mean excess return of the top fifth of pitches by the metric minus the bottom fifth. Should be large and positive, with a small week-to-week SD."],
      ["bps", "Basis points of the 100-point mandate score: 100 bps = 1 point."],
      ...(rules ? [
        [],
        ["Sizing rules"],
        ["Suggestions read from", `${rules.primaryHorizonDays}-day results`],
        ["Recommended step (bps)", rules.recommendedStepBps],
        ["Watch step (bps)", rules.watchStepBps],
        ["Largest step per review (bps)", rules.maxStepBps],
        ["Rounded to (bps)", rules.roundBps],
        ["False-discovery threshold (q)", rules.fdr],
        ["Weeks agreeing needed for recommended", rules.consistentShare],
      ] : []),
      [],
      ["Caveats"],
      ...(review.caveats ?? []).map((caveat) => [caveat]),
    ],
  };
}

function adjustmentsSheet(review) {
  const header = ["Metric", "Category", "Current weight (bps)", "Suggested change (bps)", "Suggested weight (bps)", "Suggestion", "Confidence", "Why", "Wanted change (bps)", "Aggregate correlation", "CI low", "CI high", "q-value", "Pitches", "Weeks positive", "Weeks negative", "Weeks used", "Consistency", "Top-vs-bottom spread", "Spread SD (weekly)", "Vs other metrics", "Difference vs others"];
  const rows = (review.adjustments?.rows ?? []).map((row) => {
    const e = row.evidence ?? {};
    return [
      row.label ?? row.metricId, row.category, row.currentBps, row.changeBps, row.suggestedBps,
      row.sized === "not_sized" ? `${SUGGESTION[row.direction]} (not sized: nothing in its category to pair it with)` : SUGGESTION[row.direction] ?? row.direction,
      row.direction === "offset" ? "offset" : row.confidenceLabel, BASIS[row.basis] ?? row.basis, row.wantedBps ?? null,
      e.aggregateRho ?? null, e.ci95?.[0] ?? null, e.ci95?.[1] ?? null, e.qValue ?? null, e.n ?? null,
      e.weeksPositive ?? null, e.weeksNegative ?? null, e.weeksUsed ?? null, e.consistency ?? null,
      e.spread ?? null, e.spreadSdWeekly ?? null, e.relative?.status ?? null, e.relative?.difference ?? null,
    ];
  });
  if (!rows.length) {
    return { name: "Adjustments", rows: [["No sized suggestions in this review."], [review.status === "insufficient_data" ? "Not enough graded pitches or independent weeks yet." : "The report carried no weekly matrix for the review's holding period."]] };
  }
  const net = review.adjustments.netChangeBps;
  return { name: "Adjustments", rows: [header, ...rows, [], ["Net change (bps)", null, review.adjustments.currentTotalBps, net, review.adjustments.currentTotalBps + net]] };
}

function matrixSheet(horizon) {
  const weeks = horizon.weeks ?? [];
  const header = ["Metric", ...weeks.map((week) => week.weekStart), "Aggregate", "Aggregate verdict", "q-value", "Weeks positive", "Weeks negative", "Weeks used", "Consistency"];
  const blank = weeks.map(() => null);
  return {
    name: `Matrix ${horizon.horizonDays}d`,
    rows: [
      [`Correlation with ${horizon.horizonDays}-day excess return, by entry week`],
      header,
      ...(horizon.metrics ?? []).map((metric) => [
        metric.label, ...metric.cells.map((cell) => cell.rho), metric.aggregate.rho, metric.aggregate.verdict, metric.aggregate.excessReturnPerSd?.qValue ?? null,
        metric.weeksPositive, metric.weeksNegative, metric.weeksUsed, metric.consistency.score,
      ]),
      [],
      ["Pitches graded", ...weeks.map((week) => week.graded), horizon.graded],
      ["Average excess return", ...weeks.map((week) => week.meanExcessReturn)],
      ["Average benchmark return (same holding periods)", ...weeks.map((week) => week.meanBenchmarkReturn)],
      [],
      ["Pitches behind each cell (a correlation needs enough of them; blank above = too few)"],
      ["Metric", ...weeks.map((week) => week.weekStart), "All weeks"],
      ...(horizon.metrics ?? []).map((metric) => [metric.label, ...metric.cells.map((cell) => cell.n), metric.aggregate.n]),
      [],
      ["Weekly cell is statistically distinguishable from zero (1 = yes)"],
      ["Metric", ...weeks.map((week) => week.weekStart)],
      ...(horizon.metrics ?? []).map((metric) => [metric.label, ...metric.cells.map((cell) => (cell.rho == null ? null : cell.significant ? 1 : 0))]),
      ...(blank.length ? [] : [[], ["No graded weeks yet."]]),
    ],
  };
}

function spreadSheet(horizon) {
  const weeks = horizon.weeks ?? [];
  return {
    name: `Spread ${horizon.horizonDays}d`,
    rows: [
      [`Top fifth minus bottom fifth, ${horizon.horizonDays}-day excess return, by entry week`],
      ["Metric", ...weeks.map((week) => week.weekStart), "All pitches", "Mean of weeks", "SD of weeks", "Weeks used"],
      ...(horizon.metrics ?? []).map((metric) => [
        metric.label, ...metric.cells.map((cell) => cell.spread), metric.spread.overall, metric.spread.meanWeekly, metric.spread.sdWeekly, metric.spread.weeksUsed,
      ]),
    ],
  };
}

function pitchesSheet(pitches, outcomes, horizons) {
  const byPitch = new Map();
  for (const outcome of outcomes) {
    if (outcome.status !== "matured" || !Number.isFinite(outcome.excessReturn)) continue;
    if (!byPitch.has(outcome.pitchId)) byPitch.set(outcome.pitchId, new Map());
    byPitch.get(outcome.pitchId).set(outcome.horizonDays, outcome);
  }
  const header = [
    "Pitch id", "Ticker", "Pitched at (UTC)", "Entry date", "Entry week", "Week start (Monday)", "Model conviction", "Conviction scale", "Mandate score (0-100)",
    ...METRICS.map((metric) => `${metric.label} — peer percentile`),
    ...horizons.flatMap((h) => [`Excess return ${h}d`, `Stock return after costs ${h}d`, `Benchmark return ${h}d`]),
  ];
  const rows = [...pitches]
    .sort((a, b) => String(a.pitchedAt).localeCompare(String(b.pitchedAt)) || String(a.ticker).localeCompare(String(b.ticker)))
    .map((pitch) => {
      const graded = byPitch.get(pitch.id) ?? new Map();
      const entryDate = [...graded.values()].map((outcome) => outcome.entryDate).find(Boolean) ?? null;
      const weekStart = entryDate ? (() => { const d = new Date(`${entryDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })() : null;
      return [
        pitch.id, pitch.ticker, pitch.pitchedAt, entryDate, entryDate ? isoWeekKey(entryDate) : null, weekStart,
        pitch.conviction ?? null, convictionScaleOf(pitch), mandateTotalFor(pitch),
        ...METRICS.map((metric) => {
          const rank = pitch.peers?.ranks?.[metric.id];
          return rank?.status === "ranked" && Number.isFinite(rank.percentile) ? rank.percentile : null;
        }),
        ...horizons.flatMap((h) => {
          const outcome = graded.get(h);
          return [outcome?.excessReturn ?? null, outcome?.netReturn ?? null, outcome?.benchmarkReturn ?? null];
        }),
      ];
    });
  return { name: "Pitches", rows: [header, ...rows] };
}

/**
 * @param {object} args
 * @param {object} args.review   generateMandateReview output
 * @param {object} args.report   the analyzePitchLab report it came from (carries every week)
 * @param {object[]} args.pitches
 * @param {object[]} args.outcomes
 * @returns {{ name: string, rows: any[][] }[]}
 */
export function buildReviewExport({ review, report, pitches = [], outcomes = [] } = {}) {
  if (!review || typeof review !== "object") throw new TypeError("buildReviewExport: review is required");
  // The report keeps every week; the stored review only the most recent ones.
  const matrix = report?.weeklyMatrix ?? review.weeklyMatrix ?? null;
  const horizons = matrix?.horizons ?? [];
  const primary = review.adjustments?.horizonDays ?? null;
  // The review's own holding period first, then the others.
  const ordered = [...horizons].sort((a, b) => (a.horizonDays === primary ? -1 : b.horizonDays === primary ? 1 : a.horizonDays - b.horizonDays));
  return [
    summarySheet(review, report),
    adjustmentsSheet(review),
    ...ordered.map(matrixSheet),
    ...ordered.map(spreadSheet),
    pitchesSheet(pitches, outcomes, horizons.map((h) => h.horizonDays).sort((a, b) => a - b)),
  ];
}
