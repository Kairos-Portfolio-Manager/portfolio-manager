import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AGENT_SCORING } from "../config/scoring/mandate-v2.js";
import { currentAgentScoring, runPitchLabConsensusCollect, runPitchLabMandateReview } from "../jobs/pitch-lab-daily.js";
import { DEFAULT_CONSENSUS_PLAN, planConsensusCollection } from "../lib/pitch-lab/consensus-plan.js";
import { buildMetricCandidates } from "../lib/pitch-lab/metric-candidates.js";
import { generateMandateReview } from "../lib/pitch-lab/mandate-review.js";
import { changeRequestLines } from "../lib/pitch-lab/review-export.js";
import { rankedAgentOnePool, selectPitchCandidates } from "../lib/pitch-lab/selection.js";
import { formatMandateReviewTelegram, formatPitchLabDailyTelegram } from "../lib/pitch-lab/telegram.js";

const agentScoring = AGENT_SCORING["agent-1"];
const NOW = new Date("2026-11-18T12:10:00Z"); // 07:10 ET
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

// The limits the job itself loads, and a catalog of liquid, priced names that pass Agent One's screen.
const RISK_LIMITS = JSON.parse(readFileSync(new URL("../config/agents/agent-1/risk-limits.json", import.meta.url), "utf8"));
function catalogOf(good) {
  const catalog = {};
  for (let i = 1; i <= good; i += 1) {
    const t = `G${String(i).padStart(2, "0")}`.replace(/\d/g, (d) => "ABCDEFGHIJ"[d]);
    catalog[t] = { t, n: `Good ${i}`, x: "NASDAQ", s: "Technology", i: "Software - Application", mc: 2_000_000_000, advd: 50_000_000, p: 20 + i, c52: i * 0.01, qa: "2026-10-01", ea: "2026-09-30" };
  }
  catalog.NOPX = { t: "NOPX", n: "No price", x: "NASDAQ", s: "Technology", i: "Software", mc: 2_000_000_000, advd: 50_000_000, c52: 9, qa: "2026-10-01" };
  return catalog;
}

// ─── Consensus collection plan ───────────────────────────────────────────────

test("the consensus plan takes the top of the ranking every day, then the least recently observed", () => {
  const ranked = Array.from({ length: 12 }, (_, i) => `T${String(i).padStart(2, "0")}`);
  const lastSeen = new Map([
    ["T00", hoursAgo(30)], // top priority, due
    ["T01", hoursAgo(5)], // top priority, already observed today → skipped
    ["T03", hoursAgo(24 * 9)],
    ["T04", hoursAgo(24 * 2)],
    ["T05", hoursAgo(24 * 20)], // the stalest of the rest
  ]);
  const plan = planConsensusCollection({ rankedTickers: ranked, lastSeen, now: NOW, limit: 6, topPriority: 3 });
  // T00, T02 (top 3 that are due), then never-seen names in rank order, then the stalest.
  assert.deepEqual(plan.tickers, ["T00", "T02", "T06", "T07", "T08", "T09"]);
  assert.deepEqual({ poolSize: plan.poolSize, fresh: plan.fresh, neverSeen: plan.neverSeen, priority: plan.priority }, { poolSize: 12, fresh: 1, neverSeen: 7, priority: 2 });
  // Once everything has been seen, the rotation goes oldest first.
  const allSeen = new Map(ranked.map((ticker, i) => [ticker, hoursAgo(24 * (i + 1))]));
  assert.deepEqual(planConsensusCollection({ rankedTickers: ranked, lastSeen: allSeen, now: NOW, limit: 5, topPriority: 2 }).tickers, ["T00", "T01", "T11", "T10", "T09"]);
  assert.equal(planConsensusCollection({ rankedTickers: ranked, now: NOW, limit: 5, topPriority: 2 }).daysToCoverPool, 4);
  assert.deepEqual(planConsensusCollection({ rankedTickers: [], now: NOW }).tickers, []);
  assert.throws(() => planConsensusCollection({ rankedTickers: ranked, limit: 0 }), /positive integer/);
  assert.equal(DEFAULT_CONSENSUS_PLAN.limit, 250);
});

