import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../config/agents.js";
import { buildPhase0Observation, formatPhase0Observation } from "../lib/phase0-observer.js";
import { isTradingDate, etDateString } from "../lib/market-calendar.js";
import { getRedis, listOpenReconciliations } from "../lib/redis.js";
import { buildResearchRunReport } from "../lib/research-run-report.js";
import { getAnthropicBudgetReadiness } from "../lib/anthropic-monthly-budget.js";
import { sendMessage } from "../lib/telegram.js";
import { signPhase0Observation, assertPhase0Observation } from "../lib/phase0-observation-ledger.js";
import { getOperationalLedgerSecret } from "../lib/operational-ledger.js";
import { expectedJobInvocationIds, jobInvocationHistoryKey } from "../lib/job-invocation-history.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DAILY_PREFIX = "pm:phase0-observation:";
const INDEX_KEY = "pm:phase0-observation:index";
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

export function shouldSendPhase0Telegram(record, env = process.env) {
  if (env.PHASE0_TELEGRAM_MODE?.trim() === "all") return true;
  // Phase 0 remains a durable internal record. Phones are reserved for a real
  // trust/safety failure; routine passes and research-sample warnings belong on
  // the dashboard now that Pitch Lab owns the observation conversation.
  if (record?.trustVerdict !== "FAIL") return false;
  const blockingTrust = (record.checks ?? []).filter((row) =>
    ["TRUST", "BOTH"].includes(row?.domain) && ["fail", "insufficient"].includes(row?.status));
  const parityOnly = blockingTrust.length > 0
    && blockingTrust.every((row) => ["transactional_parity", "valuation_status"].includes(row.name));
  return !parityOnly;
}

export async function deliverPhase0Telegram(record, {
  redis,
  env = process.env,
  send = sendMessage,
  now = () => new Date(),
} = {}) {
  const deliveryKey = `${DAILY_PREFIX}${record.dateET}:telegram-sent`;
  if (await redis.get(deliveryKey)) return { status: "already_recorded" };
  if (!shouldSendPhase0Telegram(record, env)) {
    await redis.set(deliveryKey, "suppressed:action-only", { ex: RETENTION_SECONDS });
    return { status: "suppressed", marker: "suppressed:action-only" };
  }
  const message = formatPhase0Observation(record);
  await send(message);
  await redis.set(deliveryKey, now().toISOString(), { ex: RETENTION_SECONDS });
  return { status: "sent", message };
}
const MAX_DAYS = 90;
const SENTINEL_MAX_AGE_MS = 30 * 60 * 1000;
const PERSISTENCE_CUTOFF_MINUTE_ET = 20 * 60 + 20;
const DEFAULT_ARCHIVE_DIR = path.join(REPO_ROOT, "ops", "phase0-observations");
const OPERATOR_EXCEPTION_FILE = path.join(REPO_ROOT, "config", "phase0-operator-exceptions.json");
const ENSURE_OBSERVATION_INDEX_SCRIPT = `
redis.call("LREM", KEYS[1], 0, ARGV[1])
redis.call("LPUSH", KEYS[1], ARGV[1])
redis.call("LTRIM", KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))
return 1
`;

function getMcpReceiptSecret(env = process.env) {
  const secret = env.MCP_RECEIPT_HMAC_SECRET?.trim();
  if (!secret) throw new Error("MCP_RECEIPT_HMAC_SECRET is required; unsigned broker-read receipts cannot count toward Phase 0.");
  return secret;
}

function parse(raw) {
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function dateET(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return etDateString(date);
}

function weekdayET(now) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
}

export function finalSentinelIsFresh(snapshot, now, observationDate = etDateString(now)) {
  const capturedMs = Date.parse(snapshot?.ts ?? "");
  const ageMs = Number.isFinite(capturedMs) ? now.getTime() - capturedMs : Infinity;
  return snapshot?.date === observationDate && ageMs >= 0 && ageMs <= SENTINEL_MAX_AGE_MS;
}

