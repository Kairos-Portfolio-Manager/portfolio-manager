import { FEATURE_CATALOG } from "./features.js";
import { convictionScaleOf } from "./pitch.js";
import { BAND_LABELS, scoreBreakdownFor } from "./score-breakdown.js";
import { mandateTotalFor } from "./mandate-score.js";
import { bandFraction } from "../peer-scoring.js";

const compact = (text, limit = 150) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
};

const pct = (value, { signed = false } = {}) => {
  if (!Number.isFinite(value)) return "—";
  const number = (value * 100).toFixed(1);
  return `${signed && value > 0 ? "+" : ""}${number}%`;
};

/** "conviction 7/10 · Mandate 6.2/10 (5/9 metrics)" — the model's view and the peer-only /10 score, for pitches without a 0-100 mandate score. */
export function scoreLine(pitch) {
  const b = scoreBreakdownFor(pitch);
  const mandate = b.score == null ? "Mandate score unavailable (no peer ranks)" : `Mandate ${b.score.toFixed(1)}/${b.scale} (${b.metricsScored}/${b.metricsTotal} metrics)`;
  return `conviction ${pitch.conviction}/${convictionScaleOf(pitch)} · ${mandate}`;
}

function dailyOutcomeLines(outcomes) {
  const groups = new Map();
  for (const outcome of outcomes) {
    const group = groups.get(outcome.horizonDays) ?? [];
    group.push(outcome);
    groups.set(outcome.horizonDays, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([horizon, rows]) => {
    const hits = rows.filter((row) => row.excessReturn > 0).length;
    const average = rows.reduce((sum, row) => sum + row.excessReturn, 0) / rows.length;
    return `• ${horizon}-day: ${hits}/${rows.length} beat SPY; average ${pct(average, { signed: true })}`;
  });
}

/** How many pitches the daily digest walks through metric by metric. */
export const DAILY_TOP_PITCHES = 4;

/** Telegram rejects a message over 4096 characters; stay under it with room to spare. */
export const TELEGRAM_SAFE_LENGTH = 3900;

const MANDATE_METRICS = FEATURE_CATALOG.filter((feature) => feature.group === "fundamental");

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** Points without trailing zeros: 13.5, 11.25, 8. */
const pts = (value) => String(Number(Number(value).toFixed(2)));

const scoredMandate = (pitch) => (mandateTotalFor(pitch) == null ? null : pitch.mandateScore);

/** How one metric was ranked, in words. `null` when the metric has no points. */
function rankPhrase(entry) {
  if (!entry || entry.missing || !Number.isFinite(entry.points)) return null;
  const percentile = Number.isFinite(entry.percentile) ? `${ordinal(Math.round(entry.percentile * 100))} percentile` : null;
  if (entry.fallbackMethod === "absolute" || !percentile) return "fixed bands (too few peers to rank)";
  if (entry.fallbackMethod === "blended_50_50") return `${percentile}, blended with fixed bands (thin peer set)`;
  return percentile;
}

function metricRows(score) {
  return MANDATE_METRICS.map(({ id, label }) => {
    const entry = score.perMetric?.[id];
    const rank = rankPhrase(entry);
    const fraction = rank && entry.maxPoints > 0 ? entry.points / entry.maxPoints : null;
    return { id, label, entry, rank, fraction };
  });
}

function peerBand(entry) {
  if (entry.fallbackMethod !== "peer_relative" || !Number.isFinite(entry.percentile)) return null;
  const band = BAND_LABELS[bandFraction(entry.percentile)];
  if (!band) return null;
  return band === "above median" ? "just above the peer median" : `${band} of peers`;
}

/**
 * The digest's per-pitch walk-through: every mandate metric with its rank and points,
 * the points summed to the 0-100 mandate score, then the best and the worst metric.
 * Everything comes from the `mandateScore` frozen on the pitch — no model text.
 */
function mandateWalkthrough(pitch, position) {
  const score = scoredMandate(pitch);
  if (!score) {
    // No 0-100 score on this pitch (an older record, or inputs the scorer does not support):
    // fall back to the peer-only /10 line rather than inventing a walk-through.
    const reason = pitch?.mandateScore?.reason ? `: ${compact(pitch.mandateScore.reason, 80)}` : "";
    return [`${position}. ${pitch.ticker} — no 0-100 mandate score${reason}`, scoreLine(pitch)];
  }
  const rows = metricRows(score);
  const scored = rows.filter((row) => row.fraction != null);
  const lines = [
    `${position}. ${pitch.ticker} — mandate score ${score.total}/100`,
    `Model conviction: ${pitch.conviction}/${convictionScaleOf(pitch)}`,
  ];
  for (const row of rows) {
    lines.push(row.rank
      ? `${row.label}: ${row.rank}, ${pts(row.entry.points)}/${pts(row.entry.maxPoints)} pts`
      : `${row.label}: no data, not scored`);
  }
  const capped = Number.isFinite(score.uncappedTotal) && score.uncappedTotal !== score.total
    ? `, capped from ${score.uncappedTotal} for a thin peer set`
    : "";
  lines.push(`Total: ${pts(score.rawPoints)} of ${pts(score.maxAvailable)} available pts = ${score.total}/100 (${scored.length} of ${rows.length} metrics had data${capped})`);

  // Best and worst by share of the metric's own points; ties go to the metric worth more.
  const byShare = [...scored].sort((a, b) => b.fraction - a.fraction || b.entry.maxPoints - a.entry.maxPoints);
  const best = byShare[0];
  const worst = [...scored].sort((a, b) => a.fraction - b.fraction || b.entry.maxPoints - a.entry.maxPoints)[0];
  if (best) lines.push(`Stands out: ${best.label}, ${best.rank}, ${pts(best.entry.points)}/${pts(best.entry.maxPoints)} pts.`);
  if (worst && worst !== best) {
    const band = peerBand(worst.entry);
    lines.push(`Biggest risk: ${worst.label}, ${worst.rank}${band ? ` (${band})` : ""}, ${pts(worst.entry.points)}/${pts(worst.entry.maxPoints)} pts.`);
  } else if (scored.length > 1) {
    // Every scored metric earned the same share of its points: there is no worst one to name.
    lines.push(`Biggest risk: no single metric; every scored metric earned ${Math.round(best.fraction * 100)}% of its points.`);
  } else {
    const gaps = rows.length - scored.length;
    lines.push(`Biggest risk: only ${scored.length} of ${rows.length} metrics had data, so ${gaps} could not be checked.`);
  }
  return lines;
}

/** Highest mandate score first; unscored pitches last, by the model's conviction. */
function strongestPitches(pitches, count = DAILY_TOP_PITCHES) {
  const metricsScored = (pitch) => Object.values(pitch?.mandateScore?.perMetric ?? {}).filter((m) => m && !m.missing).length;
  const share = (pitch) => pitch.conviction / convictionScaleOf(pitch);
  return [...pitches].sort((a, b) => {
    const [ta, tb] = [mandateTotalFor(a), mandateTotalFor(b)];
    if (ta != null || tb != null) {
      if (ta == null) return 1;
      if (tb == null) return -1;
      if (ta !== tb) return tb - ta;
      if (metricsScored(a) !== metricsScored(b)) return metricsScored(b) - metricsScored(a);
    } else if (share(a) !== share(b)) return share(b) - share(a);
    return String(a.ticker).localeCompare(String(b.ticker));
  }).slice(0, count);
}

/**
 * How many of today's scored pitches had each mandate metric at all. This is the line to
 * watch when a data source is added: a metric stuck at 0 is not being fed.
 */
function dataCoverageLines(pitches) {
  const scored = pitches.map(scoredMandate).filter(Boolean);
  if (!scored.length) return [];
  return [
    "",
    `Data behind today's scores (pitches with each metric, of ${scored.length})`,
    ...MANDATE_METRICS.map(({ id, label }) => `${label}: ${scored.filter((score) => rankPhrase(score.perMetric?.[id])).length}`),
  ];
}

export function formatPitchLabDailyTelegram({ date, pitches = [], outcomes = [], run = null, failedTickers = [], gradingError = null } = {}) {
  const top = strongestPitches(pitches);
  const ranked = pitches.flatMap((pitch) => Object.values(pitch?.peers?.ranks ?? {}));
  const rankedShare = ranked.length ? ranked.filter((entry) => entry?.status === "ranked").length / ranked.length : null;
  const lines = [
    `Pitch Lab — ${date}`,
    `Agent 1 made ${pitches.length} paper pitch${pitches.length === 1 ? "" : "es"}${run?.selected ? ` from ${run.selected} selected companies` : ""}.`,
  ];
  if (run?.status === "no_catalog") lines.push("The company catalog was unavailable, so there was nothing to evaluate today.");
  else if (run?.status === "budget_stop") lines.push("The run stopped at its budget boundary; already-recorded pitches remain valid.");
  if (run?.failedCount) lines.push(`${run.failedCount} pitch${run.failedCount === 1 ? " was" : "es were"} dropped because the record or source data was incomplete.`);
  if (run?.shortfall) lines.push(`The eligible pool was ${run.shortfall} name${run.shortfall === 1 ? "" : "s"} short of the daily target.`);
  if (top.length) {
    lines.push("", `Strongest pitches (top ${top.length} by mandate score)`);
    top.forEach((pitch, index) => lines.push("", ...mandateWalkthrough(pitch, index + 1)));
  }
  lines.push("", "Results graded today");
  const outcomeLines = dailyOutcomeLines(outcomes);
  lines.push(...(outcomeLines.length ? outcomeLines : ["No holding periods matured today."]));
  if (gradingError) lines.push("Grading could not finish today; stored pitches are safe and grading will retry.");
  lines.push(...dataCoverageLines(pitches));
  if (rankedShare != null) lines.push(`Peer comparisons were usable for ${Math.round(rankedShare * 100)}% of today's metric checks.`);
  if (failedTickers.length) lines.push(`Price data is still pending for: ${failedTickers.slice(0, 8).join(", ")}.`);
  lines.push("", "Paper research only — no real trade or proposal was created.");
  return lines.join("\n");
}

/**
 * Split a long digest into parts Telegram will accept, breaking only between
 * blank-line-separated blocks (or between lines when one block alone is too long),
 * so nothing is ever cut off mid-line.
 */
export function splitTelegramMessage(text, limit = TELEGRAM_SAFE_LENGTH) {
  const message = String(text ?? "");
  if (message.length <= limit) return [message];
  const units = message.split("\n\n").flatMap((block, index) => {
    const prefix = index ? "\n\n" : "";
    if (block.length + prefix.length <= limit) return [`${prefix}${block}`];
    return block.split("\n").map((line, lineIndex) => `${lineIndex ? "\n" : prefix}${line}`);
  });
  const parts = [];
  let current = "";
  for (const unit of units) {
    if (current && current.length + unit.length > limit) {
      parts.push(current);
      current = unit.replace(/^\n+/, "");
    } else current += unit;
  }
  if (current) parts.push(current);
  return parts.map((part) => (part.length <= limit ? part : part.slice(0, limit)));
}

export function formatPitchLabWeeklyTelegram(report) {
  const all = report?.periods?.find((period) => period.id === "all");
  const lines = [
    "📈 Pitch Lab weekly",
    `${report?.totals?.pitches ?? 0} total paper pitches are now in the learning record.`,
    "",
    "Results so far",
  ];
  for (const horizon of all?.horizons ?? []) {
    lines.push(`• ${horizon.horizonDays}-day: ${horizon.graded} graded; ${pct(horizon.hitRate)} beat SPY; average ${pct(horizon.meanExcessReturn, { signed: true })}`);
  }
  const conviction = all?.horizons?.find((horizon) => horizon.conviction?.verdict)?.conviction?.verdict;
  if (conviction) lines.push("", `Conviction (1-${report?.convictionScale ?? 10}): ${compact(conviction.summary, 260)}`);
  const scoreFinding = (all?.horizons ?? []).find((horizon) => ["positive", "negative"].includes(horizon.mandateScore?.verdict?.label));
  if (scoreFinding) lines.push(`Mandate Score: ${compact(scoreFinding.mandateScore.verdict.summary, 220)} (${scoreFinding.horizonDays}-day)`);
  const findings = (all?.horizons ?? [])
    .flatMap((horizon) => [...(horizon.metrics ?? []), ...(horizon.peerMetrics ?? [])].map((metric) => ({ horizon: horizon.horizonDays, metric })))
    .filter(({ metric }) => ["positive", "negative"].includes(metric.verdict?.label))
    .slice(0, 3);
  if (findings.length) {
    lines.push("", "Signals worth watching");
    for (const { horizon, metric } of findings) lines.push(`• ${metric.label} at ${horizon} days: ${metric.verdict.label}.`);
  }
  const coverage = report?.dataCoverage;
  if (coverage?.pitches) lines.push("", `Peer context was recorded on ${coverage.pitchesWithPeerData}/${coverage.pitches} pitches.`);
  lines.push("Paper research only — conclusions remain provisional until the report reaches its minimum sample and independent-week requirements.");
  return lines.join("\n");
}

export function formatMandateReviewTelegram(review) {
  if (!review || typeof review !== "object") return "Mandate Review: unavailable.";
  const lines = ["🔍 Pitch Lab — Weekly Mandate Review"];

  if (review.status === "insufficient_data") {
    const d = review.insufficientData ?? {};
    lines.push(`Not enough data yet for mandate suggestions.`);
    if (d.gradedPitches != null) lines.push(`• ${d.gradedPitches} graded pitches (need ${(d.gradedPitches ?? 0) + (d.moreNeeded?.pitches ?? 0)})`);
    if (d.independentWeeks != null) lines.push(`• ${d.independentWeeks} independent weeks (need ${(d.independentWeeks ?? 0) + (d.moreNeeded?.weeks ?? 0)})`);
    lines.push("", "Paper research only — no mandate change has been made.");
    return lines.join("\n");
  }

  lines.push(`Based on ${review.gradedPitches ?? "?"} graded pitches over ${review.independentWeeks ?? "?"} independent weeks.`);
  const conviction = review.conviction;
  if (conviction) {
    const conf = conviction.confidenceLabel;
    if (conf === "recommended" || conf === "watch") {
      lines.push(``, `Conviction${conviction.scale ? ` (1-${conviction.scale})` : ""}: ${conviction.overallVerdict} (${conf})`);
    }
  }
  const mandateScore = review.mandateScore;
  if (mandateScore && (mandateScore.confidenceLabel === "recommended" || mandateScore.confidenceLabel === "watch")) {
    lines.push(`Mandate Score /10: ${mandateScore.overallVerdict} (${mandateScore.confidenceLabel})`);
  }

  const suggestions = (review.metrics ?? []).filter((m) => m.confidenceLabel === "recommended" || m.confidenceLabel === "watch");
  if (suggestions.length) {
    lines.push("", "Metric findings");
    for (const m of suggestions.slice(0, 6)) {
      const dir = m.suggestedDirection === "more" ? "↑ more weight" : m.suggestedDirection === "less" ? "↓ less weight" : "⚠ review direction";
      lines.push(`• ${m.label ?? m.metricId} — ${m.confidenceLabel}: ${dir}`);
    }
    if (suggestions.length > 6) lines.push(`  …and ${suggestions.length - 6} more.`);
  } else {
    lines.push("", "No significant metric findings this week. Monitoring continues.");
  }

  lines.push(...adjustmentTableLines(review.adjustments));
  lines.push(...metricIdeaLines(review.metricCandidates));
  lines.push("", "Paper research only — suggestions only; no mandate change has been made.");
  return lines.join("\n");
}

const signedBps = (bps) => `${bps > 0 ? "+" : ""}${bps} bps`;
const signedRho = (rho) => (Number.isFinite(rho) ? `${rho > 0 ? "+" : ""}${rho.toFixed(2)}` : null);

/** One plain-language line per mandate metric: what to change and by how much. */
function adjustmentLine(row) {
  const e = row.evidence ?? {};
  const corr = signedRho(e.aggregateRho);
  const weeks = e.weeksUsed ? `positive ${e.weeksPositive} of ${e.weeksUsed} weeks` : null;
  const detail = [corr ? `corr ${corr}` : null, weeks].filter(Boolean).join(", ");
  const name = row.label ?? row.metricId;
  if (row.direction === "unavailable") return `${name}: no change (${row.basis === "no_data" ? "no data yet" : "evidence unavailable"})`;
  if (row.direction === "offset") return `${name}: ${signedBps(row.changeBps)}, offset inside its category${corr ? ` (corr ${corr})` : ""}`;
  if (row.direction === "no_change") {
    return `${name}: no change (${row.basis === "not_enough_data" ? "not enough graded pitches yet" : detail || "no clear effect"})`;
  }
  const why = row.basis === "aggregate_positive" ? "went with better results"
    : row.basis === "aggregate_negative" ? "went with WORSE results, check the metric's direction"
      : "clearly weaker than the other metrics";
  const size = row.sized === "not_sized"
    ? `${row.direction} weight, not sized (nothing in its category to pair it with)`
    : `${signedBps(row.changeBps)}${row.sized === "partial" ? ` (wanted ${signedBps(row.wantedBps)})` : ""}`;
  return `${name}: ${size}, ${row.confidenceLabel} (${[why, detail].filter(Boolean).join("; ")})`;
}

const REMOVE_REASON = {
  no_data: "no data",
  flat: "no effect despite plenty of data",
  backwards: "goes with worse results",
  overlaps: "overlaps another metric",
};

/** Soft ideas about the metric list itself. Printed only when there is something to say. */
function metricIdeaLines(candidates) {
  const add = candidates?.add ?? [];
  const remove = candidates?.remove ?? [];
  if (!add.length && !remove.length) return [];
  const lines = ["", "Metric ideas (soft suggestions, not sized)"];
  for (const idea of add.slice(0, 3)) {
    const way = idea.direction === "higher_is_better" ? "higher went with better results" : "lower went with better results";
    lines.push(`${idea.strength === "consider" ? "Consider adding" : "Leaning, keep watching"}: ${idea.label} (${way}; corr ${signedRho(idea.rho)})`);
  }
  for (const idea of remove.slice(0, 3)) lines.push(`Consider removing or fixing: ${idea.label} (${REMOVE_REASON[idea.reason] ?? idea.reason}: ${idea.detail})`);
  return lines;
}

/** The closing table of the weekly review: every mandate metric and its suggested change in bps. */
function adjustmentTableLines(adjustments) {
  if (!adjustments || !Array.isArray(adjustments.rows) || !adjustments.rows.length) return [];
  return [
    "",
    `Suggested weight changes (from ${adjustments.horizonDays}-day results; 100 bps = 1 mandate point)`,
    ...adjustments.rows.map(adjustmentLine),
  ];
}