test("the collector's pool is exactly the pool the daily selection draws from", () => {
  const catalog = catalogOf(40);
  const pool = rankedAgentOnePool({ catalog, riskLimits: RISK_LIMITS });
  const { receipt, picks } = selectPitchCandidates({ catalog, date: "2026-11-18", riskLimits: RISK_LIMITS });
  assert.equal(pool.length, 40);
  assert.equal(pool.length, receipt.screenedCount);
  const poolTickers = new Set(pool.map((candidate) => candidate.ticker));
  assert.ok(picks.every((pick) => poolTickers.has(pick.ticker)));
  // The top of the pool is what the "screen" slots pick, in the same order.
  assert.deepEqual(pool.slice(0, 10).map((c) => c.ticker), picks.filter((p) => p.selection === "screen").map((p) => p.ticker));
  assert.throws(() => rankedAgentOnePool({}), /requires a catalog/);
});

// ─── Consensus collection job ────────────────────────────────────────────────

const CATALOG = catalogOf(4);
const trendFor = (ticker) => ({ ticker, raw: { earningsTrend: { trend: [{ period: "0q", endDate: "2026-12-31", earningsEstimate: { avg: 1.2, numberOfAnalysts: 9 }, revenueEstimate: { avg: 5e8, numberOfAnalysts: 8 } }] } } });

test("the consensus collector is off by default and needs its own flag", async () => {
  const forbidden = () => { throw new Error("must not be called while disabled"); };
  assert.deepEqual(await runPitchLabConsensusCollect({ env: {}, getCatalog: forbidden }), { status: "disabled" });
  const flagOff = await runPitchLabConsensusCollect({ env: { PITCH_LAB_ENABLED: "1" }, getCatalog: forbidden });
  assert.equal(flagOff.status, "disabled");
  assert.match(flagOff.reason, /PITCH_LAB_CONSENSUS_COLLECT/);
});

