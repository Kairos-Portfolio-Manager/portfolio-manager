// Research Testing Prototype scan job (docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md).
//
// Explicitly NOT the existing dashboard "Lab" feature (researchTickerForAgentUnlocked
// in this same file, or lib/lab-research.js) -- that is a manual, one-ticker-at-a-time
// tool that writes REAL proposals. This job runs automatically, on a fixed small
// universe, using ctx.dryRun so it never writes a real proposal or a real Kairos
// shadow record. Every write goes through lib/proto-store.js (proto:* keys only).
//
// Per Sam's explicit instruction (2026-09-23): "I want this agent to run exactly
// how it is running normally, just with a smaller set of tickers." This file
// therefore reuses the SAME functions the real scheduled scan and the real Lab
// tool both use (loadAgentConfig, resolveCircuitBreaker, makeDateWindow,
// buildCandidate, buildAgentReviewContext, reviewCandidateForAgent, sourcedFact),
// all newly exported from jobs/research-scan.js additively for this purpose. The
// only deliberate substitution is candidate SOURCING: a fixed ~50-ticker list
// instead of the discovery/candidate-slate universe.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadAgentConfig,
  resolveCircuitBreaker,
  makeDateWindow,
  buildCandidate,
  buildAgentReviewContext,
  reviewCandidateForAgent,
  sourcedFact,
} from "./research-scan.js";
import { fetchFundamentalsBatch } from "../lib/yahoo.js";
import { makeBoundaryToken } from "../lib/evidence.js";
import { createResearchRunBudget } from "../lib/ai-budget.js";
import { buildAnthropicUsageRecord } from "../lib/anthropic-usage.js";
import { createAthenaCircuit } from "../lib/athena.js";
import { formatAgentMemoriesForPrompt, listAgentMemories } from "../lib/agent-memory.js";
import { readResearchLedger } from "../lib/research-ledger.js";
import { projectAgentOwnedHoldings } from "../lib/research-holding-ownership.js";
import { assessPeerCoverage, scorePeerFundamentals } from "../lib/peer-coverage.js";
import { getPeerMetrics } from "../lib/redis.js";
import {
  getServiceAccountClients,
  resolveSharedSpreadsheetId,
  readHoldingsAllocation,
  readAllLots,
  readMarketScans,
  readAgentStrategyNotes,
} from "../lib/sheets.js";
import { AGENTS } from "../config/agents.js";
import { protoGet, protoSet, protoListPush, protoKey } from "../lib/proto-store.js";

// Isolation, per Codex's 2026-09-23 review: reviewCandidateForAgent's news
// cache (getCachedNews/setCachedNews) writes a real pm:news:* key by default.
// Redirect it to a proto:* equivalent instead -- still cached (saves Tavily
// quota across runs), never touches production state.
async function protoNewsCacheGet(ticker) {
  return protoGet(protoKey.newsCache(ticker));
}
// Same 12h TTL as the real pm:news:* cache (lib/redis.js: NEWS_CACHE_TTL) --
// Codex flagged 2026-09-23 that an un-expiring proto cache would let a
// prototype ticker serve indefinitely stale news as model evidence.
const PROTO_NEWS_CACHE_TTL_SECONDS = 12 * 3600;
async function protoNewsCacheSet(ticker, news) {
  return protoSet(protoKey.newsCache(ticker), news, { ex: PROTO_NEWS_CACHE_TTL_SECONDS });
}

