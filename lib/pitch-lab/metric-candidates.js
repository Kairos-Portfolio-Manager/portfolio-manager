/**
 * Mandate Review metric ideas — SOFT suggestions about the metric list itself:
 * which recorded-but-unweighted features might deserve a place in the mandate, and
 * which mandate metrics might not be earning theirs. Deliberately looser than the
 * weight adjustments: these are prompts for a human look, never a sized change, and
 * nothing here reads or writes the mandate config.
 *
 *   add     a feature Pitch Lab records on every pitch but the mandate does not weight
 *           (price momentum, RSI, volume, distance from the high, company size):
 *             "consider"  its effect survives the false-discovery control
 *             "leaning"   its correlation interval excludes zero but it does not survive
 *   remove  a mandate metric that
 *             "no_data"    has (almost) never had a value: fix its data source or drop it
 *             "flat"       has plenty of data and an effect pinned close to zero
 *             "backwards"  goes with WORSE results, beyond chance
 *             "overlaps"   ranks pitches almost exactly like another mandate metric
 *
 * Pure. Read from one holding period (the review's own). Empty lists are the normal
 * result; the review only prints this section when there is something to say.
 */

export const CANDIDATE_RULES = Object.freeze({
  primaryHorizonDays: 10,
  fdr: 0.10,
  flatBand: 0.08, // a correlation interval entirely inside ±this is "pinned near zero"
  flatMinSample: 100, // ...and only with at least this many graded pitches behind it
  noDataShare: 0.05, // a metric with a value on under this share of graded pitches has "no data"
  maxPerList: 5,
});

const isFiniteNum = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * @param {object} report        analyzePitchLab output
 * @param {object} agentScoring  the agent's AGENT_SCORING entry (to know which metrics the mandate weights)
 * @returns {{ horizonDays, add: object[], remove: object[] } | null} null when the horizon is not in the report
 */
export function buildMetricCandidates(report, agentScoring, rules = CANDIDATE_RULES) {
  const opts = { ...CANDIDATE_RULES, ...rules };
  const all = Array.isArray(report?.periods) ? report.periods.find((period) => period?.id === "all") : null;
  const horizon = all?.horizons?.find((h) => h?.horizonDays === opts.primaryHorizonDays) ?? null;
  const matrixHorizon = report?.weeklyMatrix?.horizons?.find((h) => h?.horizonDays === opts.primaryHorizonDays) ?? null;
  if (!horizon) return null;
  const minSample = report.options?.minSample ?? 30;
  const minClusters = report.options?.minClusters ?? 8;
  const mandateIds = new Set(Object.values(agentScoring?.categories ?? {}).flatMap((category) => Object.keys(category?.metrics ?? {})));

  // ── add: recorded features the mandate does not weight ──
  const add = [];
  for (const block of horizon.metrics ?? []) {
    if (!block?.id || mandateIds.has(block.id)) continue;
    const rho = block.spearman?.rho;
    const ci = block.spearman?.ci95;
    const q = block.excessReturnPerSd?.qValue;
    const label = block.verdict?.label;
    if (!isFiniteNum(rho) || (block.coverage?.present ?? 0) < minSample || (block.clusters ?? 0) < minClusters) continue;
    const significant = (label === "positive" || label === "negative") && isFiniteNum(q) && q <= opts.fdr;
    const leaning = !significant && Array.isArray(ci) && isFiniteNum(ci[0]) && isFiniteNum(ci[1]) && (ci[0] > 0 || ci[1] < 0);
    if (!significant && !leaning) continue;
    add.push({
      featureId: block.id,
      label: block.label ?? block.id,
      strength: significant ? "consider" : "leaning",
      // Raw feature values have no built-in direction: say which way went with better results.
      direction: rho > 0 ? "higher_is_better" : "lower_is_better",
      rho,
      ci95: ci ?? null,
      qValue: isFiniteNum(q) ? q : null,
      n: block.coverage.present,
      weeks: block.clusters,
    });
  }
  add.sort((a, b) => (a.strength === b.strength ? Math.abs(b.rho) - Math.abs(a.rho) : a.strength === "consider" ? -1 : 1));

  // ── remove: mandate metrics that are not earning their place ──
  const remove = [];
  const graded = matrixHorizon?.graded ?? 0;
  const enoughOverall = graded >= minSample && (matrixHorizon?.weekCount ?? 0) >= minClusters;
  const labelOf = new Map((matrixHorizon?.metrics ?? []).map((metric) => [metric.id, metric.label ?? metric.id]));
  for (const metric of enoughOverall ? matrixHorizon.metrics ?? [] : []) {
    if (!mandateIds.has(metric.id)) continue;
    const n = metric.aggregate?.n ?? 0;
    const rho = metric.aggregate?.rho;
    const ci = metric.aggregate?.ci95;
    const q = metric.aggregate?.excessReturnPerSd?.qValue;
    const base = { metricId: metric.id, label: metric.label ?? metric.id, n, rho: isFiniteNum(rho) ? rho : null, ci95: ci ?? null };
    if (n / graded < opts.noDataShare) {
      remove.push({ ...base, reason: "no_data", detail: `a value on ${n} of ${graded} graded pitches` });
      continue;
    }
    if (metric.aggregate?.verdict === "negative" && isFiniteNum(q) && q <= opts.fdr) {
      remove.push({ ...base, reason: "backwards", qValue: q, detail: "higher scores went with worse results" });
      continue;
    }
    if (n >= opts.flatMinSample && Array.isArray(ci) && isFiniteNum(ci[0]) && isFiniteNum(ci[1]) && ci[0] > -opts.flatBand && ci[1] < opts.flatBand) {
      remove.push({ ...base, reason: "flat", detail: `correlation between ${ci[0]} and ${ci[1]} on ${n} pitches` });
    }
  }
  for (const pair of enoughOverall ? matrixHorizon.overlaps ?? [] : []) {
    if (!mandateIds.has(pair.a) || !mandateIds.has(pair.b)) continue;
    remove.push({
      metricId: pair.b, label: labelOf.get(pair.b) ?? pair.b, reason: "overlaps", n: pair.n, rho: pair.rho, ci95: null,
      overlapsWith: pair.a, overlapsWithLabel: labelOf.get(pair.a) ?? pair.a,
      detail: `ranks pitches like ${labelOf.get(pair.a) ?? pair.a} (correlation ${pair.rho} on ${pair.n} pitches)`,
    });
  }

  return { horizonDays: opts.primaryHorizonDays, add: add.slice(0, opts.maxPerList), remove: remove.slice(0, opts.maxPerList) };
}
