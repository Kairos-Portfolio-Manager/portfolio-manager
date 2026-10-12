/**
 * Pitch Lab store — append-only JSON-lines files, one record per line.
 *
 *   <dir>/pitches.jsonl   one validated pitch per line (buildPitch output)
 *   <dir>/outcomes.jsonl  one matured grade per line, unique per (pitchId, horizonDays)
 *   <dir>/selections.jsonl one daily candidate-selection receipt per line, unique per date
 *
 * Append-only by construction: there is no update or delete. A duplicate pitch
 * id or a second outcome for the same (pitchId, horizon) is refused, so a
 * record can never be silently rewritten after the fact. Nothing here touches
 * Redis, Sheets, Postgres, or any production key.
 *
 * Deliberately file-based so the framework runs anywhere with no credentials.
 * When it moves onto the Jetson, swap this module for a Postgres/Redis store
 * with the same four functions; nothing else changes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildPitch } from "./pitch.js";

export function defaultPitchLabDir(env = process.env) {
  const configured = (env.PITCH_LAB_DIR ?? "").trim();
  return configured || path.resolve(process.cwd(), "data/pitch-lab");
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path.basename(file)} line ${index + 1} is not valid JSON: ${error.message}`);
      }
    });
}

export function openPitchStore(dir = defaultPitchLabDir()) {
  const pitchesFile = path.join(dir, "pitches.jsonl");
  const outcomesFile = path.join(dir, "outcomes.jsonl");
  const selectionsFile = path.join(dir, "selections.jsonl");
  const ensureDir = () => mkdirSync(dir, { recursive: true });

  function listPitches() {
    return readJsonLines(pitchesFile);
  }

  function listOutcomes() {
    return readJsonLines(outcomesFile);
  }

  /** Validate (again — never trust the caller) and append. Returns the stored record. */
  function appendPitch(input) {
    const pitch = buildPitch(input);
    if (listPitches().some((existing) => existing.id === pitch.id)) {
      throw new Error(`pitch ${pitch.id} already recorded (pitches are never rewritten)`);
    }
    ensureDir();
    appendFileSync(pitchesFile, `${JSON.stringify(pitch)}\n`);
    return pitch;
  }

  /** Append one matured outcome. Immature/unavailable rows are not final and are refused. */
  function appendOutcome(outcome) {
    if (outcome?.status !== "matured") throw new Error("only matured outcomes are stored");
    if (!Number.isFinite(outcome.excessReturn)) throw new Error("matured outcome is missing excessReturn");
    const pitchIds = new Set(listPitches().map((p) => p.id));
    if (!pitchIds.has(outcome.pitchId)) throw new Error(`outcome references unknown pitch ${outcome.pitchId}`);
    const duplicate = listOutcomes().some((o) => o.pitchId === outcome.pitchId && o.horizonDays === outcome.horizonDays);
    if (duplicate) throw new Error(`outcome for ${outcome.pitchId} at ${outcome.horizonDays}d already recorded`);
    ensureDir();
    appendFileSync(outcomesFile, `${JSON.stringify(outcome)}\n`);
    return outcome;
  }

  function listSelections() {
    return readJsonLines(selectionsFile);
  }

  /** One receipt per trading date: a second draw for the same date is refused, so a day's sampling can never be redone after seeing it. */
  function appendSelection(receipt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(receipt?.date ?? ""))) throw new Error("selection receipt needs a YYYY-MM-DD date");
    if (!Array.isArray(receipt.picks)) throw new Error("selection receipt needs a picks array");
    if (listSelections().some((existing) => existing.date === receipt.date)) {
      throw new Error(`selection for ${receipt.date} already recorded (a day is drawn once)`);
    }
    ensureDir();
    appendFileSync(selectionsFile, `${JSON.stringify(receipt)}\n`);
    return receipt;
  }

  return { dir, listPitches, listOutcomes, listSelections, appendPitch, appendOutcome, appendSelection };
}
