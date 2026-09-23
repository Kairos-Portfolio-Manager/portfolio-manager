import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Safety regression test requested by Codex's 2026-09-23 review of commit
 * `80def9f` (docs/roadmaps/RESEARCH-PROTOTYPE-CODEX-REVIEW-PROMPT-2026-09-23.md):
 * "no test proves [ctx.dryRun] cannot call createProposal or
 * recordAgent4ShadowReview... a live run/log line does not establish that
 * safety property." This test drives `reviewCandidateForAgent` -- the exact
 * function the Research Testing Prototype and the real scheduled scan both
 * call -- all the way to the real proposal-creation branch, with `ctx.dryRun`
 * toggled, and proves the two real writers are never invoked when it's true.
 *
 * Requires `node --experimental-test-module-mocks` (wired into `npm test`).
 *
 * Mocked (network/LLM/money-write boundaries only): ai-overlay.js
 * (getAIRecommendation), evaluator.js (evaluateProposal), tavily.js
 * (tavilySearch), edgar.js (fetchRecentFilings), redis.js (createProposal --
 * spied, never real), agent4-shadow-adapter.js (recordAgent4ShadowReview --
 * spied, never real). Everything else in the gate chain (risk engine,
 * conviction/macro/breaker/mandate-score gates, sizing) is the REAL pure
 * production code, unmocked, driven with agent-2's real config so the test
 * proves the actual gate chain reaches the branch, not a fabricated shortcut.
 *
 * Uses agent-2 rather than agent-1 specifically to avoid agent-1's extra
 * conviction-clamp entry-signal gate (`applyConvictionClamp`, momentum/RSI
 * qualification) -- that gate is agent-1 mandate logic, unrelated to the
 * dryRun mechanism this test verifies, which is agent-agnostic in the code.
 */

// mock.module REPLACES a module's exports wholesale, so every real export a
// mocked module normally provides must be re-supplied here even when unused
// by reviewCandidateForAgent directly -- other modules in the import graph
// (e.g. lib/agent-memory.js importing getRedis from lib/redis.js) still need
// them. Import the real modules first and spread their real exports, only
// overriding the specific functions this test cares about.
const realRedis = await import("../lib/redis.js");
const realAiOverlay = await import("../lib/ai-overlay.js");
const realEvaluator = await import("../lib/evaluator.js");
const realTavily = await import("../lib/tavily.js");
const realEdgar = await import("../lib/edgar.js");
const realShadowAdapter = await import("../lib/agent4-shadow-adapter.js");

mock.module("../lib/ai-overlay.js", {
  exports: {
    ...realAiOverlay,
    getAIRecommendation: async () => ({
      action: "BUY",
      targetWeight: 8,
      confidence: 0.7,
      thesis: "Test fixture thesis for the dry-run isolation regression test.",
      risks: ["Test fixture risk."],
      killCriteria: ["Test fixture kill criterion A.", "Test fixture kill criterion B."],
      buyDossier: { thesis: "Test fixture thesis.", valuationScenario: {}, bearCase: "Test bear case.", killCriteria: ["A", "B"], horizon: "weeks", sizingRationale: "test" },
      overrideNotes: [],
    }),
    enforceFractionalShareHoldPolicy: async (proposal) => ({ proposal, retried: false, initialViolations: [], repeatedViolations: [] }),
  },
});

mock.module("../lib/evaluator.js", {
  exports: {
    ...realEvaluator,
    evaluateProposal: async () => ({ verdict: "APPROVE", critique: [], suspectEvidence: [] }),
    resolveFinalVerdict: (first) => ({ ...first, revisions: 0 }),
  },
});

mock.module("../lib/tavily.js", { exports: { ...realTavily, tavilySearch: async () => [] } });
mock.module("../lib/edgar.js", { exports: { ...realEdgar, fetchRecentFilings: async () => [] } });

let createProposalCalls = 0;
let realNewsCacheCalls = 0;
mock.module("../lib/redis.js", {
  exports: {
    ...realRedis,
    createProposal: async () => { createProposalCalls += 1; throw new Error("createProposal must never be called in dry-run mode"); },
    // These must never be reached when ctx.newsCacheGet/Set are supplied
    // (they are, in both tests below, via buildCtx) -- proves the 2026-09-23
    // fix for Codex's "prototype writes pm:news:*" finding actually redirects
    // the call rather than merely adding an unused option.
    getCachedNews: async () => { realNewsCacheCalls += 1; throw new Error("the real pm:news:* getCachedNews must never be called when ctx.newsCacheGet is supplied"); },
    setCachedNews: async () => { realNewsCacheCalls += 1; throw new Error("the real pm:news:* setCachedNews must never be called when ctx.newsCacheSet is supplied"); },
  },
});

let shadowReviewCalls = 0;
mock.module("../lib/agent4-shadow-adapter.js", {
  exports: {
    ...realShadowAdapter,
    recordAgent4ShadowReview: async () => { shadowReviewCalls += 1; throw new Error("recordAgent4ShadowReview must never be called in dry-run mode"); },
  },
});

