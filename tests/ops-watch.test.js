import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkBrokerReader, checkPitchLab, checkSentinelLiveness, lastSaturday, summarizeReadError, summarizeReadHistory, READ_FAILURE_THRESHOLD, runOpsChecks,
} from "../lib/ops-watch/checks.js";
import { runOpsWatch, gatherInputs, OPS_STATE_KEY, etParts } from "../jobs/ops-watch.js";

const NOW = Date.parse("2026-10-26T13:00:00Z");
const online = (name, uptimeMs = 3600000) => ({ name, pm2_env: { status: "online", pm_uptime: NOW - uptimeMs } });
const procs = (...extra) => [online("portfolio-broker-reader"), online("pitch-lab"), online("portfolio-manager"), ...extra];
const et = (date, hour, minute = 0, weekday = "Mon") => ({ date, hour, minute, weekday });
const titles = (findings) => findings.map((f) => `${f.severity} ${f.title}`);

test("reader: healthy reader, fresh heartbeat, no failures -> nothing", () => {
  assert.deepEqual(checkBrokerReader({ processes: procs(), heartbeatMs: NOW - 60000, readHealth: null, nowMs: NOW }), []);
});

test("the incident: N consecutive MCP read failures names the kind, count, date and the CLI hint", () => {
  const readHealth = { "holdings-sync": { consecutiveFailures: 523, firstFailureAt: "2026-10-16T13:30:00.000Z", lastFailureAt: "2026-10-26T13:30:00Z", lastSuccessAt: "2026-09-22T16:30:00Z", lastError: 'Claude CLI failed (exit 1): {"type":"system","cwd":"/home/sam/x","tools":["Task"]}' } };
  const out = checkBrokerReader({ processes: procs(), heartbeatMs: NOW - 60000, readHealth, nowMs: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "P1");
  assert.match(out[0].title, /holdings-sync \(523 in a row since 2026-10-16 13:30Z\)/);
  assert.match(out[0].detail, /Claude CLI failed \(exit 1\)\. Last success 2026-09-22/);
  assert.match(out[0].detail, /claude auth status/);
  assert.ok(!out[0].detail.includes("/home/sam"), "the CLI JSON dump is not forwarded to Telegram");
});

test("below the failure threshold is quiet; at the threshold it fires", () => {
  const at = (n) => checkBrokerReader({ processes: procs(), heartbeatMs: NOW, readHealth: { "holdings-sync": { consecutiveFailures: n, lastError: "x" } }, nowMs: NOW });
  assert.equal(at(READ_FAILURE_THRESHOLD - 1).length, 0);
  assert.equal(at(READ_FAILURE_THRESHOLD).length, 1);
});

test("fingerprints are stable across counts so dedup works", () => {
  const f = (n) => checkBrokerReader({ processes: procs(), heartbeatMs: NOW, readHealth: { "holdings-sync": { consecutiveFailures: n, lastError: "x" } }, nowMs: NOW })[0].fingerprint;
  assert.equal(f(3), f(600));
});

test("reader process missing or stopped is a P1", () => {
  assert.match(titles(checkBrokerReader({ processes: [online("pitch-lab")], heartbeatMs: NOW, readHealth: null, nowMs: NOW }))[0], /not registered/);
  const stopped = [{ name: "portfolio-broker-reader", pm2_env: { status: "stopped" } }];
  assert.match(titles(checkBrokerReader({ processes: stopped, heartbeatMs: null, readHealth: null, nowMs: NOW }))[0], /is stopped/);
});

test("the heartbeat bug: reader online but heartbeat stale/missing is flagged, but not right after a restart", () => {
  const stale = checkBrokerReader({ processes: procs(), heartbeatMs: NOW - 31 * 60000, readHealth: null, nowMs: NOW });
  assert.match(stale[0].title, /not heartbeating/);
  assert.equal(checkBrokerReader({ processes: procs(), heartbeatMs: null, readHealth: null, nowMs: NOW }).length, 1);
  const fresh = [online("portfolio-broker-reader", 60000)];
  assert.deepEqual(checkBrokerReader({ processes: fresh, heartbeatMs: null, readHealth: null, nowMs: NOW }), []);
});

test("fail closed: unreadable inputs are findings, not passes", () => {
  assert.match(titles(checkBrokerReader({ processes: null, heartbeatMs: NOW, readHealth: null, nowMs: NOW }))[0], /cannot read the PM2 process list/);
  assert.match(titles(checkBrokerReader({ processes: procs(), heartbeatMs: undefined, readHealth: null, nowMs: NOW })).join(), /heartbeat/);
  assert.match(titles(checkBrokerReader({ processes: procs(), heartbeatMs: NOW, readHealth: undefined, nowMs: NOW })).join(), /receipt history/);
});

test("summarizeReadError keeps the human part only", () => {
  assert.equal(summarizeReadError('Claude CLI failed (exit 1): {"a":1}'), "Claude CLI failed (exit 1)");
  assert.equal(summarizeReadError(""), "no error text captured");
});

const pitch = (over = {}) => ({
  enabled: true, processes: procs(), nowET: et("2026-10-26", 20, 30), isTradingDay: true, nowMs: NOW,
  dailyRun: { status: "ok", selected: 15, pitched: 15, failedCount: 0, shortfall: 0 },
  dailyDigest: "2026-10-26T22:45:00.000Z", weeklyDigest: "2026-10-24T14:00:03.000Z", ...over,
});

test("pitch lab: a normal day produces no findings", () => {
  assert.deepEqual(checkPitchLab(pitch()), []);
});

test("pitch lab: disabled means intentionally idle, so nothing is checked", () => {
  assert.deepEqual(checkPitchLab(pitch({ enabled: false, processes: [], dailyRun: null })), []);
});

test("pitch lab: daily run missing after the 19:30 cutoff -> P1; before it -> quiet", () => {
  assert.match(titles(checkPitchLab(pitch({ dailyRun: null, dailyDigest: null })))[0], /did not complete today/);
  assert.deepEqual(checkPitchLab(pitch({ dailyRun: null, dailyDigest: null, nowET: et("2026-10-26", 18, 15) })), []);
});

test("pitch lab: the silent failures the scheduler does not page on", () => {
  assert.match(titles(checkPitchLab(pitch({ dailyRun: { status: "no_catalog", pitched: 0 } })))[0], /no company catalog/);
  assert.match(titles(checkPitchLab(pitch({ dailyRun: { status: "budget_stop", pitched: 6, selected: 15 } })))[0], /budget boundary/);
  assert.match(titles(checkPitchLab(pitch({ dailyRun: { status: "ok", pitched: 0, selected: 15, failedCount: 15 } })))[0], /zero pitches/);
  const partial = checkPitchLab(pitch({ dailyRun: { status: "ok", pitched: 13, selected: 15, failedCount: 2 } }));
  assert.equal(partial[0].severity, "P2", "a partial run is logged but not paged");
});

test("pitch lab: digest not delivered (missing or stuck in-flight) -> P1", () => {
  assert.match(titles(checkPitchLab(pitch({ dailyDigest: null })))[0], /daily digest was not delivered/);
  assert.match(checkPitchLab(pitch({ dailyDigest: "sending" }))[0].detail, /in-flight/);
});

test("pitch lab: weekly report not delivered for the last Saturday -> P1 (after 11:00 ET)", () => {
  assert.match(titles(checkPitchLab(pitch({ weeklyDigest: null })))[0], /weekly report for 2026-10-24/);
  assert.deepEqual(checkPitchLab(pitch({ weeklyDigest: null, nowET: et("2026-10-26", 9, 0) })), []);
});

test("pitch lab: process down is flagged even on a holiday/weekend-style non-trading run", () => {
  const down = checkPitchLab(pitch({ processes: [online("portfolio-manager")], isTradingDay: false }));
  assert.match(titles(down)[0], /not registered in PM2/);
  assert.equal(down.length, 1, "date-specific checks are skipped on non-trading days");
});

test("pitch lab: unreadable markers fail closed", () => {
  assert.match(titles(checkPitchLab(pitch({ dailyRun: undefined })))[0], /cannot read the Pitch Lab daily run marker/);
  assert.match(titles(checkPitchLab(pitch({ dailyDigest: undefined })))[0], /digest delivery marker/);
});

test("lastSaturday is always strictly before the given date", () => {
  assert.equal(lastSaturday("2026-10-26"), "2026-10-24");
  assert.equal(lastSaturday("2026-10-24"), "2026-10-17");
  assert.equal(lastSaturday("2026-10-25"), "2026-10-24");
});

test("sentinel liveness: scheduler down, or no run recorded today after 20:30 ET", () => {
  const base = { processes: procs(), nowET: et("2026-10-26", 20, 30), isTradingDay: true, nowMs: NOW };
  assert.deepEqual(checkSentinelLiveness({ ...base, lastRun: { date: "2026-10-26" } }), []);
  assert.match(titles(checkSentinelLiveness({ ...base, lastRun: { date: "2026-10-23" } }))[0], /did not run today/);
  assert.deepEqual(checkSentinelLiveness({ ...base, nowET: et("2026-10-26", 19, 0), lastRun: { date: "2026-10-23" } }), [], "not due yet");
  assert.match(titles(checkSentinelLiveness({ ...base, processes: [online("pitch-lab")], lastRun: { date: "2026-10-26" } }))[0], /Portfolio Manager scheduler is not registered/);
  assert.match(titles(checkSentinelLiveness({ ...base, lastRun: undefined }))[0], /cannot read/);
});

function fakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async lrange(k) { return store.get(k) ?? []; },
    async set(k, v) { store.set(k, v); return "OK"; },
  };
}

