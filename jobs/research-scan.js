import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractMarketCap, fetchFundamentals, fetchFundamentalsBatch, fetchDailyBars, fetchQuotes, percentChange } from "../lib/yahoo.js";
import { scoreCandidates } from "../lib/quant-scorer.js";
import { rsi, atr, avgDailyDollarVolume, weeklyVolatility, classifySubVertical } from "../lib/indicators.js";
import { evaluateDataGates } from "../lib/data-gates.js";
import { evaluateMandateBusinessEligibility, screenCatalogForAgent } from "../lib/mandate-catalog-screen.js";
import { assessEvidenceQuality, buildTechnicalFactPacket } from "../lib/evidence-quality-policy.js";
import { assembleEntrySignals, assessConviction } from "../lib/conviction.js";
import { tavilySearch } from "../lib/tavily.js";
import { fetchRecentFilings } from "../lib/edgar.js";
import { fetchMacroSnapshot, formatMacroSnapshot, fetchTreasuryYieldObservations, computeTreasuryYieldChangeBps } from "../lib/fred.js";
import { applySingleRedMacroTierCap, evaluateMacroRedFlags, formatMacroRedFlags } from "../lib/macro-regime.js";
import { enforceFractionalShareHoldPolicy, getAIRecommendation } from "../lib/ai-overlay.js";
import { applyRiskChecks } from "../lib/risk-engine.js";
import { evaluateProposal, resolveFinalVerdict } from "../lib/evaluator.js";
import { makeBoundaryToken, sanitizeEvidenceItems } from "../lib/evidence.js";
import {
  formatEvidenceFlagSummary,
  shouldTelegramEvidenceFlags,
  summarizeEvidenceFlags,
} from "../lib/evidence-alerts.js";
import { assessCircuitBreaker, applyBreakerToProposal, deriveDailyNavBreakerBasis, reconcileNavHighWaterMark } from "../lib/circuit-breaker.js";
import { sendMessage as sendTelegram } from "../lib/telegram.js";
import { formatAgentMemoriesForPrompt, listAgentMemories } from "../lib/agent-memory.js";
import {
  getCachedNews,
  getRedis,
  setCachedNews,
  getCachedMacro,
  setCachedMacro,
  getCachedTreasuryYieldChangeBps,
  setCachedTreasuryYieldChangeBps,
  getCachedPortfolioTotalValue,
  listAllProposals,
  createProposal,
  getPortfolioHighWaterMark,
  setPortfolioHighWaterMark,
  getBreakerState,
  setBreakerState,
  getUniverseCatalog,
  getPeerMetrics,
  requestPeerCoverage,
  setSlateSnapshot,
  setPrivateResearchSlate,
  setResearchScanStatus,
  setAgentParityRuntimeSummary,
} from "../lib/redis.js";
import { assessPeerCoverage, scorePeerFundamentals, selectPeerReadyCandidates } from "../lib/peer-coverage.js";
import { sizeProposalAmount, hasOpenProposal, hasRecentProposal } from "../lib/proposal-sizing.js";
import { requestMcpMarketScan } from "./market-scan-requests.js";
import { buildSlate, formatSlateCounts } from "../lib/candidate-slate.js";
import {
  ATTENTION_POLICY_VERSIONS,
  buildLiveResearchCandidateBus,
  resolveAgentCatalogMode,
} from "../lib/research-candidate-bus.js";
import { allocateFairAgentRunCaps } from "../lib/research-capacity.js";
import { projectAgentOwnedHoldings } from "../lib/research-holding-ownership.js";
import { resolveSectorExposureKey } from "../lib/sector-exposure.js";
import { readResearchLedger, applyResearchRecords, formatResearchHistoryForPrompt, summarizeResearchLedger } from "../lib/research-ledger.js";
import { getAthenaConfig, createAthenaCircuit, fetchAthenaDossier, athenaDossierToEvidence } from "../lib/athena.js";
import {
  getServiceAccountClients,
  resolveSharedSpreadsheetId,
  getSheetIds,
  readCashBalance,
  readHoldingsAllocation,
  readAllLots,
  readMarketScans,
  readAgentStrategyNotes,
  appendAgentRecommendations,
  agentTabName,
  readPerformanceHistory,
} from "../lib/sheets.js";
import { AGENTS } from "../config/agents.js";
import { canCreateActionableProposal, classifyResearchFailure, isResearchActive, finiteNonNegative, needsImmediateResearchFailureAlert } from "../lib/research-run-health.js";
import {
  RESEARCH_OUTCOME_VERSION,
  addOutcome,
  assertOutcomeConservation,
  blankOutcomeCounts,
  classifyRecommendationOutcome,
  classifyResearchRunOutcome,
  researchOutcomeCountsHaveFailures,
} from "../lib/research-run-report.js";
import { withWorkflowLock } from "../lib/workflow-lock.js";
import { BudgetExhaustedError, createResearchRunBudget } from "../lib/ai-budget.js";
import { createAnthropicMonthlyBudget } from "../lib/anthropic-monthly-budget.js";
import { buildAgentParityRuntimeSummary } from "../lib/agent-parity-runtime-summary.js";
import { RESEARCH_FUNNEL_RECEIPT_VERSION } from "../lib/research-funnel-report.js";
import { recordAgent4ShadowReview } from "../lib/agent4-shadow-adapter.js";
import { appendResearchDecisionAudits } from "../lib/research-decision-audit.js";
import { applyPersistedMandateScoreGate } from "../lib/mandate-proposal-gate.js";
import { createScheduledPeerFundamentalProposalCanary, peerFundamentalScreenPolicy } from "../lib/peer-fundamental-proposal-canary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENT_IDS = AGENTS.filter(isResearchActive).map((agent) => agent.id);

// The private slate is an advisory baseline for the shadow selector. It must
// describe the candidates actually sent through the live model loop, not the
// wider pre-peer selection where deferred candidates never received review.
export function buildPrivateResearchSlateItems(reviewedCandidates, reviewBuckets) {
  if (!(reviewedCandidates instanceof Map) || !(reviewBuckets instanceof Map)) {
    throw new TypeError("reviewed candidates and review buckets must be Maps");
  }
  return [...reviewedCandidates.keys()].map((ticker) => ({
    ticker,
    // A peer-ready fallback was not in the original priority map. It was still
    // actually reviewed, so preserve it as an explicit advisory-slate source
    // instead of emitting an invalid undefined bucket after durable writes.
    bucket: reviewBuckets.get(ticker) ?? "peer_ready_backfill",
  }));
}

function blankModelCallCounts() {
  return {
    generator: { attempted: 0, succeeded: 0, failed: 0 },
    evaluator: { attempted: 0, succeeded: 0, failed: 0 },
  };
}