export function dueObservedJobs(now = new Date()) {
  const weekday = weekdayET(now);
  const jobs = [
    { name: "holdings-sync", domain: "TRUST" },
    { name: "order-reconciliation", domain: "TRUST" },
    { name: "intraday-monitor", domain: "TRUST" },
    { name: "performance-review", domain: "SKILL" },
    { name: "verify-ledgers", domain: "TRUST" },
    { name: "system-sentinel", domain: "TRUST" },
    { name: "shadow-positions-refresh", domain: "TRUST" },
    { name: "db-parity", domain: "TRUST" },
  ];
  if (["Mon", "Tue", "Wed", "Thu"].includes(weekday)) {
    jobs.push({ name: "exit-monitor", domain: "TRUST" }, { name: "research-scan", domain: "SKILL" });
  }
  return jobs;
}

export function dueCriticalJobNames(now = new Date()) {
  return dueObservedJobs(now).map((job) => job.name);
}

export function observationPersistenceWindowIsOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return (value("hour") % 24) * 60 + value("minute") >= PERSISTENCE_CUTOFF_MINUTE_ET;
}

export async function deployedRevision({ env = process.env, exec = execFileAsync } = {}) {
  // The trusted PM2 restart wrapper pins the code actually loaded by the
  // process. Prefer that identity over repository HEAD, which may move later
  // through a docs-only pull without restarting the runtime.
  const configured = [env.SYSLOOP_DEPLOYED_COMMIT, env.RESEARCH_CODE_REVISION, env.GIT_COMMIT, env.VERCEL_GIT_COMMIT_SHA]
    .map((value) => value?.trim()).find(Boolean);
  let commit = configured ?? null;
  let branch = env.SYSLOOP_DEPLOYED_BRANCH?.trim() || env.GIT_BRANCH?.trim() || null;
  let startedAt = env.SYSLOOP_DEPLOYED_AT?.trim() || null;
  if (!commit || !branch || !startedAt) {
    try {
      const pm2 = JSON.parse((await exec("pm2", ["jlist"], { cwd: REPO_ROOT })).stdout);
      const processName = env.SYSLOOP_PM2_NAME?.trim() || "portfolio-manager";
      const runtime = pm2.find((entry) => entry?.name === processName)?.pm2_env;
      if (!commit) commit = runtime?.SYSLOOP_DEPLOYED_COMMIT?.trim() || null;
      if (!branch) branch = runtime?.SYSLOOP_DEPLOYED_BRANCH?.trim() || null;
      if (!startedAt) startedAt = runtime?.SYSLOOP_DEPLOYED_AT?.trim() || null;
    } catch (error) {
      console.warn(`[Phase0] PM2 deployed identity lookup incomplete: ${error.message}`);
    }
  }
  try {
    if (!commit) commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
    if (!branch) branch = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
  } catch (error) {
    console.warn(`[Phase0] git revision lookup incomplete: ${error.message}`);
  }
  return { commit, branch, startedAt };
}

function localPolicyVersions() {
  const mandateVersions = {};
  for (const agent of AGENTS) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "agents", agent.id, "mandate.json"), "utf8"));
      mandateVersions[agent.id] = value.mandateVersion ?? null;
    } catch {
      mandateVersions[agent.id] = null;
    }
  }
  let researchSelection = null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "research-selection.json"), "utf8"));
    researchSelection = { policyVersion: value.policyVersion ?? null, mode: value.mode ?? null };
  } catch {
    researchSelection = null;
  }
  return { mandateVersions, researchSelection };
}

function operatorExceptionsForDate(dateET) {
  try {
    const policy = JSON.parse(fs.readFileSync(OPERATOR_EXCEPTION_FILE, "utf8"));
    if (!Array.isArray(policy?.exceptions)) throw new Error("exceptions must be an array");
    return {
      exceptions: policy.exceptions.filter((entry) => entry?.dateET === dateET),
      policyRelease: policy.policyOnlyRelease?.dateET === dateET ? policy.policyOnlyRelease : null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exceptions: [], policyRelease: null };
    throw new Error(`Phase 0 operator-exception policy is unreadable: ${error.message}`);
  }
}

