import { createHash, randomUUID } from "crypto";
import { Redis } from "@upstash/redis";
// Shared cross-repo contract (see contracts/README.md). Keep the proposal
// expiry + ticker rule single-source so backend, dashboard, and companion agree.
import {
  BuyDossierSchema,
  SellDossierSchema,
  CURRENT_PROPOSAL_CONTRACT_VERSION,
  PROPOSAL_EXPIRY_MS,
  TICKER_RE,
} from "../contracts/proposal.js";
import { signOperationalLedgerEntry, operationalLedgerEntryHmacMatches, getOperationalLedgerSecret } from "./operational-ledger.js";
import { shadowWriteProposal } from "./pg/dual-write.js";
import { notifyProposalCreated } from "./proposal-telegram.js";
import {
  RESEARCH_DATA_STATUS_FIELDS,
  RESEARCH_SLATE_BUCKET_SET,
  SHADOW_SELECTION_REASON_CODE_SET,
  SHADOW_SELECTION_STATUS_FIELDS,
} from "./research-status-contract.js";
import { toPublicAgentParityRuntimeSummary } from "./agent-parity-runtime-summary.js";

let _redis = null;

export function getRedis() {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    if (!url || !token) return null; // gracefully skip if not configured
    _redis = new Redis({ url, token });
  }
  return _redis;
}

// Single shared spreadsheet for the whole portfolio (one Robinhood account, one
// investor pool, one set of Holdings/Performance/Trade Ledger/Lots/Investors tabs).
// Agents still each get their own internal tab (see lib/sheets.js agentTabName),
// but that's a tab within this same spreadsheet, not a separate spreadsheet ID.
export async function getCachedSharedSpreadsheetId() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get("pm:shared:spreadsheet-id");
  } catch (e) {
    console.warn("[Redis] Failed to get shared spreadsheet id:", e.message);
    return null;
  }
}

export async function setCachedSharedSpreadsheetId(id) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set("pm:shared:spreadsheet-id", id);
  } catch (e) {
    console.warn("[Redis] Failed to set shared spreadsheet id:", e.message);
  }
}

// Tracks the last successfully-processed Robinhood order timestamp, so each
// holdings-sync run only asks robinhood-sync.py for fills since then.
export async function getLastFillSyncAt() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get("pm:last-fill-sync-at");
  } catch (e) {
    console.warn("[Redis] Failed to get last fill sync timestamp:", e.message);
    return null;
  }
}

export async function setLastFillSyncAt(iso) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set("pm:last-fill-sync-at", iso);
  } catch (e) {
    console.warn("[Redis] Failed to set last fill sync timestamp:", e.message);
  }
}

// Mirrors config/tax.json's reserveRatePct into Redis so the dashboard (a
// separate Vercel deployment with no filesystem access to this repo's config)
// can show the same withdrawal tax-reserve estimate without duplicating config.
export async function setCachedTaxReserveRatePct(rate) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set("pm:tax:reserve-rate-pct", rate);
  } catch (e) {
    console.warn("[Redis] Failed to set tax reserve rate:", e.message);
  }
}

// Robinhood sync failure streak — consecutive robinhood-sync.py failures. The
// legacy Python sync breaks periodically (device challenges, session drift) and
// used to only log; the streak lets holdings-sync Telegram once it's clearly
// broken instead of alerting on every transient blip (RISK_REGISTER #7).
const SYNC_FAILURE_STREAK_KEY = "pm:robinhood-sync:failure-streak";

export async function bumpRobinhoodSyncFailureStreak() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.incr(SYNC_FAILURE_STREAK_KEY);
  } catch (e) {
    console.warn("[Redis] Failed to bump robinhood-sync failure streak:", e.message);
    return null;
  }
}

export async function clearRobinhoodSyncFailureStreak() {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(SYNC_FAILURE_STREAK_KEY);
  } catch (e) {
    console.warn("[Redis] Failed to clear robinhood-sync failure streak:", e.message);
  }
}

// Latest candidate-slate composition per agent — Phase 1 funnel observability
// (docs/roadmaps/AUTONOMY-ROADMAP.md): lets /health show the four slate buckets and the
// research-ledger coverage without grepping scan logs. Counts only, never
// tickers — the snapshot is surfaced on the unauthenticated /health route.
const SLATE_SNAPSHOT_PREFIX = "pm:slate:latest:";
const SLATE_SNAPSHOT_TTL = 7 * 24 * 3600;
// Private, bounded slate input for advisory shadow comparison. Unlike the
// aggregate snapshot above, this is never read by /health or any public route.
const PRIVATE_RESEARCH_SLATE_PREFIX = "pm:research-slate:private:";
const PRIVATE_RESEARCH_SLATE_TTL = 2 * 24 * 3600;
// Single-sourced with the shadow-selection baseline validator; see
// RESEARCH_SLATE_BUCKET_SET in lib/research-status-contract.js.
const PRIVATE_SLATE_BUCKETS = RESEARCH_SLATE_BUCKET_SET;

export async function setSlateSnapshot(agentId, snapshot) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(
      `${SLATE_SNAPSHOT_PREFIX}${agentId}`,
      JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }),
      { ex: SLATE_SNAPSHOT_TTL }
    );
  } catch (e) {
    console.warn(`[Redis] Failed to set slate snapshot for ${agentId}:`, e.message);
  }
}

