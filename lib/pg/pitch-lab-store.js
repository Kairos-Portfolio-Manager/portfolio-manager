import { createHash } from "node:crypto";
import { getPool } from "./client.js";
import { buildPitch } from "../pitch-lab/pitch.js";
import { etDateString } from "../market-calendar.js";
import { MANDATE_REVIEW_SCHEMA_VERSION } from "../pitch-lab/mandate-review.js";

export class PitchLabStoreNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is required: Postgres is Pitch Lab's canonical store.");
    this.name = "PitchLabStoreNotConfiguredError";
    this.code = "pitch_lab_store_not_configured";
  }
}

function resolvePool(pool, getPoolFn) {
  const resolved = pool ?? getPoolFn();
  if (!resolved) throw new PitchLabStoreNotConfiguredError();
  return resolved;
}

function duplicate(error) {
  return error?.code === "23505";
}

function rowRecord(row) {
  return typeof row.record === "string" ? JSON.parse(row.record) : row.record;
}

/**
 * Canonical Pitch Lab store. Its public shape matches the local JSONL adapter,
 * but all methods are asynchronous and every write is an INSERT guarded by a
 * database uniqueness constraint. The schema itself rejects UPDATE and DELETE.
 */
export function openPostgresPitchStore({ pool, getPoolFn = getPool } = {}) {
  const db = resolvePool(pool, getPoolFn);

  async function listPitches() {
    const result = await db.query("SELECT record FROM pitch_lab_pitches ORDER BY pitched_at, id");
    return result.rows.map(rowRecord);
  }

  async function listOutcomes() {
    const result = await db.query("SELECT record FROM pitch_lab_outcomes ORDER BY graded_at, pitch_id, horizon_days");
    return result.rows.map(rowRecord);
  }

  async function listSelections() {
    const result = await db.query("SELECT record FROM pitch_lab_selections ORDER BY selection_date");
    return result.rows.map(rowRecord);
  }

  async function appendPitch(input) {
    const pitch = buildPitch(input);
    try {
      await db.query(
        "INSERT INTO pitch_lab_pitches (id, agent_id, ticker, pitched_at, pitch_date, record) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
        [pitch.id, pitch.agentId, pitch.ticker, pitch.pitchedAt, etDateString(new Date(pitch.pitchedAt)), JSON.stringify(pitch)],
      );
    } catch (error) {
      if (duplicate(error)) {
        const conflict = new Error(`pitch ${pitch.id} already recorded for this agent, ticker, and ET date (pitches are never rewritten)`);
        conflict.code = "pitch_already_recorded";
        throw conflict;
      }
      throw error;
    }
    return pitch;
  }

  async function appendOutcome(outcome) {
    if (outcome?.status !== "matured") throw new Error("only matured outcomes are stored");
    if (!Number.isFinite(outcome.excessReturn)) throw new Error("matured outcome is missing excessReturn");
    try {
      const result = await db.query(
        `INSERT INTO pitch_lab_outcomes (pitch_id, horizon_days, graded_at, record)
         SELECT $1, $2, $3, $4::jsonb
         WHERE EXISTS (SELECT 1 FROM pitch_lab_pitches WHERE id = $1)
         RETURNING pitch_id`,
        [outcome.pitchId, outcome.horizonDays, outcome.gradedAt, JSON.stringify(outcome)],
      );
      if (!result.rowCount) throw new Error(`outcome references unknown pitch ${outcome.pitchId}`);
    } catch (error) {
      if (duplicate(error)) throw new Error(`outcome for ${outcome.pitchId} at ${outcome.horizonDays}d already recorded`);
      throw error;
    }
    return outcome;
  }

  async function appendSelection(receipt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(receipt?.date ?? ""))) throw new Error("selection receipt needs a YYYY-MM-DD date");
    if (!Array.isArray(receipt.picks)) throw new Error("selection receipt needs a picks array");
    try {
      await db.query(
        "INSERT INTO pitch_lab_selections (selection_date, record) VALUES ($1, $2::jsonb)",
        [receipt.date, JSON.stringify(receipt)],
      );
    } catch (error) {
      if (duplicate(error)) throw new Error(`selection for ${receipt.date} already recorded (a day is drawn once)`);
      throw error;
    }
    return receipt;
  }

  async function listMandateReviews({ agentId = null } = {}) {
    const result = agentId
      ? await db.query("SELECT record FROM pitch_lab_mandate_reviews WHERE agent_id = $1 ORDER BY generated_at DESC", [agentId])
      : await db.query("SELECT record FROM pitch_lab_mandate_reviews ORDER BY generated_at DESC");
    return result.rows.map(rowRecord);
  }

  async function appendMandateReview(review) {
    if (!review || typeof review !== "object") throw new Error("appendMandateReview: review must be an object");
    if (review.schemaVersion !== MANDATE_REVIEW_SCHEMA_VERSION) throw new Error(`appendMandateReview: unexpected schemaVersion "${review.schemaVersion}"`);
    if (!review.agentId) throw new Error("appendMandateReview: review.agentId is required");
    if (!review.generatedAt || !Number.isFinite(Date.parse(review.generatedAt))) throw new Error("appendMandateReview: review.generatedAt must be an ISO timestamp");
    if (!review.status) throw new Error("appendMandateReview: review.status is required");
    const id = `mr_${createHash("sha256").update(JSON.stringify(review)).digest("hex").slice(0, 20)}`;
    const reviewWithId = { id, ...review };
    try {
      await db.query(
        "INSERT INTO pitch_lab_mandate_reviews (id, agent_id, generated_at, status, record) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [id, review.agentId, review.generatedAt, review.status, JSON.stringify(reviewWithId)],
      );
    } catch (error) {
      if (duplicate(error)) {
        const conflict = new Error(`mandate review ${id} already recorded (identical content)`);
        conflict.code = "mandate_review_already_recorded";
        throw conflict;
      }
      throw error;
    }
    return reviewWithId;
  }

  return { kind: "postgres", listPitches, listOutcomes, listSelections, appendPitch, appendOutcome, appendSelection, listMandateReviews, appendMandateReview };
}