export function selectUnobservedScheduledResearch(statuses, consumedRunIds, now, { maxAgeHours = 72 } = {}) {
  const consumed = new Set(consumedRunIds ?? []);
  const seen = new Set();
  return (statuses ?? []).filter((status) => {
    const runId = String(status?.runId ?? "").trim();
    const completedMs = Date.parse(status?.completedAt ?? "");
    const ageHours = Number.isFinite(completedMs) ? (now.getTime() - completedMs) / 3_600_000 : Infinity;
    if (status?.source !== "scheduled" || !runId || seen.has(runId) || consumed.has(runId)) return false;
    seen.add(runId);
    return ageHours >= 0 && ageHours <= maxAgeHours;
  });
}

export async function consumedResearchRunIds(redis, secret) {
  const dates = await redis.lrange(INDEX_KEY, 0, MAX_DAYS - 1);
  if (!Array.isArray(dates)) throw new Error("Phase 0 observation index is unreadable.");
  if (!dates.length) return [];
  const rows = await redis.mget(...dates.map((date) => `${DAILY_PREFIX}${date}`));
  if (!Array.isArray(rows) || rows.length !== dates.length || rows.some((row) => row == null)) {
    throw new Error("One or more indexed Phase 0 observations are unreadable.");
  }
  const consumed = new Set();
  for (const raw of rows ?? []) {
    const record = parse(raw);
    assertPhase0Observation(record, secret);
    const evidence = record?.checks?.find((row) => row?.name === "research_accounting")?.evidence;
    for (const runId of evidence?.runIds ?? [evidence?.runId]) if (runId) consumed.add(runId);
  }
  return [...consumed];
}

export async function latestScheduledResearch(redis, now, weekday, consumedRunIds = []) {
  const rows = await redis.lrange("pm:research-scan:history", 0, 49).catch(() => null);
  if (!Array.isArray(rows)) {
    // An unreadable history must surface as insufficient evidence, never as
    // "no sample due"; requiredRunPresent=null routes to the fail-closed branch.
    return { fresh: false, requiredRunPresent: null, newSample: false, reports: [], report: null, completedAt: null };
  }
  const statuses = selectUnobservedScheduledResearch(rows.map(parse), consumedRunIds, now);
  const expectedSameDay = ["Mon", "Tue", "Wed", "Thu"].includes(weekday);
  const currentDayPresent = statuses.some((status) => dateET(status.completedAt) === etDateString(now));
  const fresh = expectedSameDay ? currentDayPresent : statuses.length > 0;
  return {
    fresh,
    // Monday must have its own run even when an unconsumed Sunday (Friday-close)
    // sample is retained. Sunday evidence remains useful but cannot satisfy
    // Monday's required scheduler cadence.
    requiredRunPresent: expectedSameDay ? currentDayPresent : true,
    // A prior Mon-Thu run may remain useful context on Friday, but it is never
    // a second research-cohort sample merely because Friday has an observation.
    newSample: statuses.length > 0,
    reports: statuses.map(buildResearchRunReport),
    report: statuses.length === 1 ? buildResearchRunReport(statuses[0]) : null,
    completedAt: statuses[0]?.completedAt ?? null,
  };
}

async function proposalQueueCounts(redis) {
  const ids = await redis.lrange("pm:approval_proposals", 0, 249);
  const rows = await Promise.all(ids.map((id) => redis.get(`pm:approval_proposal:${id}`).then(parse).catch(() => null)));
  const valid = rows.filter(Boolean);
  return valid.reduce((counts, proposal) => {
    counts.total += 1;
    const key = String(proposal.status ?? "unknown");
    counts.byStatus[key] = (counts.byStatus[key] ?? 0) + 1;
    if (proposal.fulfilledAt) counts.fulfilled += 1;
    return counts;
  }, { total: 0, fulfilled: 0, byStatus: {} });
}

