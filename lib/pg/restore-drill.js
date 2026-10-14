import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Dependency order matters: every referenced row must exist before its child.
// This is intentionally explicit so schema additions cannot silently disappear
// from backup coverage.
export const RESTORE_TABLES = Object.freeze([
  "research_intents",
  "proposals",
  "lots",
  "orders",
  "fills",
  "lot_consumptions",
  "job_runs",
  "audit_events",
  "investors",
  "capital_entries",
  "positions",
  "nav_snapshots",
  "research_job_runs",
  "universe_snapshots",
  "evidence_snapshots",
  "mandate_score_observations",
  "research_events",
  "research_selection_runs",
  "research_selection_items",
  "research_outcomes",
  // Locally-observed consensus history. It must be backed up like any other
  // research table: the estimateRevisions activation gate counts observed
  // snapshots, so losing rows silently resets a 90-day window rather than
  // producing a visible gap.
  "consensus_snapshots",
  // Pitch Lab is canonical in Postgres from its first production record.
  // Selection must restore before pitches, and pitches before outcomes.
  "pitch_lab_selections",
  "pitch_lab_pitches",
  "pitch_lab_outcomes",
]);

const SERIAL_COLUMNS = Object.freeze([
  ["fills", "id"],
  ["lot_consumptions", "id"],
  ["job_runs", "id"],
  ["nav_snapshots", "id"],
]);

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

function canonical(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) return JSON.stringify(instant.toISOString());
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function digestRows(rows) {
  return createHash("sha256").update(canonical(rows)).digest("hex");
}

async function tableNames(queryable) {
  const result = await queryable.query(
    `SELECT tablename
       FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`
  );
  return result.rows.map((row) => row.tablename);
}