function blankAgentScanSummary(agentId) {
  return {
    agentId,
    classificationVersion: RESEARCH_OUTCOME_VERSION,
    status: "completed",
    recommendationsWritten: 0,
    attemptedReviews: 0,
    actionCounts: { BUY: 0, SELL: 0, HOLD: 0, NO_TRADE: 0, ERROR: 0 },
    proposalsCreated: 0,
    proposalCounts: { BUY: 0, SELL: 0 },
    scanErrors: 0,
    budgetExhaustions: 0,
    evaluatorRejects: 0,
    outcomeCounts: blankOutcomeCounts(),
    discovery: null,
    // Aggregate-only selection telemetry. This measures why a review budget was
    // not used; it never changes the slate, peer gate, model prompt, or queue.
    researchFunnel: {
      schemaVersion: RESEARCH_FUNNEL_RECEIPT_VERSION,
      reviewBudget: 0,
      priorityCandidates: 0,
      exemptHoldingCandidates: 0,
      peerReadyCandidates: 0,
      deferredPriorityCandidates: 0,
      peerReadyBackfillCandidates: 0,
      proposalResearchEligibleCandidates: 0,
    },
    capacity: null,
    modelCalls: blankModelCallCounts(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
}

async function callGeneratorForAgent(agentId, input, ctx) {
  const counts = ctx.modelCalls?.generator;
  if (counts) counts.attempted += 1;
  try {
    const result = await getAIRecommendation({
      ...input,
      agentId,
      budget: ctx.budget,
    });
    if (counts) counts.succeeded += 1;
    return result;
  } catch (error) {
    if (counts) counts.failed += 1;
    throw error;
  }
}

async function callEvaluatorForAgent(agentId, input, ctx) {
  const counts = ctx.modelCalls?.evaluator;
  if (counts) counts.attempted += 1;
  try {
    const result = await evaluateProposal({
      ...input,
      agentId,
      budget: ctx.budget,
    });
    if (counts) counts.succeeded += 1;
    return result;
  } catch (error) {
    if (counts) counts.failed += 1;
    throw error;
  }
}

function summarizeRecommendation(summary, recommendation) {
  if (!recommendation) return;
  summary.recommendationsWritten += 1;
  const action = recommendation.action;
  if (action === "BUY" || action === "SELL" || action === "HOLD" || action === "NO_TRADE" || action === "ERROR") {
    summary.actionCounts[action] += 1;
  }
  const ruleCheck = recommendation.ruleCheck ?? "";
  if (ruleCheck.includes("scan_error")) summary.scanErrors += 1;
  if (ruleCheck.includes("budget_exhausted")) summary.budgetExhaustions += 1;
  if (ruleCheck.includes("evaluator_reject")) summary.evaluatorRejects += 1;
}

// A missing/broken universe.json quietly behaving like watchlist mode would be a
// silent no-op on the whole discovery funnel — keep the fallback, but loudly.
const DEFAULT_UNIVERSE_CONFIG = { source: "watchlist", slateSize: 20, aiReviewBudget: 12, researchCooldownDays: 14, explorationSlots: 0 };

// Split-mandate agents keep master.md (identity/philosophy/guardrails, shared
// across every task) and buy-playbook.md (entry search/sizing — the only half
// a research scan needs) side by side; both get concatenated into the same
// "personality" slot the AI overlay has always received, so the model sees an
// equivalent mandate either way. Agents not yet migrated keep one flat
// personality.md — CHANGE_MAP "Onboarding a specialist mandate" documents both
// forms until every agent moves to the split layout.
function loadPersonality(dir) {
  const masterPath = path.join(dir, "master.md");
  const buyPlaybookPath = path.join(dir, "buy-playbook.md");
  if (fs.existsSync(masterPath) && fs.existsSync(buyPlaybookPath)) {
    const master = fs.readFileSync(masterPath, "utf8").trim();
    const buyPlaybook = fs.readFileSync(buyPlaybookPath, "utf8").trim();
    return `${master}\n\n${buyPlaybook}`;
  }
  return fs.readFileSync(path.join(dir, "personality.md"), "utf8").trim();
}

function loadAgentConfig(agentId) {
  const dir = path.join(__dirname, "..", "config", "agents", agentId);
  let universe = DEFAULT_UNIVERSE_CONFIG;
  try {
    universe = { ...DEFAULT_UNIVERSE_CONFIG, ...JSON.parse(fs.readFileSync(path.join(dir, "universe.json"), "utf8")) };
  } catch (err) {
    console.error(`[Research] ${agentId}: universe.json unreadable (${err.message}) — falling back to watchlist source.`);
  }
  return {
    watchlist: JSON.parse(fs.readFileSync(path.join(dir, "watchlist.json"), "utf8")),
    weights: JSON.parse(fs.readFileSync(path.join(dir, "weights.json"), "utf8")),
    riskLimits: JSON.parse(fs.readFileSync(path.join(dir, "risk-limits.json"), "utf8")),
    personality: loadPersonality(dir),
    universe,
  };
}

/**
 * Resolves the portfolio drawdown circuit breaker (LOOP-DESIGN.md §2 step 5)
 * BEFORE any agent runs. Basis is NAV/unit when the investor ledger has one
 * (deposit/withdrawal-neutral); falls back to total portfolio value otherwise.
 * A basis switch resets the high-water mark rather than comparing across units.
 * Telegrams on tier CHANGE only, so a persistent drawdown doesn't spam.
 */
async function resolveCircuitBreaker(sheets, spreadsheetId) {
  let current = null;
  let basis = null;
  let ledgerHighWaterMark = null;
  let ledgerDailyRows = null;
  try {
    const history = await readPerformanceHistory(sheets, spreadsheetId);
    const daily = deriveDailyNavBreakerBasis(history);
    if (daily.current != null) {
      current = daily.current;
      ledgerHighWaterMark = daily.highWaterMark;
      ledgerDailyRows = daily.dailyRows;
      basis = "navPerUnit";
      if (daily.ignoredRows > 0) {
        console.log(`[Breaker] excluded ${daily.ignoredRows} duplicate-date or invalid Performance row(s); current signed daily row is ${daily.currentDate}.`);
      }
    }
  } catch (err) {
    console.warn("[Breaker] Performance history unavailable:", err.message);
  }
  const stored = await getPortfolioHighWaterMark();
  // Once NAV/unit is the established safety basis, unreadable or unusable NAV
  // evidence must not switch units and erase its ratchet. Stay UNKNOWN until
  // the signed ledger returns. Total value remains the bootstrap fallback only
  // when no NAV/unit safety record exists yet.
  if (current == null && stored?.basis === "navPerUnit") {
    basis = "navPerUnit";
  }
  if (current == null && basis == null) {
    const totalValue = await getCachedPortfolioTotalValue();
    if (totalValue != null && Number.isFinite(totalValue) && totalValue > 0) {
      current = totalValue;
      basis = "totalValue";
    }
  }

  // Rebuild NAV/unit from the signed daily ledger, but preserve Redis as a
  // monotonic safety ratchet. Valid row deletion must not lower the HWM or hide
  // a drawdown; only the explicit breaker:recompute --apply repair accepts a
  // decrease after investigation.
  const navControl = basis === "navPerUnit"
    ? reconcileNavHighWaterMark({ ledgerHighWaterMark, dailyRows: ledgerDailyRows, stored })
    : null;
  const priorHwm = navControl
    ? navControl.highWaterMark
    : (stored && stored.basis === basis ? stored.value : null);
  const assessment = assessCircuitBreaker({ current, highWaterMark: priorHwm });

  if (assessment.highWaterMark != null && basis) {
    await setPortfolioHighWaterMark({
      value: assessment.highWaterMark,
      basis,
      ...(navControl ? {
        dailyRows: navControl.dailyRows,
        ledgerHighWaterMark: navControl.ledgerHighWaterMark,
        lastIntegrityAlertKey: navControl.integrityAlertKey ? (stored?.lastIntegrityAlertKey ?? null) : null,
      } : {}),
    });
  }
  const priorState = await getBreakerState();
  await setBreakerState({ tier: assessment.tier, drawdownPct: assessment.drawdownPct, basis });

  if (assessment.tier !== "NONE") {
    console.error(
      `[Breaker] tier ${assessment.tier} active — drawdown ${assessment.drawdownPct ?? "?"}% from ${basis ?? "no"} high-water mark.`
    );
  }
  const priorTier = priorState?.tier ?? assessment.tier;
  if (priorTier !== assessment.tier) {
    const msg = `⚠️ Portfolio circuit breaker: ${priorState?.tier ?? "NONE"} → ${assessment.tier}${
      assessment.drawdownPct != null ? ` (drawdown ${assessment.drawdownPct}% on ${basis})` : " (no valuation data)"
    }`;
    try {
      await sendTelegram(msg);
    } catch (err) {
      console.error("[Breaker] Telegram alert failed:", err.message, "—", msg);
    }
  }
  if (navControl?.shouldAlert) {
    const msg =
      `⚠️ Portfolio breaker ledger integrity warning: ${navControl.issues.join(" and ")}. ` +
      `Observed signed daily rows ${navControl.observedDailyRows}; retained watermark ${navControl.dailyRows}. ` +
      `Observed ledger HWM ${navControl.ledgerHighWaterMark}; retained safety HWM ${assessment.highWaterMark}. ` +
      `The stricter breaker remains active. Investigate, then run breaker:recompute --apply to accept an intentional decrease.`;
    console.error(`[Breaker] ${msg}`);
    try {
      await sendTelegram(msg);
      await setPortfolioHighWaterMark({
        value: assessment.highWaterMark,
        basis,
        dailyRows: navControl.dailyRows,
        ledgerHighWaterMark: navControl.ledgerHighWaterMark,
        lastIntegrityAlertKey: navControl.integrityAlertKey,
      });
    } catch (err) {
      console.error("[Breaker] Integrity Telegram alert failed:", err.message, "—", msg);
    }
  }
  return assessment;
}

function selectMarketScanTickers(agentId, marketScans, watchlistTickers, limit = 5) {
  const watchlist = new Set(watchlistTickers.map((t) => t.toUpperCase()));
  const picked = [];
  const seen = new Set();
  for (const row of marketScans) {
    const ticker = row.ticker?.toUpperCase();
    if (!ticker || seen.has(ticker) || watchlist.has(ticker)) continue;
    const hint = row.agentHint?.trim();
    if (hint && hint !== agentId) continue;
    seen.add(ticker);
    picked.push(ticker);
    if (picked.length >= limit) break;
  }
  return picked;
}

function scanSignalsForTicker(marketScans, ticker) {
  return marketScans
    .filter((row) => row.ticker === ticker)
    .slice(0, 3)
    .map((row) => ({
      scanName: row.scanName,
      signal: row.signal,
      score: row.score,
      notes: row.notes,
    }));
}

/**
 * Conviction discipline (agent-1 memo): the AI overlay may size aggressively, but a
 * BUY can never exceed the position cap its strong-signal evidence earns. A single-
 * strong-signal "Speculative" name is clamped to 5% even if the model wanted 15%, and
 * an unqualified name (no strong signal) is downgraded to HOLD outright.
 * Extracted so the evaluator's revision path re-applies the same clamp.
 */
function applyConvictionClamp(rec, agent, candidate, riskLimits) {
  if (agent.id !== "agent-1" || rec.action !== "BUY") return rec;
  const entrySignals = assembleEntrySignals(candidate);
  const conviction = assessConviction(entrySignals, riskLimits);
  if (!conviction.qualified) {
    return {
      ...rec,
      action: "HOLD",
      targetWeight: 0,
      overrideNotes: [...(rec.overrideNotes ?? []), "conviction: unqualified (no strong signal) — downgraded to HOLD"],
    };
  }
  if (rec.targetWeight > conviction.maxWeightPct) {
    return {
      ...rec,
      targetWeight: conviction.maxWeightPct,
      overrideNotes: [
        ...(rec.overrideNotes ?? []),
        `conviction ${conviction.tier}: clamped ${rec.targetWeight}%→${conviction.maxWeightPct}%`,
      ],
    };
  }
  return rec;
}

/** Lookback windows used by the candidate builder (momentum + daily-bar history). */
function makeDateWindow(now = new Date()) {
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(now.getMonth() - 3);
  const oneMonthAgo = new Date(now);
  oneMonthAgo.setMonth(now.getMonth() - 1);
  // The 52-week-high fallback (lib/evidence-quality-policy.js) needs 252 valid
  // trading-day closes, which takes ~11.5 calendar months to accumulate. This
  // was previously 8 months — structurally too short to ever satisfy that (or
  // even the 200-day) requirement, regardless of ticker. 14 months leaves
  // buffer for holidays/gaps. The primary source for sma50/sma200/high52Week
  // is now Yahoo's own precomputed summaryDetail figures (free, no extra
  // request) — this window only matters as their fallback.
  const barsHistoryStart = new Date(now);
  barsHistoryStart.setMonth(now.getMonth() - 14);
  return { now, threeMonthsAgo, oneMonthAgo, barsHistoryStart };
}

function toIsoTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const parsed = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function sourcedFact(id, label, value, unit, source) {
  if (value == null || value === "" || (typeof value === "number" && !Number.isFinite(value))) return null;
  return { id, kind: "raw_fact", label, value, unit, source };
}

function buildCandidateFactEvidence(candidate, macroRedFlags = null) {
  const raw = candidate.raw ?? {};
  const facts = [
    sourcedFact("raw_current_price", "Current price", raw.price?.regularMarketPrice, "USD", "Yahoo quote"),
    sourcedFact("raw_trailing_pe", "Trailing P/E", raw.summaryDetail?.trailingPE, "multiple", "Yahoo fundamentals"),
    sourcedFact("raw_forward_pe", "Forward P/E", raw.summaryDetail?.forwardPE, "multiple", "Yahoo fundamentals"),
    sourcedFact("raw_trailing_eps", "Trailing EPS", raw.defaultKeyStatistics?.trailingEps, "USD per share", "Yahoo fundamentals"),
    sourcedFact("raw_forward_eps", "Forward EPS", raw.defaultKeyStatistics?.forwardEps, "USD per share", "Yahoo fundamentals"),
    sourcedFact("raw_revenue_growth", "Revenue growth", raw.financialData?.revenueGrowth, "decimal", "Yahoo fundamentals"),
    sourcedFact("raw_earnings_growth", "Earnings growth", raw.financialData?.earningsGrowth, "decimal", "Yahoo fundamentals"),
    sourcedFact("raw_gross_margin", "Gross margin", raw.financialData?.grossMargins, "decimal", "Yahoo fundamentals"),
    sourcedFact("raw_profit_margin", "Profit margin", raw.financialData?.profitMargins, "decimal", "Yahoo fundamentals"),
    sourcedFact("raw_free_cash_flow", "Free cash flow", raw.financialData?.freeCashflow, "USD", "Yahoo fundamentals"),
    sourcedFact("raw_momentum_3m", "Three-month price return", candidate.momentum3m, "decimal", "Yahoo daily bars"),
    sourcedFact("raw_momentum_1m", "One-month price return", candidate.momentum1m, "decimal", "Yahoo daily bars"),
    sourcedFact("raw_rsi_14", "14-session RSI", candidate.rsi, "index_0_to_100", "Yahoo daily bars"),
    sourcedFact("raw_average_daily_dollar_volume", "Average daily dollar volume", candidate.avgDollarVolume, "USD", "Yahoo daily bars"),
  ];
  const technical = candidate.technicalFacts ?? {};
  // technical.*.source is "yahoo_summary_detail" when it came from Yahoo's own
  // precomputed figure, otherwise it was reconstructed from daily bars — label
  // each fact with which one actually happened, not just where a value could
  // theoretically come from.
  const technicalSource = (fact) => (fact?.source === "yahoo_summary_detail" ? "Yahoo fundamentals (summaryDetail)" : "Yahoo daily bars");
  if (technical.currentPrice?.status === "available") {
    facts.push(sourcedFact("technical_current_price", "Timestamped current price", technical.currentPrice.value, "USD", "Yahoo quote"));
  }
  if (technical.sma50?.status === "available") {
    facts.push(sourcedFact("technical_sma_50", "50-session simple moving average", technical.sma50.value, "USD", technicalSource(technical.sma50)));
  }
  if (technical.sma200?.status === "available") {
    facts.push(sourcedFact("technical_sma_200", "200-session simple moving average", technical.sma200.value, "USD", technicalSource(technical.sma200)));
  }
  if (technical.high52Week?.status === "available") {
    facts.push(sourcedFact("technical_high_52_week", "52-week high", technical.high52Week.value, "USD", technicalSource(technical.high52Week)));
  }
  // Deterministic dual-red macro gate (lib/macro-regime.js) as typed facts, so the
  // model cites a stated boolean instead of computing "is SPY below its 200-day
  // average" itself from raw numbers — the enforcement backstop is separate
  // (applyMacroRedGate in the proposal pipeline), this is only the evidence.
  if (macroRedFlags?.spyRed !== null && macroRedFlags?.spyRed !== undefined) {
    facts.push(sourcedFact("macro_spy_below_200day", "SPY below its 200-day average", macroRedFlags.spyRed, "boolean", "Yahoo quote (SPY)"));
  }
  if (macroRedFlags?.rateRed !== null && macroRedFlags?.rateRed !== undefined) {
    facts.push(sourcedFact("macro_rate_pressure", "10-year Treasury yield moved >50bps over the trailing 30 trading days", macroRedFlags.rateRed, "boolean", "FRED (DGS10)"));
  }
  if (candidate.peerFactEvidence) facts.push(candidate.peerFactEvidence);
  return facts.filter(Boolean);
}

/**
 * Every scheduled AI-review candidate participates in peer coverage, not just
 * names entered through Lab. A missing cohort is queued before model work; the
 * dedicated collector then fetches the target plus its economic peers.
 */
export async function queuePeerCoverageForCandidates(candidates = [], {
  peerMetrics = {},
  requestCoverage = requestPeerCoverage,
} = {}) {
  const queued = [];
  const covered = [];
  for (const candidate of candidates) {
    const ticker = String(candidate?.ticker ?? "").trim().toUpperCase();
    if (!ticker) continue;
    const coverage = assessPeerCoverage({
      ticker,
      industry: candidate.industry ?? null,
      sector: candidate.sector ?? null,
      peerMetrics,
    });
    if (coverage.ready) covered.push(ticker);
    await requestCoverage({
      ticker,
      industry: candidate.industry ?? null,
      sector: candidate.sector ?? null,
      source: "scheduled_research",
    });
    if (!coverage.ready) queued.push(ticker);
  }
  return { queued, covered };
}

/**
 * Builds one research candidate from a fetched fundamentals record: one daily-bar
 * fetch covers momentum, RSI, ATR, weekly vol, and ADDV (replaces the prior two
 * close-only fetches and feeds lib/indicators.js + the data gates). Extracted from
 * the scan's candidate loop so the lab single-ticker path builds candidates through
 * the identical code.
 */
async function buildCandidate(f, riskLimits, { now, threeMonthsAgo, oneMonthAgo, barsHistoryStart }) {
  const bars = await fetchDailyBars(f.ticker, { period1: barsHistoryStart, period2: now });
  const closes = bars.map((b) => b.close);
  const closesSince = (cutoff) => bars.filter((b) => new Date(b.date) >= cutoff).map((b) => ({ close: b.close }));
  const lastBarDate = bars.length ? bars[bars.length - 1].date : null;
  const addv = avgDailyDollarVolume(bars, 30);
  const marketCap = f.marketCap ?? extractMarketCap(f.raw);
  const quoteTimestamp = toIsoTimestamp(f.raw?.price?.regularMarketTime);
  const technicalFacts = buildTechnicalFactPacket({
    bars,
    price: f.raw?.price?.regularMarketPrice ?? null,
    priceTimestamp: quoteTimestamp,
    asOf: lastBarDate,
    // Yahoo's own summaryDetail already reports these — free, same fetchFundamentals
    // call, no extra request. Only falls back to the from-bars reconstruction
    // above when Yahoo doesn't report one for a given ticker.
    providedSma50: f.raw?.summaryDetail?.fiftyDayAverage ?? null,
    providedSma200: f.raw?.summaryDetail?.twoHundredDayAverage ?? null,
    providedHigh52Week: f.raw?.summaryDetail?.fiftyTwoWeekHigh ?? null,
    providedAsOf: quoteTimestamp,
  });

  const dataGate = evaluateDataGates(
    {
      price: f.raw?.price?.regularMarketPrice ?? null,
      trailingEps: f.raw?.defaultKeyStatistics?.trailingEps ?? null,
      forwardEps: f.raw?.defaultKeyStatistics?.forwardEps ?? null,
      grossMargins: f.raw?.financialData?.grossMargins ?? null,
      profitMargins: f.raw?.financialData?.profitMargins ?? null,
      rsi: rsi(closes, 14),
      lastBarDate,
      marketCap,
      avgDollarVolume: addv,
    },
    riskLimits,
    { now }
  );

  return {
    ...f,
    sector: f.sector ?? f.raw?.assetProfile?.sector ?? null,
    industry: f.industry ?? f.raw?.assetProfile?.industry ?? null,
    subVertical: classifySubVertical(f),
    momentum3m: percentChange(closesSince(threeMonthsAgo)),
    momentum1m: percentChange(closesSince(oneMonthAgo)),
    rsi: rsi(closes, 14),
    atr: atr(bars, 14),
    weeklyVol: weeklyVolatility(closes),
    avgDollarVolume: addv,
    marketCap,
    lastBarDate,
    technicalFacts,
    dataGate,
  };
}

/**
 * Portfolio-wide context shared by every ticker an agent reviews in one run:
 * benchmark entry price; current exposure by ticker/broad sector (% of invested
 * capital, with legacy sub-vertical only as a fallback when sector is absent);
 * macro backdrop (shared market fact — fetched/cached
 * once globally, not per-agent); and the sizing/dedup context for auto-queueing
 * risk-gated BUY/SELL calls into the approval queue. openProposals and
 * availableCashForBuys are mutated as tickers queue within a run so a later
 * ticker (or the next agent's run) doesn't double-queue against a list fetched
 * before the run started.
 */
async function buildAgentReviewContext(sheets, spreadsheetId, { candidates, riskLimits, benchmark, heldAllocation = null }) {
  const benchmarkQuotes = await fetchQuotes([benchmark]);
  const spyEntryPrice = benchmarkQuotes[benchmark]?.regularMarketPrice ?? null;
  // Yahoo's lightweight quote() already reports this — same call as spyEntryPrice
  // above, no extra request. Feeds the deterministic dual-red macro gate below.
  const spySma200 = benchmarkQuotes[benchmark]?.twoHundredDayAverage ?? null;

  const [resolvedHeldAllocation, cashBalance, lots] = await Promise.all([
    heldAllocation ? Promise.resolve(heldAllocation) : readHoldingsAllocation(sheets, spreadsheetId),
    readCashBalance(sheets, spreadsheetId),
    // Kairos's shadow observer needs ownership data for SELL review. A read
    // failure must never disturb the existing specialist/approval path.
    readAllLots(sheets, spreadsheetId).catch((error) => {
      console.error(`[Kairos] Shadow lot snapshot unavailable: ${error.message}`);
      return null;
    }),
  ]);
  heldAllocation = resolvedHeldAllocation;
  const investedTotal = heldAllocation.reduce((sum, h) => sum + (h.marketValue ?? 0), 0);
  const tickerWeightPct = {};
  const sectorWeightPct = {};
  for (const h of heldAllocation) {
    if (!h.marketValue || !investedTotal) continue;
    const weightPct = (h.marketValue / investedTotal) * 100;
    tickerWeightPct[h.ticker] = weightPct;
    const known = candidates.find((c) => c.ticker === h.ticker);
    const evidence = known ?? await fetchFundamentals(h.ticker);
    const sector = resolveSectorExposureKey(evidence);
    if (sector) sectorWeightPct[sector] = (sectorWeightPct[sector] ?? 0) + weightPct;
  }

  let macroSnapshot = await getCachedMacro();
  if (!macroSnapshot) {
    macroSnapshot = await fetchMacroSnapshot();
    if (macroSnapshot) await setCachedMacro(macroSnapshot);
  }
  const macroText = formatMacroSnapshot(macroSnapshot);

  // Deterministic dual-red macro gate (lib/macro-regime.js): computed here, once
  // per agent run, not left for the AI to derive from raw numbers in a prompt.
  let treasuryYieldChangeBps = await getCachedTreasuryYieldChangeBps();
  if (treasuryYieldChangeBps == null) {
    const observations = await fetchTreasuryYieldObservations();
    treasuryYieldChangeBps = computeTreasuryYieldChangeBps(observations);
    if (treasuryYieldChangeBps != null) await setCachedTreasuryYieldChangeBps(treasuryYieldChangeBps);
  }
  const macroRedFlags = evaluateMacroRedFlags({ spyPrice: spyEntryPrice, spySma200, treasuryYieldChangeBps });

  const totalPortfolioValue = await getCachedPortfolioTotalValue();
  const openProposals = await listAllProposals();
  let availableCashForBuys =
    finiteNonNegative(cashBalance) -
    openProposals
      .filter((p) => p.side === "BUY" && p.status === "ApprovedForBrokerReview" && !p.fulfilledAt)
      .reduce((sum, p) => sum + (p.amountDollars ?? 0), 0);
  availableCashForBuys = finiteNonNegative(Math.round(availableCashForBuys * 100) / 100);
  const ordinarySellCooldownDays = riskLimits.ordinarySellCooldownDays ?? 7;

  return {
    spyEntryPrice,
    macroRedFlags,
    heldAllocation,
    tickerWeightPct,
    sectorWeightPct,
    macroText,
    totalPortfolioValue,
    openProposals,
    availableCashForBuys,
    ordinarySellCooldownDays,
    lots,
  };
}

/**
 * Reviews ONE candidate for ONE agent through the exact production pipeline:
 * data gate → news fetch/fence → AI overlay generator → risk engine (downgrade-
 * only) → conviction clamp (agent-1) → circuit-breaker pre-gate → duplicate
 * open-proposal pre-check → independent evaluator (fail-closed, one revision
 * max) → sizing (starter sizing, cash cap, sell cooldown/dedupe) → breaker
 * sizing pass → createProposal(). Extracted verbatim from the scheduled scan's
 * per-ticker inner loop so the dashboard Lab's single-ticker entry point
 * (researchTickerForAgent) runs the SAME code path, never a parallel copy that
 * can drift. Nothing in here may ever upgrade an action — every step only
 * blocks, shrinks, or downgrades toward HOLD.
 *
 * Mutates ctx.availableCashForBuys / ctx.openProposals / ctx.evidenceFlags
 * exactly as the old loop mutated its locals, so multi-ticker runs keep the
 * same within-run dedupe/cash accounting.
 *
 * Returns { recommendation, researchRecord, rec, createdProposal,
 * evaluatorVerdict, noProposalReason }. recommendation/researchRecord are null
 * only on the starter-slots-full skip (matching the loop's old `continue`);
 * evaluatorVerdict/noProposalReason are advisory strings for the lab endpoint
 * and never feed back into any money decision.
 */
async function reviewCandidateForAgent(agent, c, ctx) {
  const { riskLimits } = ctx;
  let createdProposal = null;
  let evaluatorVerdict = null;
  let evaluatorCritique = [];
  let noProposalReason = null;
  let evaluatorState = "not_run";
  let proposalDisposition = "not_applicable";
  let evaluatorRevisions = 0;
  let kairosOutcome = "not_recorded";
  let kairosExplanation = [];

  // Data-availability gate runs BEFORE the (expensive) AI overlay. Per the memo, missing
  // or stale required inputs are an automatic NO_TRADE — we never ask Claude to reason
  // over a candidate we can't fully see, and we never queue a proposal off it.
  if (c.dataGate && !c.dataGate.ok) {
    const reason = c.dataGate.reasons.join("; ") || "incomplete data";
    console.log(`[Research] ${agent.id}: NO_TRADE ${c.ticker} — ${reason}`);
    return {
      recommendation: {
        date: new Date().toISOString().slice(0, 10),
        ticker: c.ticker,
        action: "NO_TRADE",
        quantScore: c.quantScore ?? null,
        rationale: `NO_TRADE (data gate): ${reason}`,
        newsLinks: "",
        status: "data_error",
        entryPrice: c.raw?.price?.regularMarketPrice ?? null,
        spyEntryPrice: ctx.spyEntryPrice,
        targetWeight: 0,
        confidence: null,
        ruleCheck: `data_gate_blocked: ${reason}`,
      },
      // A data-gate block still counts as "looked at" for slate rotation —
      // otherwise a permanently-gated name would occupy an exploration slot forever.
      researchRecord: {
        ticker: c.ticker,
        action: "NO_TRADE",
        quantScore: c.quantScore ?? null,
        confidence: null,
        thesis: `NO_TRADE (data gate): ${reason}`,
        entryPrice: c.raw?.price?.regularMarketPrice ?? null,
      },
      rec: null,
      createdProposal: null,
      evaluatorVerdict: "not run (data gate)",
      noProposalReason: `NO_TRADE (data gate): ${reason}`,
      outcomeFacts: {
        attempted: true,
        dataGateBlocked: true,
        dataGateStale: Boolean(c.dataGate.stale),
        failureKind: null,
        generatorAction: null,
        finalAction: "HOLD",
        riskOverridden: false,
        evaluatorState: "not_run",
        duplicateOpen: false,
        proposalDisposition: "not_applicable",
      },
    };
  }

  // News is a market fact too — shared cache by ticker is fine and saves Tavily quota across agents.
  let news = await getCachedNews(c.ticker);
  if (!news) {
    try {
      news = await tavilySearch(`${c.ticker} ${c.name} stock news`, { maxResults: 3, days: 7 });
      await setCachedNews(c.ticker, news);
    } catch (err) {
      console.warn(`[Research] ${agent.id}: Tavily search failed for ${c.ticker}:`, err.message);
      news = []; // don't cache — let the next ticker/run retry instead of masking an outage for 12h
    }
  }

  // Fence-and-scan untrusted internet text before any model sees it (lib/evidence.js).
  // Cache keeps the ORIGINAL text; sanitization runs on every use so pattern updates apply to cached items too.
  const newsScan = sanitizeEvidenceItems(news, { kind: `news:${c.ticker}`, textFields: ["title", "content"] });
  const scanSignalScan = sanitizeEvidenceItems(scanSignalsForTicker(ctx.marketScans, c.ticker), {
    kind: `scan:${c.ticker}`,
    textFields: ["signal", "notes"],
  });
  for (const flag of [...newsScan.flags, ...scanSignalScan.flags]) {
    ctx.evidenceFlags.push(flag);
    console.error(`[Evidence] ${agent.id}: instruction-like content redacted in ${flag.kind}: ${flag.reasons.join(", ")}`);
  }
  const safeNews = newsScan.items;
  const safeScanSignals = scanSignalScan.items;
  const newsQuality = assessEvidenceQuality(safeNews);
  const newsForProposal = safeNews.map((item, index) => ({
    ...item,
    // Keep context-only reporting visible to the model as fenced context, but
    // prohibit it from entering the typed evidence ledger as thesis support.
    thesisSupport: newsQuality[index]?.support === true,
    sourceQualityReasons: newsQuality[index]?.reasons ?? [],
  }));

  // Optional Athena dossier (lib/athena.js): a second, locally-run research
  // system's read on this ticker. Config-gated off by default; fetched fresh
  // (local + free), then fenced and sanitized like every other external source.
  let safeAthenaEvidence = [];
  if (getAthenaConfig()) {
    const dossier = await fetchAthenaDossier(c.ticker, { circuit: ctx.athenaCircuit });
    const { items: athenaItems, flags: implausibleFlags } = athenaDossierToEvidence(dossier, {
      livePrice: c.raw?.price?.regularMarketPrice ?? null,
    });
    for (const flag of implausibleFlags) {
      ctx.evidenceFlags.push({ kind: `athena:${c.ticker}`, reasons: flag.reasons });
      console.error(`[Evidence] ${agent.id}: dropped implausible Athena valuation in ${c.ticker}.${flag.section}: ${flag.reasons.join(", ")}`);
    }
    const athenaScan = sanitizeEvidenceItems(athenaItems, {
      kind: `athena:${c.ticker}`,
      textFields: ["content"],
    });
    for (const flag of athenaScan.flags) {
      ctx.evidenceFlags.push(flag);
      console.error(`[Evidence] ${agent.id}: instruction-like content redacted in ${flag.kind}: ${flag.reasons.join(", ")}`);
    }
    safeAthenaEvidence = athenaScan.items;
  }

  const recentFilings = await fetchRecentFilings(c.ticker, { limit: 3 });
  const proposalPolicy = [
    "Capital availability and exact dollar sizing are enforced mechanically after this research decision. Do not use available cash, a minimum allocation, per-share price, or whole-share affordability to choose BUY, SELL, or HOLD.",
    "Fractional-share market orders are supported. When the investment case clears the evidence and risk bar, return the appropriate target weight; downstream controls determine the executable dollar amount.",
    `Ordinary research-scan SELL/rotation proposals are cadence-capped to one SELL review per agent/ticker every ${ctx.ordinarySellCooldownDays} days.`,
    "A sell-funded replacement is a contingent rotation idea: first propose/review the SELL, then only propose the BUY after the sell is approved, filled, and cash is synced. Do not present a new BUY as funded until cash is real.",
    "Immediate risk exits from stop/kill-criteria monitors are handled by separate exit jobs and can bypass this ordinary rotation cadence.",
    ...(c.quantScoreContext?.partialPeerFundamentalScreen === true
      ? [peerFundamentalScreenPolicy({ proposalResearchEligible: c.quantScoreContext?.proposalResearchEligible === true })]
      : []),
  ].join("\n");

  const overlayInput = {
    ticker: c.ticker,
    name: c.name,
    quantScore: c.quantScore,
    breakdown: c.breakdown,
    news: newsForProposal,
    strategyNotes: ctx.strategyNotes,
    isHeld: ctx.holdingTickers.includes(c.ticker),
    nextEarningsDate: c.nextEarningsDate,
    analystTrend: c.analystTrend,
    insiderActivity: c.insiderActivity,
    recentFilings,
    marketScanSignals: safeScanSignals,
    athenaEvidence: safeAthenaEvidence,
    macro: [ctx.macroText, formatMacroRedFlags(ctx.macroRedFlags)].filter(Boolean).join("\n\n"),
    personality: ctx.personality,
    persistentMemory: ctx.persistentMemory,
    proposalPolicy,
    // The agent's own prior conclusion on this name (research ledger) — per-ticker,
    // so it belongs in the user message, never the cached system block.
    researchHistory: formatResearchHistoryForPrompt(ctx.researchLedger[c.ticker]),
    boundaryToken: ctx.boundaryToken,
    factEvidence: buildCandidateFactEvidence(c, ctx.macroRedFlags),
    quantScoreContext: c.quantScoreContext,
  };
  let proposal = await callGeneratorForAgent(agent.id, overlayInput, ctx);
  if (proposal.outputInvalid) {
    const error = new Error(`model_output_invalid: ${proposal.outputError ?? "invalid structured response"}`);
    error.code = "model_output_invalid";
    throw error;
  }
  const preflightNotes = [];
  const fractionalPolicy = await enforceFractionalShareHoldPolicy(proposal, async (violations) => {
    console.warn(`[Research] ${agent.id}: ${c.ticker} HOLD used prohibited fractional-share reasoning (${violations.join(", ")}); retrying once.`);
    const corrected = await callGeneratorForAgent(agent.id, {
      ...overlayInput,
      decisionPolicyCorrection: violations.join(", "),
    }, ctx);
    if (corrected.outputInvalid) {
      const error = new Error(`model_output_invalid: ${corrected.outputError ?? "invalid corrected structured response"}`);
      error.code = "model_output_invalid";
      throw error;
    }
    return corrected;
  });
  proposal = fractionalPolicy.proposal;
  if (fractionalPolicy.retried) {
    preflightNotes.push(`fractional_share_policy_retry: ${fractionalPolicy.initialViolations.join(",")}`);
    if (fractionalPolicy.repeatedViolations.length) {
      const reason = `model repeated prohibited fractional-share HOLD reasoning after correction (${fractionalPolicy.repeatedViolations.join(",")})`;
      console.error(`[Research] ${agent.id}: NO_TRADE ${c.ticker} — ${reason}`);
      return {
        recommendation: {
          date: new Date().toISOString().slice(0, 10), ticker: c.ticker, action: "NO_TRADE", quantScore: c.quantScore,
          rationale: `NO_TRADE (policy invalid): ${reason}`, newsLinks: news.map((n) => n.url).join(", "), status: "policy_invalid",
          entryPrice: c.raw?.price?.regularMarketPrice ?? null, spyEntryPrice: ctx.spyEntryPrice, targetWeight: 0, confidence: null,
          ruleCheck: `fractional_share_policy_invalid: ${fractionalPolicy.repeatedViolations.join(",")}`,
        },
        researchRecord: { ticker: c.ticker, action: "NO_TRADE", quantScore: c.quantScore ?? null, confidence: null, thesis: `NO_TRADE (policy invalid): ${reason}`, entryPrice: c.raw?.price?.regularMarketPrice ?? null },
        rec: null, createdProposal: null, evaluatorVerdict: "not run (policy invalid)", noProposalReason: reason,
        outcomeFacts: {
          attempted: true, dataGateBlocked: false, dataGateStale: false, failureKind: "review_error", generatorAction: "HOLD", finalAction: "HOLD",
          riskOverridden: false, evaluatorState: "not_run", duplicateOpen: false, proposalDisposition: "not_applicable",
        },
      };
    }
  }
  const generatorAction = proposal.action;
  if (proposal.evidenceValidation && !proposal.evidenceValidation.valid) {
    preflightNotes.push(`evidence_preflight: ${proposal.evidenceValidation.issues.join("; ")}`);
  }
  if (proposal.action !== "HOLD") {
    const businessEligibility = evaluateMandateBusinessEligibility({
      agentId: agent.id,
      candidate: c,
      claimedBusinessFamily: proposal.claimedBusinessFamily,
    });
    if (!businessEligibility.eligible) {
      preflightNotes.push(`${businessEligibility.reasonCode}: ${businessEligibility.reason}`);
      proposal = { ...proposal, action: "HOLD", targetWeight: 0 };
    }
  }
  if (proposal.suspectEvidence?.length) {
    ctx.evidenceFlags.push({ kind: `model:${c.ticker}`, reasons: proposal.suspectEvidence });
    console.error(`[Evidence] ${agent.id}: model flagged suspect evidence for ${c.ticker}: ${proposal.suspectEvidence.join("; ")}`);
  }

  const sector = resolveSectorExposureKey(c);
  const riskContext = {
    sector,
    currentSectorWeightPct: sector ? (ctx.sectorWeightPct[sector] ?? 0) : 0,
    currentPositionWeightPct: ctx.tickerWeightPct[c.ticker] ?? 0,
    // Friend's rule: never average down into a losing held position, and never let a
    // stale-data read slip past the AI overlay into a live proposal.
    isHeldAtLoss: (ctx.heldReturnPct[c.ticker] ?? 0) < 0,
    dataStale: c.dataGate ? c.dataGate.stale : false,
    marketCap: c.marketCap ?? null,
    avgDollarVolume: c.avgDollarVolume ?? null,
    analystTrend: c.analystTrend ?? null,
    insiderActivity: c.insiderActivity ?? null,
  };
  let rec = applyConvictionClamp(applyRiskChecks(proposal, riskContext, riskLimits), agent, c, riskLimits);
  if (preflightNotes.length) {
    rec = { ...rec, overrideNotes: [...preflightNotes, ...(rec.overrideNotes ?? [])] };
  }
  let riskOverridden = generatorAction !== "HOLD" && rec.action === "HOLD";

  // Deterministic dual-red macro gate (lib/macro-regime.js): per every agent's
  // mandate, "both SPY-below-200-day and 10-year-rate-pressure red means
  // NO_TRADE." This must not be left for the AI to self-certify from raw
  // numbers in its prompt — it's enforced here, the same way a data gate or
  // the risk engine enforces anything else. Agent 3's mandate explicitly
  // treats macro as informational only at its horizon, so it's exempt.
  const DUAL_RED_BLOCKS_AGENTS = new Set(["agent-1", "agent-2"]);
  if (rec.action === "BUY" && DUAL_RED_BLOCKS_AGENTS.has(agent.id) && ctx.macroRedFlags?.dualRed) {
    rec = {
      ...rec,
      action: "HOLD",
      targetWeight: 0,
      overrideNotes: [...(rec.overrideNotes ?? []), "macro_dual_red: SPY below 200-day average AND 10-year rate pressure — NO_TRADE per mandate"],
    };
    riskOverridden = true;
  } else if (rec.action === "BUY" && DUAL_RED_BLOCKS_AGENTS.has(agent.id) && [ctx.macroRedFlags?.spyRed, ctx.macroRedFlags?.rateRed].includes(true)) {
    // Single red is not a block, but it can only retain the mandate's Tier-2
    // upper bound. The pure helper reads that bound from the policy table.
    rec = applySingleRedMacroTierCap(rec, { agentId: agent.id, macroRedFlags: ctx.macroRedFlags });
  }

  // The mandate-score gate is intentionally default-off until the full
  // decision-time evidence contract has earned activation. Once enabled it
  // reads only an immutable observation at-or-before this decision and fails
  // closed if either that score or any required entry evidence is absent.
  // This stays before the evaluator so no spend is incurred for an entry that
  // deterministic mandate policy cannot admit. It runs after the macro gate
  // because both are downgrade-only and the macro check is pure in-memory: a
  // BUY already blocked to HOLD above skips this gate's Postgres read.
  const mandateGate = await applyPersistedMandateScoreGate(rec, {
    agentId: agent.id,
    ticker: c.ticker,
    asOf: new Date().toISOString(),
    // `evaluateMandateSizing` requires typed decision-time evidence. The live
    // scan does not yet retain the full contract, so an enabled gate correctly
    // blocks rather than treating partial risk context as authoritative.
    evidence: {},
  });
  rec = mandateGate.rec;
  if (mandateGate.applied && rec.action === "HOLD") riskOverridden = true;

  // Circuit-breaker pre-gate: don't spend evaluator tokens on an action the
  // breaker tier can't admit anyway (BUYs at ≥12% drawdown, everything at HALT).
  if (rec.action !== "HOLD") {
    const breakerGate = applyBreakerToProposal(ctx.breaker.tier, rec.action, 1);
    if (!breakerGate.allowed) {
      rec = { ...rec, action: "HOLD", targetWeight: 0, overrideNotes: [...(rec.overrideNotes ?? []), breakerGate.note] };
      riskOverridden = true;
      evaluatorVerdict = "not run (circuit breaker)";
      noProposalReason = breakerGate.note;
    }
  }

  // Duplicate pre-check: an identical open proposal means this one can never
  // queue, so skip the evaluator spend and note why.
  const isDuplicateOpen =
    rec.action !== "HOLD" && hasOpenProposal(ctx.openProposals, { agentId: agent.id, ticker: c.ticker, side: rec.action });
  if (isDuplicateOpen) {
    rec.overrideNotes = [...(rec.overrideNotes ?? []), "duplicate_open_proposal: evaluator skipped, will not re-queue"];
    evaluatorVerdict = "skipped (duplicate open proposal)";
    noProposalReason = "duplicate open proposal exists — evaluator skipped, not re-queued";
  }

  // Independent evaluator (lib/evaluator.js): every actionable proposal is graded
  // by a separate skeptical model before it can reach Sam's approval queue.
  // Downgrade-only, one revision max, and any evaluator failure fails CLOSED.
  if (rec.action !== "HOLD" && !isDuplicateOpen) {
    try {
      const evalContext = {
        ticker: c.ticker,
        name: c.name,
        quantScore: c.quantScore,
        breakdown: c.breakdown,
        rawData: {
          price: c.raw?.price?.regularMarketPrice ?? null,
          marketCap: c.marketCap ?? null,
          trailingEps: c.raw?.defaultKeyStatistics?.trailingEps ?? null,
          forwardEps: c.raw?.defaultKeyStatistics?.forwardEps ?? null,
          trailingPe: c.raw?.summaryDetail?.trailingPE ?? null,
          forwardPe: c.raw?.summaryDetail?.forwardPE ?? null,
          revenueGrowth: c.raw?.financialData?.revenueGrowth ?? null,
          earningsGrowth: c.raw?.financialData?.earningsGrowth ?? null,
          grossMargins: c.raw?.financialData?.grossMargins ?? null,
          profitMargins: c.raw?.financialData?.profitMargins ?? null,
          freeCashflow: c.raw?.financialData?.freeCashflow ?? null,
          analystTrend: c.analystTrend ?? null,
          insiderActivity: c.insiderActivity ?? null,
          nextEarningsDate: c.nextEarningsDate ?? null,
          momentum3mPct: c.momentum3m ?? null,
          momentum1mPct: c.momentum1m ?? null,
          rsi14: c.rsi ?? null,
          avgDailyDollarVolume: c.avgDollarVolume ?? null,
          heldPositionWeightPct: ctx.tickerWeightPct[c.ticker] ?? 0,
          sector,
          subVertical: c.subVertical ?? null,
        },
        newsBlock: safeNews.map((n) => `- ${n.title} (${n.url})\n  ${(n.content ?? "").slice(0, 300)}`).join("\n"),
        mandate: ctx.personality,
        boundaryToken: ctx.boundaryToken,
      };

      let finalEval;
      const first = await callEvaluatorForAgent(agent.id, { ...evalContext, proposal: rec }, ctx);
      if (first.verdict === "REVISE") {
        console.log(`[Evaluator] ${agent.id}: ${c.ticker} sent back for revision — ${first.critique.join("; ")}`);
        const revisedRaw = await callGeneratorForAgent(agent.id, {
          ...overlayInput,
          evaluatorCritique: first.critique,
          previousProposal: rec,
        }, ctx);
        // A revision is a fresh model-provided BUY size, so re-apply every
        // downgrade-only sizing clamp before the evaluator can see it.
        const revised = applySingleRedMacroTierCap(
          applyConvictionClamp(applyRiskChecks(revisedRaw, riskContext, riskLimits), agent, c, riskLimits),
          { agentId: agent.id, macroRedFlags: ctx.macroRedFlags },
        );
        if (revised.action === "HOLD") {
          // Generator conceded (or the risk engine downgraded the revision) — final HOLD.
          finalEval = { ...first, verdict: "REJECT", revisions: 1, critique: [...first.critique, "generator conceded on revision"] };
          rec = revised;
        } else {
          const second = await callEvaluatorForAgent(agent.id, { ...evalContext, proposal: revised }, ctx);
          finalEval = resolveFinalVerdict(first, second);
          if (finalEval.verdict === "APPROVE") rec = revised;
        }
      } else {
        finalEval = resolveFinalVerdict(first);
      }

      if (finalEval.suspectEvidence?.length) {
        ctx.evidenceFlags.push({ kind: `evaluator:${c.ticker}`, reasons: finalEval.suspectEvidence });
      }
      evaluatorCritique = finalEval.critique ?? [];
      evaluatorRevisions = finalEval.revisions ?? 0;
      if (finalEval.verdict === "APPROVE") {
        evaluatorState = "approved";
        rec.overrideNotes = [
          ...(rec.overrideNotes ?? []),
          `evaluator: APPROVE${finalEval.revisions ? " after 1 revision" : ""}`,
        ];
        evaluatorVerdict = `APPROVE${finalEval.revisions ? " after 1 revision" : ""}`;
      } else if (rec.action !== "HOLD") {
        evaluatorState = "rejected";
        console.log(`[Evaluator] ${agent.id}: ${c.ticker} ${rec.action} rejected — ${finalEval.critique.join("; ")}`);
        const critiqueText = finalEval.critique.slice(0, 2).join("; ") || "no critique returned";
        rec = {
          ...rec,
          action: "HOLD",
          targetWeight: 0,
          overrideNotes: [...(rec.overrideNotes ?? []), `evaluator_reject: ${critiqueText}`],
        };
        evaluatorVerdict = `REJECT${finalEval.revisions ? " after 1 revision" : ""}`;
        noProposalReason = `evaluator rejected: ${critiqueText}`;
      } else {
        // Generator conceded to HOLD on the revision path — rec already reflects it.
        evaluatorState = "rejected";
        evaluatorVerdict = "REJECT (generator conceded on revision)";
        noProposalReason = "evaluator sent the proposal back and the revised recommendation came back HOLD";
      }
    } catch (err) {
      if (
        err instanceof BudgetExhaustedError ||
        [
          "monthly_budget_exhausted",
          "monthly_budget_telemetry_unavailable",
          "monthly_budget_config_invalid",
          "monthly_budget_overshoot",
          "anthropic_model_unpriced",
          "anthropic_pricing_version_unknown",
          "anthropic_request_unbounded",
        ].includes(err?.code)
      ) throw err;
      // Evaluator infrastructure failure (API down, 429): fail closed — an
      // unevaluated actionable proposal must not reach the approval queue.
      console.error(`[Evaluator] ${agent.id}: ${c.ticker} evaluation errored (failing closed to HOLD): ${err.message}`);
      rec = {
        ...rec,
        action: "HOLD",
        targetWeight: 0,
        overrideNotes: [...(rec.overrideNotes ?? []), `evaluator_error (failed closed): ${err.message}`],
      };
      evaluatorState = "error";
      evaluatorVerdict = "error (failed closed)";
      noProposalReason = `evaluator error (failed closed to HOLD): ${err.message}`;
    }
  }

  const rationale = [
    rec.thesis,
    rec.risks.length ? `Risks: ${rec.risks.join("; ")}` : null,
    rec.killCriteria.length ? `Kill criteria: ${rec.killCriteria.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const entryPrice = c.raw?.price?.regularMarketPrice ?? null;
  // The analyst owns the thesis; Kairos governs portfolio fit and Sam remains
  // the approving human. Preserve that accountability in the readable BUY
  // dossier without adding it to the execution/signature surface.
  if (rec.action === "BUY" && rec.buyDossier) {
    rec.buyDossier = {
      ...rec.buyDossier,
      version: 1,
      owner: { agentId: agent.id, label: agent.name },
    };
  }

  // Risk-gated BUY/SELL calls go straight into Sam's approval queue instead of
  // waiting for him to read the Sheet and re-type a proposal by hand. He still
  // approves or rejects every one in the dashboard before anything is placed.
  if (rec.action !== "HOLD" && !canCreateActionableProposal(agent)) {
    const note = `${agent.id} is paper-only; actionable recommendation recorded without creating an approval proposal`;
    rec.overrideNotes = [...(rec.overrideNotes ?? []), `paper_only: ${note}`];
    noProposalReason = note;
    proposalDisposition = "paper_only";
  } else if (rec.action !== "HOLD" && !hasOpenProposal(ctx.openProposals, { agentId: agent.id, ticker: c.ticker, side: rec.action })) {
    if (
      rec.action === "SELL" &&
      hasRecentProposal(ctx.openProposals, {
        agentId: agent.id,
        ticker: c.ticker,
        side: "SELL",
        cooldownDays: ctx.ordinarySellCooldownDays,
      })
    ) {
      rec.overrideNotes = [
        ...(rec.overrideNotes ?? []),
        `ordinary_sell_cooldown: skipped approval proposal because this position had a SELL review within ${ctx.ordinarySellCooldownDays} days`,
      ];
      console.log(
        `[Research] ${agent.id}: SELL ${c.ticker} blocked by ${ctx.ordinarySellCooldownDays}d ordinary sell cooldown.`
      );
      noProposalReason = `ordinary SELL cooldown: this position had a SELL review within ${ctx.ordinarySellCooldownDays} days`;
      proposalDisposition = "blocked";
    } else {
      let sized = sizeProposalAmount({
        action: rec.action,
        targetWeightPct: rec.targetWeight,
        totalPortfolioValue: ctx.totalPortfolioValue,
        // Actual position dollars — SELLs exit what's really held, and BUY
        // increments are computed against the same total-value denominator.
        currentPositionValue:
          rec.action === "SELL"
            ? ctx.ownedPositionValueByTicker[c.ticker] ?? 0
            : ctx.heldAllocation.find((h) => h.ticker === c.ticker)?.marketValue ?? 0,
        cashAvailable: rec.action === "BUY" ? ctx.availableCashForBuys : undefined,
        limits: riskLimits,
      });
      if (!sized) {
        noProposalReason = "sizing produced no proposal (position already at target weight, or nothing held to sell)";
        proposalDisposition = "blocked";
      }

      // Circuit-breaker sizing pass: REDUCE tier halves BUY dollars; blocked tiers
      // were already downgraded pre-evaluator — this is a belt-and-braces recheck.
      if (sized) {
        const breakerGate = applyBreakerToProposal(ctx.breaker.tier, rec.action, sized.amountDollars);
        if (!breakerGate.allowed) {
          console.error(`[Breaker] ${agent.id}: ${rec.action} ${c.ticker} blocked at queue time — ${breakerGate.note}`);
          rec.overrideNotes = [...(rec.overrideNotes ?? []), breakerGate.note];
          sized = null;
          noProposalReason = breakerGate.note;
          proposalDisposition = "blocked";
        } else if (breakerGate.note) {
          rec.overrideNotes = [...(rec.overrideNotes ?? []), breakerGate.note];
          sized = { ...sized, amountDollars: breakerGate.amountDollars };
        }
      }

      if (sized) {
        if (rec.action === "SELL" && rec.sellDossier) {
          rec.sellDossier = {
            ...rec.sellDossier,
            version: 1,
            owner: { agentId: agent.id, label: agent.name },
            positionScope: `Only the proposing specialist's verified ${c.ticker} lots, up to ${ctx.ownedPositionSharesByTicker[c.ticker] ?? 0} shares.`,
          };
        }
        if (sized.starterSized) {
          const slots = Math.max(1, riskLimits.starterPortfolioMaxPositions ?? 2);
          const currentPositions = ctx.heldAllocation.filter((h) => h.shares > 0).length;
          const openStarterBuys = ctx.openProposals.filter(
            (p) =>
              p.agentId === agent.id &&
              p.side === "BUY" &&
              (p.status === "Pending" || (p.status === "ApprovedForBrokerReview" && !p.fulfilledAt))
          ).length;
          if (currentPositions + openStarterBuys >= slots) {
            console.log(
              `[Research] ${agent.id}: starter slots full (${currentPositions} positions + ${openStarterBuys} open BUYs / ${slots}) — skipping ${c.ticker} proposal.`
            );
            // Matches the old loop's `continue`: no recommendation row, no ledger record.
            return {
              recommendation: null,
              researchRecord: null,
              rec,
              createdProposal: null,
              evaluatorVerdict,
              noProposalReason: `starter slots full (${currentPositions} positions + ${openStarterBuys} open BUYs / ${slots}) — proposal skipped`,
              outcomeFacts: {
                attempted: true,
                dataGateBlocked: false,
                dataGateStale: false,
                failureKind: null,
                generatorAction,
                finalAction: rec.action,
                riskOverridden,
                evaluatorState,
                duplicateOpen: isDuplicateOpen,
                proposalDisposition: "blocked",
              },
            };
          }
        }

        const maxPrice = rec.action === "BUY" && entryPrice ? Math.round(entryPrice * 1.02 * 100) / 100 : null;
        const riskSummary = `Quant score ${c.quantScore}/100. Confidence ${rec.confidence ?? "n/a"}. Risk checks: ${
          rec.overrideNotes.length ? rec.overrideNotes.join("; ") : "all passed"
        }.${sized.starterSized ? " Small-account starter sizing used instead of strict target-weight sizing." : ""}${
          sized.clamped ? " Sized amount clamped to the $10,000 proposal cap." : ""
        }${sized.cashClamped ? ` Sized amount capped by idle cash available after accepted, unfilled BUY proposals ($${ctx.availableCashForBuys}).` : ""}${
          rec.action === "BUY" ? ` Idle cash remaining before this proposal: $${ctx.availableCashForBuys}.` : ""
        }`;

        try {
          const cashAvailableBeforeProposal = ctx.availableCashForBuys;
          const created = await createProposal({
            agentId: agent.id,
            ticker: c.ticker,
            side: rec.action,
            amountDollars: sized.amountDollars,
            maxPrice,
            sellOwnerShareLimit: rec.action === "SELL"
              ? ctx.ownedPositionSharesByTicker[c.ticker]
              : null,
            rationale,
            riskSummary,
            buyDossier: rec.action === "BUY" ? rec.buyDossier : undefined,
            sellDossier: rec.action === "SELL" ? rec.sellDossier : undefined,
          });
          if (created) {
            ctx.openProposals.push(created);
            if (created.side === "BUY") {
              ctx.availableCashForBuys = Math.max(0, Math.round((ctx.availableCashForBuys - created.amountDollars) * 100) / 100);
            }
            console.log(`[Research] ${agent.id}: queued ${rec.action} ${c.ticker} proposal ($${sized.amountDollars}).`);
            createdProposal = created;
            proposalDisposition = "created";
            // Observer-only Kairos shadow review. Its record is intentionally
            // isolated from the proposal's status/signature/execution fields;
            // a missing policy or failed shadow write cannot block Sam's queue.
            try {
              const shadow = await recordAgent4ShadowReview({
                proposal: created,
                recommendation: rec,
                context: { ...ctx, cashAvailableBeforeProposal },
              });
              if (shadow.status === "recorded") {
                kairosOutcome = shadow.decision.outcome;
                kairosExplanation = shadow.decision.explanation ?? [];
                console.log(`[Kairos] SHADOW ${shadow.decision.outcome} ${created.side} ${created.ticker}: ${shadow.decision.reasonCodes.join(", ")}`);
              } else {
                console.warn(`[Kairos] Shadow review not recorded for ${created.id}: ${shadow.status}.`);
              }
            } catch (shadowError) {
              console.error(`[Kairos] Shadow review failed for ${created.id}; specialist proposal remains unchanged: ${shadowError.message}`);
            }
          } else {
            // createProposal already screamed (Redis missing / write failure).
            noProposalReason = "proposal could not be written to the approval queue (Redis unavailable — see server logs)";
            proposalDisposition = "queue_error";
          }
        } catch (err) {
          console.warn(`[Research] ${agent.id}: failed to queue proposal for ${c.ticker}:`, err.message);
          noProposalReason = `failed to queue proposal: ${err.message}`;
          proposalDisposition = "queue_error";
        }
      }
    }
  }

  const researchRecord = {
    ticker: c.ticker,
    action: rec.action,
    quantScore: c.quantScore ?? null,
    confidence: rec.confidence ?? null,
    thesis: rec.thesis ?? "",
    entryPrice,
  };

  const recommendation = {
    date: new Date().toISOString().slice(0, 10),
    ticker: c.ticker,
    action: rec.action,
    quantScore: c.quantScore,
    rationale,
    newsLinks: news.map((n) => n.url).join(", "),
    status: "pending",
    entryPrice,
    spyEntryPrice: ctx.spyEntryPrice,
    targetWeight: rec.targetWeight,
    confidence: rec.confidence,
    ruleCheck: rec.overrideNotes.length ? rec.overrideNotes.join("; ") : "OK",
  };

  if (!createdProposal && !noProposalReason) {
    noProposalReason =
      rec.action === "HOLD"
        ? rec.overrideNotes?.length
          ? `HOLD after risk checks: ${rec.overrideNotes.join("; ")}`
          : "model recommended HOLD"
        : "no proposal was queued";
  }
  if (!evaluatorVerdict) evaluatorVerdict = "not run (HOLD before evaluator)";

  return {
    recommendation,
    researchRecord,
    rec,
    createdProposal,
    evaluatorVerdict,
    noProposalReason,
    decisionAudit: {
      runId: ctx.runId,
      agentId: agent.id,
      ticker: c.ticker,
      decidedAt: new Date().toISOString(),
      quantScore: c.quantScore ?? null,
      generatorAction,
      finalAction: rec.action,
      evaluatorState,
      evaluatorVerdict,
      evaluatorCritique,
      proposalDisposition,
      proposalId: createdProposal?.id ?? null,
      reason: noProposalReason,
      ruleCheck: rec.overrideNotes ?? [],
      generatorThesis: proposal.thesis ?? null,
      finalThesis: rec.thesis ?? null,
      rationale,
      requestedTargetWeight: proposal.targetWeight ?? null,
      finalTargetWeight: rec.targetWeight ?? null,
      evaluatorRevisions,
      kairosOutcome,
      kairosExplanation,
    },
    outcomeFacts: {
      attempted: true,
      dataGateBlocked: false,
      dataGateStale: false,
      failureKind: null,
      generatorAction,
      finalAction: rec.action,
      riskOverridden,
      evaluatorState,
      duplicateOpen: isDuplicateOpen,
      proposalDisposition,
    },
  };
}

