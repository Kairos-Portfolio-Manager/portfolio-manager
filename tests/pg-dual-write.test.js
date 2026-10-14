import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  dualWriteEnabled,
  runShadowOperation,
  shadowWriteProposal,
  shadowWriteLot,
  shadowWriteCapitalEntry,
  shadowWriteNavSnapshot,
  shadowWritePosition,
  shadowReplacePositions,
} from "../lib/pg/dual-write.js";
import { applyMigrations } from "../lib/pg/restore-drill.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "db/migrations");

// The safety-critical properties of the shadow layer, testable without a DB:
// OFF by default, and a shadow write is always a no-op that never throws when
// disabled. (Live insert/parity behavior is exercised by the manual Neon smoke,
// not the unit suite, so CI never depends on DB connectivity.)

const savedFlag = process.env.PG_DUAL_WRITE;
process.env.PG_DUAL_WRITE = ""; // force disabled regardless of ambient env

test("dualWriteEnabled is false without the explicit flag", () => {
  assert.equal(dualWriteEnabled(), false);
});

test("shadow writes are no-ops that never throw when disabled — even on garbage input", async () => {
  for (const fn of [shadowWriteProposal, shadowWriteLot, shadowWriteCapitalEntry, shadowWriteNavSnapshot, shadowWritePosition, shadowReplacePositions]) {
    const res = await fn({ total: "garbage", not: "a real object" });
    assert.deepEqual(res, { ok: false, skipped: true });
  }
});

test("NAV shadow write validates and inserts a complete accounting snapshot", async () => {
  const calls = [];
  const result = await shadowWriteNavSnapshot({
    date: "2026-07-14",
    totalValue: 125.37,
    cash: 110,
    unitsOutstanding: 100,
    navPerUnit: 1.2537,
  }, { enabled: true, pool: { query: async (...args) => calls.push(args) } });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /INSERT INTO nav_snapshots/);
  assert.match(calls[0][0], /pg_advisory_xact_lock/);
  assert.match(calls[0][0], /ORDER BY id DESC\s+LIMIT 1/);
  assert.deepEqual(calls[0][1], ["2026-07-14", 125.37, 110, 100, 1.2537]);
});

test("real Postgres NAV writes compare only with the latest same-date row", async () => {
  const db = new PGlite();
  try {
    await applyMigrations(db, migrationsDir);
    const values = [98.90, 98.78, 98.77, 98.78, 98.77, 98.77];
    for (const navPerUnit of values) {
      const result = await shadowWriteNavSnapshot({
        date: "2026-10-12",
        totalValue: navPerUnit * 100,
        cash: 100,
        unitsOutstanding: 100,
        navPerUnit,
      }, { enabled: true, pool: db });
      assert.equal(result.ok, true);
    }
    const rows = (await db.query(
      "SELECT nav_per_unit::float8 AS nav FROM nav_snapshots WHERE snapshot_date = $1 ORDER BY id",
      ["2026-10-12"],
    )).rows;
    assert.deepEqual(rows.map((row) => row.nav), [98.90, 98.78, 98.77, 98.78, 98.77]);
  } finally {
    await db.close();
  }
});

test("an enabled shadow failure is reported but never thrown into the authoritative path", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = await runShadowOperation(
      "failure-test",
      async () => { throw new Error("database unavailable"); },
      { enabled: true, pool: {} }
    );
    assert.deepEqual(result, { ok: false, error: "database unavailable" });
    assert.match(errors[0], /authoritative write unaffected/);
  } finally {
    console.error = originalError;
  }
});

test("position refresh rolls back a partial shadow transaction and still does not throw", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (String(sql).startsWith("INSERT INTO positions") && queries.filter((q) => String(q).startsWith("INSERT INTO positions")).length === 2) {
        throw new Error("second row failed");
      }
    },
    release() {},
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await shadowReplacePositions([
      { ticker: "NVDA", shares: 1, avgCost: 100, costBasis: 100, marketValue: 110 },
      { ticker: "AMD", shares: 2, avgCost: 50, costBasis: 100, marketValue: 105 },
    ], { enabled: true, pool: { connect: async () => client } });
    assert.deepEqual(result, { ok: false, error: "second row failed" });
    assert.ok(queries.includes("ROLLBACK"));
    assert.ok(!queries.includes("COMMIT"));
  } finally {
    console.error = originalError;
  }
});

test("position refresh stores one quote provenance identity with every valuation row", async () => {
  const calls = [];
  const client = { async query(...args) { calls.push(args); }, release() {} };
  const result = await shadowReplacePositions([
    { ticker: "NVDA", shares: 1, avgCost: 100, costBasis: 100, marketValue: 110 },
  ], {
    enabled: true,
    pool: { connect: async () => client },
    valuation: {
      quoteSnapshotVersion: "yahoo-quote-set-v1:abc",
      quoteSource: "yahoo-finance2:quote",
      quoteTimestamp: "2026-07-14T19:59:58.000Z",
    },
  });
  assert.deepEqual(result, { ok: true });
  const insert = calls.find(([sql]) => String(sql).includes("INSERT INTO positions"));
  assert.equal(insert[1][6], "yahoo-quote-set-v1:abc");
  assert.equal(insert[1][7], "yahoo-finance2:quote");
  assert.equal(insert[1][8].toISOString(), "2026-07-14T19:59:58.000Z");
});

test.after(() => {
  if (savedFlag === undefined) delete process.env.PG_DUAL_WRITE;
  else process.env.PG_DUAL_WRITE = savedFlag;
});
