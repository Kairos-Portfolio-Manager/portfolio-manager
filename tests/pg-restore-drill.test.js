import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyMigrations,
  assertBackupCoverage,
  decryptSnapshot,
  encryptSnapshot,
  exportLogicalSnapshot,
  privacySafeManifest,
  restoreLogicalSnapshot,
  verifyRestoredSnapshot,
} from "../lib/pg/restore-drill.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "db/migrations");

async function disposableDb(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const db = new PGlite();
  return { db, directory, close: async () => { await db.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function seedRepresentativeState(db) {
  await db.query("INSERT INTO investors (investor_id, email, name) VALUES ($1,$2,$3)", ["fixture-investor", "fixture@example.invalid", "Fixture"]);
  await db.query(
    `INSERT INTO capital_entries
       (entry_id, investor_id, entry_date, type, amount, nav_per_unit, units, row_hmac)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ["capital-fixture", "fixture-investor", "2026-07-14", "contribution", "1000.00", "1.000000", "1000.000000", "a".repeat(64)]
  );
  await db.query(
    `INSERT INTO proposals
       (id, agent_id, ticker, side, amount_dollars, rationale, risk_summary, status,
        created_by_user_id, decision_hmac, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)`,
    ["proposal-fixture", "agent-1", "FIX", "BUY", "125.00", "restore fixture", "bounded", "ApprovedForBrokerReview", "fixture-user", "b".repeat(64), "2026-07-14T16:00:00Z", "2026-07-15T16:00:00Z"]
  );
  await db.query(
    `INSERT INTO positions (ticker, name, shares, avg_cost, cost_basis, market_value)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    ["FIX", "Restore Fixture", "9999999999.12345678", "100.0000", "125.00", "126.25"]
  );
  await db.query(
    `INSERT INTO lots
       (lot_id, ticker, owner_agent_id, open_date, cost_per_share, shares_original, shares_open, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ["lot-fixture", "FIX", "agent-1", "2026-07-14", "100.0000", "0.07560000", "0.00011500", "OPEN"]
  );
  await db.query(
    `INSERT INTO job_runs (job, status, started_at, ended_at, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    ["restore-fixture", "ok", "2026-07-14T16:00:00Z", "2026-07-14T16:00:01Z", { fixture: true }]
  );
  await db.query(
    "INSERT INTO pitch_lab_selections (selection_date, record) VALUES ($1, $2)",
    ["2026-10-12", { date: "2026-10-12", picks: [{ ticker: "FIX" }] }]
  );
  await db.query(
    "INSERT INTO pitch_lab_pitches (id, agent_id, ticker, pitched_at, pitch_date, record) VALUES ($1, $2, $3, $4, $5, $6)",
    ["pitch-fixture", "agent-1", "FIX", "2026-10-12T22:40:00Z", "2026-10-12", { id: "pitch-fixture", agentId: "agent-1", ticker: "FIX", pitchedAt: "2026-10-12T22:40:00.000Z" }]
  );
  await db.query(
    "INSERT INTO pitch_lab_outcomes (pitch_id, horizon_days, graded_at, record) VALUES ($1, $2, $3, $4)",
    ["pitch-fixture", 5, "2026-10-20T22:00:00Z", { pitchId: "pitch-fixture", horizonDays: 5, status: "matured", gradedAt: "2026-10-20T22:00:00Z" }]
  );
}

test("real migrations + encrypted logical snapshot restore cleanly into disposable Postgres", async () => {
  const source = await disposableDb("portfolio-pg-source-");
  const target = await disposableDb("portfolio-pg-target-");
  try {
    const migrationFiles = await applyMigrations(source.db, migrationsDir);
    await seedRepresentativeState(source.db);
    // Reproduce the production topology: Neon renders timestamptz in GMT while
    // PGlite inherits the restore host's local timezone. Snapshot and verify
    // must canonicalize both sessions rather than comparing display zones.
    await source.db.query("SET TIME ZONE 'Etc/GMT+5'");
    const snapshot = await exportLogicalSnapshot(source.db);
    assert.match(snapshot.tables.proposals.rows[0].created_at, /\+00$/);
    const { envelope, key } = encryptSnapshot(snapshot);
    assert.doesNotMatch(envelope.toString("utf8"), /fixture@example\.invalid|proposal-fixture/);
    const envelopeMetadata = JSON.parse(envelope.toString("utf8"));
    assert.equal(envelopeMetadata.format, "portfolio-postgres-encrypted-v2");
    assert.equal(envelopeMetadata.compression, "gzip");

    const decrypted = decryptSnapshot(envelope, key);
    await applyMigrations(target.db, migrationsDir);
    const schemaTampered = structuredClone(decrypted);
    schemaTampered.tables.positions.columns.find(({ name }) => name === "shares").udtName = "float8";
    await assert.rejects(
      restoreLogicalSnapshot(target.db, schemaTampered),
      /restore target schema does not match backup for positions/
    );
    await restoreLogicalSnapshot(target.db, decrypted);
    await target.db.query("SET TIME ZONE 'Etc/GMT+5'");
    const verification = await verifyRestoredSnapshot(target.db, decrypted);

    assert.equal(verification.ok, true);
    // 25 as of 0011_pitch_lab_mandate_review. This count is deliberately explicit:
    // adding a table to the schema without adding it to the backup inventory
    // must break here rather than silently ship an unbacked-up table.
    assert.equal(verification.tablesVerified, 25);
    assert.ok(verification.rowsVerified >= 7);
    assert.deepEqual(decrypted.migrations, migrationFiles);

    const restoredCapital = (await target.db.query("SELECT row_hmac FROM capital_entries WHERE entry_id = $1", ["capital-fixture"])).rows[0];
    const restoredProposal = (await target.db.query("SELECT decision_hmac FROM proposals WHERE id = $1", ["proposal-fixture"])).rows[0];
    assert.equal(restoredCapital.row_hmac, "a".repeat(64));
    assert.equal(restoredProposal.decision_hmac, "b".repeat(64));
    const restoredPosition = (await target.db.query(
      "SELECT shares::text AS shares FROM positions WHERE ticker = $1",
      ["FIX"]
    )).rows[0];
    assert.equal(restoredPosition.shares, "9999999999.12345678");
    assert.equal(decrypted.tables.positions.rows[0].shares, "9999999999.12345678");
    assert.equal(decrypted.tables.positions.columns.find(({ name }) => name === "shares")?.udtName, "numeric");
    const restoredLot = (await target.db.query(
      "SELECT shares_original::text AS original, shares_open::text AS open FROM lots WHERE lot_id = $1",
      ["lot-fixture"]
    )).rows[0];
    assert.equal(restoredLot.original, "0.07560000");
    assert.equal(restoredLot.open, "0.00011500");

    // A post-restore serial insert must not collide with restored IDs.
    const next = (await target.db.query(
      "INSERT INTO job_runs (job,status,started_at) VALUES ('after-restore','ok',now()) RETURNING id"
    )).rows[0].id;
    assert.equal(Number(next), 2);

    const manifest = privacySafeManifest(snapshot, verification, { totalMs: 1234 }, "fixture");
    assert.deepEqual(manifest.verification, {
      ok: true,
      tablesVerified: 25,
      failedTableCount: 0,
      allColumnsAndSignatureBytesPreserved: true,
    });
    assert.equal(manifest.rtoSeconds, 1.234);
    assert.equal(manifest.encryptedBackup, "aes-256-gcm+gzip");
    assert.doesNotMatch(JSON.stringify(manifest), /fixture@example\.invalid|proposal-fixture|FIX/);
  } finally {
    await source.close();
    await target.close();
  }
});

test("coverage fails closed when a new public table is not in the backup inventory", async () => {
  const source = await disposableDb("portfolio-pg-coverage-");
  try {
    await applyMigrations(source.db, migrationsDir);
    await source.db.query("CREATE TABLE untracked_financial_state (id text primary key)");
    await assert.rejects(assertBackupCoverage(source.db), /uncovered \[untracked_financial_state\]/);
  } finally {
    await source.close();
  }
});

test("authenticated encryption rejects a tampered backup", async () => {
  const { envelope, key } = encryptSnapshot({ format: "portfolio-postgres-logical-v2", migrations: [], tables: {} });
  const parsed = JSON.parse(envelope.toString("utf8"));
  const bytes = Buffer.from(parsed.ciphertext, "base64");
  bytes[0] ^= 1;
  parsed.ciphertext = bytes.toString("base64");
  assert.throws(() => decryptSnapshot(Buffer.from(JSON.stringify(parsed)), key));
});

test("compressed envelopes keep repetitive production-shaped evidence bounded", () => {
  const repeatedEvidence = "evidence-row:".repeat(100_000);
  const snapshot = {
    format: "portfolio-postgres-logical-v2",
    migrations: ["0010_pitch_lab.sql"],
    tables: { evidence_snapshots: { rows: [{ payload: repeatedEvidence }] } },
  };
  const { envelope, key } = encryptSnapshot(snapshot);
  assert.ok(envelope.length < Buffer.byteLength(JSON.stringify(snapshot)) / 20);
  assert.deepEqual(decryptSnapshot(envelope, key), snapshot);
});

test("decrypt remains compatible with legacy uncompressed v1 envelopes", () => {
  const snapshot = { format: "portfolio-postgres-logical-v2", migrations: [], tables: {} };
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(snapshot))), cipher.final()]);
  const envelope = Buffer.from(JSON.stringify({
    format: "portfolio-postgres-encrypted-v1",
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
  assert.deepEqual(decryptSnapshot(envelope, key), snapshot);
});