/**
 * Runs one agent's full scan (quant score -> AI overlay -> risk engine -> write) against
 * its own daily universe (the shared catalog through its mandate screen, or an
 * explicit degraded seed-watchlist rollback), but the SAME shared portfolio/spreadsheet as
 * the other two agents —
 * so risk checks (sector/position-size limits) see real combined exposure across all
 * three agents, and one agent's proposal can be downgraded because of another agent's
 * existing position. One agent's failure doesn't block the others (see runResearchScan).
 */
async function runResearchScanForAgent(
  agent,
  sheets,
  spreadsheetId,
  sheetIds,
  { breaker, boundaryToken, budget, runId, source = "manual", candidateBus = null, runBudgetCapUsd = null, verifiedLots = [] } = {}
) {
  const summary = blankAgentScanSummary(agent.id);
  breaker = breaker ?? { tier: "NONE", drawdownPct: 0 };
  boundaryToken = boundaryToken ?? makeBoundaryToken();
  const evidenceFlags = []; // injection-suspect evidence collected across the run, Telegramed once at the end
  const { watchlist, weights: weightsConfig, riskLimits, personality, universe: universeCfg } = loadAgentConfig(agent.id);
  const catalogMode = resolveAgentCatalogMode(agent.id, universeCfg);
  summary.capacity = {
    allocationPolicyVersion: "equal-agent-run-cap-v1",
    maxUsd: runBudgetCapUsd,
    starting: budget?.snapshot?.() ?? null,
    ending: null,
  };
  const marketScans = await readMarketScans(sheets, spreadsheetId).catch((err) => {
    console.warn(`[Research] ${agent.id}: market scan context unavailable:`, err.message);
    return [];
  });

  // Holdings + research ledger come first now: the candidate slate needs both
  // before the day's universe is even known (catalog-sourced agents).
  const [accountHoldings, strategyNotes] = await Promise.all([
    readHoldingsAllocation(sheets, spreadsheetId),
    readAgentStrategyNotes(sheets, spreadsheetId, agent.id),
  ]);
  const ownedHoldings = projectAgentOwnedHoldings({
    agentId: agent.id,
    lots: verifiedLots,
    holdings: accountHoldings,
  });
  const holdingTickers = ownedHoldings.tickers;
  const heldReturnPct = ownedHoldings.returnPctByTicker;
  const researchLedger = await readResearchLedger(agent.id);

  // For catalog agents the watchlist is no longer the universe — scan names only
  // need to dodge holdings (which the slate already guarantees a review for).
  const scanTickers = selectMarketScanTickers(
    agent.id,
    marketScans,
    catalogMode.effectiveSource === "catalog" ? holdingTickers : watchlist.tickers
  );

  // Day's universe: catalog-sourced agents get a slate narrowed from the full
  // mandate-screened NYSE/NASDAQ catalog (LOOP-DESIGN funnel); explicit rollback
  // or unavailable catalog data uses the visibly degraded seed-list path.
  let universeTickers;
  let explorationTickers = new Set();
  if (catalogMode.effectiveSource === "catalog") {
    const agentBus = candidateBus?.agents?.[agent.id] ?? null;
    const screened = agentBus?.eligible ?? [];
    if (agentBus && screened.length) {
      const { slate, counts } = buildSlate({
        screened,
        holdings: holdingTickers,
        scanTickers,
        ledger: researchLedger,
        config: { ...universeCfg, agentId: agent.id },
      });
      universeTickers = slate.map((s) => s.ticker);
      explorationTickers = new Set(slate.filter((s) => s.bucket === "exploration").map((s) => s.ticker));
      summary.discovery = {
        status: "complete",
        source: "catalog",
        degraded: false,
        reasonCode: null,
        candidateBusVersion: candidateBus.contractVersion,
        catalogSnapshotId: candidateBus.catalogSnapshotId,
        screenPolicyVersion: agentBus.screenPolicyVersion,
        attentionPolicyVersion: agentBus.attentionPolicyVersion,
        visible: agentBus.visibleCount,
        eligible: agentBus.eligibleCount,
        screenedOut: agentBus.rejectedCount,
        counts,
      };
      console.log(
        `[Research] ${agent.id}: slate = ${formatSlateCounts(counts)}; catalog ${agentBus.eligibleCount} eligible / ${agentBus.visibleCount} visible / ${candidateBus.census.listed} listed (${candidateBus.catalogSnapshotId}).`
      );
      // Phase 1 funnel observability (AUTONOMY-ROADMAP): persist the day's slate
      // composition + research-ledger coverage so /health can show the funnel
      // working instead of it living only in the log line above. Counts only —
      // the snapshot surfaces on the unauthenticated /health route.
      await setSlateSnapshot(agent.id, {
        date: new Date().toISOString().slice(0, 10),
        status: "complete",
        degraded: false,
        reasonCode: null,
        source: "catalog",
        candidateBusVersion: candidateBus.contractVersion,
        catalogSnapshotId: candidateBus.catalogSnapshotId,
        screenPolicyVersion: agentBus.screenPolicyVersion,
        attentionPolicyVersion: agentBus.attentionPolicyVersion,
        counts,
        screened: agentBus.eligibleCount,
        screenedOut: agentBus.rejectedCount,
        sectorEnriched: candidateBus.census.classified,
        cataloged: candidateBus.census.listed,
        census: candidateBus.census,
        aiReviewBudget: universeCfg.aiReviewBudget ?? 12,
        ledger: summarizeResearchLedger(researchLedger),
      });
    } else {
      const reasonCode = agentBus ? "catalog_screen_empty" : "catalog_unavailable";
      // A missing/torn catalog may use the seed list, but it must remain
      // explicitly degraded. An intact catalog whose mandate screen produces no
      // eligible names fails closed instead of bypassing that screen.
      console.error(
        `[Research] ${agent.id}: ${reasonCode}${agentBus ? " — no non-holding candidate is eligible; failing closed." : ` — FALLING BACK to seed watchlist (${watchlist.tickers.length} names). Check jobs/universe-refresh.js.`}`
      );
      universeTickers = agentBus
        ? [...new Set(holdingTickers)]
        : [...new Set([...holdingTickers, ...watchlist.tickers, ...scanTickers])];
      summary.discovery = {
        status: "degraded",
        source: agentBus ? "catalog" : "watchlist-fallback",
        degraded: true,
        reasonCode,
        candidateBusVersion: candidateBus?.contractVersion ?? null,
        catalogSnapshotId: candidateBus?.catalogSnapshotId ?? null,
        screenPolicyVersion: agentBus?.screenPolicyVersion ?? null,
        attentionPolicyVersion: agentBus?.attentionPolicyVersion ?? ATTENTION_POLICY_VERSIONS[agent.id],
        visible: agentBus?.visibleCount ?? 0,
        eligible: agentBus?.eligibleCount ?? 0,
        screenedOut: agentBus?.rejectedCount ?? 0,
        counts: { holdings: holdingTickers.length, movers: 0, ranked: 0, exploration: 0 },
      };
      await setSlateSnapshot(agent.id, {
        date: new Date().toISOString().slice(0, 10),
        status: "degraded",
        degraded: true,
        reasonCode,
        source: agentBus ? "catalog" : "watchlist-fallback",
        candidateBusVersion: candidateBus?.contractVersion ?? null,
        catalogSnapshotId: candidateBus?.catalogSnapshotId ?? null,
        screenPolicyVersion: agentBus?.screenPolicyVersion ?? null,
        attentionPolicyVersion: agentBus?.attentionPolicyVersion ?? ATTENTION_POLICY_VERSIONS[agent.id],
        counts: summary.discovery.counts,
        screened: agentBus?.eligibleCount ?? 0,
        screenedOut: agentBus?.rejectedCount ?? 0,
        sectorEnriched: candidateBus?.census?.classified ?? 0,
        cataloged: candidateBus?.census?.listed ?? 0,
        census: candidateBus?.census ?? null,
        aiReviewBudget: universeCfg.aiReviewBudget ?? 12,
        ledger: summarizeResearchLedger(researchLedger),
      });
    }
  } else {
    // A rollback changes discovery input, never holding-monitor obligations.
    universeTickers = [...new Set([...holdingTickers, ...watchlist.tickers, ...scanTickers])];
    summary.discovery = {
      status: catalogMode.degraded ? "degraded" : "legacy",
      source: catalogMode.degraded ? "watchlist-rollback" : "watchlist",
      degraded: catalogMode.degraded,
      reasonCode: catalogMode.reasonCode,
      candidateBusVersion: candidateBus?.contractVersion ?? null,
      catalogSnapshotId: candidateBus?.catalogSnapshotId ?? null,
      screenPolicyVersion: candidateBus?.agents?.[agent.id]?.screenPolicyVersion ?? null,
      attentionPolicyVersion: ATTENTION_POLICY_VERSIONS[agent.id],
      visible: candidateBus?.agents?.[agent.id]?.visibleCount ?? 0,
      eligible: 0,
      screenedOut: 0,
      counts: null,
    };
    await setSlateSnapshot(agent.id, {
      date: new Date().toISOString().slice(0, 10),
      ...summary.discovery,
      cataloged: candidateBus?.census?.listed ?? 0,
      census: candidateBus?.census ?? null,
      aiReviewBudget: universeCfg.aiReviewBudget ?? 12,
      ledger: summarizeResearchLedger(researchLedger),
    });
    console.log(
      `[Research] ${agent.id}: explicit ${summary.discovery.source} mode — scanning ${universeTickers.length} tickers (${watchlist.tickers.length} seed + ${scanTickers.length} Robinhood scan).`
    );
  }

  const fundamentals = await fetchFundamentalsBatch(universeTickers);
  const persistentMemory = formatAgentMemoriesForPrompt(await listAgentMemories(agent.id));

  const dateWindow = makeDateWindow();
  const candidates = [];
  for (const f of fundamentals) {
    if (f.error) {
      console.warn(`[Research] ${agent.id}: skipping ${f.ticker}: ${f.error}`);
      continue;
    }
    candidates.push(await buildCandidate(f, riskLimits, dateWindow));
  }

  // Re-apply the same mandate screen to fresh fundamentals/price candidates.
  // Held names are mandatory monitoring overrides, never entry eligibility.
  const { passed, rejected } = screenCatalogForAgent(agent.id, candidates, riskLimits);
  for (const rejection of rejected) {
    console.log(`[Research] ${agent.id}: screened out ${rejection.ticker} — ${rejection.reason}`);
  }
  const passedTickers = new Set(passed.map((candidate) => candidate.ticker));
  const mandatoryHoldings = candidates.filter(
    (candidate) => holdingTickers.includes(candidate.ticker) && !passedTickers.has(candidate.ticker)
  );
  const eligible = [...passed, ...mandatoryHoldings];
  if (mandatoryHoldings.length) {
    console.warn(
      `[Research] ${agent.id}: ${mandatoryHoldings.length} attributed holding(s) bypassed discovery eligibility for mandatory monitoring only.`
    );
  }
  if (candidates.length > 0 && eligible.length === 0) {
    console.error(`[Research] ${agent.id}: mandate screen rejected every candidate — failing closed with zero eligible names.`);
  }

  const scored = scoreCandidates(eligible, weightsConfig.quant_weights);

  // AI overlay selection under a hard daily budget (cost guardrail). Priority:
  // holdings are ALWAYS reviewed (even past the budget — a held position must
  // never go unwatched because discovery filled the day's slots), then the
  // exploration names the slate reserved, then Robinhood scan signals, then
  // top-quant fill until the budget is spent.
  const aiReviewBudget = Math.max(1, universeCfg.aiReviewBudget ?? 12);
  const toReview = new Map();
  const reviewBuckets = new Map();
  const addToReview = (ticker, { exempt = false, bucket = "ranked" } = {}) => {
    if (toReview.has(ticker)) return;
    if (!exempt && toReview.size >= aiReviewBudget) return;
    const c = scored.find((s) => s.ticker === ticker);
    if (c) {
      toReview.set(ticker, c);
      reviewBuckets.set(ticker, bucket);
    }
  };
  for (const ticker of holdingTickers) addToReview(ticker, { exempt: true, bucket: "holdings" });
  for (const ticker of explorationTickers) addToReview(ticker, { bucket: "exploration" });
  for (const ticker of scanTickers) addToReview(ticker, { bucket: "movers" });
  for (const c of scored) {
    if (toReview.size >= aiReviewBudget) break;
    addToReview(c.ticker);
  }

  // Coverage is a normal part of scheduled research, not a Lab-only escape
  // hatch. Queue the full already-fetched slate before model work so the
  // collector can establish tomorrow's cohorts even when today's top picks lack
  // a peer set.
  const storedPeerMetrics = await getPeerMetrics();
  const peerCoverageQueue = await queuePeerCoverageForCandidates(scored, {
    peerMetrics: storedPeerMetrics,
  });
  if (peerCoverageQueue.queued.length) {
    console.log(`[Research] ${agent.id}: queued peer coverage for ${peerCoverageQueue.queued.length}/${scored.length} slate candidates.`);
  }

  // A scheduled scan is held to the same peer-relative standard as Lab. Do
  // not send a candidate through the model on its old mixed-slate score while
  // its requested cohort is still being collected; it will re-enter tomorrow
  // once the post-scan collector has made the cohort scoreable.
  const peerSelection = selectPeerReadyCandidates({
    primary: [...toReview.values()],
    fallback: scored,
    peerMetrics: storedPeerMetrics,
    limit: toReview.size,
    canUse: (candidate, coverage) => Boolean(scorePeerFundamentals({ candidate, peers: coverage.peers })),
  });
  const peerScoredToReview = new Map();
  // runResearchScanForAgent executes one scheduled agent scan, so this is a
  // one-slot-per-agent-per-scan canary rather than a shared process budget.
  const peerProposalCanary = createScheduledPeerFundamentalProposalCanary({ source });
  for (const { candidate: c, coverage } of peerSelection.selected) {
    const peerScore = scorePeerFundamentals({ candidate: c, peers: coverage.peers });
    if (!peerScore) continue;
    const proposalResearchEligible = peerProposalCanary.claimResearchSlot();
    const peerCohortLabel = `${coverage.peerSetUsed.key ?? coverage.peerSetUsed.level} peer cohort (${coverage.peerCount + 1} names)`;
    peerScoredToReview.set(c.ticker, {
      ...c,
      quantScore: peerScore.quantScore,
      breakdown: peerScore.breakdown,
      quantScoreContext: {
        source: `stored Yahoo/SEC peer fundamentals; ${peerCohortLabel}`,
        description: `normalized rank versus the resolved ${peerCohortLabel}; seven current fundamental fields only (no momentum, estimates, or long-horizon mandate evidence), not a full mandate conviction score`,
        partialPeerFundamentalScreen: true,
        proposalResearchEligible,
      },
      peerFactEvidence: sourcedFact(
        "peer_cohort",
        "Resolved peer cohort",
        `${peerCohortLabel}; ${coverage.peerCount} data-complete peers`,
        "cohort description",
        "stored peer coverage cache (Yahoo fundamentals and SEC-derived metrics)",
      ),
    });
  }
  summary.researchFunnel = {
    schemaVersion: RESEARCH_FUNNEL_RECEIPT_VERSION,
    reviewBudget: aiReviewBudget,
    priorityCandidates: toReview.size,
    exemptHoldingCandidates: [...reviewBuckets.values()].filter((bucket) => bucket === "holdings").length,
    peerReadyCandidates: peerScoredToReview.size,
    deferredPriorityCandidates: peerSelection.deferredPrimary,
    peerReadyBackfillCandidates: peerSelection.backfilled,
    proposalResearchEligibleCandidates: [...peerScoredToReview.values()]
      .filter((candidate) => candidate.quantScoreContext?.proposalResearchEligible === true)
      .length,
  };
  if (peerSelection.deferredPrimary) {
    console.log(`[Research] ${agent.id}: deferred ${peerSelection.deferredPrimary}/${toReview.size} priority candidates pending a scoreable peer cohort; peer-ready backfill added ${peerSelection.backfilled}.`);
  }
  console.log(`[Research] ${agent.id}: running AI overlay for ${peerScoredToReview.size} peer-scored tickers (budget ${aiReviewBudget}, holdings exempt)...`);
  summary.attemptedReviews = peerScoredToReview.size;

  const reviewContext = await buildAgentReviewContext(sheets, spreadsheetId, {
    candidates,
    riskLimits,
    benchmark: watchlist.benchmark,
    heldAllocation: accountHoldings,
  });

  const ctx = {
    ...reviewContext,
    runId,
    riskLimits,
    personality,
    strategyNotes,
    persistentMemory,
    marketScans,
    holdingTickers,
    ownedPositionSharesByTicker: ownedHoldings.positionSharesByTicker,
    ownedPositionValueByTicker: ownedHoldings.positionValueByTicker,
    heldReturnPct,
    researchLedger,
    breaker,
    boundaryToken,
    budget,
    modelCalls: summary.modelCalls,
    evidenceFlags,
    athenaCircuit: createAthenaCircuit(),
    alertedResearchFailures: new Set(),
  };

  const recommendations = [];
  const researchRecords = []; // research-ledger updates, persisted once after the loop
  const decisionAudits = [];
  for (const c of peerScoredToReview.values()) {
    try {
      const { recommendation, researchRecord, createdProposal, decisionAudit, outcomeFacts } = await reviewCandidateForAgent(agent, c, ctx);
      const outcomeKind = classifyRecommendationOutcome(outcomeFacts);
      summary.outcomeCounts = addOutcome(summary.outcomeCounts, outcomeKind);
      if (researchRecord) researchRecords.push(researchRecord);
      decisionAudits.push(decisionAudit ?? {
        runId,
        agentId: agent.id,
        ticker: c.ticker,
        decidedAt: new Date().toISOString(),
        quantScore: c.quantScore ?? null,
        generatorAction: outcomeFacts?.generatorAction ?? null,
        finalAction: outcomeFacts?.finalAction ?? recommendation?.action ?? "NO_TRADE",
        evaluatorState: outcomeFacts?.evaluatorState ?? "not_run",
        proposalDisposition: outcomeFacts?.proposalDisposition ?? "not_applicable",
        reason: recommendation?.rationale ?? "review completed without a proposal",
        rationale: recommendation?.rationale ?? null,
      });
      if (createdProposal) {
        summary.proposalsCreated += 1;
        if (createdProposal.side === "BUY" || createdProposal.side === "SELL") {
          summary.proposalCounts[createdProposal.side] += 1;
        }
      }
      if (recommendation) {
        recommendations.push(recommendation);
        summarizeRecommendation(summary, recommendation);
      }
    } catch (err) {
      // One ticker failing (Anthropic 429/timeout, Yahoo hiccup, EDGAR outage)
      // must not discard every other ticker's finished research — especially
      // since proposals queued earlier in this loop already exist in Redis and
      // would otherwise have no matching recommendation row in the Sheet.
      console.error(`[Research] ${agent.id}: ${c.ticker} failed mid-review (continuing): ${err.message}`);
      const failure = classifyResearchFailure(err);
      if (needsImmediateResearchFailureAlert(failure)) {
        const alertKey = `${agent.id}:${c.ticker}:${failure.kind}`;
        if (!ctx.alertedResearchFailures.has(alertKey)) {
          ctx.alertedResearchFailures.add(alertKey);
          const alert = `🚨 Research review blocked: ${agent.id} ${c.ticker} — ${failure.kind}. No HOLD was recorded as a judgment; the review is marked ERROR. ${failure.message.slice(0, 240)}`;
          try { await sendTelegram(alert); } catch (alertError) { console.error("[Research] immediate failure Telegram alert failed:", alertError.message); }
        }
      }
      const outcomeKind = classifyRecommendationOutcome({
        attempted: true,
        dataGateBlocked: false,
        dataGateStale: false,
        failureKind: ["budget_exhausted", "monthly_budget_exhausted"].includes(failure.kind) ? "budget_exhausted" : "review_error",
        generatorAction: null,
        finalAction: null,
        riskOverridden: false,
        evaluatorState: "not_run",
        duplicateOpen: false,
        proposalDisposition: "not_applicable",
      });
      summary.outcomeCounts = addOutcome(summary.outcomeCounts, outcomeKind);
      const recommendation = {
        date: new Date().toISOString().slice(0, 10),
        ticker: c.ticker,
        action: "ERROR",
        quantScore: c.quantScore ?? null,
        rationale: `${failure.kind}: ${failure.message}`,
        newsLinks: "",
        status: "error",
        entryPrice: c.raw?.price?.regularMarketPrice ?? null,
        spyEntryPrice: ctx.spyEntryPrice,
        targetWeight: 0,
        confidence: null,
        ruleCheck: failure.kind,
      };
      recommendations.push(recommendation);
      summarizeRecommendation(summary, recommendation);
      decisionAudits.push({
        runId,
        agentId: agent.id,
        ticker: c.ticker,
        decidedAt: new Date().toISOString(),
        quantScore: c.quantScore ?? null,
        finalAction: "ERROR",
        evaluatorState: "not_run",
        proposalDisposition: "not_applicable",
        reason: `${failure.kind}: ${failure.message}`,
        rationale: `${failure.kind}: ${failure.message}`,
      });
    }
  }

  assertOutcomeConservation(summary.outcomeCounts, summary.attemptedReviews);

  await appendAgentRecommendations(sheets, spreadsheetId, sheetIds[agentTabName(agent.id)], agent.id, recommendations);
  await appendResearchDecisionAudits(decisionAudits, { redis: getRedis() });
  console.log(`[Research] ${agent.id}: done — wrote ${recommendations.length} recommendations.`);

  // Persist this run's research memory (advisory: rotation + prompt context only,
  // so one write after the loop — a failed run just re-researches sooner).
  await applyResearchRecords(agent.id, researchRecords);

  // Capture the actual completed live-review selection, not the wider candidate
  // slate built before fundamentals, screening, scoring, and the AI budget. This
  // occurs only after both recommendation and research-ledger persistence pass.
  if (catalogMode.requestedSource === "catalog") {
    await setPrivateResearchSlate(
      agent.id,
      buildPrivateResearchSlateItems(peerScoredToReview, reviewBuckets),
      { sourceRunId: runId }
    );
  }

  // Injection-suspect evidence is logged every time, but Telegram only escalates
  // higher-signal cases so routine single-source redactions don't look like bot replies.
  const evidenceSummary = summarizeEvidenceFlags(evidenceFlags);
  if (shouldTelegramEvidenceFlags(evidenceFlags)) {
    const summary = `⚠️ Scheduled research scan safety alert: ${agent.id} flagged ${evidenceSummary.rawCount} evidence item(s) across ${evidenceSummary.uniqueCount} root cause(s): ${formatEvidenceFlagSummary(evidenceSummary)}`;
    try {
      await sendTelegram(summary);
    } catch (err) {
      console.error("[Evidence] Telegram alert failed:", err.message, "—", summary);
    }
  } else if (evidenceFlags.length) {
    console.warn(`[Evidence] ${agent.id}: ${evidenceSummary.rawCount} evidence flag(s) across ${evidenceSummary.uniqueCount} root cause(s) logged without Telegram: ${formatEvidenceFlagSummary(evidenceSummary)}`);
  }
  summary.capacity.ending = budget?.snapshot?.() ?? null;
  summary.completedAt = new Date().toISOString();
  return summary;
}

