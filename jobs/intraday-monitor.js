/**
 * Intraday monitor — runs every 30 minutes during market hours (10 AM–3:30 PM ET Mon-Fri).
 * Also runs at 9:35 AM ET for the opening check and at 3:50 PM ET for the pre-close check.
 *
 * Three things it does on every tick:
 *
 * 1. Price alerts — checks Redis for stored target-price alerts (e.g. "buy NVDA if it
 *    drops below $185"). When triggered it queues a BUY/SELL proposal and removes the alert.
 *
 * 2. Holding surveillance — checks every verified strategy-owned position.
 *    Agent One lots run its simplified intraday ATR stop and may queue a SELL
 *    proposal. Agents Two and Three receive the same live quote/momentum
 *    surveillance but never inherit Agent One's mandate-specific ATR rule.
 *
 * 3. Momentum break — flags positions where intraday price is down >3% from open, logged
 *    for awareness but not auto-proposed (that needs context the AI overlay provides).
 */

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { fetchQuotes, fetchDailyBars } from "../lib/yahoo.js";
import { atr } from "../lib/indicators.js";
import { listPriceAlerts, checkAlerts, removePriceAlert } from "../lib/price-alerts.js";
import { listAllProposals, createProposal, wasProposalNudged, markProposalNudged } from "../lib/redis.js";
import { hasOpenProposal } from "../lib/proposal-sizing.js";
import { selectExpiringProposals, formatExpiryNudge } from "../lib/proposal-nudge.js";
import { buildHoldingMonitorCoverage } from "../lib/holding-monitor-coverage.js";
import { holdingMarketSeriesIsFresh } from "../lib/holding-mandate-evidence.js";
import {
  initializeSpecialistHoldingCoverage,
  projectSpecialistMonitorHoldings,
  specialistExitPolicyMode,
} from "../lib/holding-monitor-ownership.js";
import { sendMessage as sendTelegram } from "../lib/telegram.js";
import { withWorkflowLock } from "../lib/workflow-lock.js";
import { researchTickerForAgent } from "./research-scan.js";
import { AGENTS } from "../config/agents.js";
import { isResearchActive } from "../lib/research-run-health.js";
import {
  getServiceAccountClients,
  resolveSharedSpreadsheetId,
  readAllLots,
  readHoldingsAllocation,
} from "../lib/sheets.js";

// Price alerts carry their own agentId. Holding exits always use verified lot ownership.

export function initializeIntradayHoldingCoverage(allocation) {
  const validHeld = allocation.filter((holding) => Number.isFinite(holding.shares) && holding.shares > 0);
  const invalidHeld = allocation.filter((holding) => holding.shares !== 0
    && (!Number.isFinite(holding.shares) || holding.shares < 0));
  const coverage = { monitored: 0, degraded: 0, failed: invalidHeld.length, reasons: {} };
  if (invalidHeld.length) coverage.reasons.invalid_held_shares = invalidHeld.length;
  return { validHeld, invalidHeld, coverage };
}

export function recordIntradayQuoteBatchFailure(validHeld, coverage) {
  coverage.degraded += validHeld.length;
  if (validHeld.length) coverage.reasons.quote_batch_unavailable = validHeld.length;
  return buildHoldingMonitorCoverage({
    expected: coverage.monitored + coverage.degraded + coverage.failed,
    ...coverage,
  });
}

export function recordIntradayProposalQueueFailure(coverage) {
  coverage.failed += 1;
  coverage.reasons.exit_proposal_queue_failure = (coverage.reasons.exit_proposal_queue_failure ?? 0) + 1;
}