const { reviewCandidateForAgent, loadAgentConfig } = await import("../jobs/research-scan.js");
const { makeBoundaryToken } = await import("../lib/evidence.js");
const { AGENTS } = await import("../config/agents.js");

let protoNewsCacheGetCalls = 0;
let protoNewsCacheSetCalls = 0;

function buildCtx({ dryRun }) {
  const agentConfig = loadAgentConfig("agent-2");
  return {
    riskLimits: agentConfig.riskLimits,
    personality: agentConfig.personality,
    strategyNotes: "",
    persistentMemory: "",
    marketScans: [],
    holdingTickers: [],
    ownedPositionSharesByTicker: {},
    ownedPositionValueByTicker: {},
    heldReturnPct: {},
    researchLedger: {},
    breaker: { tier: "NONE" },
    boundaryToken: makeBoundaryToken(),
    evidenceFlags: [],
    athenaCircuit: {},
    budget: null,
    spyEntryPrice: 500,
    macroText: "",
    macroRedFlags: { dualRed: false, spyRed: false, rateRed: false },
    totalPortfolioValue: 500_000,
    availableCashForBuys: 100_000,
    ordinarySellCooldownDays: 7,
    openProposals: [],
    tickerWeightPct: {},
    sectorWeightPct: {},
    heldAllocation: [],
    dryRun,
    // Isolation for the transitive pm:news:* write Codex flagged 2026-09-23 --
    // a real prototype job supplies proto:* equivalents here; this test
    // supplies its own spies to prove the redirection actually happens.
    newsCacheGet: async () => { protoNewsCacheGetCalls += 1; return null; },
    newsCacheSet: async () => { protoNewsCacheSetCalls += 1; },
  };
}

function buildCandidate() {
  return {
    ticker: "TESTX",
    name: "Test Fixture Co",
    quantScore: 72,
    breakdown: {},
    marketCap: 5_000_000_000,
    avgDollarVolume: 20_000_000,
    raw: { price: { regularMarketPrice: 100 } },
  };
}

test("dry-run isolation: ctx.dryRun=true reaches the proposal branch but NEVER calls createProposal or recordAgent4ShadowReview", async () => {
  createProposalCalls = 0;
  shadowReviewCalls = 0;
  realNewsCacheCalls = 0;
  protoNewsCacheGetCalls = 0;
  protoNewsCacheSetCalls = 0;
  const agent = AGENTS.find((a) => a.id === "agent-2");
  const ctx = buildCtx({ dryRun: true });
  const result = await reviewCandidateForAgent(agent, buildCandidate(), ctx);

  // Prove we actually reached the branch under test, not an earlier HOLD/NO_TRADE exit.
  assert.equal(result.rec.action, "BUY", `expected the gate chain to clear to BUY; got ${result.rec.action} (notes: ${JSON.stringify(result.rec.overrideNotes)})`);
  assert.equal(result.evaluatorVerdict, "APPROVE");

  // The actual safety property Codex asked for.
  assert.equal(createProposalCalls, 0, "createProposal was called during a dry run");
  assert.equal(shadowReviewCalls, 0, "recordAgent4ShadowReview was called during a dry run");

  // Codex's second 2026-09-23 finding: reviewCandidateForAgent's news cache
  // writes real pm:news:* by default. ctx.newsCacheGet/Set must redirect it.
  assert.equal(realNewsCacheCalls, 0, "the real pm:news:* cache was touched even though ctx supplied an override");
  assert.equal(protoNewsCacheGetCalls, 1, "ctx.newsCacheGet was not called");
  assert.equal(protoNewsCacheSetCalls, 1, "ctx.newsCacheSet was not called (cache-miss path should call it once)");

  // And the dry-run result still looks like a completed, gradable outcome.
  assert.equal(result.createdProposal?.dryRun, true);
  assert.equal(result.createdProposal?.status, "DryRun");
  assert.equal(result.createdProposal?.id, null);
  assert.equal(result.createdProposal?.side, "BUY");
  assert.equal(result.createdProposal?.ticker, "TESTX");
  assert.ok(result.createdProposal?.amountDollars > 0);
});

test("control: the same gate chain with ctx.dryRun=false DOES reach createProposal (proves the test fixture is real, not a false negative)", async () => {
  createProposalCalls = 0;
  shadowReviewCalls = 0;
  const agent = AGENTS.find((a) => a.id === "agent-2");
  const ctx = buildCtx({ dryRun: false });
  // The mocked createProposal throws by design (it must never be trusted to
  // silently succeed in a test) -- reviewCandidateForAgent catches that error
  // and reports queue_error, which is itself proof the call was attempted.
  const result = await reviewCandidateForAgent(agent, buildCandidate(), ctx);
  assert.equal(createProposalCalls, 1, "expected the real (mocked) createProposal to be called exactly once with dryRun=false");
  assert.equal(result.rec.action, "BUY");
});
