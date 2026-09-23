import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Isolation guard for the Research Testing Prototype (docs/roadmaps/RESEARCH-LAB-PLAN-2026-09-23.md).
 *
 * The whole point of "same repo, isolated data" is that a bug in prototype code
 * cannot touch a `pm:*` key. lib/proto-store.js enforces that at runtime; these
 * tests pin the guard's behavior and make sure nothing outside proto-store.js
 * talks to Redis directly on the prototype's behalf -- the exact shape of the
 * 2026-09-21 universe-refresh incident (an injection seam existed for
 * everything except the store, and the store call bypassed it).
 */

import { protoGet, protoSet, protoDel, protoListPush, protoListRange, protoKeys, protoKey } from "../lib/proto-store.js";

test("proto-store refuses any key that is not prefixed proto:", async () => {
  await assert.rejects(() => protoGet("pm:universe:meta"), /refuses a non-"proto:" key/);
  await assert.rejects(() => protoSet("pm:research-slate:private:agent-1", {}), /refuses a non-"proto:" key/);
  await assert.rejects(() => protoDel("pm:hwm:portfolio"), /refuses a non-"proto:" key/);
  await assert.rejects(() => protoListPush("pm:something", 1), /refuses a non-"proto:" key/);
});

test("protoGet/protoDel degrade gracefully with no Redis configured (never throw on read)", async () => {
  // getRedis() returns null when UPSTASH_* env vars are absent, which is the
  // state of this worktree by design (no .env). Reads must not throw.
  assert.equal(await protoGet("proto:config"), null);
  await assert.doesNotReject(() => protoDel("proto:config"));
});

test("every named key helper produces a proto:-prefixed key", () => {
  const samples = [
    protoKey.universe(),
    protoKey.config(),
    protoKey.runReceipt("run-1"),
    protoKey.runList(),
    protoKey.proposal("p-1"),
    protoKey.proposalsByRun("run-1"),
    protoKey.proposalsAll(),
    protoKey.grade("p-1", "sam"),
    protoKey.gradesByProposal("p-1"),
    protoKey.weeklyLessons("2026-W39"),
    protoKey.feedbackState(),
  ];
  for (const key of samples) assert.ok(key.startsWith("proto:"), key);
});

test("proto-store.js is the only file under lib/ or jobs/ that imports @upstash/redis for prototype code", () => {
  // Every other prototype file must go through lib/proto-store.js, never straight to
  // Redis -- mirrors the universe-refresh-isolation.test.js lesson.
  const protoFiles = [
    ...readdirSync("lib").filter((f) => f.startsWith("proto-")).map((f) => `lib/${f}`),
    ...readdirSync("jobs").filter((f) => f.startsWith("proto-")).map((f) => `jobs/${f}`),
  ].filter((f) => f !== "lib/proto-store.js");
  for (const file of protoFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["']@upstash\/redis["']/,
      `${file} must not import @upstash/redis directly -- go through lib/proto-store.js`,
    );
    assert.doesNotMatch(
      source,
      /from\s+["']\.\.?\/redis\.js["']/,
      `${file} must not import the production lib/redis.js store -- go through lib/proto-store.js`,
    );
  }
});
