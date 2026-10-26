import "dotenv/config";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getRedis } from "../lib/redis.js";
import { isTradingDate } from "../lib/market-calendar.js";
import { planAlerts } from "../lib/alerting/policy.js";
import { lastSaturday, runOpsChecks } from "../lib/ops-watch/checks.js";
import { sendMessage } from "../lib/telegram.js";

// Ops-watch: a small, separate PM2 process (ops-watch-scheduler.js) that watches the
// things the evening sentinel cannot — Pitch Lab, the Jetson broker reader, and the
// sentinel itself — and alerts through the shared policy (new -> now, still-open -> daily
// digest, resolved -> note, failed send -> retried next run).
//
// It is deliberately separate from scheduler.js so it cannot touch the Phase 0 safety
// clock, and separate from the Pitch Lab process so it can notice that process dying.
//
// Write surface: pm:opswatch:* keys and Telegram. Reads only everywhere else.

const pExecFile = promisify(execFile);

export const OPS_STATE_KEY = "pm:opswatch:alert-state";
export const OPS_LAST_RUN_KEY = "pm:opswatch:last-run";
const READER_HEARTBEAT_KEY = "pm:broker-reader:last-seen";
const READER_HEALTH_KEY = "pm:broker-reader:read-health";
const SENTINEL_LAST_RUN_KEY = "pm:sysloop:last-run";

export function etParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: get("weekday"),
  };
}

export const isTradingDay = (et) => !["Sat", "Sun"].includes(et.weekday) && isTradingDate(et.date);

async function gatherPm2() {
  try {
    const { stdout } = await pExecFile("pm2", ["jlist"], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout).map((p) => ({ name: p.name, pm2_env: { status: p.pm2_env?.status, pm_uptime: p.pm2_env?.pm_uptime } }));
  } catch (e) {
    console.error("[OpsWatch] pm2 jlist failed:", e.message);
    return null;
  }
}

const parseJson = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
};

/** null = key absent; undefined = could not be read (the check then fails closed). */
async function readKey(redis, read) {
  try { return await read(); } catch (e) {
    console.error(`[OpsWatch] Redis read failed: ${e.message}`);
    return undefined;
  }
}

export async function gatherInputs({ redis = getRedis(), now = new Date(), env = process.env, listProcesses = gatherPm2 } = {}) {
  const et = etParts(now);
  const nowMs = now.getTime();
  const processes = await listProcesses();
  const get = (key) => (redis ? readKey(redis, async () => (await redis.get(key)) ?? null) : undefined);

  const [heartbeatRaw, healthRaw, sentinelRaw, dailyRaw, dailyDigest] = await Promise.all([
    get(READER_HEARTBEAT_KEY),
    redis ? readKey(redis, async () => (await redis.hgetall(READER_HEALTH_KEY)) ?? null) : undefined,
    get(SENTINEL_LAST_RUN_KEY),
    get(`pitchlab:run:daily:${et.date}`),
    get(`pitchlab:telegram:daily:${et.date}`),
  ]);
  const weeklyDigest = await get(`pitchlab:telegram:weekly:${lastSaturday(et.date)}`);

  const heartbeatMs = heartbeatRaw === undefined ? undefined : heartbeatRaw === null ? null : Date.parse(String(heartbeatRaw));
  let readHealth = healthRaw;
  if (readHealth && typeof readHealth === "object") {
    readHealth = Object.fromEntries(Object.entries(readHealth).map(([kind, value]) => [kind, parseJson(value)]));
  }
  const trading = isTradingDay(et);

  return {
    reader: { processes, heartbeatMs, readHealth, nowMs },
    pitchLab: {
      enabled: env.PITCH_LAB_ENABLED?.trim() === "1",
      processes,
      nowET: et,
      isTradingDay: trading,
      dailyRun: parseJson(dailyRaw),
      dailyDigest,
      weeklyDigest,
      nowMs,
    },
    sentinel: { processes, lastRun: parseJson(sentinelRaw), nowET: et, isTradingDay: trading, nowMs },
  };
}

export async function runOpsWatch({ dryRun = false, now = new Date(), redis = getRedis(), send = sendMessage, log = console, listProcesses = gatherPm2, env = process.env } = {}) {
  const et = etParts(now);
  // Weekday-only: nothing here is time-critical on weekends. Holidays still run — a
  // dead process on a holiday is still dead — but the date-specific checks self-skip.
  if (["Sat", "Sun"].includes(et.weekday)) return { status: "weekend" };
  if (!redis) {
    log.error("[OpsWatch] Redis NOT CONFIGURED — cannot read evidence or persist alert state; watcher is blind");
    return { status: "no_redis" };
  }
  const inputs = await gatherInputs({ redis, now, env, listProcesses });
  const findings = runOpsChecks(inputs);
  for (const f of findings) log.log(`[OpsWatch]   ${f.severity} ${f.check}: ${f.title}`);

  let state = null;
  try { state = await redis.get(OPS_STATE_KEY); } catch (e) { log.error(`[OpsWatch] alert state unreadable (${e.message}); treating as empty`); }
  const plan = planAlerts({ findings, state, now, dateET: et.date, label: "Ops watch" });

  let sent = false;
  if (plan.text && !dryRun) {
    try { await send(plan.text); sent = true; } catch (e) {
      log.error("[OpsWatch] TELEGRAM ALERT FAILED — findings unreported, will retry next run:", e.message);
    }
  }
  if (!dryRun) {
    try {
      await redis.set(OPS_STATE_KEY, JSON.stringify(!plan.text || sent ? plan.stateIfSent : plan.stateIfNotSent));
      await redis.set(OPS_LAST_RUN_KEY, JSON.stringify({ ts: now.toISOString(), date: et.date, findings: findings.length }));
    } catch (e) {
      log.error(`[OpsWatch] state NOT persisted (${e.message}); findings may re-announce next run`);
    }
  }
  log.log(`[OpsWatch] ${findings.length} finding(s); new=${plan.freshFingerprints.length} digest=${plan.digestFingerprints.length} resolved=${plan.clearedTitles.length} sent=${sent}${dryRun ? " (dry run)" : ""}`);
  return { status: "ok", findings, plan, sent };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runOpsWatch({ dryRun: process.argv.includes("--dry-run") });
  console.log(JSON.stringify({ status: result.status, findings: result.findings?.map((f) => `${f.severity} ${f.title}`), message: result.plan?.text ?? null }, null, 2));
  process.exit(0);
}
