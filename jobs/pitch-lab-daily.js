/**
 * Pitch Lab jobs — the real wiring for lib/pitch-lab/daily-runner.js and
 * grade-runner.js. Paper only: this file never creates a proposal, touches a
 * broker, or writes a pm:* production key. Canonical Pitch Lab evidence goes to
 * its dedicated append-only Postgres tables. Redis contact is limited to the
 * peer bridge, daily candidate catalog, Telegram dedupe markers, and one
 * namespaced website-report projection.
 *
 * Gated by PITCH_LAB_ENABLED=1 (default off). Run from pitch-lab-scheduler.js,
 * which is a separate PM2 process — deliberately NOT part of scheduler.js, so it
 * cannot change the Phase 0 safety clock or critical-job coverage.
 *
 * Env:
 *   PITCH_LAB_ENABLED=1         enable the jobs
 *   DATABASE_URL                required canonical Pitch Lab store
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
import { estimateAnthropicRequestUpperBound, resolveAnthropicPricingVersion } from "../lib/anthropic-pricing.js";
import { recordAnthropicUsage } from "../lib/anthropic-usage.js";
import { etDateString, marketHolidayNameET } from "../lib/market-calendar.js";
import { getRedis, getUniverseCatalog } from "../lib/redis.js";
import { mandateVersionFor } from "../lib/research-version.js";
import { sendMessage } from "../lib/telegram.js";
import { fetchDailyBars } from "../lib/yahoo.js";
import { gatherCandidateData, peersForPitch, publishPitchLabReport } from "../lib/pitch-lab-peer-bridge.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { runDailyPitches } from "../lib/pitch-lab/daily-runner.js";
import { gradeMaturedPitches } from "../lib/pitch-lab/grade-runner.js";
import { renderReportHtml } from "../lib/pitch-lab/render-html.js";
import { formatPitchLabDailyTelegram, formatPitchLabWeeklyTelegram } from "../lib/pitch-lab/telegram.js";
import { defaultPitchLabDir } from "../lib/pitch-lab/store.js";
import { openPostgresPitchStore } from "../lib/pg/pitch-lab-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ID = "agent-1";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_REPLY_TOKENS = 1200;
const TELEGRAM_RETENTION_SECONDS = 45 * 24 * 60 * 60;
const TELEGRAM_CLAIM_SECONDS = 10 * 60;
const DAILY_RUN_RETENTION_SECONDS = 2 * 24 * 60 * 60;

export const pitchLabEnabled = (env = process.env) => env.PITCH_LAB_ENABLED?.trim() === "1";

const positive = (value, fallback) => {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export async function sendTelegramOnce(key, message, { redis = getRedis(), send = sendMessage, log = console } = {}) {
  if (!redis) {
    await send(message);
    return true;
  }
  const claimed = await redis.set(key, "sending", { nx: true, ex: TELEGRAM_CLAIM_SECONDS });
  if (!claimed) return false;
  try {
    await send(message);
    let confirmationError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await redis.set(key, new Date().toISOString(), { ex: TELEGRAM_RETENTION_SECONDS });
        confirmationError = null;
        break;
      } catch (error) {
        confirmationError = error;
      }
    }
    if (confirmationError) {
      // Delivery already happened. Keep the short-lived claim so an immediate
      // scheduler retry cannot duplicate the phone message, and do not turn a
      // Redis confirmation problem into a false job failure.
      log.warn(`[PitchLab] Telegram delivered but dedupe confirmation failed: ${confirmationError.message}`);
    }
    return true;
  } catch (error) {
    await redis.del(key).catch(() => {});
    throw error;
  }
}

const dailyRunKey = (date) => `pitchlab:run:daily:${date}`;

function phoneSafeRunSummary(result) {
  return {
    status: result.status,
    date: result.date,
    selected: result.selected,
    pitched: result.pitched,
    failedCount: result.failed?.length ?? 0,
    shortfall: result.shortfall ?? 0,
  };
}

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
  return async function callModel({ ticker, system, prompt, remainingUsd = Infinity }) {
    const request = {
      model,
      max_tokens: MAX_REPLY_TOKENS,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: prompt }],
    };
    const pricingVersion = resolveAnthropicPricingVersion({ env, at: new Date() });
    const requestBound = estimateAnthropicRequestUpperBound({ model, pricingVersion, request });
    if (Number.isFinite(remainingUsd) && requestBound.upperBoundUsd > remainingUsd + 1e-9) {
      const error = new Error(
        `Pitch Lab per-run cap has $${remainingUsd.toFixed(4)} left; the next call requires a $${requestBound.upperBoundUsd.toFixed(4)} upper-bound reservation.`,
      );
      error.code = "run_budget_exhausted";
      throw error;
    }
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
    if (response.stop_reason === "max_tokens") {
      const error = new Error("reply hit max_tokens — discarded (fail closed)");
      error.code = "reply_truncated";
      // The provider call was completed and billed even though the pitch is
      // unusable. Preserve that cost so the per-run cap accounts for it.
      error.costUsd = telemetry?.record?.estimatedCostUsd ?? 0;
      throw error;
    }
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
  const result = await runDailyPitches({
    now,
    dryRun,
    store: overrides.store ?? openPostgresPitchStore({ pool: overrides.pool }),
    getCatalog: overrides.getCatalog ?? getUniverseCatalog,
    riskLimits: loadRiskLimits(),
    gatherData: overrides.gatherData ?? gatherCandidateData,
    getPeers: overrides.getPeers ?? ((args) => peersForPitch(args)),
    callModel: overrides.callModel ?? createModelCaller({ monthlyBudget, model, env }),
    // Expected per-name drops stay in logs and the evening digest. The scheduler
    // itself still pages Telegram if the whole job throws.
    notify: overrides.notify ?? (async (message) => console.warn(`[PitchLab] ${message}`)),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    mandateExcerpt: loadMandateExcerpt(),
    mandateVersion: `agent_one_v${mandateVersionFor(AGENT_ID)}`,
    model,
    size: 15,
    randomSlots: 5,
    maxPitches: Math.floor(positive(env.PITCH_LAB_MAX_PITCHES, 15)),
    maxUsd: positive(env.PITCH_LAB_MAX_USD, 1),
  });
  if (!dryRun) {
    const redis = overrides.redis ?? getRedis();
    if (!redis) throw new Error("Redis is required to record Pitch Lab daily completion and deliver its digest.");
    await redis.set(dailyRunKey(result.date), JSON.stringify(phoneSafeRunSummary(result)), { ex: DAILY_RUN_RETENTION_SECONDS });
  }
  return result;
}

export async function runPitchLabGrade({
  env = process.env,
  now = () => new Date(),
  store,
  pool,
  redis,
  send,
  grade = gradeMaturedPitches,
  fetchBars = fetchDailyBars,
  dailyRun,
} = {}) {
  if (!pitchLabEnabled(env)) return { status: "disabled" };
  const holiday = marketHolidayNameET(now());
  if (holiday) return { status: "holiday" };
  const date = etDateString(now());
  const cache = redis === undefined ? getRedis() : redis;
  if (!cache) {
    console.warn(`[PitchLab] ${date}: digest deferred because the daily completion marker is unavailable.`);
    return { status: "deferred", reason: "daily_completion_unavailable", date };
  }
  let run = dailyRun ?? null;
  if (!run) {
    try {
      const value = await cache.get(dailyRunKey(date));
      run = typeof value === "string" ? JSON.parse(value) : value;
    } catch (error) {
      console.warn(`[PitchLab] daily digest context was unavailable: ${error.message}`);
    }
  }
  if (!run) {
    console.log(`[PitchLab] ${date}: digest deferred until the daily pitch run completes.`);
    return { status: "deferred", reason: "daily_incomplete", date };
  }

  const canonical = store ?? openPostgresPitchStore({ pool });
  let result = { pending: 0, stored: 0, failedTickers: [] };
  let gradingError = null;
  try {
    result = await grade({ store: canonical, fetchBars, now });
  } catch (error) {
    gradingError = error;
    console.error(`[PitchLab] grading failed; today's pitch digest will still be sent: ${error.message}`);
  }
  const [pitches, outcomes] = await Promise.all([canonical.listPitches(), canonical.listOutcomes()]);
  const today = pitches.filter((pitch) => etDateString(new Date(pitch.pitchedAt)) === date);
  const maturedToday = outcomes.filter((row) => etDateString(new Date(row.gradedAt)) === date);
  await sendTelegramOnce(
    `pitchlab:telegram:daily:${date}`,
    formatPitchLabDailyTelegram({
      date,
      pitches: today,
      outcomes: maturedToday,
      run,
      failedTickers: result.failedTickers,
      gradingError,
    }),
    { redis: cache, send },
  );
  return { status: gradingError ? "partial" : "ok", ...result, gradingFailed: Boolean(gradingError), telegram: "daily_digest" };
}

export async function runPitchLabReport({ env = process.env, now = () => new Date(), store, pool, redis, send } = {}) {
  if (!pitchLabEnabled(env)) return { status: "disabled" };
  const dir = defaultPitchLabDir(env);
  const canonical = store ?? openPostgresPitchStore({ pool });
  const report = analyzePitchLab({ pitches: await canonical.listPitches(), outcomes: await canonical.listOutcomes(), now: now() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(dir, "report.html"), renderReportHtml(report));
  const cache = redis === undefined ? getRedis() : redis;
  if (!cache) throw new Error("Redis is required to publish and deduplicate the Pitch Lab weekly report.");
  const published = await publishPitchLabReport(report, { redis: cache, now });
  await sendTelegramOnce(
    `pitchlab:telegram:weekly:${etDateString(now())}`,
    formatPitchLabWeeklyTelegram(report),
    { redis: cache, send },
  );
  console.log(`[PitchLab] report written (${report.totals.pitches} pitches); published=${published}`);
  return { status: "ok", pitches: report.totals.pitches, published };
}

/** The scheduler's atomic daily unit: finish all pitches, then grade and notify. */
export async function runPitchLabDailyCycle({ runDaily = runPitchLabDaily, runGrade = runPitchLabGrade } = {}) {
  const daily = await runDaily();
  if (["disabled", "holiday"].includes(daily?.status) || daily?.dryRun) return daily;
  // The daily write already succeeded. Carry that completion evidence in
  // memory so a transient Redis read cannot silently suppress grading/digest.
  const gradeResult = await runGrade({ dailyRun: phoneSafeRunSummary(daily) });
  if (gradeResult?.status === "deferred") {
    const error = new Error(`Pitch Lab grading deferred after a completed daily run: ${gradeResult.reason ?? "unknown reason"}`);
    error.code = "pitch_lab_grade_deferred";
    throw error;
  }
  return { ...daily, grade: gradeResult, status: gradeResult.status === "ok" ? daily.status : gradeResult.status };
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