export async function getSlateSnapshot(agentId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${SLATE_SNAPSHOT_PREFIX}${agentId}`);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn(`[Redis] Failed to get slate snapshot for ${agentId}:`, e.message);
    return null;
  }
}

export async function setPrivateResearchSlate(agentId, items, { sourceRunId, redis = getRedis(), now = () => new Date() } = {}) {
  if (!redis) return null;
  if (!Array.isArray(items)) throw new TypeError("private research slate items must be an array");
  const normalizedSourceRunId = String(sourceRunId ?? "").trim();
  if (!normalizedSourceRunId) throw new TypeError("private research slate sourceRunId is required");
  const capturedAt = now().toISOString();
  const seen = new Set();
  const normalized = items.map((item) => {
    const ticker = String(item?.ticker ?? "").trim().toUpperCase();
    const bucket = String(item?.bucket ?? "").trim();
    if (!TICKER_RE.test(ticker) || !PRIVATE_SLATE_BUCKETS.has(bucket)) throw new TypeError("private research slate item is invalid");
    if (seen.has(ticker)) throw new TypeError(`private research slate contains duplicate ticker: ${ticker}`);
    seen.add(ticker);
    return { agentId, ticker, bucket };
  });
  try {
    const payload = { agentId, sourceRunId: normalizedSourceRunId, capturedAt, items: normalized };
    await redis.set(`${PRIVATE_RESEARCH_SLATE_PREFIX}${agentId}`, JSON.stringify(payload), { ex: PRIVATE_RESEARCH_SLATE_TTL });
    return payload;
  } catch (error) {
    console.warn(`[Redis] Failed to set private research slate for ${agentId}:`, error.message);
    return null;
  }
}

export async function getPrivateResearchSlate(agentId, { redis = getRedis() } = {}) {
  if (!redis) return null;
  try {
    const raw = await redis.get(`${PRIVATE_RESEARCH_SLATE_PREFIX}${agentId}`);
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  } catch (error) {
    console.warn(`[Redis] Failed to get private research slate for ${agentId}:`, error.message);
    return null;
  }
}

// "What did the system last do" — the dashboard sidebar's answer to that
// question, reusing the pm:job:<name>:last-run keys scheduler.js already
// writes via wrapJob() for every cron (no new instrumentation). PM runs as
// scheduled jobs rather than a 24/7 loop, so unlike a live activity feed, the
// single most-recently-finished job across the whole roster is the honest
// signal. Keep in sync with scheduler.js's wrapJob() call sites if a job is
// added/renamed/removed.
const SYSTEM_JOBS = {
  "premarket-check": "Premarket check",
  "holdings-sync": "Holdings sync",
  "order-reconciliation": "Order reconciliation",
  "intraday-monitor": "Intraday monitor",
  "exit-monitor": "Exit monitor",
  "research-scan": "Research scan",
  "performance-review": "Performance review",
  "verify-ledgers": "Ledger verification",
  "system-sentinel": "System sentinel",
  "universe-refresh": "Universe refresh",
  "weekly-review": "Weekly review",
  "investor-weekly-update": "Investor update",
};

export async function getLastSystemActivity() {
  const redis = getRedis();
  if (!redis) return null;
  const names = Object.keys(SYSTEM_JOBS);
  try {
    const raw = await redis.mget(...names.map((name) => `pm:job:${name}:last-run`));
    let latest = null;
    names.forEach((name, i) => {
      const value = raw[i];
      if (!value) return;
      const run = typeof value === "string" ? JSON.parse(value) : value;
      if (!run?.ts) return;
      if (!latest || run.ts > latest.ts) latest = { job: name, label: SYSTEM_JOBS[name], ...run };
    });
    return latest;
  } catch (e) {
    console.warn("[Redis] Failed to get last system activity:", e.message);
    return null;
  }
}

// Investor-facing weekly updates are stored per investor so the dashboard can
// show the same update that was emailed without exposing another investor's
// capital account or activity.
const INVESTOR_UPDATE_TTL = 90 * 24 * 3600;

function investorUpdateKey(investorId) {
  return `pm:investor-update:latest:${investorId}`;
}

export async function setInvestorUpdate(investorId, update) {
  const redis = getRedis();
  if (!redis || !investorId || !update) return;
  try {
    await redis.set(investorUpdateKey(investorId), JSON.stringify(update), { ex: INVESTOR_UPDATE_TTL });
  } catch (e) {
    console.warn(`[Redis] Failed to store investor update for ${investorId}:`, e.message);
  }
}

export async function getInvestorUpdate(investorId) {
  const redis = getRedis();
  if (!redis || !investorId) return null;
  try {
    const raw = await redis.get(investorUpdateKey(investorId));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn(`[Redis] Failed to read investor update for ${investorId}:`, e.message);
    return null;
  }
}

// Proposal expiry nudges — dedupe marker so each Pending proposal gets exactly
// one "about to expire" Telegram (F-2026-003: proposals were lapsing unseen).
const PROPOSAL_NUDGE_PREFIX = "pm:proposal-nudge:";
const PROPOSAL_NUDGE_TTL = 3 * 24 * 3600; // outlives the proposal's own 48h expiry

export async function wasProposalNudged(proposalId) {
  const redis = getRedis();
  if (!redis) return false;
  try {
    return Boolean(await redis.get(`${PROPOSAL_NUDGE_PREFIX}${proposalId}`));
  } catch (e) {
    console.warn(`[Redis] Failed to check nudge marker for ${proposalId}:`, e.message);
    return false;
  }
}

export async function markProposalNudged(proposalId) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`${PROPOSAL_NUDGE_PREFIX}${proposalId}`, "1", { ex: PROPOSAL_NUDGE_TTL });
  } catch (e) {
    console.warn(`[Redis] Failed to set nudge marker for ${proposalId}:`, e.message);
  }
}

// Approval queue — same Redis keys the dashboard's lib/proposals.ts writes/reads,
// so a fill can be matched back to the specific agent proposal Sam approved for it.
const PROPOSALS_LIST_KEY = "pm:approval_proposals";
// PROPOSAL_EXPIRY_MS is imported from the shared contract (48h).
const RESEARCH_SCAN_STATUS_KEY = "pm:research-scan:latest";
const RESEARCH_SCAN_HISTORY_KEY = "pm:research-scan:history";
const RESEARCH_SCAN_TTL = 14 * 24 * 3600;
const RESEARCH_SCAN_HISTORY_MAX = 50;
const RESEARCH_SCAN_HISTORY_RUN_PREFIX = "pm:research-scan:history-run:";
const APPEND_RESEARCH_TERMINAL = `
local existing = redis.call("get", KEYS[1])
if existing then
  if existing == ARGV[1] then return 0 end
  return -1
end
redis.call("lpush", KEYS[2], ARGV[2])
redis.call("ltrim", KEYS[2], 0, tonumber(ARGV[3]))
redis.call("expire", KEYS[2], tonumber(ARGV[4]))
redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[4]))
return 1
`;
const AGENT_PARITY_RUNTIME_LATEST_KEY = "pm:agent-parity-runtime:latest";
const AGENT_PARITY_RUNTIME_HISTORY_KEY = "pm:agent-parity-runtime:history";
const AGENT_PARITY_RUNTIME_RUN_PREFIX = "pm:agent-parity-runtime:history-run:";
const AGENT_PARITY_RUNTIME_TTL = 14 * 24 * 3600;
const AGENT_PARITY_RUNTIME_HISTORY_MAX = 50;
const APPEND_AGENT_PARITY_RUNTIME = `
local existing = redis.call("get", KEYS[1])
if existing then
  if existing == ARGV[1] then
    redis.call("set", KEYS[3], ARGV[2], "EX", tonumber(ARGV[4]))
    return 0
  end
  return -1
