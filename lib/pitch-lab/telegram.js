import { FEATURE_CATALOG } from "./features.js";

const LABELS = new Map(FEATURE_CATALOG.map((feature) => [feature.id, feature.label]));

const compact = (text, limit = 150) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
};

const pct = (value, { signed = false } = {}) => {
  if (!Number.isFinite(value)) return "—";
  const number = (value * 100).toFixed(1);
  return `${signed && value > 0 ? "+" : ""}${number}%`;
};

function strongestPeerSignal(pitch) {
  const ranked = Object.entries(pitch?.peers?.ranks ?? {})
    .filter(([, rank]) => rank?.status === "ranked" && Number.isFinite(rank.percentile))
    .sort((a, b) => b[1].percentile - a[1].percentile);
  if (!ranked.length) return null;
  const [id, rank] = ranked[0];
  return `${LABELS.get(id) ?? id} ${Math.round(rank.percentile * 100)}th percentile vs peers`;
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

export function formatPitchLabDailyTelegram({ date, pitches = [], outcomes = [], run = null, failedTickers = [], gradingError = null } = {}) {
  const top = [...pitches].sort((a, b) => b.conviction - a.conviction || a.ticker.localeCompare(b.ticker)).slice(0, 3);
  const ranked = pitches.flatMap((pitch) => Object.values(pitch?.peers?.ranks ?? {}));
  const rankedShare = ranked.length ? ranked.filter((entry) => entry?.status === "ranked").length / ranked.length : null;
  const lines = [
    `🧪 Pitch Lab — ${date}`,
    `Agent 1 made ${pitches.length} paper pitch${pitches.length === 1 ? "" : "es"}${run?.selected ? ` from ${run.selected} selected companies` : ""}.`,
  ];
  if (run?.status === "no_catalog") lines.push("The company catalog was unavailable, so there was nothing to evaluate today.");
  else if (run?.status === "budget_stop") lines.push("The run stopped at its budget boundary; already-recorded pitches remain valid.");
  if (run?.failedCount) lines.push(`${run.failedCount} pitch${run.failedCount === 1 ? " was" : "es were"} dropped because the record or source data was incomplete.`);
  if (run?.shortfall) lines.push(`The eligible pool was ${run.shortfall} name${run.shortfall === 1 ? "" : "s"} short of the daily target.`);
  if (top.length) {
    lines.push("", "Strongest pitches");
    for (const pitch of top) {
      const peer = strongestPeerSignal(pitch);
      lines.push(`• ${pitch.ticker} — ${pitch.conviction}/5. ${compact(pitch.rationale?.thesis)}${peer ? ` ${peer}.` : ""}`);
      if (pitch.rationale?.risks?.[0]) lines.push(`  Main risk: ${compact(pitch.rationale.risks[0], 120)}`);
    }
  }
  lines.push("", "Results graded today");
  const outcomeLines = dailyOutcomeLines(outcomes);
  lines.push(...(outcomeLines.length ? outcomeLines : ["No holding periods matured today."]));
  if (gradingError) lines.push("Grading could not finish today; stored pitches are safe and grading will retry.");
  if (rankedShare != null) lines.push(`Peer comparisons were usable for ${Math.round(rankedShare * 100)}% of today's metric checks.`);
  if (failedTickers.length) lines.push(`Price data is still pending for: ${failedTickers.slice(0, 8).join(", ")}.`);
  lines.push("", "Paper research only — no real trade or proposal was created.");
  return lines.join("\n");
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
  if (conviction) lines.push("", `Conviction: ${compact(conviction.summary, 260)}`);
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