async function tableColumns(queryable, table) {
  const result = await queryable.query(
    `SELECT column_name AS name,
            data_type AS "dataType",
            udt_schema AS "udtSchema",
            udt_name AS "udtName",
            ordinal_position AS "ordinalPosition"
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return result.rows.map((column) => ({
    name: column.name,
    dataType: column.dataType,
    udtSchema: column.udtSchema,
    udtName: column.udtName,
    ordinalPosition: Number(column.ordinalPosition),
  }));
}

function textProjection(columns) {
  return columns
    .map(({ name }) => `t.${quoteIdentifier(name)}::text AS ${quoteIdentifier(name)}`)
    .join(", ");
}

async function readTableAsTypedText(queryable, table, columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`snapshot schema is missing columns for ${table}`);
  }
  // Explicit ::text is load-bearing. PostgreSQL NUMERIC values otherwise pass
  // through JSON parsing or driver type parsers and can become lossy JavaScript
  // Numbers before encryption (for example NUMERIC(18,8) near 10 billion).
  // Target-column casts on INSERT reconstruct the typed values from these exact
  // strings; null remains a real null rather than the text "null".
  const result = await queryable.query(
    `SELECT ${textProjection(columns)} FROM ${quoteIdentifier(table)} AS t ORDER BY t.*`
  );
  return result.rows;
}

async function useCanonicalTextTimezone(queryable) {
  // `timestamptz::text` is rendered in the current session timezone. Neon runs
  // in GMT while the disposable PGlite target inherits the host timezone, so
  // the same instant otherwise produces different text and a false digest
  // mismatch. The drill owns dedicated sessions and canonicalizes both sides
  // to UTC before producing any content digest.
  await queryable.query("SET TIME ZONE 'UTC'");
}

export async function assertBackupCoverage(queryable) {
  const present = await tableNames(queryable);
  const expected = new Set(["_migrations", ...RESTORE_TABLES]);
  const missing = [...expected].filter((table) => !present.includes(table));
  const uncovered = present.filter((table) => !expected.has(table));
  if (missing.length || uncovered.length) {
    throw new Error(
      `backup coverage mismatch: missing [${missing.join(", ") || "none"}], uncovered [${uncovered.join(", ") || "none"}]`
    );
  }
  return present;
}

export async function applyMigrations(queryable, migrationsDir) {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set((await queryable.query("SELECT filename FROM _migrations")).rows.map((row) => row.filename));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await queryable.query("BEGIN");
    try {
      // node-postgres accepts a multi-statement simple query; PGlite exposes
      // `exec` for that same operation and reserves `query` for one statement.
      if (typeof queryable.exec === "function") await queryable.exec(sql);
      else await queryable.query(sql);
      await queryable.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await queryable.query("COMMIT");
    } catch (error) {
      await queryable.query("ROLLBACK").catch(() => {});
      throw new Error(`migration ${file} failed during restore drill: ${error.message}`);
    }
  }
  return files;
}

export async function exportLogicalSnapshot(queryable) {
  await useCanonicalTextTimezone(queryable);
  await assertBackupCoverage(queryable);
  const migrations = (await queryable.query("SELECT filename FROM _migrations ORDER BY filename")).rows.map((row) => row.filename);
  const tables = {};
  for (const table of RESTORE_TABLES) {
    const columns = await tableColumns(queryable, table);
    // Ordering by the whole composite row is deterministic across the source
    // and target without embedding private primary-key values in a manifest.
    const rows = await readTableAsTypedText(queryable, table, columns);
    tables[table] = { columns, rows, count: rows.length, digest: digestRows(rows) };
  }
  return {
    format: "portfolio-postgres-logical-v2",
    createdAt: new Date().toISOString(),
    migrations,
    tables,
  };
}

export function encryptSnapshot(snapshot, key = randomBytes(32)) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("snapshot encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(canonical(snapshot));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    key,
    envelope: Buffer.from(JSON.stringify({
      format: "portfolio-postgres-encrypted-v1",
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    })),
  };
}

export function decryptSnapshot(envelope, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("snapshot decryption key must be 32 bytes");
  const parsed = JSON.parse(Buffer.from(envelope).toString("utf8"));
  if (parsed.format !== "portfolio-postgres-encrypted-v1" || parsed.algorithm !== "aes-256-gcm") {
    throw new Error("unsupported encrypted snapshot format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function resetSerialSequences(queryable) {
  for (const [table, column] of SERIAL_COLUMNS) {
    const max = String((await queryable.query(
      `SELECT COALESCE(MAX(${quoteIdentifier(column)}), 0) AS max FROM ${quoteIdentifier(table)}`
    )).rows[0].max);
    if (!/^\d+$/.test(max)) throw new Error(`invalid serial maximum for ${table}.${column}`);
    const sequence = (await queryable.query("SELECT pg_get_serial_sequence($1, $2) AS name", [table, column])).rows[0].name;
    if (!sequence) continue;
    const hasRows = BigInt(max) > 0n;
    await queryable.query("SELECT setval($1::regclass, $2, $3)", [sequence, hasRows ? max : "1", hasRows]);
  }
}

export async function restoreLogicalSnapshot(queryable, snapshot) {
  if (snapshot?.format !== "portfolio-postgres-logical-v2") throw new Error("unsupported logical snapshot format");
  await assertBackupCoverage(queryable);
  const applied = (await queryable.query("SELECT filename FROM _migrations ORDER BY filename")).rows.map((row) => row.filename);
  if (canonical(applied) !== canonical(snapshot.migrations)) {
    throw new Error("restore target migration set does not match backup");
  }
  await queryable.query("BEGIN");
  try {
    for (const table of RESTORE_TABLES) {
      const backup = snapshot.tables?.[table];
      if (!backup || !Array.isArray(backup.rows)) throw new Error(`snapshot is missing table ${table}`);
      const targetColumns = await tableColumns(queryable, table);
      if (canonical(targetColumns) !== canonical(backup.columns)) {
        throw new Error(`restore target schema does not match backup for ${table}`);
      }
      for (const row of backup.rows) {
        const columns = backup.columns.map(({ name }) => name);
        const names = columns.map(quoteIdentifier).join(", ");
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
        await queryable.query(
          `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders})`,
          columns.map((column) => row[column])
        );
      }
    }
    await resetSerialSequences(queryable);
    await queryable.query("COMMIT");
  } catch (error) {
    await queryable.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function verifyRestoredSnapshot(queryable, snapshot) {
  await useCanonicalTextTimezone(queryable);
  const failures = [];
  let rowsVerified = 0;
  for (const table of RESTORE_TABLES) {
    const expected = snapshot.tables[table];
    const actualColumns = await tableColumns(queryable, table);
    if (canonical(actualColumns) !== canonical(expected.columns)) {
      failures.push({ table, expectedCount: expected.count, actualCount: null, reason: "schema mismatch" });
      continue;
    }
    const rows = await readTableAsTypedText(queryable, table, actualColumns);
    const digest = digestRows(rows);
    rowsVerified += rows.length;
    if (rows.length !== expected.count || digest !== expected.digest) {
      failures.push({ table, expectedCount: expected.count, actualCount: rows.length });
    }
  }
  return {
    ok: failures.length === 0,
    tablesVerified: RESTORE_TABLES.length,
    rowsVerified,
    failures,
  };
}

export function privacySafeManifest(snapshot, verification, timings, sourceKind) {
  const populatedTables = Object.values(snapshot.tables).filter((table) => table.count > 0).length;
  return {
    format: "portfolio-postgres-restore-proof-v1",
    sourceKind,
    generatedAt: new Date().toISOString(),
    sourceSnapshotAt: snapshot.createdAt,
    migrationCount: snapshot.migrations.length,
    tableCount: RESTORE_TABLES.length,
    populatedTableCount: populatedTables,
    totalRows: verification.rowsVerified,
    encryptedBackup: "aes-256-gcm",
    verification: {
      ok: verification.ok,
      tablesVerified: verification.tablesVerified,
      failedTableCount: verification.failures.length,
      allColumnsAndSignatureBytesPreserved: verification.ok,
    },
    rpo: "transaction-consistent snapshot at drill start",
    rtoSeconds: Number((timings.totalMs / 1000).toFixed(3)),
  };
}