end
redis.call("lpush", KEYS[2], ARGV[2])
redis.call("ltrim", KEYS[2], 0, tonumber(ARGV[3]))
redis.call("expire", KEYS[2], tonumber(ARGV[4]))
redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[4]))
redis.call("set", KEYS[3], ARGV[2], "EX", tonumber(ARGV[4]))
return 1
`;
const RESEARCH_DATA_STATUS_KEY = "pm:research-data:status";
const RESEARCH_DATA_STATUS_TTL = 8 * 24 * 3600;
const SHADOW_SELECTION_STATUS_KEY = "pm:research-selection:status";
const SHADOW_SELECTION_STATUS_TTL = 8 * 24 * 3600;
function normalizeShadowReasonCodeCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => SHADOW_SELECTION_REASON_CODE_SET.has(key) && Number.isInteger(count) && count >= 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function proposalKeyFor(id) {
  return `pm:approval_proposal:${id}`;
}

// A Pending proposal that's sat undecided for 48h is stale — flips it to Expired
// (persisted, mirrors portfolio-dashboard's lib/proposals.ts expiry) so it stops
// blocking hasOpenProposal() and stops showing as actionable in the approval queue.
// Decided/fulfilled proposals never expire.
async function expireProposalIfNeeded(proposal, redis) {
  if (!proposal || proposal.status !== "Pending") return proposal;
  const expiresAt = proposal.expiresAt ?? new Date(Date.parse(proposal.createdAt) + PROPOSAL_EXPIRY_MS).toISOString();
  if (Date.now() < Date.parse(expiresAt)) return proposal;
  const expired = { ...proposal, status: "Expired", expiresAt, updatedAt: new Date().toISOString() };
  try {
    await redis.set(proposalKeyFor(expired.id), JSON.stringify(expired));
    await shadowWriteProposal(expired);
  } catch (e) {
    console.warn(`[Redis] Failed to persist expiry for proposal ${expired.id}:`, e.message);
  }
  return expired;
}

export async function getProposalById(proposalId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(proposalKeyFor(proposalId));
    const proposal = typeof raw === "string" ? JSON.parse(raw) : raw;
    return proposal ? await expireProposalIfNeeded(proposal, redis) : proposal;
  } catch (e) {
    console.warn(`[Redis] Failed to get proposal ${proposalId}:`, e.message);
    return null;
  }
}

export async function listOpenApprovedProposals(limit = 250) {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const ids = await redis.lrange(PROPOSALS_LIST_KEY, 0, limit - 1);
    const proposals = await Promise.all(
      ids.map((id) =>
        redis
          .get(proposalKeyFor(id))
          .then((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw))
          .catch(() => null)
      )
    );
    return proposals.filter((p) => p && p.status === "ApprovedForBrokerReview" && !p.fulfilledAt);
  } catch (e) {
    console.warn("[Redis] Failed to list approved proposals:", e.message);
    return [];
  }
}

export function applyProposalFulfillment(proposal, tradeId, now = new Date().toISOString(), fulfilledShares = undefined) {
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.status !== "ApprovedForBrokerReview") throw new Error("Proposal is not approved.");
  if (proposal.fulfilledAt && proposal.fulfilledTradeId !== tradeId && proposal.fulfilledOrderId !== tradeId) {
    throw new Error("Proposal is already fulfilled.");
  }
  const fulfilled = {
    ...proposal,
    fulfilledAt: now,
    fulfilledTradeId: tradeId,
    // The dashboard's AllocationProposal type reads fulfilledOrderId — write both
    // names so a backend-fulfilled proposal doesn't render as "fulfilled, no order"
    // in the UI (known cross-repo schema drift).
    fulfilledOrderId: tradeId,
    executionState: null,
    updatedAt: now,
  };
  if (fulfilledShares !== undefined) fulfilled.fulfilledShares = Number(fulfilledShares);
  return fulfilled;
}

export async function markProposalFulfilled(proposalId, tradeId, now = new Date().toISOString(), fulfilledShares = undefined) {
  const redis = getRedis();
  if (!redis) throw new Error("Redis is not configured.");
  try {
    const raw = await redis.get(proposalKeyFor(proposalId));
    const proposal = typeof raw === "string" ? JSON.parse(raw) : raw;
    const fulfilled = applyProposalFulfillment(proposal, tradeId, now, fulfilledShares);
    await redis.set(proposalKeyFor(proposalId), JSON.stringify(fulfilled));
    await shadowWriteProposal(fulfilled);
    return fulfilled;
  } catch (e) {
    throw new Error(`Failed to mark proposal ${proposalId} fulfilled: ${e.message}`);
  }
}

const PROPOSALS_MAX = 250; // mirrors portfolio-dashboard's lib/proposals.ts MAX_PROPOSALS

export async function listAllProposals(limit = PROPOSALS_MAX) {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const ids = await redis.lrange(PROPOSALS_LIST_KEY, 0, limit - 1);
    const proposals = await Promise.all(
      ids.map((id) =>
        redis
          .get(proposalKeyFor(id))
          .then((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw))
          .then((proposal) => (proposal ? expireProposalIfNeeded(proposal, redis) : proposal))
          .catch(() => null)
      )
    );
    return proposals.filter(Boolean);
  } catch (e) {
    console.warn("[Redis] Failed to list proposals:", e.message);
    return [];
  }
}

/**
 * Queues a research agent's risk-gated BUY/SELL straight into the same approval
 * queue the dashboard's /approvals page reads — Sam still approves or rejects
 * each one there before anything is placed on Robinhood. Mirrors the validation
 * portfolio-dashboard's lib/proposals.ts applies on its POST /api/proposals route,
 * since this writes to the identical Redis schema from a different repo.
 */
export async function createProposal({
  agentId,
  ticker,
  side,
  amountDollars,
  maxPrice,
  rationale,
  riskSummary,
  sellOwnerShareLimit = null,
  buyDossier = undefined,
  sellDossier = undefined,
}, {
  redis = getRedis(),
  notify = notifyProposalCreated,
} = {}) {
  if (!redis) {
    // This is the research pipeline's OUTPUT — losing it silently is the
    // historic "scan ran, zero proposals, nobody noticed" failure mode.
    console.error(
      `[Redis] NOT CONFIGURED (UPSTASH_REDIS_REST_URL/TOKEN missing) — proposal DROPPED: ${agentId} ${side} $${amountDollars} ${ticker}`
    );
    return null;
  }

  if (!ticker || !TICKER_RE.test(ticker)) throw new Error(`Invalid ticker for proposal: ${ticker}`);
  if (side !== "BUY" && side !== "SELL") throw new Error(`Invalid side for proposal: ${side}`);
  if (!Number.isFinite(amountDollars) || amountDollars <= 0) throw new Error(`Invalid amountDollars for proposal: ${amountDollars}`);
  if (!rationale || !rationale.trim()) throw new Error("Proposal rationale is required.");
  if (side === "BUY" && buyDossier != null) BuyDossierSchema.parse(buyDossier);
  if (side === "SELL" && sellDossier != null) SellDossierSchema.parse(sellDossier);
  if (side === "SELL" && (!Number.isFinite(sellOwnerShareLimit) || sellOwnerShareLimit <= 0)) {
    throw new Error("A SELL proposal requires the proposing agent's verified open-lot share ceiling.");
  }

  const now = new Date().toISOString();
  const proposal = {
    id: randomUUID(),
    agentId,
    ticker,
    side,
    amountDollars: Math.round(amountDollars * 100) / 100,
    maxPrice: maxPrice != null ? Math.round(maxPrice * 100) / 100 : null,
    proposalContractVersion: CURRENT_PROPOSAL_CONTRACT_VERSION,
    sellOwnerShareLimit: side === "SELL"
      ? Math.round(sellOwnerShareLimit * 1e8) / 1e8
      : null,
    rationale: rationale.trim(),
    riskSummary: (riskSummary ?? "").trim() || "Generated by automated research scan; no manager risk note added.",
    ...(buyDossier != null ? { buyDossier: BuyDossierSchema.parse(buyDossier) } : {}),
    ...(sellDossier != null ? { sellDossier: SellDossierSchema.parse(sellDossier) } : {}),
    status: "Pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + PROPOSAL_EXPIRY_MS).toISOString(),
    createdByUserId: "system:research-scan",
    createdByEmail: null,
    decidedAt: null,
    decidedByUserId: null,
    decisionNote: null,
    fulfilledAt: null,
    fulfilledTradeId: null,
    fulfilledOrderId: null,
    fulfilledShares: null,
    decisionHmac: null,
  };

  try {
    await redis.set(proposalKeyFor(proposal.id), JSON.stringify(proposal));
    await redis.lpush(PROPOSALS_LIST_KEY, proposal.id);
    await redis.ltrim(PROPOSALS_LIST_KEY, 0, PROPOSALS_MAX - 1);
    // Dual-write shadow (ADR 0001): OFF unless PG_DUAL_WRITE=true; never throws
    // into this path. Redis stays authoritative until parity clears.
    await shadowWriteProposal(proposal);
    // A phone notification must never hold the live risk/proposal loop hostage.
    // The shared Telegram client has its own 5s network timeout, and detaching
    // here also makes injected/custom senders incapable of stalling this path.
    void Promise.resolve()
      .then(() => notify(proposal))
      .then((delivered) => {
        if (delivered === false) console.error(`[Telegram] Proposal ${proposal.id} was queued but Telegram is not configured.`);
      })
      .catch((error) => {
        console.error(`[Telegram] Proposal ${proposal.id} was queued but its phone notification failed: ${error.message}`);
      });
    return proposal;
  } catch (e) {
    console.warn(`[Redis] Failed to create proposal for ${agentId} ${side} ${ticker}:`, e.message);
    return null;
  }
}

function stableResearchJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableResearchJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableResearchJson(value[key])}`).join(",")}}`;
}

export async function setAgentParityRuntimeSummary(summary, {
  redis = getRedis(),
  now = () => new Date(),
} = {}) {
  if (!redis) throw new Error("Redis is required to persist agent parity runtime telemetry.");
  const projected = toPublicAgentParityRuntimeSummary({
    ...summary,
    updatedAt: now().toISOString(),
  });
  if (!projected) throw new TypeError("agent parity runtime telemetry is invalid");
  const fingerprint = createHash("sha256")
    .update(stableResearchJson({ ...projected, updatedAt: null }))
    .digest("hex");
  const markerKey = `${AGENT_PARITY_RUNTIME_RUN_PREFIX}${encodeURIComponent(projected.runId)}`;
  const result = await redis.eval(
    APPEND_AGENT_PARITY_RUNTIME,
    [markerKey, AGENT_PARITY_RUNTIME_HISTORY_KEY, AGENT_PARITY_RUNTIME_LATEST_KEY],
    [
      fingerprint,
      JSON.stringify(projected),
      String(AGENT_PARITY_RUNTIME_HISTORY_MAX - 1),
      String(AGENT_PARITY_RUNTIME_TTL),
    ]
  );
  if (Number(result) === -1) {
    throw new Error(`Conflicting agent parity runtime telemetry for runId ${projected.runId}.`);
  }
  return {
    appended: Number(result) === 1,
    deduplicated: Number(result) === 0,
    runId: projected.runId,
    payload: projected,
  };
}

export async function getAgentParityRuntimeSummary({ redis = getRedis() } = {}) {
  if (!redis) return null;
  try {
    const raw = await redis.get(AGENT_PARITY_RUNTIME_LATEST_KEY);
    const value = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    return toPublicAgentParityRuntimeSummary(value);
  } catch (error) {
    console.warn("[Redis] Failed to get agent parity runtime telemetry:", error.message);
    return null;
  }
}

export async function appendResearchScanTerminalStatus(payload, { redis = getRedis() } = {}) {
  if (!redis) throw new Error("Redis is required to persist research scan history.");
  const runId = String(payload?.runId ?? "").trim();
  if (!runId) throw new Error("A terminal research scan status requires runId.");
  const { updatedAt: _updatedAt, ...identity } = payload;
  const fingerprint = createHash("sha256").update(stableResearchJson(identity)).digest("hex");
  const markerKey = `${RESEARCH_SCAN_HISTORY_RUN_PREFIX}${encodeURIComponent(runId)}`;
  const result = await redis.eval(
    APPEND_RESEARCH_TERMINAL,
    [markerKey, RESEARCH_SCAN_HISTORY_KEY],
    [fingerprint, JSON.stringify(payload), String(RESEARCH_SCAN_HISTORY_MAX - 1), String(RESEARCH_SCAN_TTL)]
  );
  if (Number(result) === -1) throw new Error(`Conflicting terminal research status for runId ${runId}.`);
  return { appended: Number(result) === 1, deduplicated: Number(result) === 0, runId };
}

export async function setResearchScanStatus(status, { redis = getRedis(), now = () => new Date() } = {}) {
  if (!redis) {
    console.error("[Redis] NOT CONFIGURED — research scan status could not be recorded.");
    return { recorded: false, reason: "redis_not_configured" };
  }
  const payload = { ...status, updatedAt: now().toISOString() };
  try {
    let history = null;
    if (payload.status === "completed" || payload.status === "failed") {
      history = await appendResearchScanTerminalStatus(payload, { redis });
    }
    await redis.set(RESEARCH_SCAN_STATUS_KEY, JSON.stringify(payload), { ex: RESEARCH_SCAN_TTL });
    return { recorded: true, history };
  } catch (e) {
    console.error("[Redis] Failed to set research scan status:", e.message);
    throw e;
  }
}

export async function getResearchScanStatus() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(RESEARCH_SCAN_STATUS_KEY);
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn("[Redis] Failed to get research scan status:", e.message);
    return null;
  }
}

export async function listResearchScanHistory({ limit = RESEARCH_SCAN_HISTORY_MAX, redis = getRedis() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > RESEARCH_SCAN_HISTORY_MAX) {
    throw new TypeError(`research scan history limit must be between 1 and ${RESEARCH_SCAN_HISTORY_MAX}`);
  }
  if (!redis) throw new Error("Redis is required to read research scan history.");
  const rows = await redis.lrange(RESEARCH_SCAN_HISTORY_KEY, 0, limit - 1);
  if (!Array.isArray(rows)) throw new Error("Research scan history is unreadable.");
  return rows.map((row) => {
    if (row && typeof row === "object") return row;
    try {
      return JSON.parse(String(row));
    } catch {
      throw new Error("Research scan history contains invalid JSON.");
    }
  });
}

// Aggregate-only status for the advisory research-data pipeline. Projecting to
// a fixed allow-list prevents accidental publication of ticker, rationale, or
// error payloads through the unauthenticated /health endpoint.
export async function setResearchDataStatus(status, { redis = getRedis(), now = () => new Date() } = {}) {
  if (!redis) return null;
  const payload = Object.fromEntries(RESEARCH_DATA_STATUS_FIELDS
    .filter((field) => status?.[field] !== undefined)
    .map((field) => [field, status[field]]));
  if (Object.hasOwn(payload, "selectionReasonCodeCounts")) {
    payload.selectionReasonCodeCounts = normalizeShadowReasonCodeCounts(payload.selectionReasonCodeCounts);
  }
  payload.updatedAt = now().toISOString();
  try {
    await redis.set(RESEARCH_DATA_STATUS_KEY, JSON.stringify(payload), { ex: RESEARCH_DATA_STATUS_TTL });
    return payload;
  } catch (e) {
    console.warn("[Redis] Failed to set research-data status:", e.message);
    return null;
  }
}

export async function getResearchDataStatus({ redis = getRedis() } = {}) {
  if (!redis) return null;
  try {
    const raw = await redis.get(RESEARCH_DATA_STATUS_KEY);
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn("[Redis] Failed to get research-data status:", e.message);
    return null;
  }
}

// Bounded aggregate latest view only. This intentionally excludes selected
// tickers, evidence, rationales, holdings, and any durable payload fields.
export async function setShadowSelectionStatus(status, { redis = getRedis(), now = () => new Date() } = {}) {
  if (!redis) return null;
  const payload = Object.fromEntries(SHADOW_SELECTION_STATUS_FIELDS
    .filter((field) => status?.[field] !== undefined)
    .map((field) => [field, status[field]]));
  if (Object.hasOwn(payload, "reasonCodeCounts")) payload.reasonCodeCounts = normalizeShadowReasonCodeCounts(payload.reasonCodeCounts);
  payload.updatedAt = now().toISOString();
  try {
    await redis.set(SHADOW_SELECTION_STATUS_KEY, JSON.stringify(payload), { ex: SHADOW_SELECTION_STATUS_TTL });
    return payload;
  } catch (error) {
    console.warn("[Redis] Failed to set shadow-selection status:", error.message);
    return null;
  }
}

export async function getShadowSelectionStatus({ redis = getRedis() } = {}) {
  if (!redis) return null;
  try {
    const raw = await redis.get(SHADOW_SELECTION_STATUS_KEY);
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  } catch (error) {
    console.warn("[Redis] Failed to get shadow-selection status:", error.message);
    return null;
  }
}

export async function getCachedPortfolioTotalValue() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get("pm:portfolio:total-value");
    return raw != null ? Number(raw) : null;
  } catch (e) {
    console.warn("[Redis] Failed to get cached portfolio total value:", e.message);
    return null;
  }
}

export async function setCachedPortfolioTotalValue(value) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set("pm:portfolio:total-value", value);
  } catch (e) {
    console.warn("[Redis] Failed to set cached portfolio total value:", e.message);
  }
}

const MARKET_SCANS_KEY = "pm:market-scans:latest";
const MARKET_SCANS_STATUS_KEY = "pm:market-scans:status";
const MARKET_SCANS_TTL = 24 * 3600;

export async function getCachedMarketScans() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(MARKET_SCANS_KEY);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn("[Redis] Failed to get cached market scans:", e.message);
    return null;
  }
}

export async function setCachedMarketScans(payload) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(MARKET_SCANS_KEY, JSON.stringify(payload), { ex: MARKET_SCANS_TTL });
  } catch (e) {
    console.warn("[Redis] Failed to cache market scans:", e.message);
  }
}

export async function getMarketScanStatus() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(MARKET_SCANS_STATUS_KEY);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn("[Redis] Failed to get market scan status:", e.message);
    return null;
  }
}

export async function setMarketScanStatus(status) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(MARKET_SCANS_STATUS_KEY, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }), { ex: MARKET_SCANS_TTL });
  } catch (e) {
    console.warn("[Redis] Failed to set market scan status:", e.message);
  }
}

// Circuit breaker state (lib/circuit-breaker.js) — high-water mark + last tier,
// persisted so drawdown is measured across restarts and tier CHANGES can Telegram.
const HWM_KEY = "pm:hwm:portfolio";
const BREAKER_STATE_KEY = "pm:breaker:state";

export async function getPortfolioHighWaterMark() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(HWM_KEY);
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn("[Redis] Failed to get portfolio high-water mark:", e.message);
    return null;
  }
}

export async function setPortfolioHighWaterMark({ value, basis, dailyRows, ledgerHighWaterMark, lastIntegrityAlertKey }) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const record = { value, basis, updatedAt: new Date().toISOString() };
    if (Number.isInteger(dailyRows) && dailyRows >= 0) record.dailyRows = dailyRows;
    if (Number.isFinite(ledgerHighWaterMark) && ledgerHighWaterMark > 0) record.ledgerHighWaterMark = ledgerHighWaterMark;
    if (typeof lastIntegrityAlertKey === "string" && lastIntegrityAlertKey) {
      record.lastIntegrityAlertKey = lastIntegrityAlertKey;
    }
    await redis.set(HWM_KEY, JSON.stringify(record));
  } catch (e) {
    console.warn("[Redis] Failed to set portfolio high-water mark:", e.message);
  }
}

export async function getBreakerState() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(BREAKER_STATE_KEY);
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn("[Redis] Failed to get breaker state:", e.message);
    return null;
  }
}

export async function setBreakerState(state) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(BREAKER_STATE_KEY, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.warn("[Redis] Failed to set breaker state:", e.message);
  }
}

// Weekly review artifacts — scorecards + lessons per ISO week, so the dashboard
// (or a future monthly job) can read what the weekly loop concluded.
export async function setWeeklyReviewArtifact(isoWeek, artifact) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`pm:weekly-review:${isoWeek}`, JSON.stringify(artifact), { ex: 90 * 24 * 3600 });
  } catch (e) {
    console.warn("[Redis] Failed to store weekly review artifact:", e.message);
  }
}

export async function getWeeklyReviewArtifact(isoWeek) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`pm:weekly-review:${isoWeek}`);
    return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    console.warn("[Redis] Failed to read weekly review artifact:", e.message);
    return null;
  }
}

// News dedup — avoid re-fetching Tavily results for the same ticker within a day
const NEWS_CACHE_TTL = 12 * 3600;

export async function getCachedNews(ticker) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`pm:news:${ticker}`);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn("[Redis] Failed to get cached news:", e.message);
    return null;
  }
}

export async function setCachedNews(ticker, results) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`pm:news:${ticker}`, JSON.stringify(results), { ex: NEWS_CACHE_TTL });
  } catch (e) {
    console.warn("[Redis] Failed to cache news:", e.message);
  }
}

// Universe catalog (lib/universe.js) — several thousand entries, so it's stored
// in chunks to stay under Upstash request-size limits regardless of plan tier.
// Persistent (no TTL): a missed nightly refresh must not erase weeks of paced
// sector enrichment. pm:universe:status is small and informational.
const UNIVERSE_META_KEY = "pm:universe:meta";
const UNIVERSE_CHUNK_PREFIX = "pm:universe:catalog:";
const UNIVERSE_STATUS_KEY = "pm:universe:status";
const UNIVERSE_CHUNK_SIZE = 1000;

export async function getUniverseCatalog() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const metaRaw = await redis.get(UNIVERSE_META_KEY);
    const meta = typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;
    if (!meta?.chunks) return null;
    const chunks = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) =>
        redis.get(`${UNIVERSE_CHUNK_PREFIX}${i}`).then((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw))
      )
    );
    const catalog = {};
    for (const chunk of chunks) {
      if (!chunk) return null; // missing chunk = torn write — treat as no catalog rather than a silently partial one
      Object.assign(catalog, chunk);
    }
    return catalog;
  } catch (e) {
    console.warn("[Redis] Failed to get universe catalog:", e.message);
    return null;
  }
}

export async function setUniverseCatalog(catalog) {
  const redis = getRedis();
  if (!redis) {
    console.error("[Redis] NOT CONFIGURED — universe catalog NOT persisted; scans will fall back to seed watchlists.");
    return;
  }
  try {
    const tickers = Object.keys(catalog).sort();
    const chunkCount = Math.max(1, Math.ceil(tickers.length / UNIVERSE_CHUNK_SIZE));
    for (let i = 0; i < chunkCount; i++) {
      const chunk = {};
      for (const t of tickers.slice(i * UNIVERSE_CHUNK_SIZE, (i + 1) * UNIVERSE_CHUNK_SIZE)) chunk[t] = catalog[t];
      await redis.set(`${UNIVERSE_CHUNK_PREFIX}${i}`, JSON.stringify(chunk));
    }
    // Meta last. A crash mid-write can leave a mixed old/new catalog until the
    // next refresh — acceptable for advisory discovery data (each entry is still
    // internally consistent; money paths never read this).
    await redis.set(UNIVERSE_META_KEY, JSON.stringify({ chunks: chunkCount, tickers: tickers.length, updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.error("[Redis] Failed to set universe catalog:", e.message);
    throw e;
  }
}

export async function getUniverseStatus() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(UNIVERSE_STATUS_KEY);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn("[Redis] Failed to get universe status:", e.message);
    return null;
  }
}

export async function setUniverseStatus(status) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(UNIVERSE_STATUS_KEY, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.warn("[Redis] Failed to set universe status:", e.message);
  }
}

// Peer-metrics store (Mandate v2, Phase A/W2) — per-name metric vectors accumulated
// by the nightly enrichment crawl (guarded by PEER_METRICS_ENABLED), chunked like the
// catalog to stay under Upstash request-size limits. Persistent (no TTL): a missed
// refresh must not erase weeks of paced accumulation. Advisory discovery data — money
// paths never read it; peer distributions are derived from it by jobs/peer-distributions.js.
// See docs/MANDATE-V2-INGESTION.md.
const PEER_METRICS_META_KEY = "pm:peer-metrics:meta";
const PEER_METRICS_CHUNK_PREFIX = "pm:peer-metrics:chunk:";
const PEER_METRICS_CHUNK_SIZE = 1000;
const PEER_COVERAGE_REQUESTS_KEY = "pm:peer-coverage:requests";
const PEER_DIST_PREFIX = "pm:peer-dist:";
const PEER_DIST_META_KEY = "pm:peer-dist:meta";

// Whole-market mandate scores (Phase 1 of the "deterministic breadth, AI depth"
// roadmap). Written nightly by jobs/mandate-scoring.js: a dated snapshot per agent
// plus a `latest` pointer. Research context + score history only — NOT a money path.
const MANDATE_SCORES_PREFIX = "pm:mandate-scores:";
const MANDATE_SCORES_TTL = 120 * 24 * 3600; // keep ~4 months of nightly snapshots for delta/backtest use

/** Read the full peer-metrics map ({ ticker: { industry, metrics, ts } }), or {} if none. */
export async function getPeerMetrics() {
  const redis = getRedis();
  if (!redis) return {};
  try {
    const metaRaw = await redis.get(PEER_METRICS_META_KEY);
    const meta = typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;
    if (!meta?.chunks) return {};
    const chunks = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) =>
        redis.get(`${PEER_METRICS_CHUNK_PREFIX}${i}`).then((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw))
      )
    );
    const map = {};
    for (const chunk of chunks) {
      if (!chunk) return {}; // torn write — treat as empty rather than silently partial
      Object.assign(map, chunk);
    }
    return map;
  } catch (e) {
    console.warn("[Redis] Failed to get peer metrics:", e.message);
    return {};
  }
}

/** Persist the full peer-metrics map, chunked. */
export async function setPeerMetrics(map) {
  const redis = getRedis();
  if (!redis) {
    console.error("[Redis] NOT CONFIGURED — peer metrics NOT persisted; peer-relative scoring stays unpopulated.");
    return;
  }
  try {
    const tickers = Object.keys(map).sort();
    const chunkCount = Math.max(1, Math.ceil(tickers.length / PEER_METRICS_CHUNK_SIZE));
    for (let i = 0; i < chunkCount; i++) {
      const chunk = {};
      for (const t of tickers.slice(i * PEER_METRICS_CHUNK_SIZE, (i + 1) * PEER_METRICS_CHUNK_SIZE)) chunk[t] = map[t];
      await redis.set(`${PEER_METRICS_CHUNK_PREFIX}${i}`, JSON.stringify(chunk));
    }
    await redis.set(PEER_METRICS_META_KEY, JSON.stringify({ chunks: chunkCount, tickers: tickers.length, updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.error("[Redis] Failed to set peer metrics:", e.message);
    throw e;
  }
}

/** Durable, bounded requests from Lab/research for cohort enrichment priority. */
export async function getPeerCoverageRequests() {
  const redis = getRedis();
  if (!redis) return {};
  try {
    const raw = await redis.get(PEER_COVERAGE_REQUESTS_KEY);
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("[Redis] Failed to get peer coverage requests:", e.message);
    return {};
  }
}

export async function requestPeerCoverage(request, { now = new Date().toISOString() } = {}) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const { mergeCoverageRequests } = await import("./peer-coverage.js");
    const existing = await getPeerCoverageRequests();
    const merged = mergeCoverageRequests(existing, [request], now);
    await redis.set(PEER_COVERAGE_REQUESTS_KEY, JSON.stringify(merged));
    return merged[request?.ticker?.trim?.().toUpperCase()] ?? null;
  } catch (e) {
    console.warn("[Redis] Failed to request peer coverage:", e.message);
    return null;
  }
}

/** Write per-industry distributions ({ industry: { metricId: number[] } }) as one key each + an index. */
export async function setPeerDistributions(distByIndustry) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const industries = Object.keys(distByIndustry);
    for (const industry of industries) {
      await redis.set(`${PEER_DIST_PREFIX}${industry}`, JSON.stringify(distByIndustry[industry]));
    }
    await redis.set(PEER_DIST_META_KEY, JSON.stringify({ industries, updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.error("[Redis] Failed to set peer distributions:", e.message);
    throw e;
  }
}

/**
 * Persist one agent's whole-market score snapshot for a date, and update the `latest`
 * pointer. `snapshot` = { date, generatedAt, scoredCount, scores: [{ ticker, total, ... }] }.
 */
export async function setMandateScores(agentId, snapshot) {
  const redis = getRedis();
  if (!redis) return;
  const date = snapshot?.date ?? new Date().toISOString().slice(0, 10);
  const payload = JSON.stringify(snapshot);
  try {
    await redis.set(`${MANDATE_SCORES_PREFIX}${agentId}:${date}`, payload, { ex: MANDATE_SCORES_TTL });
    await redis.set(`${MANDATE_SCORES_PREFIX}${agentId}:latest`, payload, { ex: MANDATE_SCORES_TTL });
  } catch (e) {
    console.error("[Redis] Failed to set mandate scores:", e.message);
    throw e;
  }
}

/** Read one agent's mandate-score snapshot (a specific date, or `latest`). */
export async function getMandateScores(agentId, date = "latest") {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${MANDATE_SCORES_PREFIX}${agentId}:${date}`);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn("[Redis] Failed to get mandate scores:", e.message);
    return null;
  }
}

