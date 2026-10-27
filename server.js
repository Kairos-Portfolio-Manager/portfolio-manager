import "dotenv/config";
import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { runResearchScan, researchTickerForAgent } from "./jobs/research-scan.js";
import { runIntradayMonitor } from "./jobs/intraday-monitor.js";
import { listPriceAlerts, addPriceAlert, removePriceAlert } from "./lib/price-alerts.js";
import { syncHoldings } from "./jobs/holdings-sync.js";
import { getProposalById, markProposalFulfilled, getRedis, getUniverseStatus, getResearchDataStatus, getShadowSelectionStatus, setLabResearchStatus, getLabResearchStatus, getSlateSnapshot, getLastSystemActivity, getAgentParityRuntimeSummary } from "./lib/redis.js";
import { toPublicSlateSnapshot } from "./lib/public-slate-snapshot.js";
import { recordMcpFill } from "./lib/mcp-accounting.js";
import { getServiceAccountClients, getSheetIds, resolveSharedSpreadsheetId } from "./lib/sheets.js";
import { validateResearchTickerRequest, buildLabOutcome } from "./lib/lab-research.js";
import { fetchAthenaStatus } from "./lib/athena.js";
import { writeAsyncJson } from "./lib/http-json.js";
import { AGENTS } from "./config/agents.js";
import { isResearchActive } from "./lib/research-run-health.js";
import { withWorkflowLock } from "./lib/workflow-lock.js";
import { shadowWriteCapitalEntry, shadowWriteProposal } from "./lib/pg/dual-write.js";
import { getPortfolioManagerShadowState } from "./lib/portfolio-manager-shadow-store.js";
import { researchStoreConfigured } from "./lib/pg/research-observations.js";
import { resolveResearchCodeRevision } from "./lib/mandate-observation.js";
import { validateCompanionProposalStatePatch } from "./lib/companion-proposal-state.js";

const PORT = process.env.PORTFOLIO_SERVER_PORT ?? 3200;
const SECRET = process.env.PORTFOLIO_WEBHOOK_SECRET?.trim();
const AGENT_IDS = AGENTS.map((a) => a.id);

let scanRunning = false;
let syncRunning = false;
const MAX_JSON_BODY_BYTES = 128 * 1024;

// Lab single-ticker research runs (POST /research-ticker): in-flight keys
// (`agentId:ticker`) so the same request can't double-run; results live in
// Redis under pm:lab-research:<requestId> for the dashboard to poll.
const labResearchRunning = new Set();

async function runLabResearch({ requestId, runKey, ticker, agentId, startedAt }) {
  try {
    const result = await researchTickerForAgent(agentId, ticker);
    const outcome = buildLabOutcome(result);
    await setLabResearchStatus(requestId, {
      status: "done",
      ticker,
      agentId,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome,
    });
    console.log(
      `[Server] Lab research ${agentId}/${ticker} done — ${outcome.action}${
        outcome.proposalId ? ` (proposal ${outcome.proposalId}, $${outcome.amountDollars})` : ` (${outcome.reason})`
      }.`
    );
  } catch (e) {
    // The Redis record is this run's only output surface — the failure must land there loudly.
    console.error(`[Server] Lab research ${agentId}/${ticker} failed:`, e.message);
    await setLabResearchStatus(requestId, {
      status: "error",
      ticker,
      agentId,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: e.message,
    });
  } finally {
    labResearchRunning.delete(runKey);
  }
}

// FAIL CLOSED: without a configured secret, every route except /health is
// refused. The old fail-open behavior meant an unset env var silently exposed
// /record-trade, /scan, and /alerts to anyone who could reach this port.
function auth(req) {
  if (!SECRET) return false;
  const header = req.headers["authorization"] ?? "";
  const expected = Buffer.from(`Bearer ${SECRET}`);
  const provided = Buffer.from(String(header));
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      reject(new Error("Request body exceeds the 128 KiB limit."));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        fail(new Error("Request body exceeds the 128 KiB limit."));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      const body = Buffer.concat(chunks).toString("utf8");
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { fail(e); }
    });
    req.on("error", fail);
  });
}

