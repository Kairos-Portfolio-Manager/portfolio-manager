import { fingerprint } from "../sysloop/fingerprint.js";

// Ops-watch checks: things the evening sentinel cannot see or must not own.
//
//   - Pitch Lab runs in its own PM2 process; the sentinel has no view of it, and
//     scheduler.js is forbidden from referencing it (tests/pitch-lab-daily.test.js).
//   - The broker reader's failure is a CAUSE (CLI logged out); the sentinel only
//     sees the symptom ("holdings-sync did not run today") once a day.
//   - Nothing watches the sentinel itself.
//
// These findings are deliberately NOT part of the sentinel snapshot: that snapshot
// feeds the Phase 0 observer's open_p0_p1 gate, and unrelated operational findings
// must not change the Phase 0 safety clock.
//
// Every check is pure. FAIL CLOSED: an input that could not be read is a finding,
// never a pass. Severity is P1 for "needs a human soon", P2 for log-only detail.

export const READ_FAILURE_THRESHOLD = 3;
export const READ_STUCK_MS = 2 * 60 * 60 * 1000; // one failing request this old is persistent even with few recorded attempts
const READER_PROCESS = "portfolio-broker-reader";
const SCHEDULER_PROCESS = "portfolio-manager";
const PITCH_LAB_PROCESS = "pitch-lab";
const READER_HEARTBEAT_STALE_MS = 30 * 60 * 1000;
const READER_MIN_UPTIME_MS = 10 * 60 * 1000;
const PITCH_LAB_DAILY_DUE_HOUR_ET = 19.5; // daily cycle starts 18:40 and takes ~5 minutes
const SENTINEL_DUE_HOUR_ET = 20.5; // final sentinel runs at 20:10

function finding(check, severity, title, detail, seed) {
  return {
    check,
    severity,
    title,
    detail: String(detail ?? "").slice(0, 500),
    fingerprint: fingerprint(`${check}:${seed ?? title}`),
  };
}

function unreadable(check, what) {
  return finding(check, "P1", `Ops-watch cannot read ${what}`, `${what} was unreadable, so this check could not run (fail closed).`, `unreadable:${what}`);
}

const processEntry = (processes, name) => (Array.isArray(processes) ? processes.find((p) => p?.name === name) : null);

/**
 * Current read-failure state for one MCP read kind, from what the ALREADY-DEPLOYED reader
 * writes: `pm:job:<kind>:last-run` (the latest attempt's signed receipt) and the per-attempt
 * history for THAT REQUEST's date (`pm:job:<kind>:history:<receipt.dateET>` — keyed by the
 * date the request was made for, which can be days old: a failed request stays at the head
 * of the FIFO queue and is retried until it succeeds, so later slots queue behind it).
 * A "failed" outcome is a failed read; "ok" or a completed "mismatch" is not.
 */
export function summarizeReadState({ lastRun, history } = {}) {
  const none = { consecutiveFailures: 0, requestedAt: null, firstFailureAt: null, lastFailureAt: null, lastError: null };
  if (!lastRun || typeof lastRun !== "object" || lastRun.outcome !== "failed") return none;
  const rows = (Array.isArray(history) ? history : []).filter((e) => e && typeof e === "object" && e.requestId === lastRun.requestId);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].outcome === "failed"; i -= 1) streak += 1;
  const failedRows = streak ? rows.slice(rows.length - streak) : [];
  return {
    // The last-run receipt is itself a failed attempt even if the history list was trimmed.
    consecutiveFailures: Math.max(1, streak),
    requestedAt: lastRun.requestedAt ?? null,
    firstFailureAt: failedRows[0]?.completedAt ?? failedRows[0]?.ts ?? lastRun.completedAt ?? null,
    lastFailureAt: lastRun.completedAt ?? lastRun.ts ?? null,
    lastError: lastRun.error ?? null,
  };
}

/** Strip the CLI's JSON dump: keep only the human part before the first "{". */
export function summarizeReadError(error) {
  return String(error ?? "").split("{")[0].replace(/\s+/g, " ").replace(/[:\s]+$/, "").slice(0, 140) || "no error text captured";
}

export function checkProcessOnline({ processes, name, check, label, nowMs }) {
  if (!Array.isArray(processes)) return [unreadable(check, "the PM2 process list")];
  const entry = processEntry(processes, name);
  if (!entry) return [finding(check, "P1", `${label} is not registered in PM2`, `No PM2 process named ${name}.`, `${name}:absent`)];
  const status = entry.pm2_env?.status;
  if (status !== "online") {
    return [finding(check, "P1", `${label} is ${status ?? "in an unknown state"}`, `PM2 reports ${name} as ${status ?? "unknown"}.`, `${name}:not-online`)];
  }
  return [];
}