export function mapAnthropicBudgetReadiness(readiness, capacityEvidence = {}, observationDate = null) {
  const hasMonitoringOverride = Object.prototype.hasOwnProperty.call(capacityEvidence, "preventedProtectedMonitoring");
  const protectedDeniedDate = dateET(readiness?.protectedCapacityLastDeniedAt);
  const protectedDeniedToday = readiness?.protectedCapacityDenied === false
    ? false
    : readiness?.protectedCapacityDenied === true && observationDate && protectedDeniedDate === observationDate
      ? true
      : null;
  return {
    monthly: readiness ? {
      schemaVersion: readiness.schemaVersion,
      monthUtc: readiness.monthUtc,
      status: readiness.status,
      capStatus: readiness.capStatus,
      telemetryStatus: readiness.telemetryStatus,
      pricingVersion: readiness.pricingVersion,
      spentUsd: readiness.spentUsd,
      reservedUsd: readiness.reservedUsd,
      remainingUsd: readiness.remainingUsd,
      thresholds: readiness.thresholds ? {
        ceilingUsd: readiness.thresholds.ceilingUsd,
        warnPct: readiness.thresholds.warnPct,
        warningAtUsd: readiness.thresholds.warningAtUsd,
      } : null,
      coverage: readiness.coverage ? {
        retentionDays: readiness.coverage.retentionDays,
        startUtc: readiness.coverage.startUtc,
        endUtc: readiness.coverage.endUtc,
        pricedRecords: readiness.coverage.pricedRecords,
        issueCount: readiness.coverage.issueCount,
      } : null,
      protectedCapacityDenied: readiness.protectedCapacityDenied,
      protectedCapacityLastDeniedAt: readiness.protectedCapacityLastDeniedAt,
    } : null,
    // Provider quota/headroom is not part of Anthropic's monthly readiness
    // contract. Keep this explicit injected seam for runtime evidence/tests.
    providerCapacityStatus: capacityEvidence.providerCapacityStatus ?? null,
    preventedProtectedMonitoring: hasMonitoringOverride
      ? capacityEvidence.preventedProtectedMonitoring
      : protectedDeniedToday,
  };
}

