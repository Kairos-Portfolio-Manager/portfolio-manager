/**
 * Pitch Lab jobs — the real wiring for lib/pitch-lab/daily-runner.js and
 * grade-runner.js. Paper only: this file never creates a proposal, touches a
 * broker, or writes a pm:* production key. Its only database contact goes
 * through lib/pitch-lab-peer-bridge.js (peer-table read, peer-coverage requests,
 * the namespaced report key) plus the shared Anthropic budget/telemetry and the
 * read-only universe catalog.
 *
 * Gated by PITCH_LAB_ENABLED=1 (default off). Run from pitch-lab-scheduler.js,
 * which is a separate PM2 process — deliberately NOT part of scheduler.js, so it
 * cannot change the Phase 0 safety clock or critical-job coverage.
 *
 * Env (all optional except the gate):
 *   PITCH_LAB_ENABLED=1         enable the jobs
 *   PITCH_LAB_DIR               store directory (default ./data/pitch-lab)
 *   PITCH_LAB_MODEL             model id (default claude-sonnet-4-6)
 *   PITCH_LAB_MAX_PITCHES       pitches per run (default 15)
 *   PITCH_LAB_MAX_USD           per-run spend cap (default 1.00)
 *   PITCH_LAB_PEER_REQUESTS=1   let pitches queue peer-coverage requests (bridge flag)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicMonthlyBudget } from "../lib/anthropic-monthly-budget.js";
import { recordAnthropicUsage } from "../lib/anthropic-usage.js";
import { marketHolidayNameET } from "../lib/market-calendar.js";
import { getUniverseCatalog } from "../lib/redis.js";
import { mandateVersionFor } from "../lib/research-version.js";
import { sendMessage } from "../lib/telegram.js";
import { fetchDailyBars } from "../lib/yahoo.js";
import { gatherCandidateData, peersForPitch, publishPitchLabReport } from "../lib/pitch-lab-peer-bridge.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { runDailyPitches } from "../lib/pitch-lab/daily-runner.js";
import { gradeMaturedPitches } from "../lib/pitch-lab/grade-runner.js";
import { renderReportHtml } from "../lib/pitch-lab/render-html.js";
import { defaultPitchLabDir, openPitchStore } from "../lib/pitch-lab/store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ID = "agent-1";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_REPLY_TOKENS = 1200;

export const pitchLabEnabled = (env = process.env) => env.PITCH_LAB_ENABLED?.trim() === "1";

const positive = (value, fallback) => {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Agent One's identity + universe sections, read from the canonical mandate file. Fails closed if unreadable. */
export function loadMandateExcerpt(root = ROOT) {
  const text = readFileSync(path.join(root, "agent_mandates", "Agent_One_Mandate_v3.md"), "utf8");
  const start = text.indexOf("## 1. IDENTITY");
  const end = text.indexOf("## 2. POSITION IN THE SYSTEM");
  if (start < 0 || end <= start) throw new Error("Agent One mandate identity section not found — refusing to pitch without the mandate");
  return text.slice(start, end).trim();
}

function loadRiskLimits(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, "config", "agents", AGENT_ID, "risk-limits.json"), "utf8"));
}

/** One budgeted model call: authorise against the monthly ceiling, call, record usage, settle. No retries. */
export function createModelCaller({ client, monthlyBudget, model, env = process.env } = {}) {
  const anthropic = client ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY?.trim(), maxRetries: 0 });
  return async function callModel({ ticker, system, prompt }) {
    const request = {
      model,
      max_tokens: MAX_REPLY_TOKENS,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: prompt }],
    };
    const authorization = await monthlyBudget.authorizeCall({ role: "pitch_lab", model, request });
    let response;
    try {
      response = await anthropic.messages.create(request);
    } catch (error) {
      await monthlyBudget.settleProviderFailure?.(authorization, error);
      throw error;
    }
    const telemetry = await recordAnthropicUsage({
      role: "pitch_lab",
      agentId: AGENT_ID,
      ticker,
      model,
      stopReason: response.stop_reason,
      usage: response.usage,
      pricingVersion: authorization?.pricingVersion ?? null,
      now: authorization?.authorizedAt ? new Date(authorization.authorizedAt) : new Date(),
    });
    await monthlyBudget.settleCall(authorization, telemetry);
    if (response.stop_reason === "max_tokens") throw new Error("reply hit max_tokens — discarded (fail closed)");
    return { text: response.content.find((block) => block.type === "text")?.text ?? "", costUsd: telemetry?.record?.estimatedCostUsd ?? 0 };
  };
}

