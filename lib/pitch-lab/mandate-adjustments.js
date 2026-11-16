/**
 * Mandate Review adjustments — turns the weekly matrix into a SUGGESTED change to
 * each mandate metric's weight, in basis points of the 100-point mandate score
 * (1 point = 100 bps). Suggestions only: nothing here reads or writes the mandate
 * config, creates a proposal, or touches a ledger or broker. The weights arrive as a
 * parameter (the agent's AGENT_SCORING entry) so this module never imports the config.
 *
 * Rules (docs/PITCH-LAB.md "Mandate Review adjustments"):
 *   - The AGGREGATE decides. A weekly column can never create or cancel a suggestion;
 *     the weekly tally only sets the confidence (recommended vs watch).
 *       more   the aggregate is positive and survives the false-discovery control
 *       less   the aggregate is negative and survives it (also flagged: the metric is
 *              working backwards), OR the metric is clearly weaker than the other
 *              metrics (weekly-matrix.js `relative`), which is capped at "watch"
 *   - Size: 100 bps when recommended, 50 bps when watch. Never more than 100 bps a
 *     review, always a multiple of 50 bps, never below a weight of zero.
 *   - The mandate stays at 100 points and every category keeps its own total, so each
 *     move is paired inside its category: first against opposite suggestions, then
 *     against metrics that have enough data and showed no clear effect ("offset").
 *     Metrics with no data or too little data are never used as the other side. A move
 *     with nothing to pair against is reported but not sized.
 *   - Changes are relative to the weights passed in (the live config), never stacked on
 *     an earlier review's suggestion.
 *
 * Pure: no I/O. Fail closed: missing or malformed evidence yields "unavailable".
 */

export const ADJUSTMENT_VERSION = "pitch-lab.mandate-adjustments.v1";

export const ADJUSTMENT_RULES = Object.freeze({
  primaryHorizonDays: 10, // the holding period the suggestions are read from
  fdr: 0.10, // the analysis's own false-discovery threshold
  recommendedStepBps: 100,
  watchStepBps: 50,
  maxStepBps: 100, // per metric, per review (applies to offsets too)
  roundBps: 50,
  consistentShare: 0.6, // share of weeks agreeing with the aggregate needed for "recommended"
  minWeeksForConsistency: 3,
  bpsPerPoint: 100,
});

const isFiniteNum = (value) => typeof value === "number" && Number.isFinite(value);

/** The agent's metrics in mandate order, with their category and weight in bps. */
function mandateMetrics(agentScoring, bpsPerPoint) {
  const out = [];
  for (const [categoryId, category] of Object.entries(agentScoring?.categories ?? {})) {
    for (const [metricId, spec] of Object.entries(category?.metrics ?? {})) {
      out.push({ metricId, category: categoryId, currentBps: isFiniteNum(spec?.points) ? Math.round(spec.points * bpsPerPoint) : null });
    }
  }
  return out;
}

/** What the evidence says about one metric, before any sizing. */
function classify(metric, rules) {
  const aggregate = metric?.aggregate ?? null;
  const verdict = aggregate?.verdict ?? null;
  const qValue = aggregate?.excessReturnPerSd?.qValue ?? null;
  const evidence = {
    n: aggregate?.n ?? 0,
    weeks: aggregate?.weeks ?? 0,
    aggregateRho: isFiniteNum(aggregate?.rho) ? aggregate.rho : null,
    ci95: aggregate?.ci95 ?? null,
    qValue: isFiniteNum(qValue) ? qValue : null,
    verdict,
    weeksPositive: metric?.weeksPositive ?? 0,
    weeksNegative: metric?.weeksNegative ?? 0,
    weeksUsed: metric?.weeksUsed ?? 0,
    consistency: metric?.consistency?.score ?? null,
    spread: metric?.spread?.overall ?? null,
    spreadSdWeekly: metric?.spread?.sdWeekly ?? null,
    relative: metric?.relative ? { status: metric.relative.status, difference: metric.relative.difference ?? null, ci95: metric.relative.ci95 ?? null } : null,
  };
  const result = (direction, confidenceLabel, basis, extra = {}) => ({ direction, confidenceLabel, basis, evidence, ...extra });

  if (!metric || !aggregate || !evidence.n) return result("unavailable", "unavailable", "no_data");
  if (verdict === "insufficient_data") return result("no_change", "no_change", "not_enough_data");
  if (!["positive", "negative", "inconclusive"].includes(verdict) || evidence.aggregateRho == null) return result("unavailable", "unavailable", "malformed_evidence");

  const consistent = (agreeing) => evidence.weeksUsed >= rules.minWeeksForConsistency && agreeing / evidence.weeksUsed >= rules.consistentShare;
  if (verdict === "positive" || verdict === "negative") {
    // A clear verdict without a usable q-value is malformed, never "no effect".
    if (evidence.qValue == null) return result("unavailable", "unavailable", "malformed_evidence");
    if (evidence.qValue <= rules.fdr) {
      return verdict === "positive"
        ? result("more", consistent(evidence.weeksPositive) ? "recommended" : "watch", "aggregate_positive")
        : result("less", consistent(evidence.weeksNegative) ? "recommended" : "watch", "aggregate_negative", { reviewDirection: true });
    }
  }
  if (evidence.relative?.status === "below_others") return result("less", "watch", "weaker_than_other_metrics");
  return result("no_change", "no_change", "no_clear_effect");
}