/** Read the sorted peer values for one industry+metric (matches YahooIndustryPeerSource). */
export async function getPeerDistribution(industry, metricId) {
  const redis = getRedis();
  if (!redis || !industry) return [];
  try {
    const raw = await redis.get(`${PEER_DIST_PREFIX}${industry}`);
    const dist = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(dist?.[metricId]) ? dist[metricId] : [];
  } catch (e) {
    console.warn("[Redis] Failed to get peer distribution:", e.message);
    return [];
  }
}

// Macro snapshot — shared across every ticker in a scan and changes slowly, so cache across runs too.
const MACRO_CACHE_TTL = 6 * 3600;

export async function getCachedMacro() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get("pm:macro");
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn("[Redis] Failed to get cached macro snapshot:", e.message);
    return null;
  }
}

export async function setCachedMacro(snapshot) {
  const redis = getRedis();
  if (!redis || !snapshot) return;
  try {
    await redis.set("pm:macro", JSON.stringify(snapshot), { ex: MACRO_CACHE_TTL });
  } catch (e) {
    console.warn("[Redis] Failed to cache macro snapshot:", e.message);
  }
}

// Separate cache slot (same TTL/shape convention as pm:macro) for the
// deterministic dual-red gate's Treasury-yield-change input — kept apart from
// the display-oriented macro snapshot so one's shape never breaks the other's
// formatter.
export async function getCachedTreasuryYieldChangeBps() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get("pm:macro:treasury-yield-change-bps");
    if (raw == null) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn("[Redis] Failed to get cached treasury yield change:", e.message);
    return null;
  }
}

