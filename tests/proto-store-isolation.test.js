import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Isolation guard for the Research Testing Prototype (docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md).
 *
 * The whole point of "same repo, isolated data" is that a bug in prototype code
 * cannot touch a `pm:*` key, create a real proposal, or write anything a real
 * production observer (Sysloop, Phase 0) would mistake for a real run.
 * lib/proto-store.js enforces the `proto:*` guard at runtime; these tests pin
 * that guard's behavior AND assert that no proto-* file imports a money-path or
 * production-status WRITE function from lib/redis.js -- mirrors the
 * 2026-09-21 universe-refresh incident (an injection seam existed for
 * everything except the store, and the store call bypassed it).
 *
 * Read-only and shared-queue functions (getPeerMetrics, getUniverseCatalog,
 * requestPeerCoverage) are deliberately NOT forbidden -- jobs/proto-research-scan.js
 * legitimately reads production's peer-metrics cache and widens the SAME shared
 * peer-coverage request queue the real Lab tool and the scheduled scan both use.
 * That is a request for more shared data, not a write of money-path or
 * prototype-identifying state, so it is allowed. Only writes that a) create real
 * proposals/orders, b) mutate risk/breaker state, or c) write production
 * scan-status keys another job or observer reads as ground truth are forbidden.
 */
const FORBIDDEN_REDIS_WRITE_FUNCTIONS = [
  "createProposal",
  "setBreakerState",
  "setPortfolioHighWaterMark",
  "setResearchScanStatus",
  "setResearchDataStatus",
  "setShadowSelectionStatus",
  "setSlateSnapshot",
  "setPrivateResearchSlate",
  "setAgentParityRuntimeSummary",
  "setInvestorUpdate",
  "setUniverseCatalog",
  "setUniverseStatus",
  "setPeerMetrics",
  "setMandateScores",
  "setLabResearchStatus", // the EXISTING dashboard "Lab" feature's own status key -- never touch it
];

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

test("proto-store.js is the only file under lib/ or jobs/ that imports @upstash/redis directly", () => {
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
  }
});

test("no proto-* file imports a money-path or production-status WRITE function from lib/redis.js", () => {
  const protoFiles = [
    ...readdirSync("lib").filter((f) => f.startsWith("proto-")).map((f) => `lib/${f}`),
    ...readdirSync("jobs").filter((f) => f.startsWith("proto-")).map((f) => `jobs/${f}`),
  ].filter((f) => f !== "lib/proto-store.js");
  for (const file of protoFiles) {
    const source = readFileSync(file, "utf8");
    const redisImportMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/redis\.js["']/);
    if (!redisImportMatch) continue;
    const importedNames = redisImportMatch[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    for (const forbidden of FORBIDDEN_REDIS_WRITE_FUNCTIONS) {
      assert.ok(
        !importedNames.includes(forbidden),
        `${file} imports "${forbidden}" from lib/redis.js -- a real money-path/production-status write, never allowed in the prototype`,
      );
    }
  }
});