/**
 * Runs the research scan for one or more agents. Defaults to all registered
 * agents so newly-available cash can collect competing proposals from every desk.
 * Pass agentIds to override for a targeted diagnostic scan.
 */
async function runResearchScanUnlocked({ agentIds = DEFAULT_AGENT_IDS, source = "manual" } = {}) {
  if (source !== "scheduled" && source !== "manual") {
    throw new TypeError("research scan source must be scheduled or manual");
  }
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const agentSummaries = [];
  let terminalStatusPersisted = false;
  // The scheduler receipt needs the run's outcome even when the scan throws —
  // and a `degraded` run DOES throw, by design, so that `ok` stays false and
  // Phase 0 cannot count a partially failed scan as green. A plain `return`
  // therefore never reaches wrapJob in the case we most care about. Capture the
  // classification here and surface it on both paths: returned on success,
  // attached to the Error on the throw path.
  let lastRunOutcome = { outcome: "failed", outcomeReason: "scan_outcome_unrecorded", outcomeDetail: null };
  const persistFinalStatus = async (status, error = null) => {
    const completedAt = new Date().toISOString();
    // Additive truthfulness: `status` keeps its legacy two-value meaning for every
    // existing consumer, while `outcome`/`outcomeReason` say whether the run was
    // clean, partially degraded, or produced no usable research at all. This
    // records the distinction; it does not decide what an observer may count.
    //
    // The aborted-before-classification path matters: this function is also called
    // from the outer catch, where agentSummaries can be empty. An empty roster
    // classifies as `ok`, which would be a lie on a run that threw — so a legacy
    // `failed` status always wins over an `ok` classification.
    const classified = classifyResearchRunOutcome(agentSummaries);
    const abortedBeforeClassification = status === "failed" && classified.outcome === "ok";
    lastRunOutcome = {
      outcome: abortedBeforeClassification ? "failed" : classified.outcome,
      outcomeReason: abortedBeforeClassification ? "scan_aborted_before_classification" : classified.reason,
      outcomeDetail: classified.detail,
    };
    const terminalStatus = {
      runId,
      source,
      status,
      startedAt,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      agents: agentSummaries,
      totals: agentSummaries.reduce(
        (acc, agent) => ({
          recommendationsWritten: acc.recommendationsWritten + agent.recommendationsWritten,
          attemptedReviews: acc.attemptedReviews + agent.attemptedReviews,
          proposalsCreated: acc.proposalsCreated + agent.proposalsCreated,
          scanErrors: acc.scanErrors + agent.scanErrors,
          budgetExhaustions: acc.budgetExhaustions + agent.budgetExhaustions,
          evaluatorRejects: acc.evaluatorRejects + agent.evaluatorRejects,
          outcomeCounts: Object.fromEntries(
            Object.keys(acc.outcomeCounts).map((kind) => [kind, acc.outcomeCounts[kind] + (agent.outcomeCounts?.[kind] ?? 0)])
          ),
        }),
        {
          recommendationsWritten: 0,
          attemptedReviews: 0,
          proposalsCreated: 0,
          scanErrors: 0,
          budgetExhaustions: 0,
          evaluatorRejects: 0,
          outcomeCounts: blankOutcomeCounts(),
        }
      ),
      classificationVersion: RESEARCH_OUTCOME_VERSION,
      ...lastRunOutcome,
      error,
    };
    await setResearchScanStatus(terminalStatus);
    terminalStatusPersisted = true;
    if (source === "scheduled") {
      try {
        await setAgentParityRuntimeSummary(buildAgentParityRuntimeSummary(terminalStatus));
      } catch (telemetryError) {
        // The independently retained scheduler terminal receipt is written only
        // after this function returns. Missing runtime telemetry stays visible
        // as absent/stale health evidence but cannot rewrite an already-retained
        // terminal scan outcome into a conflicting status.
        console.error("[Research] Agent parity runtime telemetry failed:", telemetryError.message);
      }
    }
  };

  await setResearchScanStatus({
    runId,
    source,
    status: "running",
    startedAt,
    completedAt: null,
    agents: [],
    classificationVersion: RESEARCH_OUTCOME_VERSION,
    error: null,
  });

  try {
    // Request a refresh of the shared Market Scans tab before any agent reads it.
    // Scan movers are refreshed by the Mac execution companion using only its
    // read-only Robinhood MCP. Jetson intentionally has no direct broker-login
    // credentials, so research always proceeds against the last completed
    // snapshot rather than attempting a legacy Python login or waiting here.
    try {
      const { queued } = await requestMcpMarketScan();
      console.log(`[Research] Market scan refresh ${queued ? "requested from" : "already pending for"} Mac MCP companion.`);
    } catch (err) {
      console.warn("[Research] Could not request Mac MCP market scan refresh — continuing with last completed snapshot:", err.message);
    }

    const { sheets, drive } = getServiceAccountClients();
    const spreadsheetId = await resolveSharedSpreadsheetId(sheets, drive);
    const sheetIds = await getSheetIds(sheets, spreadsheetId);
    // Verified operational-ledger read. A signature failure stops the scan
    // before any agent can infer ownership or size a SELL from untrusted lots.
    const verifiedLots = await readAllLots(sheets, spreadsheetId);

    // System-wide gates computed ONCE per run, before any agent: the drawdown
    // circuit breaker (restricts what any agent may queue) and the per-run
    // boundary token for untrusted-evidence fencing.
    const breaker = await resolveCircuitBreaker(sheets, spreadsheetId);
    const boundaryToken = makeBoundaryToken();
    const monthlyBudget = createAnthropicMonthlyBudget();
    // Frozen agents are excluded even when named explicitly (CLI diagnostics),
    // so a freeze cannot be bypassed by a targeted run.
    const requestedAgents = AGENTS.filter((a) => agentIds.includes(a.id));
    for (const agent of requestedAgents.filter((a) => !isResearchActive(a))) {
      console.warn(`[Research] ${agent.id} is frozen (researchStatus=${agent.researchStatus}) — skipped; no research or proposals this run.`);
    }
    const activeAgents = requestedAgents.filter(isResearchActive);
    if (!activeAgents.length) throw new Error("No research-active agents to scan; all requested agents are frozen or unknown.");
    const catalog = await getUniverseCatalog();
    let candidateBus = null;
    if (catalog && Object.keys(catalog).length) {
      try {
        candidateBus = buildLiveResearchCandidateBus({
          catalog,
          agentConfigs: Object.fromEntries(
            activeAgents.map((agent) => {
              const config = loadAgentConfig(agent.id);
              return [agent.id, { riskLimits: config.riskLimits, universe: config.universe }];
            })
          ),
        });
      } catch (error) {
        console.error(`[Research] shared candidate bus failed closed: ${error.message}`);
      }
    } else {
      console.error("[Research] shared candidate bus unavailable: universe catalog is empty or unreadable.");
    }

    const totalRunMaxUsd = Number(process.env.RESEARCH_RUN_MAX_USD);
    const fairCaps = allocateFairAgentRunCaps(
      // Partition over every registered agent, not just active ones, so a
      // freeze cuts spend instead of handing the frozen share to agent-1.
      AGENTS.map((agent) => agent.id),
      Number.isFinite(totalRunMaxUsd) && totalRunMaxUsd > 0 ? totalRunMaxUsd : 3
    );
    const agentBudgets = new Map(
      activeAgents.map((agent) => {
        const cap = fairCaps[agent.id];
        return [
          agent.id,
          createResearchRunBudget({
            env: { ...process.env, RESEARCH_RUN_MAX_USD: String(cap) },
            monthlyBudget,
            onWarning: ({ reservedUsd, maxUsd }) =>
              sendTelegram(
                `⚠️ Research API budget for ${agent.id} is ${Math.round((reservedUsd / maxUsd) * 100)}% reserved ($${reservedUsd.toFixed(2)} of $${maxUsd.toFixed(2)}).`
              ).catch((err) => console.error("[Research] Budget warning Telegram failed:", err.message)),
          }),
        ];
      })
    );

    for (const agent of activeAgents) {
      try {
        const summary = await runResearchScanForAgent(agent, sheets, spreadsheetId, sheetIds, {
          breaker,
          boundaryToken,
          budget: agentBudgets.get(agent.id),
          runId,
          source,
          candidateBus,
          runBudgetCapUsd: fairCaps[agent.id],
          verifiedLots,
        });
        agentSummaries.push(summary);
      } catch (err) {
        console.error(`[Research] ${agent.id} failed:`, err.message);
        agentSummaries.push({
          ...blankAgentScanSummary(agent.id),
          status: "failed",
          completedAt: new Date().toISOString(),
          error: err.message,
        });
      }
    }
    const status = agentSummaries.some(
      (agent) => agent.status === "failed" || researchOutcomeCountsHaveFailures(agent.outcomeCounts)
    ) ? "failed" : "completed";
    await persistFinalStatus(status, status === "failed" ? "One or more agents failed. See per-agent status." : null);
    if (status === "failed") {
      // Persisting a failed status alone is insufficient: the scheduler's own
      // invocation receipt must be failed so Phase 0 cannot count it green.
      // The outcome rides on the Error so the receipt can still distinguish a
      // `degraded` run (some reviews succeeded) from a total `failed` one.
      throw Object.assign(
        new Error("One or more research agents failed; see persisted per-agent status."),
        lastRunOutcome,
      );
    }
    return { status, agents: agentSummaries, ...lastRunOutcome };
  } catch (err) {
    console.error("[Research] Scan failed before completion:", err.message);
    // A failed terminal status is intentionally followed by a throw so the
    // scheduler receipt cannot count the invocation as green. Do not append a
    // second, differently fingerprinted terminal record for the same run.
    if (!terminalStatusPersisted) {
      await persistFinalStatus("failed", err.message);
    }
    // Carry the outcome on the rethrown error too. Only fill fields the error
    // does not already have: an error thrown from the branch above already
    // carries the correctly classified outcome, and overwriting it here with a
    // later classification would lose the distinction.
    if (err && typeof err === "object" && err.outcome === undefined) Object.assign(err, lastRunOutcome);
    throw err;
  }
}