export async function setCachedTreasuryYieldChangeBps(changeBps) {
  const redis = getRedis();
  if (!redis || changeBps == null) return;
  try {
    await redis.set("pm:macro:treasury-yield-change-bps", JSON.stringify(changeBps), { ex: MACRO_CACHE_TTL });
  } catch (e) {
    console.warn("[Redis] Failed to cache treasury yield change:", e.message);
  }
}

// Lab single-ticker research runs (POST /research-ticker): progress/result the
// dashboard polls while the pipeline runs. Short TTL — these are ephemeral run
// records, not history (the durable trail is the agent tab row + the proposal).
const LAB_RESEARCH_TTL = 3600;

function labResearchKeyFor(requestId) {
  return `pm:lab-research:${requestId}`;
}

export async function setLabResearchStatus(requestId, record) {
  const redis = getRedis();
  if (!redis) {
    // This record is the lab run's OUTPUT surface — dropping it silently would
    // leave the dashboard polling a requestId that never resolves.
    console.error(
      `[Redis] NOT CONFIGURED (UPSTASH_REDIS_REST_URL/TOKEN missing) — lab research status DROPPED: ${requestId} (${record?.agentId} ${record?.ticker}, status ${record?.status})`
    );
    return null;
  }
  try {
    await redis.set(labResearchKeyFor(requestId), JSON.stringify(record), { ex: LAB_RESEARCH_TTL });
    return record;
  } catch (e) {
    console.error(`[Redis] Failed to store lab research status ${requestId} (${record?.status}):`, e.message);
    return null;
  }
}