async function runIntradayMonitorUnlocked({ context = "intraday" } = {}) {
  console.log(`[Intraday] Starting ${context} check...`);

  const { sheets, drive } = getServiceAccountClients();
  const spreadsheetId = await resolveSharedSpreadsheetId(sheets, drive);

  const [allocation, verifiedLots, openProposals, priceAlerts] = await Promise.all([
    readHoldingsAllocation(sheets, spreadsheetId),
    readAllLots(sheets, spreadsheetId),
    listAllProposals(),
    listPriceAlerts(),
  ]);

  const ownership = projectSpecialistMonitorHoldings({ holdings: allocation, lots: verifiedLots });
  const validHeld = ownership.positions;
  const expectedHeldCount = validHeld.length + ownership.quarantined.length;
  const coverage = initializeSpecialistHoldingCoverage(ownership);
  const heldTickers = validHeld.map((h) => h.ticker);
  const note = (reason) => { coverage.reasons[reason] = (coverage.reasons[reason] ?? 0) + 1; };
  const result = () => ({
    holdingMonitoring: buildHoldingMonitorCoverage({ expected: expectedHeldCount, ...coverage }),
  });
  const allTickers = [...new Set([...heldTickers, ...priceAlerts.map((a) => a.ticker)])];

  // Fetch current prices for everything we care about
  let quotes = {};
  try {
    quotes = await fetchQuotes(allTickers);
  } catch (e) {
    console.warn("[Intraday] Quote fetch failed:", e.message);
    return { holdingMonitoring: recordIntradayQuoteBatchFailure(validHeld, coverage) };
  }

  const priceMap = {};
  for (const [ticker, q] of Object.entries(quotes)) {
    priceMap[ticker] = q?.regularMarketPrice ?? null;
  }

  // ── 1. Price alerts ──────────────────────────────────────────────────────────
  const triggered = checkAlerts(priceAlerts, priceMap);
  for (const alert of triggered) {
    const price = priceMap[alert.ticker];
    console.log(
      `[Intraday] ALERT triggered: ${alert.ticker} ${alert.direction} $${alert.targetPrice} (current $${price})`
    );

    const agentLabel = alert.agentId ? `Agent ${alert.agentId.split("-")[1]}` : "Agent";
    // A frozen agent's alert stays stored (not consumed) so it resumes on unfreeze.
    const alertAgent = AGENTS.find((agent) => agent.id === alert.agentId);
    if (alertAgent && !isResearchActive(alertAgent)) {
      console.log(`[Intraday] ${alert.ticker}: alert owned by frozen ${alert.agentId} — not researched; alert kept.`);
      continue;
    }
    try {
      const result = await researchTickerForAgent(alert.agentId, alert.ticker);
      const finalAction = result.rec?.action ?? result.recommendation?.action ?? "NO_TRADE";
      const proposalText = result.createdProposal
        ? `proposal ${result.createdProposal.id} queued`
        : result.noProposalReason ?? "no proposal created";
      console.log(`[Intraday] ${alert.ticker}: canonical alert research returned ${finalAction} — ${proposalText}.`);
      await removePriceAlert(alert.id);

      try {
        const msg =
          `Price alert evaluated\n` +
          `${agentLabel} | ${alert.ticker}\n` +
          `${alert.direction === "below" ? "Below" : "Above"} $${alert.targetPrice}; now $${price}\n` +
          (alert.note ? `Note: ${alert.note}\n` : "") +
          `Canonical pipeline: ${finalAction} | ${proposalText}`;
        await sendTelegram(msg);
      } catch (e) {
        console.warn("[Intraday] Telegram notification failed:", e.message);
      }
    } catch (e) {
      console.error(`[Intraday] Alert research failed for ${alert.ticker}; keeping alert active for retry:`, e.message);
    }
  }

  if (!triggered.length) console.log("[Intraday] No price alerts triggered.");

  // ── 2. Intraday ATR stop check on held positions ─────────────────────────────
  if (heldTickers.length === 0) {
    console.log("[Intraday] No held positions to check ATR stops.");
  }

  const now = new Date();
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(now.getMonth() - 3);

  for (const pos of validHeld) {
    const price = priceMap[pos.ticker];
    if (!price) {
      coverage.degraded += 1;
      note("quote_unavailable");
      continue;
    }

    if (specialistExitPolicyMode(pos.agentId) !== "agent_one_atr_intraday") {
      console.log(
        `[Intraday] ${pos.agentId} ${pos.ticker}: live quote surveillance complete; ` +
        "Agent One ATR exit rule not applicable."
      );
      coverage.monitored += 1;
      continue;
    }

    try {
      const bars = await fetchDailyBars(pos.ticker, { period1: threeMonthsAgo, period2: now });
      if (bars.length < 20) {
        coverage.degraded += 1;
        note("insufficient_price_history");
        continue;
      }
      if (!holdingMarketSeriesIsFresh(bars, now.toISOString())) {
        coverage.degraded += 1;
        note("stale_price_history");
        continue;
      }

      const recentBars = bars.slice(-20);
      const high20 = Math.max(...recentBars.map((b) => b.high));
      const atrVal = atr(bars, 14);
      const stopLevel = Math.round((high20 - atrVal * 1.5) * 100) / 100;
      if (!Number.isFinite(pos.costBasis) || pos.costBasis <= 0) {
        coverage.degraded += 1;
        note("owned_cost_basis_unavailable");
        continue;
      }
      const ownerMarketValue = pos.shares * price;
      const returnP = ((ownerMarketValue - pos.costBasis) / pos.costBasis) * 100;

      console.log(
        `[Intraday] ${pos.ticker}: price $${price} | 20-day high $${high20.toFixed(2)} | ATR stop $${stopLevel} | return ${returnP.toFixed(1)}%`
      );

      if (price < stopLevel && returnP < 0) {
        // Only flag ATR stop breach on a losing position (memo: no averaging down, quick exit)
        console.log(`[Intraday] ${pos.ticker}: ATR stop breached at $${price} (stop $${stopLevel}) — flagging for exit.`);

        if (!hasOpenProposal(openProposals, { agentId: pos.agentId, ticker: pos.ticker, side: "SELL" })) {
          const ownerNotional = Math.round(ownerMarketValue * 100) / 100;
          let created = null;
          try {
            created = await createProposal({
              agentId: pos.agentId,
              ticker: pos.ticker,
              side: "SELL",
              amountDollars: ownerNotional,
              maxPrice: null,
              sellOwnerShareLimit: pos.shares,
              rationale: `Intraday ATR stop breach: ${pos.ticker} at $${price} is below ATR stop $${stopLevel} (20-day high $${high20.toFixed(2)} − 1.5×ATR $${atrVal.toFixed(2)}). Position is at a loss (${returnP.toFixed(1)}%). Agent One memo requires fast exit.`,
              riskSummary: `ATR stop triggered intraday. Full exit signal analysis will run at 4:45 PM ET exit monitor.`,
            });
          } catch (error) {
            console.error(`[Intraday] ${pos.ticker}: exit proposal queue failed:`, error.message);
          }
          if (!created) {
            recordIntradayProposalQueueFailure(coverage);
            continue;
          }
          openProposals.push(created);
          console.log(`[Intraday] Queued SELL ${pos.ticker} $${ownerNotional} from ATR stop breach.`);
        }
      }
      coverage.monitored += 1;
    } catch (e) {
      console.warn(`[Intraday] ATR check failed for ${pos.ticker}:`, e.message);
      coverage.degraded += 1;
      note("price_history_unavailable");
    }
  }

  // ── 3. Momentum break flag (informational) ───────────────────────────────────
  for (const ticker of heldTickers) {
    const q = quotes[ticker];
    if (!q) continue;
    const open = q.regularMarketOpen;
    const current = q.regularMarketPrice;
    if (!open || !current) continue;
    const intraChange = (current - open) / open;
    if (intraChange <= -0.03) {
      console.log(
        `[Intraday] MOMENTUM FLAG ${ticker}: down ${(intraChange * 100).toFixed(1)}% from open ($${open} → $${current}) — watch closely.`
      );
    }
  }

  // ── 4. Approval-queue expiry nudge (F-2026-003) ──────────────────────────────
  // Pending proposals silently lapse 48h after creation; Telegram once per
  // proposal as it enters its final 24h so decisions stop expiring unseen.
  // Marked nudged only AFTER a successful send, so a Telegram failure retries
  // on the next tick instead of losing the nudge.
  try {
    const expiring = selectExpiringProposals(openProposals);
    const toNudge = [];
    for (const p of expiring) {
      if (!(await wasProposalNudged(p.id))) toNudge.push(p);
    }
    if (toNudge.length) {
      await sendTelegram(formatExpiryNudge(toNudge));
      for (const p of toNudge) await markProposalNudged(p.id);
      console.log(`[Intraday] Nudged ${toNudge.length} proposal(s) nearing expiry.`);
    }
  } catch (e) {
    console.error("[Intraday] Expiry nudge failed:", e.message);
  }

  console.log(`[Intraday] ${context} check complete.`);
  const summary = result();
  console.log(
    `[Intraday] holding coverage — ${summary.holdingMonitoring.monitored} monitored, ` +
    `${summary.holdingMonitoring.degraded} explicitly degraded, ` +
    `${summary.holdingMonitoring.failed} failed of ${summary.holdingMonitoring.expected}.`
  );
  return summary;
}

// A manual dashboard trigger must never overlap a scheduled check: both can
// create alert-driven research or exit proposals. Redis makes this exclusion
// hold across PM2 restarts and future multi-process operation.
export async function runIntradayMonitor(options = {}) {
  return withWorkflowLock("intraday-monitor", () => runIntradayMonitorUnlocked(options), { ttlSeconds: 20 * 60 });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runIntradayMonitor({ context: "manual" }).catch((e) => {
    console.error("[Intraday] Error:", e.message);
    process.exit(1);
  });
}