export async function runResearchScan(options) {
  return withWorkflowLock("research", () => runResearchScanUnlocked(options), { ttlSeconds: 45 * 60 });
}

/**
 * Lab entry point (dashboard Lab → POST /research-ticker in server.js): run the
 * FULL research pipeline for one ticker, one agent, on demand — circuit breaker
 * and boundary token resolved first exactly like a scheduled run, then the same
 * reviewCandidateForAgent() code path the scan uses (this is an extra entry
 * point, not a parallel pipeline). Leaves the same audit trail as the scan
 * (recommendation row on the agent's tab + research-ledger record) and queues a
 * properly-sized proposal into Sam's approval queue only if the candidate clears
 * every gate. Throws on unusable input/data — the HTTP layer records the error.
 *
 * Returns { ticker, agentId, quantScore, rec, recommendation, createdProposal,
 * evaluatorVerdict, noProposalReason } for lib/lab-research.js buildLabOutcome().
 */
async function researchTickerForAgentUnlocked(agentId, ticker) {
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Unknown agentId: ${agentId}`);
  if (!isResearchActive(agent)) throw new Error(`${agent.id} is frozen: research and new proposals are paused.`);
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!symbol) throw new Error("ticker is required");

  const { watchlist, weights: weightsConfig, riskLimits, personality } = loadAgentConfig(agent.id);

  const { sheets, drive } = getServiceAccountClients();
  const spreadsheetId = await resolveSharedSpreadsheetId(sheets, drive);
  const sheetIds = await getSheetIds(sheets, spreadsheetId);

  // Same system-wide gates as the scheduled scan, resolved before any review.
  const breaker = await resolveCircuitBreaker(sheets, spreadsheetId);
  const boundaryToken = makeBoundaryToken();
  const evidenceFlags = [];
  const monthlyBudget = createAnthropicMonthlyBudget();
  const budget = createResearchRunBudget({
    monthlyBudget,
    onWarning: ({ reservedUsd, maxUsd }) => sendTelegram(`⚠️ Lab research API budget is ${Math.round((reservedUsd / maxUsd) * 100)}% reserved ($${reservedUsd.toFixed(2)} of $${maxUsd.toFixed(2)}).`).catch((err) => console.error("[Research] Lab budget warning Telegram failed:", err.message)),
  });

  const marketScans = await readMarketScans(sheets, spreadsheetId).catch((err) => {
    console.warn(`[Research] ${agent.id}: market scan context unavailable:`, err.message);
    return [];
  });
  const [accountHoldings, verifiedLots, strategyNotes] = await Promise.all([
    readHoldingsAllocation(sheets, spreadsheetId),
    readAllLots(sheets, spreadsheetId),
    readAgentStrategyNotes(sheets, spreadsheetId, agent.id),
  ]);
  const ownedHoldings = projectAgentOwnedHoldings({ agentId: agent.id, lots: verifiedLots, holdings: accountHoldings });
  const holdingTickers = ownedHoldings.tickers;
  const heldReturnPct = ownedHoldings.returnPctByTicker;
  const researchLedger = await readResearchLedger(agent.id);

  const [fundamentals] = await fetchFundamentalsBatch([symbol]);
  if (!fundamentals || fundamentals.error) {
    throw new Error(`No usable market data for ${symbol}: ${fundamentals?.error ?? "no fundamentals returned"}`);
  }
  const candidateRaw = await buildCandidate(fundamentals, riskLimits, makeDateWindow());

  // A Lab request may expand the data-coverage queue, but must never score a
  // company against itself while its cohort is absent. This is intentionally a
  // coverage outcome, not an investment HOLD, and runs before any model call.
  const peerMetrics = await getPeerMetrics();
  const peerCoverage = assessPeerCoverage({
    ticker: symbol,
    industry: fundamentals.industry ?? null,
    sector: fundamentals.sector ?? null,
    peerMetrics,
  });
  if (!peerCoverage.ready) {
    await requestPeerCoverage({
      ticker: symbol,
      industry: fundamentals.industry ?? null,
      sector: fundamentals.sector ?? null,
      source: "lab",
    });
    const reason = `research coverage pending: ${peerCoverage.reason}; ${peerCoverage.peerCount} data-complete peers (${peerCoverage.peerSetUsed.level ?? "unclassified"})`;
    return {
      ticker: symbol,
      agentId: agent.id,
      quantScore: null,
      rec: null,
      recommendation: {
        ticker: symbol,
        action: "NO_TRADE",
        quantScore: null,
        rationale: `NO_TRADE (${reason})`,
        confidence: null,
        ruleCheck: `peer_coverage_pending: ${peerCoverage.reason}`,
      },
      createdProposal: null,
      evaluatorVerdict: "not run (peer coverage pending)",
      noProposalReason: reason,
    };
  }

  // Lab is an alternate entry point, not an escape hatch from any mandate.
  // This agent-specific path stops before proposal generation on screen failure.
  {
    const { rejected } = screenCatalogForAgent(agent.id, [candidateRaw], riskLimits);
    if (rejected.length && !holdingTickers.includes(symbol)) {
      const reason = rejected.map((r) => r.reason).join("; ");
      console.log(`[Research] ${agent.id}: NO_TRADE ${symbol} — ${reason}`);
      return {
        recommendation: {
          date: new Date().toISOString().slice(0, 10),
          ticker: symbol,
          action: "HOLD",
          quantScore: null,
          rationale: `NO_TRADE (universe gate): ${reason}`,
          newsLinks: "",
          status: "blocked",
          entryPrice: candidateRaw.raw?.price?.regularMarketPrice ?? null,
          spyEntryPrice: null,
          targetWeight: 0,
          confidence: null,
          ruleCheck: `universe_gate_blocked: ${reason}`,
        },
        researchRecord: {
          ticker: symbol,
          action: "NO_TRADE",
          quantScore: null,
          confidence: null,
          thesis: `NO_TRADE (universe gate): ${reason}`,
          entryPrice: candidateRaw.raw?.price?.regularMarketPrice ?? null,
        },
        rec: null,
        createdProposal: null,
        evaluatorVerdict: "not run (universe gate)",
        noProposalReason: `NO_TRADE (universe gate): ${reason}`,
      };
    }
  }

  // Never normalize a Lab ticker against itself. This cohort score is useful
  // research evidence, but it is intentionally not a fabricated full mandate
  // score: the proposal policy below forces HOLD until that separate evidence
  // package is complete.
  const peerScore = scorePeerFundamentals({
    candidate: { ...candidateRaw, ticker: symbol },
    peers: peerCoverage.peers,
  });
  if (!peerScore) {
    throw new Error(`Peer coverage was marked ready for ${symbol}, but no peer-fundamental score could be built`);
  }
  const peerCohortLabel = `${peerCoverage.peerSetUsed.key ?? peerCoverage.peerSetUsed.level} peer cohort (${peerCoverage.peerCount + 1} names)`;
  const candidate = {
    ...candidateRaw,
    quantScore: peerScore.quantScore,
    breakdown: peerScore.breakdown,
    quantScoreContext: {
      source: `stored Yahoo/SEC peer fundamentals; ${peerCohortLabel}`,
      description: `normalized rank versus the resolved ${peerCohortLabel}; seven current fundamental fields only (no momentum, estimates, or long-horizon mandate evidence), not a full mandate conviction score`,
      partialPeerFundamentalScreen: true,
      // The dashboard Lab is a separate, human-invoked workflow. It never
      // consumes or bypasses the scheduled per-agent proposal canary.
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

  const persistentMemory = formatAgentMemoriesForPrompt(await listAgentMemories(agent.id));
  const reviewContext = await buildAgentReviewContext(sheets, spreadsheetId, {
    candidates: [candidate],
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
    holdingTickers,
    ownedPositionSharesByTicker: ownedHoldings.positionSharesByTicker,
    ownedPositionValueByTicker: ownedHoldings.positionValueByTicker,
    heldReturnPct,
    researchLedger,
    breaker,
    boundaryToken,
    evidenceFlags,
    athenaCircuit: createAthenaCircuit(),
    budget,
  };

  const result = await reviewCandidateForAgent(agent, candidate, ctx);

  // Same output paths as the scheduled scan (Sheet row + research ledger). A
  // failed Sheet write must not strand an already-queued proposal or lose the
  // lab outcome, so it is LOUD but not fatal.
  if (result.recommendation) {
    try {
      await appendAgentRecommendations(sheets, spreadsheetId, sheetIds[agentTabName(agent.id)], agent.id, [result.recommendation]);
    } catch (err) {
      console.error(`[Research] ${agent.id}: LAB RUN failed to write recommendation row for ${symbol} (proposal state unaffected): ${err.message}`);
    }
  }
  if (result.researchRecord) {
    try {
      await applyResearchRecords(agent.id, [result.researchRecord]);
    } catch (err) {
      console.error(`[Research] ${agent.id}: LAB RUN failed to update research ledger for ${symbol}: ${err.message}`);
    }
  }

  const evidenceSummary = summarizeEvidenceFlags(evidenceFlags);
  if (shouldTelegramEvidenceFlags(evidenceFlags)) {
    const summary = `⚠️ Lab research safety alert: ${agent.id} flagged ${evidenceSummary.rawCount} evidence item(s) across ${evidenceSummary.uniqueCount} root cause(s) on ${symbol}: ${formatEvidenceFlagSummary(evidenceSummary)}`;
    try {
      await sendTelegram(summary);
    } catch (err) {
      console.error("[Evidence] Telegram alert failed:", err.message, "—", summary);
    }
  } else if (evidenceFlags.length) {
    console.warn(`[Evidence] ${agent.id}: ${evidenceSummary.rawCount} evidence flag(s) across ${evidenceSummary.uniqueCount} root cause(s) logged without Telegram: ${formatEvidenceFlagSummary(evidenceSummary)}`);
  }

  return {
    ticker: symbol,
    agentId: agent.id,
    quantScore: candidate.quantScore ?? null,
    rec: result.rec,
    recommendation: result.recommendation,
    createdProposal: result.createdProposal,
    evaluatorVerdict: result.evaluatorVerdict,
    noProposalReason: result.noProposalReason,
  };
}

export async function researchTickerForAgent(agentId, ticker) {
  return withWorkflowLock(
    "research",
    () => researchTickerForAgentUnlocked(agentId, ticker),
    { ttlSeconds: 15 * 60 }
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const cliAgentIds = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  runResearchScan({
    source: "manual",
    ...(cliAgentIds.length ? { agentIds: cliAgentIds } : {}),
  }).catch((e) => {
    console.error("[Research] Scan error:", e.message);
    process.exit(1);
  });
}