export async function runPitchLabDaily({ env = process.env, now = () => new Date(), dryRun = false, ...overrides } = {}) {
  if (!pitchLabEnabled(env)) return { status: "disabled" };
  const holiday = marketHolidayNameET(now());
  if (holiday) {
    console.log(`[PitchLab] skipped — market holiday: ${holiday}`);
    return { status: "holiday" };
  }
  const model = env.PITCH_LAB_MODEL?.trim() || DEFAULT_MODEL;
  const monthlyBudget = overrides.monthlyBudget ?? createAnthropicMonthlyBudget({ now });
  return runDailyPitches({
    now,
    dryRun,
    store: overrides.store ?? openPitchStore(defaultPitchLabDir(env)),
    getCatalog: overrides.getCatalog ?? getUniverseCatalog,
    riskLimits: loadRiskLimits(),
    gatherData: overrides.gatherData ?? gatherCandidateData,
    getPeers: overrides.getPeers ?? ((args) => peersForPitch(args)),
    callModel: overrides.callModel ?? createModelCaller({ monthlyBudget, model, env }),
    notify: overrides.notify ?? sendMessage,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    mandateExcerpt: loadMandateExcerpt(),
    mandateVersion: `agent_one_v${mandateVersionFor(AGENT_ID)}`,
    model,
    size: 15,
    randomSlots: 5,
    maxPitches: Math.floor(positive(env.PITCH_LAB_MAX_PITCHES, 15)),
    maxUsd: positive(env.PITCH_LAB_MAX_USD, 1),
  });
}

export async function runPitchLabGrade({ env = process.env, now = () => new Date() } = {}) {
  if (!pitchLabEnabled(env)) return { status: "disabled" };
  const holiday = marketHolidayNameET(now());
  if (holiday) return { status: "holiday" };
  const result = await gradeMaturedPitches({ store: openPitchStore(defaultPitchLabDir(env)), fetchBars: fetchDailyBars, now });
  if (result.failedTickers.length) {
    try {
      await sendMessage(`⚠️ Pitch Lab grading: no price data for ${result.failedTickers.slice(0, 8).join(", ")} — those pitches stay ungraded.`);
    } catch (error) {
      console.error(`[PitchLab] notification failed: ${error?.message ?? error}`);
    }
  }
  return { status: "ok", ...result };
}

export async function runPitchLabReport({ env = process.env, now = () => new Date() } = {}) {
  if (!pitchLabEnabled(env)) return { status: "disabled" };
  const dir = defaultPitchLabDir(env);
  const store = openPitchStore(dir);
  const report = analyzePitchLab({ pitches: store.listPitches(), outcomes: store.listOutcomes(), now: now() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(dir, "report.html"), renderReportHtml(report));
  const published = await publishPitchLabReport(report, { now });
  console.log(`[PitchLab] report written (${report.totals.pitches} pitches); published=${published}`);
  return { status: "ok", pitches: report.totals.pitches, published };
}

// Manual run: `node jobs/pitch-lab-daily.js [daily|grade|report] [--dry-run]`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [task = "daily"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const jobs = { daily: runPitchLabDaily, grade: runPitchLabGrade, report: runPitchLabReport };
  if (!jobs[task]) {
    console.error("usage: node jobs/pitch-lab-daily.js [daily|grade|report] [--dry-run]   (requires PITCH_LAB_ENABLED=1)");
    process.exit(1);
  }
  const result = await jobs[task]({ dryRun: process.argv.includes("--dry-run") });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "disabled") console.error("[PitchLab] disabled — set PITCH_LAB_ENABLED=1 to run.");
}
