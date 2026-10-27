import test from "node:test";
import assert from "node:assert/strict";
import { parityStatusPayload, parityTelegramTransition, runDailyDbParityCheck } from "../jobs/db-parity-check.js";

test("daily parity status preserves aggregate valuation classification without inventories", () => {
  const payload = parityStatusPayload({
    ok: true,
    comparedAt: "2026-07-14T20:00:00.000Z",
    matched: ["positions"],
    divergences: [],
    valuation: {
      status: "NON_COMPARABLE",
      comparable: false,
      reason: "versioned quote provenance unavailable",
      authoritative: { inventory: { count: 1, digest: "private-a" }, marketValue: 15.37 },
      postgres: { inventory: { count: 1, digest: "private-b" }, marketValue: 15.39 },
    },
  });

  assert.deepEqual(payload.valuation, {
    status: "NON_COMPARABLE",
    comparable: false,
    reason: "versioned quote provenance unavailable",
  });
  assert.doesNotMatch(JSON.stringify(payload), /private-a|private-b|15\.37|15\.39/);
});

test("daily parity status is explicit when valuation classification is absent", () => {
  assert.equal(parityStatusPayload({ ok: false }).valuation, null);
});

test("accounting-shadow Telegram alerts only on divergence and recovery transitions", () => {
  const divergence = { ok: false, divergences: [{ key: "accounting_snapshot" }] };
  assert.match(parityTelegramTransition(null, divergence).message, /does not change balances/);
  assert.equal(parityTelegramTransition({ status: "diverged" }, divergence).message, null);
  assert.match(parityTelegramTransition({ status: "diverged" }, { ok: true }).message, /back in sync/);
  assert.equal(parityTelegramTransition({ status: "healthy" }, { ok: true }).message, null);
});

test("a failed parity transition alert is retried on the next run", async () => {
  const values = new Map();
  const history = [];
  const redis = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); return "OK"; },
    async lpush(_key, value) { history.unshift(value); return history.length; },
    async ltrim() { return "OK"; },
  };
  const result = {
    ok: false,
    comparedAt: "2026-10-14T00:00:00.000Z",
    report: "diverged",
    divergences: [{ key: "accounting_snapshot" }],
  };
  let attempts = 0;
  let delivered = 0;
  const original = console.warn;
  console.warn = () => {};
  try {
    await runDailyDbParityCheck({ run: async () => result, redis, send: async () => { attempts += 1; throw new Error("telegram down"); } });
    await runDailyDbParityCheck({ run: async () => result, redis, send: async () => { attempts += 1; delivered += 1; } });
  } finally {
    console.warn = original;
  }
  assert.equal(attempts, 2);
  assert.equal(delivered, 1);
  assert.equal(JSON.parse(values.get("pm:pg-parity:telegram-state")).status, "diverged");
});
