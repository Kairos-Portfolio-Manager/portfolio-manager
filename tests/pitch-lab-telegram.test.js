import test from "node:test";
import assert from "node:assert/strict";
import { TELEGRAM_SAFE_LENGTH, formatPitchLabDailyTelegram, formatPitchLabWeeklyTelegram, splitTelegramMessage } from "../lib/pitch-lab/telegram.js";
import { formatProposalTelegram } from "../lib/proposal-telegram.js";

// A stored `mandateScore` block, as lib/pitch-lab/mandate-score.js freezes it on a pitch.
const metric = (points, maxPoints, percentile, over = {}) => ({
  points, maxPoints, peerCount: 12, fallbackMethod: "peer_relative", percentile, absoluteSource: null, missing: points == null, ...over,
});
function scoredPitch(ticker, total, perMetric, over = {}) {
  const scored = Object.values(perMetric).filter((m) => !m.missing);
  return {
    ticker, conviction: 7, convictionScale: 10,
    rationale: { thesis: "Model prose that the digest must not quote.", risks: ["Model risk text."] },
    mandateScore: {
      status: "scored", total, uncappedTotal: total,
      rawPoints: scored.reduce((sum, m) => sum + m.points, 0),
      maxAvailable: scored.reduce((sum, m) => sum + m.maxPoints, 0),
      perMetric, ...over,
    },
  };
}
const NET = () => scoredPitch("NET", 44, {
  revBeat: metric(null, 10, null),
  revGrowth: metric(3.75, 15, 0.667),
  epsTrajectory: metric(4.5, 18, 0.61),
  estimateRevisions: metric(null, 12, null),
  marginTrend: metric(9, 12, 0.75),
  peerValuation: metric(8, 8, 0.92),
  balanceSheet: metric(0, 10, 0.13),
  instOwnershipDir: metric(null, 8, null),
  thirteenF: metric(null, 7, null),
});

