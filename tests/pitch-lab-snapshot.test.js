import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPitchLabSnapshot, isoWeekKey, EVIDENCE_BAR, SNAPSHOT_SCHEMA_VERSION } from "../lib/pitch-lab/dashboard-snapshot.js";
import { isoWeekKey as analysisIsoWeekKey } from "../lib/pitch-lab/analysis.js";
import { publishPitchLabSnapshot, PITCH_LAB_SNAPSHOT_KEY } from "../lib/pitch-lab-snapshot-publisher.js";
import { refreshDashboardSnapshot } from "../jobs/pitch-lab-daily.js";

// 18:44 ET on a given date (EDT, UTC-4)
const at = (date) => `${date}T22:44:00.000Z`;
const pitch = (id, ticker, conviction, date, extra = {}) => ({
  id, ticker, conviction, pitchedAt: at(date),
  rationale: { thesis: `${ticker} thesis ${"x".repeat(60)}`, risks: [`${ticker} main risk`] }, ...extra,
});
const outcome = (pitchId, horizonDays, excessReturn, gradedAt = "2026-10-27T22:45:00.000Z", entryDate = "2026-10-20") => ({ pitchId, horizonDays, excessReturn, gradedAt, entryDate });

test("an empty store yields a valid, honest snapshot (nothing invented)", () => {
  const s = buildPitchLabSnapshot({ pitches: [], outcomes: [], now: new Date("2026-10-26T12:00:00Z") });
  assert.equal(s.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(s.program.totalPitches, 0);
  assert.equal(s.program.firstPitchDate, null);
  assert.equal(s.latest.date, null);
  assert.deepEqual(s.latest.pitches, []);
  assert.equal(s.scoreboard["5"].graded, 0);
  assert.equal(s.scoreboard["5"].hitRate, null);
  assert.deepEqual(s.evidenceBar, EVIDENCE_BAR);
});

test("pitches are grouped by ET date, sorted strongest-first, and text is bounded", () => {
  const long = pitch("c", "ZZZ", 5, "2026-10-20", { rationale: { thesis: "t".repeat(900), risks: ["r".repeat(900)] } });
  const s = buildPitchLabSnapshot({
    pitches: [pitch("a", "AAA", 3, "2026-10-19"), pitch("b", "BBB", 4, "2026-10-20"), long, pitch("d", "CCC", 5, "2026-10-20")],
    outcomes: [],
  });
  assert.equal(s.program.pitchDays, 2);
  assert.equal(s.program.firstPitchDate, "2026-10-19");
  assert.equal(s.latest.date, "2026-10-20");
  assert.deepEqual(s.latest.pitches.map((p) => p.ticker), ["CCC", "ZZZ", "BBB"], "conviction desc, then ticker");
  assert.ok(s.latest.pitches[1].thesis.length <= 240);
  assert.ok(s.latest.pitches[1].risk.length <= 160);
  assert.deepEqual(s.days.map((d) => [d.date, d.pitched]), [["2026-10-19", 1], ["2026-10-20", 3]]);
});

test("a pitch at 22:44Z belongs to its ET date, not the UTC date of a later hour", () => {
  const late = { ...pitch("a", "AAA", 3, "2026-10-19"), pitchedAt: "2026-10-20T01:30:00.000Z" }; // 21:30 ET Oct 19
  assert.equal(buildPitchLabSnapshot({ pitches: [late], outcomes: [] }).program.firstPitchDate, "2026-10-19");
});

test("scoreboard: beat-SPY counts, pending, independent weeks, and conviction buckets", () => {
  const pitches = [
    pitch("a", "AAA", 5, "2026-10-19"), pitch("b", "BBB", 5, "2026-10-19"), pitch("c", "CCC", 3, "2026-10-26"), pitch("d", "DDD", 3, "2026-10-26"),
  ];
  const s = buildPitchLabSnapshot({
    pitches,
    outcomes: [outcome("a", 5, 0.04), outcome("b", 5, -0.02), outcome("c", 5, 0.01, "2026-11-03T22:45:00.000Z", "2026-10-27"), outcome("a", 10, 0.05)],
  });
  const five = s.scoreboard["5"];
  assert.equal(five.graded, 3);
  assert.equal(five.pending, 1);
  assert.equal(five.beat, 2);
  assert.equal(five.hitRate, 0.6667);
  assert.equal(five.independentWeeks, 2);
  assert.deepEqual(five.convictionBuckets, [
    { conviction: 3, n: 1, meanExcess: 0.01, hitRate: 1 },
    { conviction: 5, n: 2, meanExcess: 0.01, hitRate: 0.5 },
  ]);
  assert.equal(s.scoreboard["10"].graded, 1);
  assert.equal(s.scoreboard["20"].graded, 0);
});

test("outcomes with non-finite returns or for unknown pitches never count as graded", () => {
  const s = buildPitchLabSnapshot({ pitches: [pitch("a", "AAA", 4, "2026-10-19")], outcomes: [outcome("a", 5, NaN), outcome("ghost", 5, 0.5), outcome("a", 5, null), outcome("a", 5, 0.02)] });
  assert.equal(s.scoreboard["5"].graded, 1);
  assert.equal(s.scoreboard["5"].convictionBuckets.length, 1);
  assert.equal(s.scoreboard["5"].convictionBuckets[0].n, 1);
});

test("the run summary is attached only to the day it belongs to", () => {
  const pitches = [pitch("a", "AAA", 4, "2026-10-23")];
  const same = buildPitchLabSnapshot({ pitches, outcomes: [], run: { date: "2026-10-23", status: "ok", selected: 15, failedCount: 2, shortfall: 1 } });
  assert.deepEqual([same.latest.selected, same.latest.dropped, same.latest.shortfall], [15, 2, 1]);
  const other = buildPitchLabSnapshot({ pitches, outcomes: [], run: { date: "2026-10-22", status: "budget_stop", selected: 15, failedCount: 9 } });
  assert.equal(other.latest.selected, null);
  assert.equal(other.latest.status, null, "no matching run summary -> unknown, never assumed clean");
});

test("repeated tickers and the conviction mix are reported", () => {
  const s = buildPitchLabSnapshot({ pitches: [pitch("a", "AAA", 3, "2026-10-19"), pitch("b", "AAA", 3, "2026-10-20"), pitch("c", "BBB", 4, "2026-10-20")], outcomes: [] });
  assert.deepEqual(s.program.repeatedTickers, [{ ticker: "AAA", days: 2 }]);
  assert.deepEqual(s.program.convictionMix, { 1: 0, 2: 0, 3: 2, 4: 1, 5: 0 });
});

test("malformed pitches are ignored, never thrown on", () => {
  const s = buildPitchLabSnapshot({ pitches: [null, {}, { id: "x", ticker: "T", conviction: "high", pitchedAt: "nope" }, pitch("a", "AAA", 3, "2026-10-19")], outcomes: [] });
  assert.equal(s.program.totalPitches, 1);
});

test("isoWeekKey groups Mon-Sun together and crosses year boundaries correctly", () => {
  assert.equal(isoWeekKey("2026-10-19"), isoWeekKey("2026-10-25"));
  assert.notEqual(isoWeekKey("2026-10-25"), isoWeekKey("2026-10-26"));
  assert.equal(isoWeekKey("2026-01-01"), "2026-W01");
  assert.equal(isoWeekKey("2025-12-29"), "2026-W01");
});

test("snapshot is small enough to read on every page view", () => {
  const many = Array.from({ length: 15 * 30 }, (_, i) => pitch(`p${i}`, `T${i % 60}`, (i % 5) + 1, `2026-${i % 2 ? "09" : "10"}-${String((i % 27) + 1).padStart(2, "0")}`));
  const s = buildPitchLabSnapshot({ pitches: many, outcomes: many.map((p, i) => outcome(p.id, 5, (i % 7 - 3) / 100)) });
  assert.ok(JSON.stringify(s).length < 40_000, `snapshot is ${JSON.stringify(s).length} bytes`);
});

test("publisher writes exactly one constant namespaced key and validates its input", async () => {
  const writes = [];
  const redis = { async set(key, value) { writes.push([key, value]); return "OK"; } };
  const snapshot = buildPitchLabSnapshot({ pitches: [pitch("a", "AAA", 3, "2026-10-19")], outcomes: [] });
  assert.equal(await publishPitchLabSnapshot(snapshot, { redis, now: () => new Date("2026-10-26T00:00:00Z") }), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "pitchlab:snapshot");
  assert.equal(PITCH_LAB_SNAPSHOT_KEY, "pitchlab:snapshot");
  const stored = JSON.parse(writes[0][1]);
  assert.equal(stored.publishedAt, "2026-10-26T00:00:00.000Z");
  assert.equal(stored.snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  await assert.rejects(() => publishPitchLabSnapshot({ schemaVersion: "other" }, { redis }), /pitch-lab.snapshot.v1/);
  await assert.rejects(() => publishPitchLabSnapshot(null, { redis }), /requires/);
});

test("refreshDashboardSnapshot is non-fatal: Redis errors, no Redis, and bad data are logged, never thrown", async () => {
  const errors = [];
  const log = { error: (m) => errors.push(m), log() {} };
  const pitches = [pitch("a", "AAA", 3, "2026-10-19")];
  const boom = { async set() { throw new Error("redis down"); } };
  assert.equal(await refreshDashboardSnapshot({ pitches, outcomes: [], redis: boom, log }), false);
  assert.match(errors.at(-1), /non-fatal.*redis down/);
  assert.equal(await refreshDashboardSnapshot({ pitches, outcomes: [], redis: undefined, publish: async () => false, log }), false);
  assert.match(errors.at(-1), /NOT published/);
  assert.equal(await refreshDashboardSnapshot({ pitches, outcomes: [], redis: { async set() { return "OK"; } }, log }), true);
});

test("the snapshot path adds no new write surface beyond its one constant key", () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
  const forbidden = /createProposal|robinhood|fill-processing|proposal-signature|sheets\.js|pm:/;
  for (const file of ["lib/pitch-lab/dashboard-snapshot.js", "lib/pitch-lab-snapshot-publisher.js"]) assert.ok(!forbidden.test(strip(read(file))), `${file} reaches a production path`);
  assert.ok(!/redis/i.test(strip(read("lib/pitch-lab/dashboard-snapshot.js"))), "the builder is pure: no Redis");
  const publisher = strip(read("lib/pitch-lab-snapshot-publisher.js"));
  assert.equal((publisher.match(/\.set\(/g) ?? []).length, 1);
  assert.match(publisher, /client\.set\(PITCH_LAB_SNAPSHOT_KEY,/);
  // The bridge's own pinned write surface is untouched.
  assert.ok(!/SNAPSHOT/.test(read("lib/pitch-lab-peer-bridge.js")));
});

test("the regression (Codex): independent weeks follow the ENTRY date, exactly like the analysis - a Friday pitch and a Monday pitch can share a week", () => {
  const pitches = [pitch("fri", "FFF", 3, "2026-10-23"), pitch("mon", "MMM", 3, "2026-10-26")];
  // Friday 18:44 ET pitch enters Monday 26 Oct; the Monday pitch enters Tuesday 27 Oct: same ISO week.
  const s = buildPitchLabSnapshot({ pitches, outcomes: [outcome("fri", 5, 0.01, undefined, "2026-10-26"), outcome("mon", 5, 0.02, undefined, "2026-10-27")] });
  assert.equal(s.scoreboard["5"].independentWeeks, 1, "pitch dates are in two ISO weeks, but the entries share one");
  const split = buildPitchLabSnapshot({ pitches, outcomes: [outcome("fri", 5, 0.01, undefined, "2026-10-23"), outcome("mon", 5, 0.02, undefined, "2026-10-27")] });
  assert.equal(split.scoreboard["5"].independentWeeks, 2);
  for (const d of ["2026-10-23", "2026-10-26", "2026-01-01", "2025-12-29", "2026-12-31"]) assert.equal(isoWeekKey(d), analysisIsoWeekKey(d), `same definition as analysis.js for ${d}`);
});

test("publisher is time-bounded: a Redis call that never settles cannot hold the cycle open, and the refresh stays non-fatal", async () => {
  const hung = { set: () => new Promise(() => {}) };
  const snapshot = buildPitchLabSnapshot({ pitches: [pitch("a", "AAA", 3, "2026-10-19")], outcomes: [] });
  await assert.rejects(() => publishPitchLabSnapshot(snapshot, { redis: hung, timeoutMs: 30 }), /timed out/);
  const errors = [];
  const started = Date.now();
  const ok = await refreshDashboardSnapshot({ pitches: [pitch("a", "AAA", 3, "2026-10-19")], outcomes: [], redis: hung, publish: (snap, opts) => publishPitchLabSnapshot(snap, { ...opts, timeoutMs: 30 }), log: { error: (m) => errors.push(m), log() {} } });
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 1000);
  assert.match(errors.at(-1), /non-fatal.*timed out/);
});

test("the weekly report no longer overwrites the daily snapshot (it would drop the latest run's status)", () => {
  const src = readFileSync(new URL("../jobs/pitch-lab-daily.js", import.meta.url), "utf8");
  const calls = [...src.matchAll(/await refreshDashboardSnapshot\(/g)].length;
  assert.equal(calls, 1, "only the daily grade/digest path refreshes the snapshot");
  const report = src.slice(src.indexOf("export async function runPitchLabReport"), src.indexOf("export async function runPitchLabDailyCycle"));
  assert.ok(!/refreshDashboardSnapshot\(/.test(report.replace(/\/\/.*$/gm, "")));
});