/**
 * Broker reader (Jetson PM2 `portfolio-broker-reader`):
 *   - process must be online
 *   - it must be heartbeating `pm:broker-reader:last-seen` (the key it actually writes;
 *     the sentinel's `pm:companion:last-seen` is the Mac executor's, not this one)
 *   - consecutive MCP read failures >= threshold -> a named, readable alert (streak derived from the
 *     reader's own receipt history, so it works with the reader as already deployed)
 */
export function checkBrokerReader({ processes, heartbeatMs, readHealth, nowMs }) {
  const out = checkProcessOnline({ processes, name: READER_PROCESS, check: "broker-reader", label: "Broker reader", nowMs });
  const entry = processEntry(processes, READER_PROCESS);

  if (entry?.pm2_env?.status === "online") {
    const uptimeMs = Number.isFinite(entry.pm2_env.pm_uptime) ? nowMs - entry.pm2_env.pm_uptime : null;
    const settled = uptimeMs === null || uptimeMs > READER_MIN_UPTIME_MS;
    if (heartbeatMs === undefined) {
      out.push(unreadable("broker-reader", "the broker reader heartbeat"));
    } else if (settled && (!Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > READER_HEARTBEAT_STALE_MS)) {
      const detail = Number.isFinite(heartbeatMs)
        ? `Last heartbeat ${Math.round((nowMs - heartbeatMs) / 60000)} min ago (limit ${READER_HEARTBEAT_STALE_MS / 60000}).`
        : "pm:broker-reader:last-seen is missing (its TTL is 1h).";
      out.push(finding("broker-reader", "P1", "Broker reader is running but not heartbeating", detail, "heartbeat"));
    }
  }

  if (readHealth === undefined) {
    out.push(unreadable("broker-reader", "the broker read receipt history"));
  } else if (readHealth) {
    for (const [kind, state] of Object.entries(readHealth)) {
      const failures = Number(state?.consecutiveFailures ?? 0);
      if (!Number.isFinite(failures) || failures < 1) continue;
      const stuckMs = Number.isFinite(Date.parse(state.requestedAt)) ? nowMs - Date.parse(state.requestedAt) : 0;
      // Persistent = several failed attempts in a row, or one request that has been failing for hours.
      if (failures < READ_FAILURE_THRESHOLD && stuckMs < READ_STUCK_MS) continue;
      const stamp = (iso) => String(iso).slice(0, 16).replace("T", " ") + "Z";
      const stuck = state.requestedAt ? `; the request from ${stamp(state.requestedAt)} is still unfulfilled` : "";
      const last = state.lastFailureAt ? ` Last attempt ${stamp(state.lastFailureAt)}.` : "";
      out.push(finding(
        "broker-reader",
        "P1",
        `Broker reads failing: ${kind} (${failures} failed attempt${failures === 1 ? "" : "s"}${stuck})`,
        `${summarizeReadError(state.lastError)}.${last} If it is a Claude CLI failure, run \`claude auth status\` on the Jetson. Nothing new syncs until it succeeds (later reads queue behind it).`,
        `reads:${kind}`,
      ));
    }
  }
  return out;
}

function lastSaturday(dateET) {
  const day = new Date(`${dateET}T12:00:00Z`);
  let back = ((day.getUTCDay() - 6 + 7) % 7) || 7;
  day.setUTCDate(day.getUTCDate() - back);
  return day.toISOString().slice(0, 10);
}

const delivered = (marker) => typeof marker === "string" && /^\d{4}-\d{2}-\d{2}T/.test(marker);

/**
 * Pitch Lab (separate PM2 process, paper only). `enabled` mirrors PITCH_LAB_ENABLED as seen by
 * the watcher; when false the process is intentionally idle and nothing is checked.
 *
 * Evidence is the same Redis markers Pitch Lab itself writes:
 *   pitchlab:run:daily:<date>          JSON { status, pitched, failedCount, shortfall, ... }
 *   pitchlab:telegram:daily:<date>     ISO timestamp once the digest was delivered ("sending" = in flight/failed)
 *   pitchlab:telegram:weekly:<date>    same, for the Saturday report
 */