/**
 * Pair the wanted moves inside one category so its total does not change. Mutates the
 * rows' `changeBps`; rows are this category's only.
 */
function balanceCategory(rows, rules) {
  const step = rules.roundBps;
  const rho = (row) => row.evidence.aggregateRho ?? 0;
  const ups = rows.filter((row) => row.direction === "more");
  const downs = rows.filter((row) => row.direction === "less");
  const neutral = rows.filter((row) => row.direction === "no_change" && row.basis === "no_clear_effect" && isFiniteNum(row.currentBps));
  const total = (list) => list.reduce((sum, row) => sum + Math.abs(row.changeBps), 0);

  let gap = total(ups) - total(downs); // > 0: increases need funding; < 0: decreases need a home
  if (gap === 0) return;
  const raising = gap > 0;
  // Offsets come from the metrics that look weakest (when funding an increase) or
  // strongest (when placing a decrease), one step at a time so no single metric carries it all.
  const partners = [...neutral].sort((a, b) => (raising ? rho(a) - rho(b) : rho(b) - rho(a)) || a.order - b.order);
  const room = (row) => (raising ? Math.min(rules.maxStepBps, row.currentBps) : rules.maxStepBps) - Math.abs(row.changeBps);
  let progressed = true;
  while (gap !== 0 && progressed) {
    progressed = false;
    for (const row of partners) {
      if (gap === 0) break;
      if (room(row) < step) continue;
      row.changeBps += raising ? -step : step;
      row.direction = "offset";
      row.basis = "offset";
      gap += raising ? -step : step;
      progressed = true;
    }
  }
  if (gap === 0) return;

  // Nothing left to pair against: scale the unpaired side back, weakest evidence first.
  const unpaired = [...(raising ? ups : downs)].sort((a, b) =>
    (a.confidenceLabel === "watch" ? 0 : 1) - (b.confidenceLabel === "watch" ? 0 : 1)
    || Math.abs(rho(a)) - Math.abs(rho(b))
    || b.order - a.order);
  progressed = true;
  while (gap !== 0 && progressed) {
    progressed = false;
    for (const row of unpaired) {
      if (gap === 0) break;
      if (Math.abs(row.changeBps) < step) continue;
      row.changeBps += raising ? -step : step;
      gap += raising ? -step : step;
      progressed = true;
    }
  }
}

/**
 * @param {object|null} weeklyMatrix  report.weeklyMatrix (weekly-matrix.js)
 * @param {object} agentScoring       the agent's AGENT_SCORING entry (weights)
 * @param {object} [rules]            ADJUSTMENT_RULES overrides
 * @returns {object|null} null when there is no matrix for the horizon (no suggestion can be made)
 */
export function buildMandateAdjustments(weeklyMatrix, agentScoring, rules = ADJUSTMENT_RULES) {
  const opts = { ...ADJUSTMENT_RULES, ...rules };
  const horizons = Array.isArray(weeklyMatrix?.horizons) ? weeklyMatrix.horizons : [];
  const horizon = horizons.find((h) => h?.horizonDays === opts.primaryHorizonDays) ?? null;
  const weights = mandateMetrics(agentScoring, opts.bpsPerPoint);
  if (!horizon || !weights.length) return null;

  const byId = new Map((horizon.metrics ?? []).map((metric) => [metric?.id, metric]));
  const rows = weights.map((weight, order) => {
    const metric = byId.get(weight.metricId) ?? null;
    const row = { order, metricId: weight.metricId, label: metric?.label ?? null, category: weight.category, currentBps: weight.currentBps, ...classify(metric, opts), changeBps: 0 };
    if (weight.currentBps == null && (row.direction === "more" || row.direction === "less")) {
      return { ...row, direction: "unavailable", confidenceLabel: "unavailable", basis: "no_current_weight" };
    }
    if (row.direction === "more") row.changeBps = row.confidenceLabel === "recommended" ? opts.recommendedStepBps : opts.watchStepBps;
    if (row.direction === "less") {
      const wanted = row.confidenceLabel === "recommended" ? opts.recommendedStepBps : opts.watchStepBps;
      // Never below zero, and still a whole number of steps.
      row.changeBps = 0 - Math.min(wanted, Math.floor(weight.currentBps / opts.roundBps) * opts.roundBps);
    }
    row.wantedBps = row.changeBps;
    return row;
  });

  for (const category of new Set(rows.map((row) => row.category))) {
    balanceCategory(rows.filter((row) => row.category === category), opts);
  }

  const finished = rows.map(({ order: _order, wantedBps, ...row }) => {
    const moved = row.direction === "more" || row.direction === "less";
    return {
      ...row,
      suggestedBps: row.currentBps == null ? null : row.currentBps + row.changeBps,
      // A wanted move that could not be (fully) paired inside its category.
      ...(moved && row.changeBps !== wantedBps ? { wantedBps, sized: row.changeBps !== 0 ? "partial" : "not_sized" } : {}),
    };
  });
  const count = (direction) => finished.filter((row) => row.direction === direction).length;
  return {
    version: ADJUSTMENT_VERSION,
    horizonDays: horizon.horizonDays,
    rules: { ...opts },
    currentTotalBps: finished.reduce((sum, row) => sum + (row.currentBps ?? 0), 0),
    netChangeBps: finished.reduce((sum, row) => sum + row.changeBps, 0),
    summary: { more: count("more"), less: count("less"), offset: count("offset"), noChange: count("no_change"), unavailable: count("unavailable") },
    rows: finished,
  };
}
