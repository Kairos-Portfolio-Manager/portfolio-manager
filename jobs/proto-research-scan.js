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
import { createAnthropicMonthlyBudget } from "../lib/anthropic-monthly-budget.js";
import { createAthenaCircuit } from "../lib/athena.js";
import { formatAgentMemoriesForPrompt, listAgentMemories } from "../lib/agent-memory.js";
import { readResearchLedger } from "../lib/research-ledger.js";
import { projectAgentOwnedHoldings } from "../lib/research-holding-ownership.js";
import { assessPeerCoverage, scorePeerFundamentals } from "../lib/peer-coverage.js";
import { getPeerMetrics, requestPeerCoverage } from "../lib/redis.js";
import {
  getServiceAccountClients,
  resolveSharedSpreadsheetId,
  readHoldingsAllocation,
  readAllLots,
  readMarketScans,
  readAgentStrategyNotes,
} from "../lib/sheets.js";
import { AGENTS } from "../config/agents.js";
import { protoSet, protoListPush, protoKey } from "../lib/proto-store.js";

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
    // Read-only widening of the SAME production peer-coverage request queue the
    // scheduled scan uses -- this is a request for more data, not a write of
    // prototype state, and it's exactly what "run normally" means for coverage.
    await requestPeerCoverage({ ticker: symbol, industry: fundamentals.industry ?? null, sector: fundamentals.sector ?? null, source: "proto" });
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
  const monthlyBudget = createAnthropicMonthlyBudget();
  const budget = createResearchRunBudget({ monthlyBudget, onWarning: () => {} });

  const marketScans = await readMarketScans(sheets, spreadsheetId).catch(() => []);
  const [accountHoldings, verifiedLots, strategyNotes] = await Promise.all([
    readHoldingsAllocation(sheets, spreadsheetId),
    readAllLots(sheets, spreadsheetId),
    readAgentStrategyNotes(sheets, spreadsheetId, agent.id),
  ]);
  const ownedHoldings = projectAgentOwnedHoldings({ agentId: agent.id, lots: verifiedLots, holdings: accountHoldings });
  const researchLedger = await readResearchLedger(agent.id);
  const persistentMemory = formatAgentMemoriesForPrompt(await listAgentMemories(agent.id));

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
if (import.meta.url === `file://${process.argv[1]}`) {
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