export async function getLabResearchStatus(requestId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(labResearchKeyFor(requestId));
    if (raw == null) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn(`[Redis] Failed to read lab research status ${requestId}:`, e.message);
    return null;
  }
}

// ── Durable reconciliation queue (Codex re-review) ───────────────────────────
// When an ownership-scoped SELL cannot be reconciled to owned/unattributed lots,
// the in-memory needsReconciliation flag is not enough: the order lands in the
// Trade Ledger and is deduped on later syncs, so without a durable record the
// mismatch depends on a Telegram alert that may be missed and a proposal that may
// expire. This queue is a signed, durable record that sysloop surfaces until a
// repair explicitly clears it.
const RECON_PREFIX = "pm:reconciliation:";
const RECON_OPEN_SET = "pm:reconciliation:open";
const RECON_RESOLUTION_PREFIX = "pm:reconciliation:resolution:";
const LEGACY_APPROVAL_ATTESTATION_PREFIX = "pm:legacy-approval-attestation:";
const LOT_RECONCILIATION_PREFIX = "pm:lot-reconciliation:";
const LOT_RECONCILIATION_OPEN_SET = "pm:lot-reconciliation:open";

// WRITE fails closed (Codex): a reconciliation record that cannot be persisted
// leaves a broker/ledger mismatch untracked, so we THROW rather than return null.
// Callers must surface it loudly and keep the proposal unfulfilled.
export async function recordReconciliationNeeded({ orderId, proposalId, ticker, side, shares, reason }) {
  if (!orderId) throw new Error("recordReconciliationNeeded: orderId is required (dedupe + repair key).");
  const redis = getRedis();
  if (!redis) {
    throw new Error(`Cannot persist reconciliation record for order ${orderId} — Redis not configured. Mismatch would be untracked; refusing to proceed silently.`);
  }
  const entry = signOperationalLedgerEntry("reconciliation", {
    orderId: String(orderId),
    proposalId: proposalId ?? null,
    ticker: ticker ?? null,
    side: side ?? null,
    shares: shares ?? null,
    reason: String(reason ?? "").slice(0, 500),
    createdAt: new Date().toISOString(),
  });
  await redis.set(`${RECON_PREFIX}${orderId}`, JSON.stringify(entry));
  await redis.sadd(RECON_OPEN_SET, String(orderId));
  return entry;
}

