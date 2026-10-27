import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleSnapshot, persistSnapshot, redisGuardSet } from "../lib/sysloop/snapshot.js";
import { getRedis } from "../lib/redis.js";
import { planAlerts } from "../lib/alerting/policy.js";
import { sendMessage } from "../lib/telegram.js";

// Tier 0 of the system autoresearch loop (docs/SYSTEM-LOOP-PLAN.md).
// Deterministic only — no LLM calls ever happen on the Jetson. Observes the
// system, publishes a snapshot to Redis for the Mac tier, and Telegrams P0/P1s
// per lib/alerting/policy.js: new ones immediately, every still-open one in a
// once-a-day digest with its age (so a known-broken thing is never silent for
// more than a day), and a note when one resolves. A failed send is retried next
// run instead of being recorded as announced.
//
// Write surface: pm:sysloop:* keys, ops/health/*.json, Telegram. Nothing else.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ALERT_STATE_KEY = "pm:sysloop:alert-state";

// Alerting is this job's OUTPUT, but it must never become a reason the job
// fails: the snapshot feeds the Phase 0 observer. Every failure here is loud in
// the logs and non-fatal.
export async function deliverSentinelAlerts({ snapshot, prevAnomalyFingerprints, redis = getRedis(), send = sendMessage, now = new Date(), log = console }) {
  let state = null;
  try {
    state = redis ? await redis.get(ALERT_STATE_KEY) : null;
  } catch (e) {
    log.error(`[Sysloop] alert state unreadable (${e.message}); treating as empty`);
  }
  const plan = planAlerts({
    findings: snapshot.anomalies,
    state,
    now,
    dateET: snapshot.date,
    legacyKnown: prevAnomalyFingerprints,
    label: "System sentinel",
  });
  let sent = false;
  if (plan.text) {
    try {
      await send(plan.text);
      sent = true;
    } catch (e) {
      // Not recorded as announced, so the next run retries.
      log.error("[Sysloop] TELEGRAM ALERT FAILED — urgent findings unreported, will retry next run:", e.message);
    }
  }
  if (!redis) {
    log.error("[Sysloop] Redis NOT CONFIGURED — alert state not persisted; every urgent finding will re-announce next run");
    return { plan, sent, persisted: false };
  }
  try {
    await redisGuardSet(redis, ALERT_STATE_KEY, !plan.text || sent ? plan.stateIfSent : plan.stateIfNotSent);
    return { plan, sent, persisted: true };
  } catch (e) {
    log.error(`[Sysloop] alert state NOT persisted (${e.message}); findings may re-announce next run`);
    return { plan, sent, persisted: false };
  }
}

export function assertSentinelPublished(published) {
  if (published !== true) throw new Error("System sentinel snapshot was not durably published; refusing a false-green scheduled run.");
  return true;
}

export async function runSystemSentinel({ dryRun = false } = {}) {
  const started = Date.now();
  console.log(`[Sysloop] Sentinel run starting...${dryRun ? " (dry run — no Redis publish, no Telegram)" : ""}`);

  const { snapshot, nextState, prevAnomalyFingerprints, consumedDeployMarkerKeys } = await assembleSnapshot({ repoRoot: REPO_ROOT });

  const prev = new Set(prevAnomalyFingerprints);
  const fresh = snapshot.anomalies.filter((a) => !prev.has(a.fingerprint));
  const urgent = fresh.filter((a) => a.severity === "P0" || a.severity === "P1");

  console.log(
    `[Sysloop] ${snapshot.anomalies.length} anomalies (${JSON.stringify(snapshot.stats.bySeverity)}), ` +
    `${fresh.length} new since last run, ${urgent.length} urgent`
  );
  for (const a of snapshot.anomalies) console.log(`[Sysloop]   ${a.severity} ${a.check}: ${a.title}`);

  if (!dryRun) {
    const outcome = await deliverSentinelAlerts({ snapshot, prevAnomalyFingerprints });
    console.log(
      `[Sysloop] alerts: ${outcome.plan.freshFingerprints.length} new, ${outcome.plan.digestFingerprints.length} in digest, ` +
      `${outcome.plan.clearedTitles.length} resolved, sent=${outcome.sent}, statePersisted=${outcome.persisted}`
    );
  }

  const published = dryRun ? false : await persistSnapshot({
    snapshot,
    nextState,
    repoRoot: REPO_ROOT,
    consumedDeployMarkerKeys,
  });
  if (!dryRun) assertSentinelPublished(published);
  console.log(`[Sysloop] Done in ${Date.now() - started}ms (published=${published})`);
  return snapshot;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runSystemSentinel({ dryRun: process.argv.includes("--dry-run") })
    .then((s) => process.exit(s.anomalies.some((a) => a.severity === "P0") ? 2 : 0))
    .catch((e) => {
      console.error("[Sysloop] Sentinel crashed:", e);
      process.exit(1);
    });
}