test("daily Pitch Lab message walks each strongest pitch through all nine metrics and sums them to the /100 score", () => {
  const message = formatPitchLabDailyTelegram({
    date: "2026-11-17",
    pitches: [NET()],
    outcomes: [{ horizonDays: 5, excessReturn: 0.012 }, { horizonDays: 5, excessReturn: -0.004 }],
    run: { status: "partial", selected: 3, failedCount: 1, shortfall: 2 },
  });
  const lines = message.split("\n");
  assert.equal(lines[0], "Pitch Lab — 2026-11-17");
  assert.equal(lines[1], "Agent 1 made 1 paper pitch from 3 selected companies.");
  assert.match(message, /1\. NET — mandate score 44\/100/);
  assert.match(message, /Model conviction: 7\/10/);
  // Every mandate metric gets exactly one line, in the mandate's order, scored or not.
  const at = (text) => lines.findIndex((line) => line.startsWith(text));
  const order = ["Revenue beat vs consensus:", "Revenue growth (YoY):", "EPS trajectory (YoY):", "Analyst estimate revisions:", "Gross-margin trend:", "Forward P/E (lower = cheaper):", "Balance-sheet strength:", "Institutional ownership direction:", "Latest 13F accumulation:"];
  const positions = order.map(at);
  assert.ok(positions.every((p) => p > 0), "all nine metrics are listed");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(message, /Revenue growth \(YoY\): 67th percentile, 3\.75\/15 pts/);
  assert.match(message, /Forward P\/E \(lower = cheaper\): 92nd percentile, 8\/8 pts/);
  // Missing is never zero: no rank and no points.
  assert.match(message, /Revenue beat vs consensus: no data, not scored/);
  assert.match(message, /Total: 25\.25 of 63 available pts = 44\/100 \(5 of 9 metrics had data\)/);
  assert.match(message, /Stands out: Forward P\/E \(lower = cheaper\), 92nd percentile, 8\/8 pts\./);
  assert.match(message, /Biggest risk: Balance-sheet strength, 13th percentile \(bottom half of peers\), 0\/10 pts\./);
  assert.match(message, /1\/2 beat SPY; average \+0\.4%/);
  assert.match(message, /1 pitch was dropped/);
  assert.match(message, /eligible pool was 2 names short/);
  assert.match(message, /no real trade or proposal/i);
  // Numbers only: the model's prose is not quoted, and the daily digest carries no emoji.
  assert.doesNotMatch(message, /Model prose|Model risk text/);
  assert.doesNotMatch(message, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(message, /schema|root cause|evaluatorState/);
});

test("daily Pitch Lab message lists the four highest mandate scores, highest first", () => {
  const one = (ticker, total) => scoredPitch(ticker, total, { revGrowth: metric(total / 10, 15, 0.8), marginTrend: metric(6, 12, 0.7) });
  const message = formatPitchLabDailyTelegram({
    date: "2026-11-17",
    pitches: [one("AAA", 40), one("EEE", 90), one("CCC", 70), one("BBB", 55), one("DDD", 80), one("FFF", 70)],
  });
  assert.match(message, /Strongest pitches \(top 4 by mandate score\)/);
  const listed = [...message.matchAll(/^\d\. (\w+) — mandate score (\d+)\/100$/gm)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(listed, [["EEE", 90], ["DDD", 80], ["CCC", 70], ["FFF", 70]]);
  assert.doesNotMatch(message, /AAA|BBB/);
});

test("daily Pitch Lab message says how a metric was scored when peers were too thin to rank, and shows a thin-peer cap", () => {
  const pitch = scoredPitch("THIN", 84, {
    revGrowth: metric(15, 15, 0.95),
    marginTrend: metric(9, 12, null, { fallbackMethod: "absolute", peerCount: 2, absoluteSource: "agent_absolute" }),
    balanceSheet: metric(6.25, 10, 0.8, { fallbackMethod: "blended_50_50", peerCount: 5 }),
  }, { uncappedTotal: 91, thinPeerSet: true });
  const message = formatPitchLabDailyTelegram({ date: "2026-11-17", pitches: [pitch] });
  assert.match(message, /Gross-margin trend: fixed bands \(too few peers to rank\), 9\/12 pts/);
  assert.match(message, /Balance-sheet strength: 80th percentile, blended with fixed bands \(thin peer set\), 6\.25\/10 pts/);
  assert.match(message, /= 84\/100 \(3 of 9 metrics had data, capped from 91 for a thin peer set\)/);
  // A metric that was not ranked against peers gets no peer-band wording in the risk line.
  assert.match(message, /Biggest risk: Balance-sheet strength, 80th percentile, blended with fixed bands \(thin peer set\), 6\.25\/10 pts\./);
});

test("daily Pitch Lab message falls back honestly when a pitch has no 0-100 score or only one scored metric", () => {
  const legacy = {
    ticker: "OLD", conviction: 4,
    rationale: { thesis: "An older record.", risks: [] },
    peers: { ranks: { revGrowth: { status: "ranked", percentile: 0.86 }, peerValuation: { status: "ranked", percentile: 0.41 } } },
  };
  const unsupported = { ticker: "BANK", conviction: 6, convictionScale: 10, peers: null, mandateScore: { status: "unsupported", total: null, reason: "special sector not supported" } };
  const single = scoredPitch("ONE", 100, { revGrowth: metric(15, 15, 0.95) });
  const message = formatPitchLabDailyTelegram({ date: "2026-11-17", pitches: [legacy, unsupported, single] });
  // The scored pitch leads; unscored ones follow by the model's conviction share (4/5 before 6/10).
  assert.match(message, /1\. ONE — mandate score 100\/100/);
  assert.match(message, /Biggest risk: only 1 of 9 metrics had data, so 8 could not be checked\./);
  assert.match(message, /2\. OLD — no 0-100 mandate score\nconviction 4\/5 · Mandate 4\.9\/10 \(2\/9 metrics\)/);
  assert.match(message, /3\. BANK — no 0-100 mandate score: special sector not supported\nconviction 6\/10 · Mandate score unavailable \(no peer ranks\)/);
});

test("a long digest is split between blocks, never mid-line, and loses nothing", () => {
  const short = "one\n\ntwo";
  assert.deepEqual(splitTelegramMessage(short), [short]);
  const blocks = Array.from({ length: 6 }, (_, i) => Array.from({ length: 8 }, (_, j) => `block ${i} line ${j} ${"x".repeat(40)}`).join("\n"));
  const parts = splitTelegramMessage(blocks.join("\n\n"), 1200);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 1200));
  assert.deepEqual(parts.join("\n").split("\n").filter(Boolean), blocks.join("\n").split("\n"));
  // One block longer than the limit is split between its lines.
  const tall = Array.from({ length: 30 }, (_, i) => `line ${i} ${"y".repeat(50)}`).join("\n");
  const tallParts = splitTelegramMessage(tall, 500);
  assert.ok(tallParts.every((part) => part.length <= 500));
  assert.deepEqual(tallParts.join("\n").split("\n"), tall.split("\n"));
  // The real four-pitch digest fits the default limit in whole parts.
  const digest = formatPitchLabDailyTelegram({ date: "2026-11-17", pitches: ["AAAA", "BBBB", "CCCC", "DDDD"].map((t) => ({ ...NET(), ticker: t })) });
  assert.ok(splitTelegramMessage(digest).every((part) => part.length <= TELEGRAM_SAFE_LENGTH));
});

test("weekly Pitch Lab message translates statistical maturity into plain English", () => {
  const report = {
    totals: { pitches: 75 },
    periods: [{ id: "all", horizons: [{
      horizonDays: 5, graded: 45, hitRate: 0.58, meanExcessReturn: 0.006,
      conviction: { verdict: { summary: "Only 45 graded pitches across 3 independent weeks — need at least 8 before drawing a conclusion." } },
      metrics: [], peerMetrics: [],
    }] }],
    dataCoverage: { pitches: 75, pitchesWithPeerData: 63 },
  };
  const message = formatPitchLabWeeklyTelegram(report);
  assert.match(message, /75 total paper pitches/);
  assert.match(message, /58\.0% beat SPY/);
  assert.match(message, /3 independent weeks/);
  assert.match(message, /63\/75 pitches/);
});

test("proposal notification leads with the required human action", () => {
  const message = formatProposalTelegram({
    side: "BUY", ticker: "NET", amountDollars: 500, agentId: "agent-1",
    rationale: "Strong evidence across growth and price confirmation.",
    riskSummary: "Position remains inside the risk cap.",
    expiresAt: "2026-10-13T20:00:00.000Z",
  }, { dashboardUrl: "https://example.com" });
  assert.match(message, /🚨 Approval needed — BUY NET \$500\.00/);
  assert.match(message, /No order has been placed/);
  assert.match(message, /https:\/\/example\.com\/approvals/);
});