// READ fails closed (Codex): returns null (not []) when the queue can't be read,
// so an unreadable queue is treated as UNKNOWN (a P1 by the sysloop check), never
// as "all clear". Every record is verified on read — a tampered/unsigned record
// is returned with verified:false so the check can surface it as an integrity
// issue rather than trusting or dropping it.
export async function listOpenReconciliations() {
  const redis = getRedis();
  if (!redis) return null;
  let ids;
  try {
    ids = await redis.smembers(RECON_OPEN_SET);
  } catch (e) {
    console.error("[Redis] reconciliation open-set unreadable:", e.message);
    return null; // fail closed
  }
  if (!ids?.length) return [];

  let secret = null;
  try { secret = getOperationalLedgerSecret(); } catch { secret = null; }

  const items = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = await redis.get(`${RECON_PREFIX}${id}`);
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    })
  );
  if (items.some((v) => v == null)) return null; // a record we couldn't read → fail closed

  return items.map((rec) => {
    const verified = Boolean(secret) && signedOperationalEntryIsValid("reconciliation", rec, secret);
    return { ...rec, verified };
  });
}

// NOTE: there is deliberately no unattested delete for reconciliation records.
// The only supported closure path is resolveReconciliationTestArtifact below,
// which retains the original signed record beside a signed resolution.

function signedOperationalEntryIsValid(kind, entry, secret) {
  if (!entry?.rowHmac) return false;
  const { rowHmac: _rowHmac, ...fields } = entry;
  // Accepts any configured verification secret so rows signed before the
  // dedicated operational secret existed remain verifiable.
  return operationalLedgerEntryHmacMatches(kind, { ...fields, rowHmac: entry.rowHmac }, secret);
}

export async function beginLotReconciliation({ reconciliationId, lotId, ticker, agentId, originalSharesOpen, brokerShares, originalLotHmac, attestedBy, attestation, now = new Date().toISOString() }) {
  if (![reconciliationId, lotId, ticker, agentId, originalLotHmac, attestedBy, attestation].every(Boolean)) throw new Error("Lot reconciliation identity and attestation are required.");
  if (!Number.isFinite(originalSharesOpen) || originalSharesOpen <= 0 || brokerShares !== 0) throw new Error("Lot reconciliation requires a positive residual and brokerShares exactly 0.");
  const redis = getRedis();
  if (!redis) throw new Error("Redis is not configured; refusing an untracked lot reconciliation.");
  const key = `${LOT_RECONCILIATION_PREFIX}${reconciliationId}`;
  const existingRaw = await redis.get(key);
  if (existingRaw) {
    const existing = typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw;
    if (!signedOperationalEntryIsValid("lot_reconciliation", existing, getOperationalLedgerSecret())) throw new Error(`Lot reconciliation ${reconciliationId} failed integrity verification.`);
    if (existing.lotId !== lotId || existing.originalLotHmac !== originalLotHmac || existing.originalSharesOpen !== originalSharesOpen) throw new Error(`Lot reconciliation ${reconciliationId} conflicts with retained evidence.`);
    return { entry: existing, idempotent: true };
  }
  const entry = signOperationalLedgerEntry("lot_reconciliation", { reconciliationId, lotId, ticker, agentId, originalSharesOpen, brokerShares, originalLotHmac, attestedBy, attestation: String(attestation).trim().slice(0, 500), status: "PENDING", createdAt: now, sheetWriteAttemptedAt: null, appliedAt: null });
  await redis.set(key, JSON.stringify(entry));
  await redis.sadd(LOT_RECONCILIATION_OPEN_SET, reconciliationId);
  return { entry, idempotent: false };
}

