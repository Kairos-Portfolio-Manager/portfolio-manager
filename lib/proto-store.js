// The ONLY module allowed to touch Redis for the Research Testing Prototype.
// Every key it touches is guarded to the `proto:` prefix at runtime -- it
// refuses to read or write a `pm:*` key, so a bug in the prototype code can never
// reach production state. Reuses the same Upstash client/credentials as
// production (see docs/roadmaps/RESEARCH-LAB-PLAN-2026-09-23.md "Isolation")
// -- separation is by key namespace, not by database.
//
// Mirrors production's `getRedis()` pattern (lib/redis.js) deliberately, so
// this stays easy to read for anyone who already knows that file.

import { getRedis } from "./redis.js";

const PROTO_PREFIX = "proto:";

function assertLabKey(key) {
  if (typeof key !== "string" || !key.startsWith(PROTO_PREFIX)) {
    throw new TypeError(`proto-store refuses a non-"proto:" key: ${JSON.stringify(key)}`);
  }
  return key;
}

// Every function validates the key BEFORE checking whether Redis is even
// configured. The guard must hold regardless of environment state -- it must
// never be possible for "no .env present" to silently skip the isolation
// check the way the 2026-09-21 universe-refresh incident showed a missing
// seam can.

export async function protoGet(key) {
  assertLabKey(key);
  const redis = getRedis();
  if (!redis) return null;
  const value = await redis.get(key);
  return value ?? null;
}

export async function protoSet(key, value, { ex } = {}) {
  assertLabKey(key);
  const redis = getRedis();
  if (!redis) throw new Error(`proto-store: Redis not configured, refusing to silently drop a write to ${key}`);
  await redis.set(key, value, ex ? { ex } : undefined);
}

export async function protoDel(key) {
  assertLabKey(key);
  const redis = getRedis();
  if (!redis) return;
  await redis.del(key);
}

/** Appends to a Redis list, keeping only the most recent `maxLength` entries. */
// Bug found in the first live run (2026-09-23): unconditionally
// JSON.stringify-ing every pushed value, including plain strings, double-
// encodes them ("proto-run-x:AAPL" -> '"proto-run-x:AAPL"'), and the Upstash
// client's own response handling meant protoListRange's unconditional
// JSON.parse then choked on the already-plain string. Production's own
// lib/redis.js pushes plain string list items (e.g. proposal IDs) with no
// JSON.stringify at all and reads them back raw -- match that: only encode
// non-string values, and fall back to the raw string on a parse failure
// instead of assuming every row is JSON.
export async function protoListPush(key, value, { maxLength = 5000 } = {}) {
  assertLabKey(key);
  const redis = getRedis();
  if (!redis) throw new Error(`proto-store: Redis not configured, refusing to silently drop a write to ${key}`);
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  await redis.lpush(key, encoded);
  if (maxLength > 0) await redis.ltrim(key, 0, maxLength - 1);
}

export async function protoListRange(key, { start = 0, end = -1 } = {}) {
  assertLabKey(key);
  const redis = getRedis();
  if (!redis) return [];
  const rows = await redis.lrange(key, start, end);
  return rows.map((row) => {
    if (typeof row !== "string") return row;
    try {
      return JSON.parse(row);
    } catch {
      return row; // a plain string pushed as-is (e.g. a proposal ID), not JSON
    }
  });
}

/** Fails loudly rather than returning an empty scan, per project convention. */
export async function protoKeys(pattern) {
  const redis = getRedis();
  if (!redis) throw new Error("proto-store: Redis not configured, cannot list keys");
  const fullPattern = assertLabKey(pattern.startsWith(PROTO_PREFIX) ? pattern : `${PROTO_PREFIX}${pattern}`);
  const keys = [];
  let cursor = 0;
  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: fullPattern, count: 200 });
    keys.push(...batch);
    cursor = Number(nextCursor);
  } while (cursor !== 0);
  return keys;
}

export const PROTO_KEY_PREFIX = PROTO_PREFIX;

// -- Named key helpers, so every call site agrees on the exact key shape --

export const protoKey = {
  universe: () => "proto:universe:tickers",
  config: () => "proto:config",
  runReceipt: (runId) => `proto:run:${runId}:receipt`,
  runList: () => "proto:runs",
  proposal: (proposalId) => `proto:proposal:${proposalId}`,
  proposalsByRun: (runId) => `proto:run:${runId}:proposals`,
  proposalsAll: () => "proto:proposals:all",
  grade: (proposalId, grader) => `proto:grade:${proposalId}:${grader}`,
  gradesByProposal: (proposalId) => `proto:proposal:${proposalId}:graders`,
  weeklyLessons: (windowId) => `proto:feedback:${windowId}`,
  feedbackState: () => "proto:feedback:state",
  newsCache: (ticker) => `proto:news:${ticker}`,
  macroCache: () => "proto:macro",
  treasuryCache: () => "proto:macro:treasury-yield-change-bps",
  usage: () => "proto:anthropic-usage",
};
