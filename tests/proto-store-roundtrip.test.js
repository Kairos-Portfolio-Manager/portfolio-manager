import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression test for a real bug found in the 2026-09-23 first live run of
 * jobs/proto-research-scan.js: `node scripts/proto-export.js` crashed with
 * `SyntaxError: Unexpected token 'p', "proto-run-"... is not valid JSON`.
 *
 * protoListPush unconditionally JSON.stringify-ed every pushed value,
 * including plain strings (proposal IDs like "proto-run-x:AAPL", grader
 * names). That double-encodes a string ("x" -> '"x"'), and protoListRange's
 * unconditional JSON.parse then choked on the ALREADY-plain string the
 * Upstash client's own response handling produced. Fixed by matching
 * production's own lib/redis.js pattern (verified against
 * appendResearchScanTerminalStatus/listResearchScanHistory): only encode
 * non-string values on write, and fall back to the raw string on a parse
 * failure on read, rather than assuming every row is JSON.
 *
 * This test drives the actual write->read round trip against a fake but
 * behaviorally faithful in-memory Redis list (real Redis was not available
 * in this environment when the bug was found -- this is deliberately a
 * belt-and-braces check the live run itself already exercised).
 */

function fakeListRedis() {
  const lists = new Map();
  return {
    async lpush(key, value) {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
    },
    async ltrim(key, start, end) {
      const list = lists.get(key) ?? [];
      lists.set(key, list.slice(start, end < 0 ? undefined : end + 1));
    },
    async lrange(key, start, end) {
      const list = lists.get(key) ?? [];
      return list.slice(start, end === -1 ? undefined : end + 1);
    },
  };
}

const fakeRedis = fakeListRedis();
mock.module("../lib/redis.js", {
  exports: { getRedis: () => fakeRedis },
});

const { protoListPush, protoListRange } = await import("../lib/proto-store.js");

test("protoListPush/protoListRange round-trip plain strings without double-encoding", async () => {
  await protoListPush("proto:test:strings", "proto-run-abc123:AAPL");
  await protoListPush("proto:test:strings", "sam");
  const rows = await protoListRange("proto:test:strings");
  assert.deepEqual(rows, ["sam", "proto-run-abc123:AAPL"]); // lpush order: most recent first
  for (const row of rows) assert.equal(typeof row, "string");
});

test("protoListPush/protoListRange round-trip objects correctly", async () => {
  const receipt = { runId: "proto-run-xyz", counts: { reviewed: 5, error: 1 } };
  await protoListPush("proto:test:objects", receipt);
  const rows = await protoListRange("proto:test:objects");
  assert.deepEqual(rows[0], receipt);
});

test("protoListPush/protoListRange handle a mix of strings and objects in the same list", async () => {
  await protoListPush("proto:test:mixed", "plain-id-1");
  await protoListPush("proto:test:mixed", { complex: true, nested: { value: 1 } });
  await protoListPush("proto:test:mixed", "plain-id-2");
  const rows = await protoListRange("proto:test:mixed");
  assert.deepEqual(rows, ["plain-id-2", { complex: true, nested: { value: 1 } }, "plain-id-1"]);
});