export async function getLotReconciliation(reconciliationId) {
  const redis = getRedis();
  if (!redis) throw new Error("Redis is not configured; lot reconciliation state is unreadable.");
  const raw = await redis.get(`${LOT_RECONCILIATION_PREFIX}${reconciliationId}`);
  if (!raw) return null;
  const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!signedOperationalEntryIsValid("lot_reconciliation", entry, getOperationalLedgerSecret())) throw new Error(`Lot reconciliation ${reconciliationId} failed integrity verification.`);
  return entry;
}

export async function markLotReconciliationSheetWriteAttempted({ reconciliationId, now = new Date().toISOString() }) {
  const redis = getRedis();
  if (!redis) throw new Error("Redis is not configured; refusing an untracked lot reconciliation.");
  const key = `${LOT_RECONCILIATION_PREFIX}${reconciliationId}`;
  const entry = await getLotReconciliation(reconciliationId);
  if (!entry) throw new Error(`Lot reconciliation ${reconciliationId} is missing or invalid.`);
  if (entry.status === "SHEET_WRITE_ATTEMPTED" || entry.status === "APPLIED") return { entry, idempotent: true };
  if (entry.status !== "PENDING") throw new Error(`Lot reconciliation ${reconciliationId} is not pending.`);
  const attempted = signOperationalLedgerEntry("lot_reconciliation", { ...entry, status: "SHEET_WRITE_ATTEMPTED", sheetWriteAttemptedAt: now });
  await redis.set(key, JSON.stringify(attempted));
  return { entry: attempted, idempotent: false };
}

export async function markLotReconciliationApplied({ reconciliationId, now = new Date().toISOString() }) {
  const redis = getRedis();
  if (!redis) throw new Error("Redis is not configured; refusing to finalize an untracked lot reconciliation.");
  const key = `${LOT_RECONCILIATION_PREFIX}${reconciliationId}`;
  const entry = await getLotReconciliation(reconciliationId);
  if (!entry) throw new Error(`Lot reconciliation ${reconciliationId} is missing or invalid.`);
  if (entry.status === "APPLIED") return { entry, idempotent: true };
  if (entry.status !== "SHEET_WRITE_ATTEMPTED") throw new Error(`Lot reconciliation ${reconciliationId} has no recorded Sheet write attempt.`);
  const applied = signOperationalLedgerEntry("lot_reconciliation", { ...entry, status: "APPLIED", appliedAt: now });
  await redis.set(key, JSON.stringify(applied));
  await redis.srem(LOT_RECONCILIATION_OPEN_SET, reconciliationId);
  return { entry: applied, idempotent: false };
}

/**
 * Resolves an explicitly identified non-broker smoke record without deleting
 * either the original signed record or the signed resolution. This is the only
 * supported way to remove a test artifact from the open reconciliation set.
 */
export async function resolveReconciliationTestArtifact({ orderId, attestedBy, attestation, allowLegacySmoke = false, now = new Date().toISOString() }) {
  if (!orderId || !attestedBy || !attestation) throw new Error("orderId, attestedBy, and attestation are required.");
  const redis = getRedis();
  if (!redis) throw new Error("Redis is not configured.");
  const secret = getOperationalLedgerSecret();
  const raw = await redis.get(`${RECON_PREFIX}${orderId}`);
  const original = typeof raw === "string" ? JSON.parse(raw) : raw;
  const verified = signedOperationalEntryIsValid("reconciliation", original, secret);
  const legacySmoke = allowLegacySmoke &&
    /^smoke(?:-|$)/.test(String(original?.orderId ?? "")) &&
    String(original?.reason ?? "").trim().toLowerCase() === "smoke" &&
    Date.parse(original?.createdAt ?? "") < Date.parse("2026-07-12T00:00:00.000Z");
  if (!verified && !legacySmoke) {
    throw new Error(`reconciliation ${orderId} is missing or failed integrity verification; refusing to resolve it.`);
  }
  const entry = signOperationalLedgerEntry("reconciliation_resolution", {
    orderId: String(orderId), resolution: legacySmoke ? "legacy_smoke_quarantine" : "test_artifact", attestedBy: String(attestedBy),
    attestation: String(attestation).trim().slice(0, 500), createdAt: now,
  }, secret);
  const key = `${RECON_RESOLUTION_PREFIX}${orderId}`;
  const priorRaw = await redis.get(key);
  if (priorRaw) {
    const prior = typeof priorRaw === "string" ? JSON.parse(priorRaw) : priorRaw;
    if (!signedOperationalEntryIsValid("reconciliation_resolution", prior, secret)) throw new Error(`existing resolution for ${orderId} failed integrity verification.`);
    if (prior.resolution !== entry.resolution || prior.attestation !== entry.attestation || prior.attestedBy !== entry.attestedBy) throw new Error(`reconciliation ${orderId} already has a different signed resolution.`);
    await redis.srem(RECON_OPEN_SET, String(orderId));
    return { resolution: prior, idempotent: true };
  }
  await redis.set(key, JSON.stringify(entry));
  await redis.srem(RECON_OPEN_SET, String(orderId));
  return { resolution: entry, idempotent: false };
}

/**
 * Closes one historical unsigned approval as a non-executable routing test.
 * The original proposal is retained, a signed attestation is retained beside
 * it, and the proposal is moved out of executable approval status.
 */
export async function closeLegacyTestApproval({ proposalId, attestedBy, attestation, now = new Date().toISOString() }) {
  if (!proposalId || !attestedBy || !attestation) throw new Error("proposalId, attestedBy, and attestation are required.");
  const redis = getRedis();
  if (!redis) throw new Error("Redis is not configured.");
  const secret = getOperationalLedgerSecret();
  const raw = await redis.get(proposalKeyFor(proposalId));
  const proposal = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!proposal) throw new Error(`proposal ${proposalId} was not found.`);
  if (proposal.decisionHmac) throw new Error(`proposal ${proposalId} is signed; legacy-test closure is only valid for unsigned history.`);
  if (proposal.status !== "ApprovedForBrokerReview") throw new Error(`proposal ${proposalId} is not an open legacy approval.`);
  const entry = signOperationalLedgerEntry("legacy_approval_attestation", {
    proposalId: String(proposalId), ticker: String(proposal.ticker ?? ""), side: String(proposal.side ?? ""),
    attestedBy: String(attestedBy), attestation: String(attestation).trim().slice(0, 500), createdAt: now,
  }, secret);
  const key = `${LEGACY_APPROVAL_ATTESTATION_PREFIX}${proposalId}`;
  const priorRaw = await redis.get(key);
  if (priorRaw) {
    const prior = typeof priorRaw === "string" ? JSON.parse(priorRaw) : priorRaw;
    if (!signedOperationalEntryIsValid("legacy_approval_attestation", prior, secret)) throw new Error(`existing attestation for ${proposalId} failed integrity verification.`);
    if (prior.attestation !== entry.attestation || prior.attestedBy !== entry.attestedBy) throw new Error(`proposal ${proposalId} already has a different signed attestation.`);
    return { attestation: prior, idempotent: true };
  }
  const closed = {
    ...proposal,
    // The historical fill remains on the record, but this old unsigned
    // approval can no longer appear actionable or reach an executor.
    status: "Rejected",
    decisionNote: `[legacy test closure] ${entry.attestation}`,
    updatedAt: now,
  };
  await redis.set(key, JSON.stringify(entry));
  await redis.set(proposalKeyFor(proposalId), JSON.stringify(closed));
  await shadowWriteProposal(closed);
  return { attestation: entry, idempotent: false };
}