const failed = (n, day = "2026-10-26", error = "Claude CLI failed (exit 1)") => Array.from({ length: n }, (_, i) => JSON.stringify({ outcome: "failed", ok: false, ts: `${day}T${String(13 + i).padStart(2, "0")}:30:00.000Z`, error }));
const HIST = (kind, date) => `pm:job:${kind}:history:${date}`;

test("end to end: a failing reader -> one Telegram, state persisted, no repeat on the next tick, resolved note on recovery", async () => {
  const redis = fakeRedis({
    [HIST("holdings-sync", "2026-10-26")]: failed(5),
    "pm:sysloop:last-run": JSON.stringify({ date: "2026-10-26" }),
    "pitchlab:telegram:weekly:2026-10-24": "2026-10-24T14:00:03.000Z",
  });
  const sent = [];
  const common = { redis, env: { PITCH_LAB_ENABLED: "0" }, log: { log() {}, error() {} }, send: async (m) => { sent.push(m); }, listProcesses: async () => procs() };
  const at = (iso) => {
    redis.store.set("pm:broker-reader:last-seen", new Date(Date.parse(iso) - 60000).toISOString()); // reader keeps heartbeating
    return new Date(iso);
  };

  const first = await runOpsWatch({ ...common, now: at("2026-10-26T15:00:00Z") }); // 11:00 ET Monday
  assert.equal(first.status, "ok");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /1 new urgent finding/);
  assert.match(sent[0], /Broker reads failing: holdings-sync \(5 in a row since 2026-10-26 13:30Z\)/);
  assert.match(sent[0], /Claude CLI failed \(exit 1\)/);
  assert.ok(JSON.parse(redis.store.get(OPS_STATE_KEY)).open);
  assert.ok(redis.store.get("pm:opswatch:last-run"));

  await runOpsWatch({ ...common, now: at("2026-10-26T15:30:00Z") });
  assert.equal(sent.length, 1, "next tick, same day: quiet");

  redis.store.set(HIST("holdings-sync", "2026-10-27"), failed(2, "2026-10-27")); // still failing the next morning
  await runOpsWatch({ ...common, now: at("2026-10-27T12:00:00Z") }); // 08:00 ET Tuesday: digest
  assert.equal(sent.length, 2);
  assert.match(sent[1], /1 still open/);

  redis.store.set(HIST("holdings-sync", "2026-10-27"), [...failed(2, "2026-10-27"), JSON.stringify({ outcome: "ok", ok: true, ts: "2026-10-27T13:31:00.000Z" })]);
  await runOpsWatch({ ...common, now: at("2026-10-27T12:30:00Z") });
  assert.equal(sent.length, 3);
  assert.match(sent[2], /resolved/);
});

