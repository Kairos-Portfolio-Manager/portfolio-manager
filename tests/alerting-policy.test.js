import test from "node:test";
import assert from "node:assert/strict";
import { planAlerts, normalizeAlertState, emptyAlertState, describeAge } from "../lib/alerting/policy.js";
import { deliverSentinelAlerts, ALERT_STATE_KEY } from "../jobs/system-sentinel.js";

const DAY = 86400000;
const t0 = new Date("2026-10-26T22:15:00Z");
const p1 = (fp, title = `finding ${fp}`, detail = "") => ({ fingerprint: fp, severity: "P1", title, detail });
const quiet = { log: { error() {}, log() {} } };

test("a new P0/P1 is announced immediately with its detail", () => {
  const plan = planAlerts({ findings: [p1("a", "Job holdings-sync did not run today", "last ran 2026-09-22")], now: t0, dateET: "2026-10-26", digest: false });
  assert.match(plan.text, /1 new urgent finding/);
  assert.match(plan.text, /holdings-sync did not run today\n   last ran 2026-09-22/);
  assert.deepEqual(plan.freshFingerprints, ["a"]);
});

test("P2/P3 never produce a message", () => {
  const plan = planAlerts({ findings: [{ fingerprint: "x", severity: "P2", title: "meh" }, { fingerprint: "y", severity: "P3", title: "meh" }], now: t0, dateET: "2026-10-26" });
  assert.equal(plan.text, null);
});

test("a finding announced earlier today is not re-announced as new", () => {
  const first = planAlerts({ findings: [p1("a")], now: t0, dateET: "2026-10-26" });
  const again = planAlerts({ findings: [p1("a")], state: first.stateIfSent, now: new Date(t0.getTime() + 3600000), dateET: "2026-10-26" });
  assert.deepEqual(again.freshFingerprints, []);
  assert.equal(again.text, null, "same day, already digested: quiet");
});

test("the regression: a failed send does NOT mark the finding announced, so it is retried", () => {
  const first = planAlerts({ findings: [p1("a")], now: t0, dateET: "2026-10-26", digest: false });
  assert.equal(first.stateIfNotSent.open.a.alertCount, 0);
  const retry = planAlerts({ findings: [p1("a")], state: first.stateIfNotSent, now: new Date(t0.getTime() + 3600000), dateET: "2026-10-26", digest: false });
  assert.deepEqual(retry.freshFingerprints, ["a"], "next run announces it again");
  assert.equal(retry.stateIfNotSent.open.a.firstSeenMs, t0.getTime(), "age is preserved across failed sends");
});

test("the regression: a long-standing P1 is re-announced daily with its age", () => {
  let state = planAlerts({ findings: [p1("hs", "Job holdings-sync did not run today")], now: t0, dateET: "2026-10-26" }).stateIfSent;
  const nineDaysLater = new Date(t0.getTime() + 9 * DAY);
  const plan = planAlerts({ findings: [p1("hs", "Job holdings-sync did not run today")], state, now: nineDaysLater, dateET: "2026-11-04" });
  assert.deepEqual(plan.freshFingerprints, []);
  assert.deepEqual(plan.digestFingerprints, ["hs"]);
  assert.match(plan.text, /1 still open/);
  assert.match(plan.text, /holdings-sync did not run today — open 9d \(since 2026-10-26\)/);
});

test("the digest goes out once per ET date, not at every run", () => {
  let state = planAlerts({ findings: [p1("a")], now: t0, dateET: "2026-10-26" }).stateIfSent;
  const morning = planAlerts({ findings: [p1("a")], state, now: new Date(t0.getTime() + DAY), dateET: "2026-10-27" });
  assert.ok(morning.text);
  state = morning.stateIfSent;
  assert.equal(state.lastDigestDate, "2026-10-27");
  const later = planAlerts({ findings: [p1("a")], state, now: new Date(t0.getTime() + DAY + 7200000), dateET: "2026-10-27" });
  assert.equal(later.text, null);
});

test("a failed digest send leaves the digest due for the next run", () => {
  const state = planAlerts({ findings: [p1("a")], now: t0, dateET: "2026-10-26" }).stateIfSent;
  const due = planAlerts({ findings: [p1("a")], state, now: new Date(t0.getTime() + DAY), dateET: "2026-10-27" });
  assert.equal(due.stateIfNotSent.lastDigestDate, null, "digest still due");
  assert.equal(due.stateIfNotSent.open.a.alertCount, 1, "not counted as announced");
  assert.equal(due.stateIfSent.lastDigestDate, "2026-10-27");
  assert.equal(due.stateIfSent.open.a.alertCount, 2);
});