test("the consensus collector stores one observation per available ticker and survives the ones that fail", async () => {
  const saved = [];
  const pool = rankedAgentOnePool({ catalog: CATALOG, riskLimits: RISK_LIMITS }).map((c) => c.ticker);
  assert.ok(pool.length >= 3, "fixture catalog passes Agent One's screen");
  const [missing, throwing] = pool;
  const result = await runPitchLabConsensusCollect({
    env: { PITCH_LAB_ENABLED: "1", PITCH_LAB_CONSENSUS_COLLECT: "1" },
    now: () => NOW,
    getCatalog: async () => CATALOG,
    getConsensusTrend: async (ticker) => {
      if (ticker === missing) return null; // Yahoo has no trend for it
      if (ticker === throwing) throw new Error("rate limited");
      return trendFor(ticker);
    },
    readLatest: async () => new Map(),
    saveSnapshots: async (rows) => { saved.push(...rows); return { attempted: rows.length, inserted: rows.length }; },
    sleep: async () => {},
    checkpoint: 1,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual({ planned: result.planned, observed: result.observed, stored: result.stored, unavailable: result.unavailable }, { planned: pool.length, observed: pool.length - 2, stored: pool.length - 2, unavailable: 2 });
  assert.deepEqual(saved.map((row) => row.ticker).sort(), pool.filter((t) => t !== missing && t !== throwing).sort());
  assert.ok(saved.every((row) => row.retrievedAt === NOW.toISOString() && row.source === "yahoo_earnings_trend"), "rows are stamped with a full instant and built by the shared row builder");
});

test("the consensus collector skips names already observed today, and fails loudly when nothing can be written", async () => {
  const pool = rankedAgentOnePool({ catalog: CATALOG, riskLimits: RISK_LIMITS }).map((c) => c.ticker);
  const base = {
    env: { PITCH_LAB_ENABLED: "1", PITCH_LAB_CONSENSUS_COLLECT: "1" }, now: () => NOW, getCatalog: async () => CATALOG,
    getConsensusTrend: async (ticker) => trendFor(ticker), sleep: async () => {},
  };
  const fetched = [];
  const fresh = await runPitchLabConsensusCollect({
    ...base,
    getConsensusTrend: async (ticker) => { fetched.push(ticker); return trendFor(ticker); },
    readLatest: async () => new Map(pool.map((ticker) => [ticker, hoursAgo(3)])),
    saveSnapshots: async (rows) => ({ inserted: rows.length }),
  });
  assert.deepEqual({ planned: fresh.planned, alreadyFresh: fresh.alreadyFresh, fetched: fetched.length }, { planned: 0, alreadyFresh: pool.length, fetched: 0 });
  await assert.rejects(
    () => runPitchLabConsensusCollect({ ...base, readLatest: async () => new Map(), saveSnapshots: async () => { throw new Error("pg down"); } }),
    /stored nothing/,
  );
  // The source answering for nothing is an outage, and answering for under half is flagged.
  await assert.rejects(
    () => runPitchLabConsensusCollect({ ...base, getConsensusTrend: async () => null, readLatest: async () => new Map(), saveSnapshots: async (rows) => ({ inserted: rows.length }) }),
    /observed nothing/,
  );
  const mostlyRefused = await runPitchLabConsensusCollect({
    ...base, getConsensusTrend: async (ticker) => (ticker === pool[0] ? trendFor(ticker) : null),
    readLatest: async () => new Map(), saveSnapshots: async (rows) => ({ inserted: rows.length }),
  });
  assert.deepEqual({ status: mostlyRefused.status, observed: mostlyRefused.observed, stored: mostlyRefused.stored }, { status: "partial", observed: 1, stored: 1 });
  await assert.rejects(() => runPitchLabConsensusCollect({ ...base, getCatalog: async () => ({}), readLatest: async () => new Map(), saveSnapshots: async () => ({ inserted: 0 }) }), /catalog unavailable/);
});

// ─── The review always uses the mandate on disk ──────────────────────────────

test("currentAgentScoring reads the weights fresh and says when the running process is behind", async () => {
  const live = await currentAgentScoring();
  assert.equal(live.stale, false);
  assert.deepEqual(Object.keys(live.scoring.categories), Object.keys(agentScoring.categories));
  const edited = structuredClone(agentScoring);
  edited.categories.A.metrics.revGrowth.points = 16;
  edited.categories.A.metrics.revBeat.points = 9;
  const changed = await currentAgentScoring({ importFresh: async () => ({ AGENT_SCORING: { "agent-1": edited } }) });
  assert.equal(changed.stale, true);
  assert.equal(changed.scoring.categories.A.metrics.revGrowth.points, 16);
  await assert.rejects(() => currentAgentScoring({ importFresh: async () => ({ AGENT_SCORING: {} }) }), /refusing to review against unknown weights/);
});

test("a review run on a stale process uses the file's weights, records them, and says to restart", async () => {
  const edited = structuredClone(agentScoring);
  edited.categories.A.metrics.revGrowth.points = 16;
  edited.categories.A.metrics.revBeat.points = 9;
  const sent = [];
  const stored = [];
  const writes = new Map();
  const redis = { get: async () => null, set: async (key, value, options) => { if (options?.nx && writes.has(key)) return null; writes.set(key, value); return "OK"; } };
  const store = {
    listPitches: async () => [], listOutcomes: async () => [], listMandateReviews: async () => stored,
    appendMandateReview: async (review) => { const row = { id: "mr_00000000000000000001", ...review }; stored.push(row); return row; },
  };
  const result = await runPitchLabMandateReview({
    env: { PITCH_LAB_ENABLED: "1" }, now: () => new Date("2026-11-19T00:40:00Z"), store, redis, send: async (text) => { sent.push(text); },
    loadScoring: () => currentAgentScoring({ importFresh: async () => ({ AGENT_SCORING: { "agent-1": edited } }) }),
  });
  assert.equal(result.status, "insufficient_data");
  assert.equal(stored[0].mandateWeights.points.revGrowth.points, 16, "the stored review records the weights it was sized against");
  assert.match(stored[0].mandateWeights.fingerprint, /A\.revBeat=9\|A\.revGrowth=16/);
  assert.ok(sent.some((text) => /older mandate weights/.test(text) && /pm2 restart pitch-lab/.test(text)));
  assert.ok(sent.some((text) => /Weekly Mandate Review/.test(text)), "the review itself is still sent");
});

// ─── Metric ideas ────────────────────────────────────────────────────────────

const block = (id, label, { rho = 0, ci = [-0.05, 0.05], q = 0.8, verdict = "inconclusive", n = 300, clusters = 10 } = {}) => ({
  id, label, coverage: { present: n, missing: 0 }, clusters, spearman: { rho, ci95: ci }, excessReturnPerSd: { estimate: rho / 10, qValue: q }, verdict: { label: verdict },
});
const matrixMetric = (id, { n = 300, rho = 0.1, ci = [-0.02, 0.22], verdict = "inconclusive", q = 0.4 } = {}) => ({ id, label: `Label ${id}`, aggregate: { n, weeks: 10, rho: n ? rho : null, ci95: n ? ci : null, verdict, excessReturnPerSd: { qValue: q } } });
const MANDATE_IDS = ["revBeat", "revGrowth", "epsTrajectory", "estimateRevisions", "marginTrend", "peerValuation", "balanceSheet", "instOwnershipDir", "thirteenF"];
function ideasReport({ raw = [], matrix = {}, overlaps = [], graded = 300, weekCount = 10 } = {}) {
  return {
    options: { minSample: 30, minClusters: 8 },
    periods: [{ id: "all", horizons: [{ horizonDays: 10, metrics: raw }] }],
    weeklyMatrix: { horizons: [{ horizonDays: 10, graded, weekCount, overlaps, metrics: MANDATE_IDS.map((id) => matrixMetric(id, matrix[id])) }] },
  };
}

test("a recorded feature the mandate does not weight is suggested when its effect is real, and only then", () => {
  const ideas = buildMetricCandidates(ideasReport({ raw: [
    block("momentum3m", "Price momentum, 3 months", { rho: 0.21, ci: [0.08, 0.33], q: 0.01, verdict: "positive" }),
    block("rsi14", "RSI (14-day)", { rho: -0.12, ci: [-0.22, -0.01], q: 0.3 }), // interval excludes zero, does not survive the correction
    block("relativeVolume", "Volume vs 30-day average", { rho: 0.03 }),
    block("logMarketCap", "Company size", { rho: 0.4, ci: [0.1, 0.6], q: 0.01, verdict: "positive", n: 12, clusters: 2 }), // far too little data
    block("revGrowth", "Revenue growth (YoY)", { rho: 0.3, ci: [0.2, 0.4], q: 0.001, verdict: "positive" }), // already in the mandate
  ] }), agentScoring);
  assert.deepEqual(ideas.add.map((idea) => [idea.featureId, idea.strength, idea.direction]), [
    ["momentum3m", "consider", "higher_is_better"],
    ["rsi14", "leaning", "lower_is_better"],
  ]);
  assert.equal(ideas.horizonDays, 10);
});

test("a mandate metric is flagged for no data, a pinned-flat effect, working backwards, or overlapping another", () => {
  const ideas = buildMetricCandidates(ideasReport({
    matrix: {
      thirteenF: { n: 0 },
      instOwnershipDir: { n: 6 }, // 2% of graded pitches
      marginTrend: { n: 280, rho: 0.01, ci: [-0.06, 0.07] },
      balanceSheet: { n: 280, rho: -0.2, ci: [-0.3, -0.1], verdict: "negative", q: 0.01 },
      revBeat: { n: 60, rho: 0.0, ci: [-0.05, 0.05] }, // flat-looking but too few pitches to call it
    },
    overlaps: [{ a: "revGrowth", b: "epsTrajectory", rho: 0.82, n: 240 }],
  }), agentScoring);
  assert.deepEqual(ideas.remove.map((idea) => [idea.metricId, idea.reason]), [
    ["marginTrend", "flat"], ["balanceSheet", "backwards"], ["instOwnershipDir", "no_data"], ["thirteenF", "no_data"], ["epsTrajectory", "overlaps"],
  ]);
  assert.equal(ideas.remove.at(-1).overlapsWith, "revGrowth");
  // Nothing is said about removal before the report has enough graded pitches and weeks.
  assert.deepEqual(buildMetricCandidates(ideasReport({ matrix: { thirteenF: { n: 0 } }, graded: 20, weekCount: 3 }), agentScoring).remove, []);
  assert.deepEqual(buildMetricCandidates(ideasReport(), agentScoring), { horizonDays: 10, add: [], remove: [] });
  assert.equal(buildMetricCandidates({ periods: [] }, agentScoring), null);
});

test("the review prints metric ideas only when there are some, and a paste-ready change request", () => {
  const withIdeas = { status: "has_suggestions", gradedPitches: 300, independentWeeks: 10, metrics: [], adjustments: null, metricCandidates: buildMetricCandidates(ideasReport({
    raw: [block("momentum3m", "Price momentum, 3 months", { rho: 0.21, ci: [0.08, 0.33], q: 0.01, verdict: "positive" })],
    matrix: { thirteenF: { n: 0 } },
  }), agentScoring) };
  const message = formatMandateReviewTelegram(withIdeas);
  assert.match(message, /Metric ideas \(soft suggestions, not sized\)\nConsider adding: Price momentum, 3 months \(higher went with better results; corr \+0\.21\)\nConsider removing or fixing: Label thirteenF \(no data: a value on 0 of 300 graded pitches\)/);
  assert.doesNotMatch(formatMandateReviewTelegram({ ...withIdeas, metricCandidates: { add: [], remove: [] } }), /Metric ideas/);

  const none = changeRequestLines({ period: "2026-11-18", status: "insufficient_data", adjustments: null });
  assert.match(none.join("\n"), /No change is suggested: there are not yet enough graded pitches/);
  const request = changeRequestLines({
    id: "mr_abc", period: "2026-12-18", agentId: "agent-1", status: "has_suggestions", mandateWeights: { fingerprint: "A.revBeat=10|A.revGrowth=15" },
    adjustments: { rows: [
      { metricId: "revGrowth", label: "Revenue growth (YoY)", category: "A", currentBps: 1500, changeBps: 100, suggestedBps: 1600, direction: "more", confidenceLabel: "recommended", basis: "aggregate_positive", evidence: { aggregateRho: 0.19, qValue: 0.01, weeksPositive: 8, weeksUsed: 10 } },
      { metricId: "revBeat", label: "Revenue beat vs consensus", category: "A", currentBps: 1000, changeBps: -100, suggestedBps: 900, direction: "offset", confidenceLabel: "no_change", basis: "offset", evidence: { aggregateRho: 0.02 } },
      { metricId: "marginTrend", label: "Gross-margin trend", category: "C", currentBps: 1200, changeBps: 0, suggestedBps: 1200, direction: "no_change", confidenceLabel: "no_change", basis: "no_clear_effect", evidence: {} },
    ] },
  }).join("\n");
  assert.match(request, /from the Pitch Lab Mandate Review of 2026-12-18 \(mr_abc\)/);
  assert.match(request, /- revGrowth \(Revenue growth \(YoY\), category A\): 15 -> 16 points \(\+100 bps\)\. Why: aggregate went with better results, recommended; corr 0\.19, q 0\.01, positive 8 of 10 weeks\./);
  assert.match(request, /- revBeat .*: 10 -> 9 points \(-100 bps\)\. Why: offset to keep its category total unchanged/);
  assert.doesNotMatch(request, /marginTrend/, "unchanged metrics are not listed");
  assert.match(request, /A\.revBeat=10\|A\.revGrowth=15/);
  assert.match(request, /R1 research-policy change/);
});

// ─── Daily digest: what data was behind the scores ───────────────────────────

test("the daily digest counts how many of today's scored pitches had each mandate metric", () => {
  const perMetric = (present) => Object.fromEntries(MANDATE_IDS.map((id) => [id, present.includes(id) ? { points: 5, maxPoints: 10, percentile: 0.7, fallbackMethod: "peer_relative", missing: false } : { points: null, maxPoints: 10, percentile: null, missing: true }]));
  const pitch = (ticker, present) => ({ ticker, conviction: 6, convictionScale: 10, mandateScore: { status: "scored", total: 50, uncappedTotal: 50, rawPoints: 5 * present.length, maxAvailable: 10 * present.length, perMetric: perMetric(present) } });
  const message = formatPitchLabDailyTelegram({ date: "2026-11-18", pitches: [
    pitch("AAA", ["revBeat", "revGrowth", "marginTrend"]),
    pitch("BBB", ["revGrowth"]),
    { ticker: "OLD", conviction: 3, peers: null }, // no 0-100 score: not part of the count
  ] });
  const lines = message.split("\n");
  const start = lines.indexOf("Data behind today's scores (pitches with each metric, of 2)");
  assert.ok(start > 0);
  assert.deepEqual(lines.slice(start + 1, start + 10), [
    "Revenue beat vs consensus: 1", "Revenue growth (YoY): 2", "EPS trajectory (YoY): 0", "Analyst estimate revisions: 0", "Gross-margin trend: 1",
    "Forward P/E (lower = cheaper): 0", "Balance-sheet strength: 0", "Institutional ownership direction: 0", "Latest 13F accumulation: 0",
  ]);
  assert.doesNotMatch(formatPitchLabDailyTelegram({ date: "2026-11-18", pitches: [{ ticker: "OLD", conviction: 3, peers: null }] }), /Data behind today's scores/);
});

test("the new pure modules import nothing from the money path, the mandate config, or storage", () => {
  for (const file of ["consensus-plan.js", "metric-candidates.js"]) {
    const src = readFileSync(new URL(`../lib/pitch-lab/${file}`, import.meta.url), "utf8");
    assert.deepEqual([...src.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]), [], `${file} has no imports at all`);
  }
  const scheduler = readFileSync(new URL("../pitch-lab-scheduler.js", import.meta.url), "utf8");
  assert.match(scheduler, /"10 7 \* \* 1-5", guarded\("consensus-collect"/);
  assert.doesNotMatch(readFileSync(new URL("../scheduler.js", import.meta.url), "utf8"), /consensus-collect|pitch-lab/i, "Pitch Lab stays out of the production scheduler");
});