async function handleRequest(req, res) {
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url, `http://localhost`);

  if (req.method === "GET" && url.pathname === "/health") {
    // "ok" used to mean only "the process is up" — it said ok with Redis,
    // Sheets auth, and the Anthropic key all broken (the silent-no-op family
    // of bugs). Report dependency reality instead. Booleans only; safe unauthenticated.
    const deps = {
      redis: false,
      sheetsAuth: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT || process.env.GOOGLE_CREDENTIALS_PATH),
      anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      webhookSecret: Boolean(SECRET),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()),
    };
    try {
      const redis = getRedis();
      if (redis) deps.redis = (await redis.ping()) === "PONG";
    } catch {
      deps.redis = false;
    }
    const ok = deps.redis && deps.sheetsAuth && deps.anthropicKey && deps.webhookSecret;
    // Universe catalog state is informational, never part of ok — the research
    // scan has a loud seed-watchlist fallback when the catalog is missing.
    let universe = null;
    try {
      const status = await getUniverseStatus();
      if (status) universe = { state: status.state, cataloged: status.cataloged ?? 0, sectorEnriched: status.sectorEnriched ?? 0, updatedAt: status.updatedAt };
    } catch {
      universe = null;
    }
    // Latest candidate-slate composition + research-ledger coverage (Phase 1
    // funnel observability). Informational like universe: counts only, never
    // tickers, never part of ok.
    let slate = null;
    let slates = {};
    try {
      const snapshots = await Promise.all(
        ["agent-1", "agent-2", "agent-3"].map(async (agentId) => [
          agentId,
          toPublicSlateSnapshot(await getSlateSnapshot(agentId)),
        ])
      );
      slates = Object.fromEntries(snapshots);
      // Retain the legacy field for dashboard compatibility while exposing the
      // same aggregate-only observation proof for all three live agents.
      slate = slates["agent-1"] ?? null;
    } catch {
      slate = null;
      slates = {};
    }
    // Aggregate-only observation of the latest real scheduled three-agent run.
    // This is explicitly unverified runtime telemetry, not cryptographic parity
    // proof: the terminal scheduler receipt is retained only after the scan
    // function returns.
    let agentParity = null;
    try {
      agentParity = await getAgentParityRuntimeSummary();
    } catch {
      agentParity = null;
    }
    // Advisory research-data progress. The Redis helper persists an allow-listed
    // aggregate payload only, so this public endpoint never leaks tickers,
    // research rationale, proposals, or investor data.
    let researchData = null;
    try {
      researchData = await getResearchDataStatus();
    } catch {
      researchData = null;
    }
    let shadowSelection = null;
    try {
      shadowSelection = await getShadowSelectionStatus();
    } catch {
      shadowSelection = null;
    }
    const researchDataEnabled = deps.redis &&
      process.env.PEER_METRICS_ENABLED?.trim() === "1" &&
      process.env.PEER_METRICS_EDGAR?.trim() === "1" &&
      researchStoreConfigured() &&
      Boolean(resolveResearchCodeRevision({ env: process.env }));
    // Athena's own analyst-pipeline health (optional, advisory-only source —
    // see lib/athena.js). Informational like universe/slate: never part of ok,
    // since Athena being down must never take our own health down with it.
    const athena = await fetchAthenaStatus({ timeoutMs: 3000 });
    res.writeHead(ok ? 200 : 503);
    res.end(JSON.stringify({ ok, scanRunning, deps, universe, slate, slates, agentParity, researchData, shadowSelection, researchDataEnabled, athena }));
    return;
  }

  if (!auth(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // GET /activity — "what did the system last do", for the dashboard sidebar.
  // Reuses the same pm:job:<name>:last-run keys the sysloop freshness check
  // reads; scanRunning/syncRunning are surfaced too so the UI can show "running
  // now" instead of a stale last-run entry while a manual trigger is in flight.
  if (req.method === "GET" && url.pathname === "/activity") {
    let activity = null;
    try {
      activity = await getLastSystemActivity();
    } catch (e) {
      console.error("[Server] /activity lookup failed:", e.message);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ activity, scanRunning, syncRunning }));
    return;
  }

  // Kairos (Agent 4) remains shadow-only. This state endpoint exposes versioned policy,
  // immutable snapshots, and recorded shadow decisions; it never reads or
  // writes the live approval signature/execution queue.
  if (req.method === "GET" && url.pathname === "/portfolio-manager/shadow") {
    await writeAsyncJson(res, getPortfolioManagerShadowState);
    return;
  }

  // Dashboard-authored proposal decisions/edits are authoritative in Redis.
  // Once that write succeeds, this endpoint mirrors the resulting full object
  // into Postgres. Shadow failure never changes the dashboard response.
  if (req.method === "POST" && url.pathname === "/shadow/proposal") {
    try {
      const body = await readBody(req);
      const result = await shadowWriteProposal(body?.proposal);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // The Mac companion may report only its bounded execution state. It must not
  // write Redis proposal records directly: Jetson owns all lifecycle writes so
  // the Neon shadow sees the same state transition.
  if (req.method === "POST" && url.pathname === "/companion/proposal-state") {
    try {
      const body = await readBody(req);
      const proposalId = String(body?.proposalId ?? "").trim();
      if (!proposalId) throw new Error("proposalId is required");
      const redis = getRedis();
      if (!redis) throw new Error("Redis is not configured");
      const proposal = await getProposalById(proposalId);
      if (!proposal) throw new Error("Proposal not found");
      const patch = validateCompanionProposalStatePatch(body?.patch, proposal);
      const updated = { ...proposal, ...patch, updatedAt: new Date().toISOString() };
      await redis.set(`pm:approval_proposal:${proposalId}`, JSON.stringify(updated));
      const shadow = await shadowWriteProposal(updated);
      if (!shadow.ok) console.error(`[Server] companion proposal state shadow failed for ${proposalId}: ${shadow.error ?? "skipped"}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, shadowed: shadow.ok }));
    } catch (e) {
      console.error("[Server] companion proposal-state error:", e.message);
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Dashboard-authored capital entries are signed and appended to Sheets
  // first. This authenticated endpoint mirrors that immutable row to Neon;
  // entry_id uniqueness makes retrying it safe after a transient failure.
  if (req.method === "POST" && url.pathname === "/shadow/capital-entry") {
    try {
      const body = await readBody(req);
      const result = await shadowWriteCapitalEntry(body?.entry);
      res.writeHead(result.ok ? 200 : 503);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /sync-holdings — trigger an on-demand holdings sync (called by PostToolUse hook
  // after Robinhood MCP trade actions so cash/NAV refresh without waiting for the schedule)
  if (req.method === "POST" && url.pathname === "/sync-holdings") {
    if (syncRunning) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: "Sync already running" }));
      return;
    }
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, message: "Holdings sync started" }));
    syncRunning = true;
    syncHoldings()
      .catch((e) => console.error("[Server] Holdings sync error:", e.message))
      .finally(() => { syncRunning = false; });
    return;
  }

  // POST /scan — trigger full research scan
  if (req.method === "POST" && url.pathname === "/scan") {
    if (scanRunning) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: "Scan already running" }));
      return;
    }
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, message: "All-agent scan started" }));
    scanRunning = true;
    runResearchScan({ source: "manual" })
      .catch((e) => console.error("[Server] Scan error:", e.message))
      .finally(() => { scanRunning = false; });
    return;
  }

  // POST /research-ticker — dashboard Lab: run the full research pipeline for a
  // single ticker/agent and, if it clears every gate, queue a properly-sized
  // proposal into the approval queue. Responds 202 with a requestId; progress/
  // result is polled via GET /research-ticker/<requestId>.
  if (req.method === "POST" && url.pathname === "/research-ticker") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    const validated = validateResearchTickerRequest(body, AGENT_IDS);
    if (!validated.ok) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: validated.error }));
      return;
    }
    const { ticker, agentId } = validated;
    if (!isResearchActive(AGENTS.find((a) => a.id === agentId))) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: `${agentId} is frozen: research and new proposals are paused` }));
      return;
    }
    if (scanRunning) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: "Full research scan is currently running — retry after it finishes" }));
      return;
    }
    const runKey = `${agentId}:${ticker}`;
    if (labResearchRunning.has(runKey)) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: `Lab research already running for ${ticker} (${agentId})` }));
      return;
    }
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    labResearchRunning.add(runKey);
    await setLabResearchStatus(requestId, { status: "running", ticker, agentId, startedAt });
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, requestId }));
    runLabResearch({ requestId, runKey, ticker, agentId, startedAt }).catch((e) => {
      // runLabResearch handles its own errors; this only guards bookkeeping bugs.
      console.error("[Server] Lab research bookkeeping error:", e.message);
      labResearchRunning.delete(runKey);
    });
    return;
  }

  // GET /research-ticker/:requestId — poll a lab run's progress/result.
  const labStatusMatch = url.pathname.match(/^\/research-ticker\/([0-9a-fA-F-]{1,64})$/);
  if (req.method === "GET" && labStatusMatch) {
    const record = await getLabResearchStatus(labStatusMatch[1]);
    if (!record) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Unknown or expired requestId" }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify(record));
    return;
  }

  // POST /intraday — trigger an on-demand intraday check
  if (req.method === "POST" && url.pathname === "/intraday") {
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, message: "Intraday check started" }));
    runIntradayMonitor({ context: "manual" }).catch((e) => console.error("[Server] Intraday error:", e.message));
    return;
  }

  // GET /alerts — list all price alerts
  if (req.method === "GET" && url.pathname === "/alerts") {
    const alerts = await listPriceAlerts();
    res.writeHead(200);
    res.end(JSON.stringify({ alerts }));
    return;
  }

  // POST /alerts — add a new price alert
  if (req.method === "POST" && url.pathname === "/alerts") {
    try {
      const body = await readBody(req);
      const { agentId, ticker, direction, targetPrice, note } = body;
      const validAgentId = ["agent-1", "agent-2", "agent-3"].includes(agentId) ? agentId : "agent-1";
      if (!ticker || !direction || targetPrice == null) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "ticker, direction, and targetPrice are required" }));
        return;
      }
      if (direction !== "below" && direction !== "above") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "direction must be 'below' or 'above'" }));
        return;
      }
      const alert = await addPriceAlert({ agentId: validAgentId, ticker, direction, targetPrice, note });
      res.writeHead(201);
      res.end(JSON.stringify({ alert }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // DELETE /alerts/:id — remove a price alert
  const deleteMatch = url.pathname.match(/^\/alerts\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    await removePriceAlert(deleteMatch[1]);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /record-trade — called by the portfolio dashboard after a Robinhood MCP order is placed
  if (req.method === "POST" && url.pathname === "/record-trade") {
    try {
      const body = await readBody(req);
      const { proposalId, orderId, ticker, side, shares, price, agentId } = body;
      if (!proposalId || !orderId || !ticker || !side || shares == null || price == null) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "proposalId, orderId, ticker, side, shares, and price are required" }));
        return;
      }
      const { trade, alreadyRecorded, needsReconciliation } = await withWorkflowLock("accounting", async () => {
        const proposal = await getProposalById(proposalId);
        const { sheets, drive } = getServiceAccountClients();
        const spreadsheetId = await resolveSharedSpreadsheetId(sheets, drive);
        const sheetIds = await getSheetIds(sheets, spreadsheetId);
        const recorded = await recordMcpFill({
          sheets, spreadsheetId, sheetIds, proposal, orderId, ticker,
          side, shares, price, agentId: agentId ?? "agent-1",
        });
        // Do NOT mark fulfilled when the lot ledger couldn't be reconciled — the
        // trade is recorded and a durable reconciliation record persisted; the
        // proposal stays open until repaired (Codex MCP-path coverage).
        if (!recorded.needsReconciliation) await markProposalFulfilled(proposalId, orderId, undefined, recorded.trade.shares);
        return recorded;
      }, { ttlSeconds: 5 * 60 });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, alreadyRecorded, needsReconciliation: Boolean(needsReconciliation), trade }));
      // Kick off a holdings sync so the dashboard reflects the new position immediately
      syncHoldings().catch((e) => console.error("[Server] Post-trade sync error:", e.message));
    } catch (e) {
      console.error("[Server] record-trade error:", e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error("[Server] unhandled request error:", error.message);
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

export function startServer() {
  if (!SECRET) {
    console.error("[Portfolio Manager] WARNING: PORTFOLIO_WEBHOOK_SECRET is not set — all routes except /health will return 401 until it is configured.");
  }
  server.listen(PORT, () => {
    console.log(`[Portfolio Manager] HTTP server listening on port ${PORT}`);
  });
}
