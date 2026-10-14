import test from "node:test";
import assert from "node:assert/strict";
import { createProposal } from "../lib/redis.js";

const input = () => ({
  agentId: "agent-1",
  ticker: "NET",
  side: "BUY",
  amountDollars: 500,
  maxPrice: 210,
  rationale: "Strong evidence across growth and price confirmation.",
  riskSummary: "Position remains inside the risk cap.",
});

function fakeRedis({ failLpush = false } = {}) {
  const values = new Map();
  const ids = [];
  return {
    values,
    ids,
    async set(key, value) { values.set(key, value); return "OK"; },
    async lpush(_key, id) {
      if (failLpush) throw new Error("queue unavailable");
      ids.unshift(id);
      return ids.length;
    },
    async ltrim() { return "OK"; },
  };
}

test("a stalled proposal Telegram sender cannot delay proposal creation", async () => {
  const redis = fakeRedis();
  const never = new Promise(() => {});
  const result = await Promise.race([
    createProposal(input(), { redis, notify: async () => never }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("createProposal stalled")), 100)),
  ]);
  assert.equal(result.ticker, "NET");
  assert.equal(redis.ids.length, 1);
  assert.ok(redis.values.has(`pm:approval_proposal:${result.id}`));
});

test("a rejected proposal Telegram send leaves the queued proposal intact", async () => {
  const redis = fakeRedis();
  const original = console.error;
  console.error = () => {};
  try {
    const result = await createProposal(input(), { redis, notify: async () => { throw new Error("telegram down"); } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.ticker, "NET");
    assert.deepEqual(redis.ids, [result.id]);
    assert.ok(redis.values.has(`pm:approval_proposal:${result.id}`));
  } finally {
    console.error = original;
  }
});

test("a failed proposal queue write never attempts Telegram delivery", async () => {
  const redis = fakeRedis({ failLpush: true });
  let sends = 0;
  const original = console.warn;
  console.warn = () => {};
  try {
    const result = await createProposal(input(), { redis, notify: async () => { sends += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result, null);
    assert.equal(sends, 0);
  } finally {
    console.warn = original;
  }
});