test("summarizeReadHistory: streak, first/last failure, last success; mismatch is not a failure; junk is ignored", () => {
  const rows = [
    { outcome: "ok", ts: "2026-10-25T20:00:00Z" },
    { outcome: "failed", ts: "2026-10-26T13:30:00Z", error: "a" },
    { outcome: "failed", ts: "2026-10-26T14:30:00Z", error: "b" },
    null, "junk", { nope: true },
  ];
  assert.deepEqual(summarizeReadHistory(rows), { consecutiveFailures: 2, firstFailureAt: "2026-10-26T13:30:00Z", lastFailureAt: "2026-10-26T14:30:00Z", lastSuccessAt: "2026-10-25T20:00:00Z", lastError: "b" });
  assert.equal(summarizeReadHistory([...rows, { outcome: "mismatch", ts: "2026-10-26T15:00:00Z" }]).consecutiveFailures, 0);
  assert.equal(summarizeReadHistory(undefined).consecutiveFailures, 0);
  assert.equal(summarizeReadHistory([{ outcome: "failed", ts: "t" }]).lastSuccessAt, null);
});

test("end to end: Telegram failure is retried, not recorded as announced; a weekend still runs; a missing Redis does not throw", async () => {
  const redis = fakeRedis({
    [HIST("order-reconciliation", "2026-10-26")]: failed(4, "2026-10-26", "x"),
    "pm:sysloop:last-run": JSON.stringify({ date: "2026-10-26" }),
    "pitchlab:telegram:weekly:2026-10-24": "2026-10-24T14:00:03.000Z",
  });
  redis.store.set("pm:broker-reader:last-seen", new Date(Date.parse("2026-10-26T15:00:00Z")).toISOString());
  let fail = true;
  const sent = [];
  const common = { redis, env: {}, log: { log() {}, error() {} }, listProcesses: async () => procs(), send: async (m) => { if (fail) throw new Error("telegram down"); sent.push(m); } };
  await runOpsWatch({ ...common, now: new Date("2026-10-26T15:00:00Z") });
  assert.equal(sent.length, 0);
  assert.equal(Object.values(JSON.parse(redis.store.get(OPS_STATE_KEY)).open)[0].alertCount, 0);
  fail = false;
  await runOpsWatch({ ...common, now: new Date("2026-10-26T15:30:00Z") });
  assert.equal(sent.length, 1, "retried and delivered on the next tick");

  // Saturday: not skipped. A dead reader on a weekend must page now, not Monday.
  const weekend = { ...common, listProcesses: async () => [online("pitch-lab"), online("portfolio-manager")], redis: fakeRedis() };
  const result = await runOpsWatch({ ...weekend, now: new Date("2026-10-24T15:00:00Z") });
  assert.equal(result.status, "ok");
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Broker reader is not registered in PM2/);

  assert.equal((await runOpsWatch({ ...common, redis: null, now: new Date("2026-10-26T15:00:00Z") })).status, "no_redis");
});