// Isolation, per Codex's 2026-09-23 round-3 review: getAIRecommendation and
// evaluateProposal both record to the real pm:anthropic-usage:* telemetry by
// default, which is the input to the SHARED production monthly Anthropic
// budget -- prototype spend could make the real scheduled scan fail closed.
// Route usage telemetry to proto:* instead. Reuses the real pure record
// builder (buildAnthropicUsageRecord) so the shape/pricing math is identical;
// only the storage destination changes.
async function protoRecordUsage(input) {
  const record = buildAnthropicUsageRecord(input);
  await protoListPush(protoKey.usage(), record, { maxLength: 20_000 });
  return { record, persisted: true, error: null };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ID = "agent-1";

function loadProtoUniverse() {
  const configPath = path.join(__dirname, "..", "config", "proto", "universe.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const tickers = Array.isArray(parsed.tickers)
    ? [...new Set(parsed.tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean))]
    : [];
  if (!tickers.length) throw new Error("config/proto/universe.json has no usable tickers");
  return tickers;
}

/**
 * Research one ticker through the exact production pipeline in dry-run mode.
 * Mirrors researchTickerForAgentUnlocked's setup (jobs/research-scan.js) but
 * never touches Sheets/ledger writes and never creates a real proposal.
 */
async function researchOneTickerDryRun(symbol, { agent, agentConfig, ctx }) {
  const [fundamentals] = await fetchFundamentalsBatch([symbol]);
  if (!fundamentals || fundamentals.error) {
    return {
      ticker: symbol,
      outcome: "data_unavailable",
      reason: fundamentals?.error ?? "no fundamentals returned",
    };
  }
  const candidateRaw = await buildCandidate(fundamentals, agentConfig.riskLimits, makeDateWindow());

  const peerMetrics = await getPeerMetrics();
  const peerCoverage = assessPeerCoverage({
    ticker: symbol,
    industry: fundamentals.industry ?? null,
    sector: fundamentals.sector ?? null,
    peerMetrics,
  });
  if (!peerCoverage.ready) {
    // Deliberately NOT calling requestPeerCoverage here (removed 2026-09-23
    // per Codex review): it writes to the SAME shared production
    // peer-coverage queue the scheduled scan's limited enrichment capacity
    // draws from, and repeated prototype scans of an incomplete/placeholder
    // universe could displace real research coverage. Coverage still accrues
    // naturally from production's own nightly cycle; the prototype just
    // reports what isn't ready yet rather than accelerating it.
    return {
      ticker: symbol,
      outcome: "peer_coverage_pending",
      reason: peerCoverage.reason,
      peerCount: peerCoverage.peerCount,
    };
  }

  const peerScore = scorePeerFundamentals({ candidate: { ...candidateRaw, ticker: symbol }, peers: peerCoverage.peers });
  if (!peerScore) {
    return { ticker: symbol, outcome: "peer_score_unavailable", reason: "peer coverage was ready but no score could be built" };
  }
  const peerCohortLabel = `${peerCoverage.peerSetUsed.key ?? peerCoverage.peerSetUsed.level} peer cohort (${peerCoverage.peerCount + 1} names)`;
  const candidate = {
    ...candidateRaw,
    quantScore: peerScore.quantScore,
    breakdown: peerScore.breakdown,
    quantScoreContext: {
      source: `stored Yahoo/SEC peer fundamentals; ${peerCohortLabel}`,
      description: `normalized rank versus the resolved ${peerCohortLabel}`,
      partialPeerFundamentalScreen: true,
      proposalResearchEligible: false,
    },
    peerFactEvidence: sourcedFact(
      "peer_cohort",
      "Resolved peer cohort",
      `${peerCohortLabel}; ${peerCoverage.peerCount} data-complete peers`,
      "cohort description",
      "stored peer coverage cache (Yahoo fundamentals and SEC-derived metrics)",
    ),
  };

  const result = await reviewCandidateForAgent(agent, candidate, ctx);
  return {
    ticker: symbol,
    outcome: "reviewed",
    quantScore: candidate.quantScore ?? null,
    rec: result.rec,
    recommendation: result.recommendation,
    createdProposal: result.createdProposal,
    evaluatorVerdict: result.evaluatorVerdict,
    noProposalReason: result.noProposalReason,
    decisionAudit: result.decisionAudit ?? null,
  };
}

export async function runProtoResearchScan({ tickers } = {}) {
  const runId = `proto-run-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const universe = tickers?.length ? tickers.map((t) => String(t).trim().toUpperCase()) : loadProtoUniverse();

  const agent = AGENTS.find((a) => a.id === AGENT_ID);
  if (!agent) throw new Error(`Unknown agentId: ${AGENT_ID}`);
  const agentConfig = loadAgentConfig(AGENT_ID);
  const { riskLimits, personality, watchlist } = agentConfig;

  // Read-only production context. Realistic sizing/context needs real
  // holdings/cash/macro state -- reading it is not a write, and Sam asked for
  // this to behave like the real pipeline, not a synthetic sandbox.
  const { sheets, drive } = getServiceAccountClients();
  const spreadsheetId = await resolveSharedSpreadsheetId(sheets, drive);
  const breaker = await resolveCircuitBreaker(sheets, spreadsheetId);
  const boundaryToken = makeBoundaryToken();
  const evidenceFlags = [];
  // Deliberately NO real monthlyBudget: createResearchRunBudget still
  // enforces its own local, in-memory per-run dollar cap
  // (RESEARCH_RUN_MAX_USD, default $3), but omitting monthlyBudget means
  // authorizeAnthropicCall/settleAnthropicCall never touch the SHARED
  // production Redis-backed monthly budget (lib/ai-budget.js: "if
  // (!monthlyBudget) return ..." skips it entirely). Fixed 2026-09-23 per
  // Codex's finding that prototype spend could exhaust the real budget and
  // make the scheduled scan fail closed.
  const budget = createResearchRunBudget({ onWarning: () => {} });

  const marketScans = await readMarketScans(sheets, spreadsheetId).catch(() => []);
  const [accountHoldings, verifiedLots, strategyNotes] = await Promise.all([
    readHoldingsAllocation(sheets, spreadsheetId),
    readAllLots(sheets, spreadsheetId),
    readAgentStrategyNotes(sheets, spreadsheetId, agent.id),
  ]);
  const ownedHoldings = projectAgentOwnedHoldings({ agentId: agent.id, lots: verifiedLots, holdings: accountHoldings });
  const researchLedger = await readResearchLedger(agent.id);
  // Real Agent 1 memory (read-only) plus the prototype's OWN lessons on top --
  // never the other way around, and the prototype never writes production
  // memory. jobs/proto-feedback.js governs when lessons here become non-empty
  // (frozen-baseline window, docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md).
  const productionMemory = formatAgentMemoriesForPrompt(await listAgentMemories(agent.id));
  const feedbackState = await protoGet(protoKey.feedbackState());
  const protoLessons = feedbackState?.lessons?.length
    ? `\n\nPrototype-specific lessons from Sam's and his investing partner's grading (Research Testing Prototype only):\n${feedbackState.lessons.map((l) => `- ${l}`).join("\n")}`
    : "";
  const persistentMemory = `${productionMemory}${protoLessons}`;

  const candidatesForContext = []; // buildAgentReviewContext only needs this for sector-weight lookups; fine empty for a fixed small run
  const reviewContext = await buildAgentReviewContext(sheets, spreadsheetId, {
    candidates: candidatesForContext,
    riskLimits,
    benchmark: watchlist.benchmark,
    heldAllocation: accountHoldings,
  });

  const ctx = {
    ...reviewContext,
    riskLimits,
    personality,
    strategyNotes,
    persistentMemory,
    marketScans,
    holdingTickers: ownedHoldings.tickers,
    ownedPositionSharesByTicker: ownedHoldings.positionSharesByTicker,
    ownedPositionValueByTicker: ownedHoldings.positionValueByTicker,
    heldReturnPct: ownedHoldings.returnPctByTicker,
    researchLedger,
    breaker,
    boundaryToken,
    evidenceFlags,
    athenaCircuit: createAthenaCircuit(),
    budget,
    dryRun: true, // the whole point -- see reviewCandidateForAgent in research-scan.js
    recordUsage: protoRecordUsage,
    newsCacheGet: protoNewsCacheGet,
    newsCacheSet: protoNewsCacheSet,
  };

  const results = [];
  const counts = { reviewed: 0, wouldCreateProposal: 0, dataUnavailable: 0, peerCoveragePending: 0, error: 0 };
  for (const symbol of universe) {
    try {
      const outcome = await researchOneTickerDryRun(symbol, { agent, agentConfig, ctx });
      results.push(outcome);
      if (outcome.outcome === "reviewed") {
        counts.reviewed += 1;
        if (outcome.createdProposal?.dryRun) counts.wouldCreateProposal += 1;
      } else if (outcome.outcome === "data_unavailable" || outcome.outcome === "peer_score_unavailable") {
        counts.dataUnavailable += 1;
      } else if (outcome.outcome === "peer_coverage_pending") {
        counts.peerCoveragePending += 1;
      }
    } catch (err) {
      console.error(`[ProtoResearchScan] ${symbol} failed: ${err.message}`);
      results.push({ ticker: symbol, outcome: "error", reason: err.message });
      counts.error += 1;
    }
  }

  const completedAt = new Date().toISOString();
  const receipt = {
    runId,
    agentId: agent.id,
    universeSize: universe.length,
    startedAt,
    completedAt,
    counts,
  };

  await protoSet(protoKey.runReceipt(runId), receipt);
  await protoListPush(protoKey.runList(), { runId, startedAt, completedAt, counts });
  for (const result of results) {
    const proposalId = `${runId}:${result.ticker}`;
    await protoSet(protoKey.proposal(proposalId), { runId, ...result, storedAt: completedAt });
    await protoListPush(protoKey.proposalsByRun(runId), proposalId);
    await protoListPush(protoKey.proposalsAll(), proposalId, { maxLength: 20000 });
  }

  console.log(`[ProtoResearchScan] ${runId}: ${universe.length} tickers, ${counts.reviewed} reviewed, ${counts.wouldCreateProposal} would-create-proposal, ${counts.dataUnavailable} data-unavailable, ${counts.peerCoveragePending} peer-coverage-pending, ${counts.error} errors.`);
  return receipt;
}

// Manual/on-demand invocation for testing: `node jobs/proto-research-scan.js`
// fileURLToPath(), not a raw `file://${...}` template -- this Mac's paths
// contain spaces ("All Claude Projects"), which import.meta.url URL-encodes
// and process.argv[1] does not; the naive comparison silently never matches
// (documented mistake class in Feedback/portfolio-manager-code-lessons.md).
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runProtoResearchScan()
    .then((receipt) => {
      console.log(JSON.stringify(receipt, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("[ProtoResearchScan] run failed:", err);
      process.exit(1);
    });
}