export async function gatherPhase0Evidence({
  now = new Date(),
  redis = getRedis(),
  exec = execFileAsync,
  budgetReadiness = getAnthropicBudgetReadiness,
  capacityEvidence = {},
  secret = getOperationalLedgerSecret(),
  mcpReceiptSecret = getMcpReceiptSecret(),
} = {}) {
  if (!redis) throw new Error("Redis is not configured; Phase 0 evidence cannot be read or recorded.");
  const observationDate = etDateString(now);
  const weekday = weekdayET(now);
  const observedJobs = dueObservedJobs(now);
  const jobNames = observedJobs.map((job) => job.name);
  const historyJobs = ["holdings-sync", "order-reconciliation", "intraday-monitor", "system-sentinel"];
  const consumedRunIds = await consumedResearchRunIds(redis, secret);
  const [jobRows, historyRows, parityRaw, sentinelRaw, reconciliations, research, queueCounts, revision, agent4Raw, readiness] = await Promise.all([
    redis.mget(...jobNames.map((name) => `pm:job:${name}:last-run`)).catch(() => null),
    Promise.all(historyJobs.map((name) => redis.lrange(jobInvocationHistoryKey(name, observationDate), 0, 99).catch(() => null))),
    redis.get("pm:pg-parity:latest").catch(() => null),
    redis.get(`pm:sysloop:snapshot:${observationDate}`).catch(() => null),
    listOpenReconciliations(),
    latestScheduledResearch(redis, now, weekday, consumedRunIds),
    proposalQueueCounts(redis).catch(() => null),
    deployedRevision({ exec }),
    redis.get("pm:allocation-policy:active").catch(() => null),
    budgetReadiness({ now, redis }).catch(() => null),
  ]);
  const jobs = observedJobs.map((job, index) => ({ ...job, run: parse(jobRows?.[index]) }));
  const scheduledInvocations = historyJobs.map((name, index) => ({
    name,
    expected: expectedJobInvocationIds(name, observationDate),
    records: Array.isArray(historyRows?.[index]) ? historyRows[index].map(parse) : null,
  }));
  const parity = parse(parityRaw);
  const sentinel = parse(sentinelRaw);
  const agent4 = parse(agent4Raw);
  const policies = { ...localPolicyVersions(), agent4PolicyVersion: agent4?.version ?? null };
  const sentinelMs = Date.parse(sentinel?.ts ?? "");
  const sentinelAgeMs = Number.isFinite(sentinelMs) ? now.getTime() - sentinelMs : Infinity;
  const intradayHistory = scheduledInvocations.find((entry) => entry.name === "intraday-monitor");
  const holdingMonitoring = (intradayHistory?.expected ?? []).map((invocationId) => {
    const matches = (intradayHistory?.records ?? []).filter((row) => row?.invocationId === invocationId);
    return { name: "intraday-monitor", invocationId, coverage: matches.at(-1)?.evidence?.holdingMonitoring ?? null };
  });
  if (["Mon", "Tue", "Wed", "Thu"].includes(weekday)) {
    holdingMonitoring.push({
      name: "exit-monitor",
      coverage: jobs.find((job) => job.name === "exit-monitor")?.run?.evidence?.holdingMonitoring ?? null,
    });
  }
  const operatorExceptionPolicy = operatorExceptionsForDate(observationDate);
  return {
    dateET: observationDate,
    observedAt: now.toISOString(),
    tradingDay: isTradingDate(observationDate),
    criticalJobs: jobs,
    scheduledInvocations,
    sentinel: {
      fresh: finalSentinelIsFresh(sentinel, now, observationDate),
      capturedAt: sentinel?.ts ?? null,
      ageMs: Number.isFinite(sentinelAgeMs) ? sentinelAgeMs : null,
      anomalies: sentinel?.anomalies ?? null,
    },
    holdingMonitoring,
    openReconciliations: reconciliations,
    parity: parity ? {
      ...parity,
      fresh: dateET(parity.comparedAt) === observationDate,
      transactional: parity.transactional ?? parity.transactionalParity ?? null,
      valuation: parity.valuation ?? parity.valuationStatus ?? parity.valuationParity ?? null,
    } : null,
    research,
    capacity: mapAnthropicBudgetReadiness(readiness, capacityEvidence, observationDate),
    proposalQueue: queueCounts,
    operatorExceptions: operatorExceptionPolicy.exceptions,
    operatorPolicyRelease: operatorExceptionPolicy.policyRelease,
    deployment: { ...revision, policies },
    // Used only by the in-memory verdict builder; it is never persisted.
    mcpReceiptSecret,
  };
}

export function archivePhase0Observation(record, {
  archiveDir = process.env.PHASE0_EVIDENCE_DIR?.trim() || DEFAULT_ARCHIVE_DIR,
  secret = getOperationalLedgerSecret(),
} = {}) {
  assertPhase0Observation(record, secret);
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `${record.dateET}.json`);
  if (fs.existsSync(archivePath)) {
    const existing = parse(fs.readFileSync(archivePath, "utf8"));
    assertPhase0Observation(existing, secret);
    if (existing.rowHmac !== record.rowHmac) throw new Error(`Phase 0 archive conflict for ${record.dateET}.`);
    return { created: false, path: archivePath, record: existing };
  }
  fs.writeFileSync(archivePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { created: true, path: archivePath, record };
}

function readArchivedPhase0Observation(dateET, { archiveDir, secret }) {
  const archivePath = path.join(archiveDir, `${dateET}.json`);
  if (!fs.existsSync(archivePath)) return null;
  const archived = parse(fs.readFileSync(archivePath, "utf8"));
  assertPhase0Observation(archived, secret);
  if (archived.dateET !== dateET) throw new Error(`Phase 0 archive date mismatch for ${dateET}.`);
  return archived;
}