test("nothing open means no digest and no message: quiet when healthy", () => {
  const plan = planAlerts({ findings: [], state: emptyAlertState(), now: t0, dateET: "2026-10-26" });
  assert.equal(plan.text, null);
});

test("a new finding is not listed twice (new section only, not the digest)", () => {
  const plan = planAlerts({ findings: [p1("a"), p1("b")], state: planAlerts({ findings: [p1("a")], now: t0, dateET: "2026-10-26" }).stateIfSent, now: new Date(t0.getTime() + DAY), dateET: "2026-10-27" });
  assert.deepEqual(plan.freshFingerprints, ["b"]);
  assert.deepEqual(plan.digestFingerprints, ["a"]);
});

test("a finding that clears produces a resolved note and re-pages as NEW if it returns", () => {
  const state = planAlerts({ findings: [p1("a", "Reader failing")], now: t0, dateET: "2026-10-26" }).stateIfSent;
  const cleared = planAlerts({ findings: [], state, now: new Date(t0.getTime() + 2 * DAY), dateET: "2026-10-28" });
  assert.match(cleared.text, /resolved/);
  assert.match(cleared.text, /Reader failing — was open 2d/);
  assert.equal(Object.keys(cleared.stateIfSent.open).length, 0);
  const back = planAlerts({ findings: [p1("a", "Reader failing")], state: cleared.stateIfSent, now: new Date(t0.getTime() + 3 * DAY), dateET: "2026-10-29" });
  assert.deepEqual(back.freshFingerprints, ["a"]);
});

test("migration: fingerprints the old sentinel already announced are digested, not re-announced as new", () => {
  const plan = planAlerts({ findings: [p1("old")], state: null, legacyKnown: ["old"], now: t0, dateET: "2026-10-26" });
  assert.deepEqual(plan.freshFingerprints, []);
  assert.deepEqual(plan.digestFingerprints, ["old"]);
  assert.match(plan.text, /age unknown/);
});

test("output is capped: many findings fit one Telegram message", () => {
  const many = Array.from({ length: 40 }, (_, i) => p1(`f${i}`, `Finding number ${i} `.repeat(6), "d".repeat(400)));
  const plan = planAlerts({ findings: many, now: t0, dateET: "2026-10-26" });
  assert.ok(plan.text.length <= 3500);
  assert.match(plan.text, /and 32 more/);
});

test("malformed or foreign state never throws", () => {
  for (const bad of [undefined, null, "{", "[]", 7, { open: null }, { open: { a: 5 } }]) {
    assert.deepEqual(normalizeAlertState(bad).open, {});
  }
  assert.equal(describeAge({ firstSeenMs: null }, 0, "2026-10-26").includes("unknown"), true);
});

test("sentinel delivery: success persists announced state; send failure persists retry state; state errors never throw", async () => {
  const store = new Map();
  const redis = { async get(k) { return store.get(k) ?? null; }, async set(k, v) { store.set(k, v); return "OK"; } };
  const snapshot = { date: "2026-10-26", anomalies: [{ fingerprint: "hs", severity: "P1", title: "Job holdings-sync did not run today", detail: "d" }] };
  const sentMessages = [];

  let result = await deliverSentinelAlerts({ snapshot, prevAnomalyFingerprints: [], redis, now: t0, send: async (m) => { sentMessages.push(m); }, ...quiet });
  assert.equal(result.sent, true);
  assert.equal(JSON.parse(store.get(ALERT_STATE_KEY)).open.hs.alertCount, 1);

  store.clear();
  result = await deliverSentinelAlerts({ snapshot, prevAnomalyFingerprints: [], redis, now: t0, send: async () => { throw new Error("telegram down"); }, ...quiet });
  assert.equal(result.sent, false);
  assert.equal(JSON.parse(store.get(ALERT_STATE_KEY)).open.hs.alertCount, 0, "failed send is not recorded as announced");

  const brokenRedis = { async get() { throw new Error("redis down"); }, async set() { throw new Error("redis down"); } };
  result = await deliverSentinelAlerts({ snapshot, prevAnomalyFingerprints: [], redis: brokenRedis, now: t0, send: async () => {}, ...quiet });
  assert.equal(result.persisted, false);

  result = await deliverSentinelAlerts({ snapshot, prevAnomalyFingerprints: [], redis: null, now: t0, send: async () => {}, ...quiet });
  assert.equal(result.persisted, false);
});

test("the sentinel only ever writes inside its namespace", () => {
  assert.ok(ALERT_STATE_KEY.startsWith("pm:sysloop:"));
});
