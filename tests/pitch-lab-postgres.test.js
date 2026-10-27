import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { buildFeatures } from "../lib/pitch-lab/features.js";
import { openPostgresPitchStore, PitchLabStoreNotConfiguredError } from "../lib/pg/pitch-lab-store.js";
import { applyMigrations } from "../lib/pg/restore-drill.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "db/migrations");

function fakePool() {
  const state = { pitches: new Map(), outcomes: new Map(), selections: new Map() };
  return {
    state,
    async query(sql, params = []) {
      if (sql.startsWith("SELECT record FROM pitch_lab_pitches")) return { rows: [...state.pitches.values()].map((record) => ({ record })) };
      if (sql.startsWith("SELECT record FROM pitch_lab_outcomes")) return { rows: [...state.outcomes.values()].map((record) => ({ record })) };
      if (sql.startsWith("SELECT record FROM pitch_lab_selections")) return { rows: [...state.selections.values()].map((record) => ({ record })) };
      if (sql.startsWith("INSERT INTO pitch_lab_pitches")) {
        if (state.pitches.has(params[0])) throw Object.assign(new Error("duplicate"), { code: "23505" });
        state.pitches.set(params[0], JSON.parse(params[5]));
        return { rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO pitch_lab_outcomes")) {
        if (!state.pitches.has(params[0])) return { rowCount: 0, rows: [] };
        const key = `${params[0]}:${params[1]}`;
        if (state.outcomes.has(key)) throw Object.assign(new Error("duplicate"), { code: "23505" });
        state.outcomes.set(key, JSON.parse(params[3]));
        return { rowCount: 1, rows: [{ pitch_id: params[0] }] };
      }
      if (sql.startsWith("INSERT INTO pitch_lab_selections")) {
        if (state.selections.has(params[0])) throw Object.assign(new Error("duplicate"), { code: "23505" });
        state.selections.set(params[0], JSON.parse(params[1]));
        return { rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function pitchInput(overrides = {}) {
  const asOf = "2026-10-12T20:00:00.000Z";
  return {
    ticker: "NET",
    pitchedAt: "2026-10-12T22:40:00.000Z",
    conviction: 4,
    intendedHoldingDays: 10,
    entryReference: { price: 210, asOf },
    features: buildFeatures({ bars: [], asOf }),
    rationale: {
      thesis: "Revenue acceleration and improving price action support a short-term setup.",
      reasons: [{ claim: "Growth is improving.", features: ["revGrowth"] }],
      risks: ["Enterprise demand could slow."],
      killCriteria: ["Revenue growth decelerates."],
    },
    provenance: { source: "manual" },
    ...overrides,
  };
}

test("Postgres Pitch Lab store is append-only and enforces referential identity", async () => {
  const pool = fakePool();
  const store = openPostgresPitchStore({ pool });
  await store.appendSelection({ date: "2026-10-12", picks: [{ ticker: "NET" }] });
  await assert.rejects(() => store.appendSelection({ date: "2026-10-12", picks: [] }), /day is drawn once/);
  const pitch = await store.appendPitch(pitchInput());
  await assert.rejects(() => store.appendPitch(pitchInput()), /never rewritten/);
  const outcome = { pitchId: pitch.id, ticker: "NET", horizonDays: 5, status: "matured", excessReturn: 0.02, gradedAt: "2026-10-20T22:00:00.000Z" };
  await store.appendOutcome(outcome);
  await assert.rejects(() => store.appendOutcome(outcome), /already recorded/);
  await assert.rejects(() => store.appendOutcome({ ...outcome, pitchId: "pitch_unknown", horizonDays: 10 }), /unknown pitch/);
  assert.equal((await store.listPitches()).length, 1);
  assert.equal((await store.listOutcomes()).length, 1);
  assert.equal((await store.listSelections()).length, 1);
});

test("Pitch Lab refuses to start without its canonical database", () => {
  assert.throws(() => openPostgresPitchStore({ pool: null, getPoolFn: () => null }), PitchLabStoreNotConfiguredError);
});

test("Pitch Lab migration protects every evidence table against update, delete, and truncate", () => {
  const sql = readFileSync(new URL("../db/migrations/0010_pitch_lab.sql", import.meta.url), "utf8");
  for (const table of ["pitch_lab_selections", "pitch_lab_pitches", "pitch_lab_outcomes"]) {
    assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON ${table}`));
    assert.match(sql, new RegExp(`BEFORE TRUNCATE ON ${table}`));
  }
});

test("real Postgres constraints enforce immutable, timezone-stable Pitch Lab evidence", async () => {
  const db = new PGlite();
  try {
    await applyMigrations(db, migrationsDir);
    await db.query("SET datestyle TO 'German, DMY'");
    await db.query(
      "INSERT INTO pitch_lab_selections (selection_date, record) VALUES ($1, $2)",
      ["2026-10-12", { date: "2026-10-12", picks: [{ ticker: "NET" }] }],
    );
    const record = { id: "pitch-1", agentId: "agent-1", ticker: "NET", pitchedAt: "2026-10-12T22:40:00.000Z" };
    await db.query(
      "INSERT INTO pitch_lab_pitches (id, agent_id, ticker, pitched_at, pitch_date, record) VALUES ($1,$2,$3,$4,$5,$6)",
      [record.id, record.agentId, record.ticker, record.pitchedAt, "2026-10-12", record],
    );

    await assert.rejects(() => db.query("UPDATE pitch_lab_pitches SET ticker = 'BAD' WHERE id = 'pitch-1'"), /append-only/);
    await assert.rejects(() => db.query("DELETE FROM pitch_lab_pitches WHERE id = 'pitch-1'"), /append-only/);
    await assert.rejects(() => db.query("TRUNCATE pitch_lab_pitches CASCADE"), /append-only/);
    await assert.rejects(
      () => db.query(
        "INSERT INTO pitch_lab_pitches (id, agent_id, ticker, pitched_at, pitch_date, record) VALUES ($1,$2,$3,$4,$5,$6)",
        ["pitch-mismatch", "agent-1", "BAD", "2026-10-12T22:40:00.000Z", "2026-10-12", { id: "pitch-mismatch", agentId: "agent-1", ticker: "BAD", pitchedAt: "1999-01-01T00:00:00.000Z" }],
      ),
      /check constraint/i,
    );
    await assert.rejects(
      () => db.query(
        "INSERT INTO pitch_lab_pitches (id, agent_id, ticker, pitched_at, pitch_date, record) VALUES ($1,$2,$3,$4,$5,$6)",
        ["pitch-missing-agent", "agent-1", "DDOG", "2026-10-12T22:40:00.000Z", "2026-10-12", { id: "pitch-missing-agent", ticker: "DDOG", pitchedAt: "2026-10-12T22:40:00.000Z" }],
      ),
      /check constraint/i,
    );
    await assert.rejects(
      () => db.query(
        "INSERT INTO pitch_lab_pitches (id, agent_id, ticker, pitched_at, pitch_date, record) VALUES ($1,$2,$3,$4,$5,$6)",
        ["pitch-duplicate", "agent-1", "NET", "2026-10-12T23:00:00.000Z", "2026-10-12", { id: "pitch-duplicate", agentId: "agent-1", ticker: "NET", pitchedAt: "2026-10-12T23:00:00.000Z" }],
      ),
      /unique constraint/i,
    );
    await assert.rejects(
      () => db.query(
        "INSERT INTO pitch_lab_outcomes (pitch_id, horizon_days, graded_at, record) VALUES ($1,$2,$3,$4)",
        ["missing-pitch", 5, "2026-10-20T22:00:00Z", { pitchId: "missing-pitch", horizonDays: 5, status: "matured", gradedAt: "2026-10-20T22:00:00Z" }],
      ),
      /foreign key constraint/i,
    );
    await assert.rejects(
      () => db.query(
        "INSERT INTO pitch_lab_outcomes (pitch_id, horizon_days, graded_at, record) VALUES ($1,$2,$3,$4)",
        ["pitch-1", 5, "2026-10-20T22:00:00Z", { pitchId: "pitch-1", horizonDays: 5, status: "matured", gradedAt: "2026-10-21T22:00:00Z" }],
      ),
      /check constraint/i,
    );

    const store = openPostgresPitchStore({ pool: db });
    const concurrent = await Promise.allSettled([
      store.appendPitch(pitchInput({ ticker: "DDOG", pitchedAt: "2026-10-13T21:00:00.000Z" })),
      store.appendPitch(pitchInput({ ticker: "DDOG", pitchedAt: "2026-10-13T21:01:00.000Z" })),
    ]);
    assert.equal(concurrent.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((row) => row.status === "rejected").length, 1);
    assert.equal(concurrent.find((row) => row.status === "rejected").reason.code, "pitch_already_recorded");
    assert.equal((await store.listPitches()).filter((pitch) => pitch.ticker === "DDOG").length, 1);
  } finally {
    await db.close();
  }
});