async function ensureObservationIndex(redis, dateET) {
  // One atomic Redis operation: a lost client response can be retried safely,
  // while no process can observe a daily record without its repaired index.
  await redis.eval(ENSURE_OBSERVATION_INDEX_SCRIPT, [INDEX_KEY], [
    dateET, String(MAX_DAYS), String(RETENTION_SECONDS),
  ]);
}

export async function persistPhase0Observation(record, {
  redis = getRedis(),
  secret = getOperationalLedgerSecret(),
  archiveDir = process.env.PHASE0_EVIDENCE_DIR?.trim() || DEFAULT_ARCHIVE_DIR,
} = {}) {
  if (!redis) throw new Error("Redis is not configured; Phase 0 observation cannot be recorded.");
  assertPhase0Observation(record, secret);
  const key = `${DAILY_PREFIX}${record.dateET}`;
  const current = parse(await redis.get(key));
  if (current) {
    assertPhase0Observation(current, secret);
    archivePhase0Observation(current, { archiveDir, secret });
    await ensureObservationIndex(redis, record.dateET);
    return { created: false, record: current };
  }
  // The archive is written before Redis. If that Redis write previously failed,
  // the verified archive is already the immutable canonical record for the day;
  // replay it rather than conflicting with a newly generated observedAt/HMAC.
  const archived = readArchivedPhase0Observation(record.dateET, { archiveDir, secret });
  const canonical = archived ?? record;
  archivePhase0Observation(canonical, { archiveDir, secret });
  const payload = JSON.stringify(canonical);
  const inserted = await redis.set(key, payload, { nx: true, ex: RETENTION_SECONDS });
  if (!inserted) {
    const raced = parse(await redis.get(key));
    assertPhase0Observation(raced, secret);
    archivePhase0Observation(raced, { archiveDir, secret });
    await ensureObservationIndex(redis, record.dateET);
    return { created: false, record: raced };
  }
  await ensureObservationIndex(redis, record.dateET);
  return { created: true, record: canonical };
}

export async function runPhase0Observer(options = {}) {
  const evidence = await gatherPhase0Evidence(options);
  const unsignedRecord = {
    ...buildPhase0Observation(evidence),
    metrics: { proposalQueue: evidence.proposalQueue },
  };
  if (options.persist !== true) {
    console.log(`[Phase0] DRY RUN — no observation was persisted or sent. ${formatPhase0Observation(unsignedRecord).replaceAll("\n", " | ")}`);
    return unsignedRecord;
  }
  if (!observationPersistenceWindowIsOpen(options.now ?? new Date())) {
    throw new Error("Phase 0 persistence is locked until 8:20 PM ET so partial-day evidence cannot become immutable.");
  }
  const secret = options.secret ?? getOperationalLedgerSecret();
  const record = signPhase0Observation(unsignedRecord, secret);
  const persisted = await persistPhase0Observation(record, { ...options, secret });
  const retained = persisted.record;
  const redis = options.redis ?? getRedis();
  if (!persisted.created) console.log(`[Phase0] ${record.dateET} already has an immutable observation; existing record retained.`);
  const delivery = await deliverPhase0Telegram(retained, { redis, env: options.env, send: options.send, now: () => options.now ?? new Date() });
  if (delivery.status === "suppressed") {
    console.log(`[Phase0] ${record.dateET} retained without Telegram (action-only policy).`);
    return retained;
  }
  if (delivery.status === "sent") console.log(`[Phase0] ${delivery.message.replaceAll("\n", " | ")}`);
  return retained;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const persist = process.argv.slice(2).includes("--persist");
  runPhase0Observer({ persist })
    .then((record) => process.exit(record.verdict === "PASS_BOTH" || record.verdict === "SKIP" ? 0 : 2))
    .catch((error) => {
      console.error("[Phase0] observer failed:", error.message);
      process.exit(1);
    });
}
