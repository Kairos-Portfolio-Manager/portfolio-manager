import test from "node:test";
import assert from "node:assert/strict";
import { formatPitchLabDailyTelegram, formatPitchLabWeeklyTelegram } from "../lib/pitch-lab/telegram.js";
import { formatProposalTelegram } from "../lib/proposal-telegram.js";

test("daily Pitch Lab message is concise, human-readable, and explicit that it is paper-only", () => {
  const message = formatPitchLabDailyTelegram({
    date: "2026-10-12",
    pitches: [{
      ticker: "NET", conviction: 5,
      rationale: { thesis: "Revenue acceleration and improving price action support a short-term setup.", risks: ["Enterprise demand could slow."] },
      peers: { ranks: { revGrowth: { status: "ranked", percentile: 0.86 }, peerValuation: { status: "ranked", percentile: 0.41 } } },
    }],
    outcomes: [{ horizonDays: 5, excessReturn: 0.012 }, { horizonDays: 5, excessReturn: -0.004 }],
    run: { status: "partial", selected: 3, failedCount: 1, shortfall: 2 },
  });
  assert.match(message, /🧪 Pitch Lab/);
  assert.match(message, /NET — 5\/5/);
  assert.match(message, /Revenue growth \(YoY\) 86th percentile/);
  assert.match(message, /1\/2 beat SPY; average \+0\.4%/);
  assert.match(message, /1 pitch was dropped/);
  assert.match(message, /eligible pool was 2 names short/);
  assert.match(message, /no real trade or proposal/i);
  assert.doesNotMatch(message, /schema|root cause|evaluatorState/);
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