export function checkPitchLab({ enabled, processes, nowET, isTradingDay, dailyRun, dailyDigest, weeklyDigest, nowMs }) {
  if (!enabled) return [];
  const out = checkProcessOnline({ processes, name: PITCH_LAB_PROCESS, check: "pitch-lab", label: "Pitch Lab", nowMs });
  const hour = nowET.hour + nowET.minute / 60;

  // The weekly report runs every Saturday (holidays included), so it is checked EVERY day, not only on
  // trading days: a failed Saturday report must page Saturday, not Monday.
  const saturday = weeklyTarget(nowET);
  if (weeklyDigest === undefined) out.push(unreadable("pitch-lab", "the Pitch Lab weekly delivery marker"));
  else if (!delivered(weeklyDigest)) {
    out.push(finding("pitch-lab", "P1", `Pitch Lab weekly report for ${saturday} was not delivered`, `pitchlab:telegram:weekly:${saturday} is ${weeklyDigest === null ? "missing" : "still marked in-flight"}. The Saturday 10:00 ET report should have published and sent.`, "digest:weekly"));
  }

  if (!isTradingDay) return out;

  if (hour >= PITCH_LAB_DAILY_DUE_HOUR_ET) {
    if (dailyRun === undefined) {
      out.push(unreadable("pitch-lab", "the Pitch Lab daily run marker"));
    } else if (dailyRun === null) {
      out.push(finding("pitch-lab", "P1", "Pitch Lab daily run did not complete today", `No pitchlab:run:daily:${nowET.date} marker by ${PITCH_LAB_DAILY_DUE_HOUR_ET}:00 ET (the run starts 18:40). Check the pitch-lab PM2 process and its logs.`, "daily:missing"));
    } else {
      if (dailyRun.status === "no_catalog") out.push(finding("pitch-lab", "P1", "Pitch Lab found no company catalog today", "The run recorded status no_catalog, so zero pitches were made.", "daily:no_catalog"));
      else if (dailyRun.status === "budget_stop") out.push(finding("pitch-lab", "P1", "Pitch Lab stopped at its budget boundary", `Pitched ${dailyRun.pitched ?? 0} of ${dailyRun.selected ?? "?"} before the run cap or monthly budget stopped it.`, "daily:budget_stop"));
      else if (!(dailyRun.pitched > 0)) out.push(finding("pitch-lab", "P1", "Pitch Lab made zero pitches today", `Run status ${dailyRun.status ?? "unknown"}, selected ${dailyRun.selected ?? "?"}, dropped ${dailyRun.failedCount ?? "?"}.`, "daily:zero"));
      else if (dailyRun.failedCount > 0 || dailyRun.shortfall > 0) out.push(finding("pitch-lab", "P2", "Pitch Lab run was partial", `Pitched ${dailyRun.pitched}, dropped ${dailyRun.failedCount ?? 0}, shortfall ${dailyRun.shortfall ?? 0}.`, "daily:partial"));

      if (dailyDigest === undefined) out.push(unreadable("pitch-lab", "the Pitch Lab digest delivery marker"));
      else if (!delivered(dailyDigest)) out.push(finding("pitch-lab", "P1", "Pitch Lab daily digest was not delivered", `pitchlab:telegram:daily:${nowET.date} is ${dailyDigest === null ? "missing" : "still marked in-flight"}, so the Telegram digest did not confirm delivery.`, "digest:daily"));
    }
  }

  return out;
}

/**
 * Which Saturday's weekly report should exist by now. On a Saturday it is today's (due after 11:00
 * ET: the 10:00 job plus margin); every other day it is the most recent past Saturday. The report job
 * runs every Saturday regardless of market holidays.
 */
export function weeklyTarget(nowET) {
  if (nowET.weekday === "Sat") return nowET.hour + nowET.minute / 60 >= 11 ? nowET.date : lastSaturday(nowET.date);
  return lastSaturday(nowET.date);
}

export { lastSaturday };

/**
 * Nothing else watches the sentinel. If the scheduler is down or the 20:10 run never
 * happened, every other sentinel-based alert silently stops.
 */
export function checkSentinelLiveness({ processes, lastRun, nowET, isTradingDay, nowMs }) {
  const out = checkProcessOnline({ processes, name: SCHEDULER_PROCESS, check: "sentinel", label: "Portfolio Manager scheduler", nowMs });
  if (!isTradingDay) return out;
  if (nowET.hour + nowET.minute / 60 < SENTINEL_DUE_HOUR_ET) return out;
  if (lastRun === undefined) out.push(unreadable("sentinel", "the sentinel last-run record"));
  else if (!lastRun || lastRun.date !== nowET.date) {
    out.push(finding("sentinel", "P1", "System sentinel did not run today", `Last recorded run: ${lastRun?.date ?? "never"} (the final run is due at 20:10 ET). Without it, the sentinel's alerts are silent.`, "missed"));
  }
  return out;
}

export function runOpsChecks(inputs) {
  return [
    ...checkBrokerReader(inputs.reader),
    ...checkPitchLab(inputs.pitchLab),
    ...checkSentinelLiveness(inputs.sentinel),
  ];
}