test("Pitch Lab is watched when its PM2 process exists even if the flag is invisible to ops-watch", async () => {
  const base = { redis: fakeRedis(), now: new Date("2026-10-27T00:30:00Z") };
  const seen = await gatherInputs({ ...base, env: {}, listProcesses: async () => procs() });
  assert.equal(seen.pitchLab.enabled, true, "process present -> watched");
  const absent = await gatherInputs({ ...base, env: {}, listProcesses: async () => [online("portfolio-manager")] });
  assert.equal(absent.pitchLab.enabled, false, "no flag and no process -> intentionally not running");
  const flagged = await gatherInputs({ ...base, env: { PITCH_LAB_ENABLED: "1" }, listProcesses: async () => [online("portfolio-manager")] });
  assert.equal(flagged.pitchLab.enabled, true, "flag set but process missing -> watched, so the missing process is reported");
});

test("etParts agrees with the clock it is given", () => {
  const parts = etParts(new Date("2026-10-26T22:30:00Z"));
  assert.equal(parts.date, "2026-10-26");
  assert.equal(parts.hour, 18);
  assert.equal(parts.weekday, "Mon");
});

test("scheduler.js stays out of it, and ops-watch keeps a narrow write surface", () => {
  const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.ok(!/ops-watch|opswatch/i.test(read("scheduler.js")), "ops-watch must not be registered in the Phase 0 scheduler");
  const forbidden = /createProposal|robinhood|fill-processing|proposal-signature|sheets\.js/;
  for (const file of ["jobs/ops-watch.js", "ops-watch-scheduler.js", "lib/ops-watch/checks.js", "lib/alerting/policy.js"]) {
    assert.ok(!forbidden.test(read(file).replace(/\/\*[\s\S]*?\*\//g, "")), `${file} reaches a production write path`);
  }
  const writes = [...read("jobs/ops-watch.js").matchAll(/redis\.set\(([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(!/redis\.(del|hset|rpush|lpush|expire|eval)\(/.test(read("jobs/ops-watch.js")), "ops-watch only ever reads, except its two state keys");
  assert.deepEqual(writes.sort(), ["OPS_LAST_RUN_KEY", "OPS_STATE_KEY"]);
  assert.ok(OPS_STATE_KEY.startsWith("pm:opswatch:"));
});

test("runOpsChecks composes all three watchers", () => {
  const findings = runOpsChecks({
    reader: { processes: procs(), heartbeatMs: NOW, readHealth: { "order-reconciliation": { consecutiveFailures: 9, lastError: "x" } }, nowMs: NOW },
    pitchLab: pitch({ dailyRun: null, dailyDigest: null }),
    sentinel: { processes: procs(), lastRun: { date: "2026-10-23" }, nowET: et("2026-10-26", 20, 30), isTradingDay: true, nowMs: NOW },
  });
  assert.equal(findings.length, 3);
});
