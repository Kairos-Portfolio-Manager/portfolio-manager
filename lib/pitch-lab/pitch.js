/**
 * Pitch Lab pitch record — the one row stored for every paper pitch, before
 * any outcome is known, and never edited afterwards.
 *
 * Validation FAILS CLOSED: a pitch with no rationale, an out-of-range
 * conviction, an unknown feature id, or a data timestamp after the pitch time
 * (look-ahead) is rejected with every problem listed, never stored "mostly
 * right". Paper only: nothing here creates a proposal or touches a broker.
 */
import { contentHash } from "../research-version.js";
import { TICKER_RE } from "../../contracts/proposal.js";
import { METRIC_IDS } from "../../config/scoring/mandate-v2.js";
import { FEATURE_IDS, MISSING_REASONS, isKnownFeature } from "./features.js";
import { PEER_LEVELS, PEER_MODES, PEER_RANK_STATUSES, PEER_RANK_VERSION, PEER_SET_REASONS } from "./peer-rank.js";

export const PITCH_SCHEMA_VERSION = "pitch-lab.pitch.v2"; // v2: optional per-pitch `peers` block + missingReason on features
export const CONVICTION_MIN = 1;
export const CONVICTION_MAX = 5;
export const PITCH_ACTIONS = Object.freeze(["BUY"]); // buy-only (pitch lab decision, 2026-09-24)
export const PITCH_SOURCES = Object.freeze(["live", "backtest", "manual", "synthetic_demo"]);
export const SELECTION_REASONS = Object.freeze(["screen", "mover", "random", "manual", "universe"]);

/**
 * What each conviction level means. The model is shown this verbatim so a "4"
 * means the same thing on every pitch; the analysis then measures whether it
 * was right to feel that way.
 */
export const CONVICTION_RUBRIC = Object.freeze({
  1: "Speculative: a single weak or unconfirmed signal; would not be surprised to be wrong.",
  2: "Low: one real signal, but thin evidence or an obvious counter-argument.",
  3: "Moderate: at least two supporting signals and no major red flag.",
  4: "High: several aligned fundamental signals plus price confirmation.",
  5: "Very high: strong, aligned fundamentals, price confirmation, and a near-term catalyst.",
});

export const RATIONALE_LIMITS = Object.freeze({
  thesisMinChars: 40,
  textMaxChars: 4000,
  minReasons: 1,
  maxReasons: 12,
  minRisks: 1,
});

export class PitchValidationError extends Error {
  constructor(problems) {
    super(`Invalid pitch: ${problems.join("; ")}`);
    this.name = "PitchValidationError";
    this.problems = problems;
  }
}

const isIso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

function normalizeTextList(list, path, problems, { min = 0 } = {}) {
  if (list == null) list = [];
  if (!Array.isArray(list)) {
    problems.push(`${path} must be an array of strings`);
    return [];
  }
  const out = list.map(cleanText).filter(Boolean);
  if (out.some((text) => text.length > RATIONALE_LIMITS.textMaxChars)) problems.push(`${path} entries must be at most ${RATIONALE_LIMITS.textMaxChars} characters`);
  if (out.length < min) problems.push(`${path} needs at least ${min} entr${min === 1 ? "y" : "ies"}`);
  return out;
}

function normalizeRationale(raw, problems) {
  if (!raw || typeof raw !== "object") {
    problems.push("rationale is required (thesis, reasons, risks)");
    return { thesis: "", reasons: [], risks: [], killCriteria: [] };
  }
  const thesis = cleanText(raw.thesis);
  if (thesis.length < RATIONALE_LIMITS.thesisMinChars) problems.push(`rationale.thesis must be at least ${RATIONALE_LIMITS.thesisMinChars} characters`);
  if (thesis.length > RATIONALE_LIMITS.textMaxChars) problems.push(`rationale.thesis must be at most ${RATIONALE_LIMITS.textMaxChars} characters`);

  const rawReasons = Array.isArray(raw.reasons) ? raw.reasons : [];
  if (!Array.isArray(raw.reasons)) problems.push("rationale.reasons must be an array");
  const reasons = rawReasons.map((reason, index) => {
    const claim = cleanText(reason?.claim);
    if (!claim) problems.push(`rationale.reasons[${index}].claim is required`);
    const features = Array.isArray(reason?.features) ? [...new Set(reason.features)] : [];
    for (const id of features) if (!isKnownFeature(id)) problems.push(`rationale.reasons[${index}] cites unknown feature "${id}"`);
    return { claim, features: features.filter(isKnownFeature).sort() };
  });
  if (reasons.length < RATIONALE_LIMITS.minReasons) problems.push(`rationale.reasons needs at least ${RATIONALE_LIMITS.minReasons} reason`);
  if (reasons.length > RATIONALE_LIMITS.maxReasons) problems.push(`rationale.reasons allows at most ${RATIONALE_LIMITS.maxReasons} reasons`);

  return {
    thesis,
    reasons,
    risks: normalizeTextList(raw.risks, "rationale.risks", problems, { min: RATIONALE_LIMITS.minRisks }),
    killCriteria: normalizeTextList(raw.killCriteria, "rationale.killCriteria", problems),
  };
}

function normalizeFeatures(raw, pitchedAtMs, problems) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("features must be an object keyed by feature id");
    raw = {};
  }
  for (const id of Object.keys(raw)) if (!isKnownFeature(id)) problems.push(`features has unknown feature "${id}"`);
  const out = {};
  for (const id of FEATURE_IDS) {
    const entry = raw[id];
    const value = entry && typeof entry === "object" ? entry.value : entry;
    if (value != null && !(typeof value === "number" && Number.isFinite(value))) {
      problems.push(`features.${id}.value must be a finite number or null`);
      out[id] = { value: null, missing: true, asOf: null };
      continue;
    }
    const asOf = entry && typeof entry === "object" && entry.asOf != null ? entry.asOf : null;
    if (asOf != null && !isIso(asOf)) problems.push(`features.${id}.asOf must be an ISO timestamp`);
    if (isIso(asOf) && Date.parse(asOf) > pitchedAtMs) problems.push(`features.${id}.asOf is after pitchedAt (look-ahead)`);
    const reason = entry && typeof entry === "object" ? entry.missingReason : undefined;
    if (reason != null && !MISSING_REASONS.includes(reason)) problems.push(`features.${id}.missingReason "${reason}" is not recognised`);
    if (reason != null && value != null) problems.push(`features.${id}.missingReason is only valid when the value is missing`);
    if (value == null) {
      out[id] = MISSING_REASONS.includes(reason) && reason != null
        ? { value: null, missing: true, asOf: null, missingReason: reason }
        : { value: null, missing: true, asOf: null };
    } else out[id] = { value, missing: false, asOf };
  }
  return out;
}

/**
 * The `peers` block (lib/pitch-lab/peer-rank.js computePeerRanks output), or null
 * when the pitch was recorded without peer data. Fails closed: a rank that is not
 * `ranked` must carry no percentile, and peer data newer than the pitch is look-ahead.
 */
function normalizePeers(raw, pitchedAtMs, problems) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("peers must be an object or null");
    return null;
  }
  if (raw.version !== PEER_RANK_VERSION) problems.push(`peers.version must be ${PEER_RANK_VERSION}`);
  if (!PEER_LEVELS.includes(raw.level)) problems.push(`peers.level must be one of ${PEER_LEVELS.join(", ")}`);
  if (!PEER_MODES.includes(raw.mode)) problems.push(`peers.mode must be one of ${PEER_MODES.join(", ")}`);
  if (raw.reason != null && !PEER_SET_REASONS.includes(raw.reason)) problems.push(`peers.reason must be one of ${PEER_SET_REASONS.join(", ")} or null`);
  for (const field of ["peerCount", "excludedPeers"]) {
    if (!(Number.isInteger(raw[field]) && raw[field] >= 0)) problems.push(`peers.${field} must be a non-negative integer`);
  }
  if (raw.peerDataAsOf != null) {
    if (!isIso(raw.peerDataAsOf)) problems.push("peers.peerDataAsOf must be an ISO timestamp or null");
    else if (Date.parse(raw.peerDataAsOf) > pitchedAtMs) problems.push("peers.peerDataAsOf is after pitchedAt (look-ahead)");
  }
  const ranks = {};
  const input = raw.ranks && typeof raw.ranks === "object" ? raw.ranks : {};
  if (!raw.ranks || typeof raw.ranks !== "object") problems.push("peers.ranks is required");
  for (const id of Object.keys(input)) if (!METRIC_IDS.includes(id)) problems.push(`peers.ranks has unknown metric "${id}"`);
  for (const id of METRIC_IDS) {
    const rank = input[id];
    if (!rank || typeof rank !== "object") {
      problems.push(`peers.ranks.${id} is required`);
      continue;
    }
    if (!PEER_RANK_STATUSES.includes(rank.status)) problems.push(`peers.ranks.${id}.status must be one of ${PEER_RANK_STATUSES.join(", ")}`);
    if (!(Number.isInteger(rank.peerCount) && rank.peerCount >= 0)) problems.push(`peers.ranks.${id}.peerCount must be a non-negative integer`);
    const percentile = rank.percentile ?? null;
    if (rank.status === "ranked") {
      if (!(typeof percentile === "number" && Number.isFinite(percentile) && percentile >= 0 && percentile <= 1)) problems.push(`peers.ranks.${id}.percentile must be a number in [0,1] when ranked`);
    } else if (percentile !== null) problems.push(`peers.ranks.${id}.percentile must be null unless status is ranked`);
    ranks[id] = { status: rank.status, percentile, peerCount: rank.peerCount };
  }
  return {
    version: raw.version,
    industry: cleanText(raw.industry) || null,
    sector: cleanText(raw.sector) || null,
    level: raw.level,
    key: cleanText(raw.key) || null,
    peerCount: raw.peerCount,
    mode: raw.mode,
    peerDataAsOf: raw.peerDataAsOf == null ? null : new Date(Date.parse(raw.peerDataAsOf)).toISOString(),
    excludedPeers: raw.excludedPeers,
    reason: raw.reason ?? null,
    ranks,
  };
}

/**
 * Validate and normalize a pitch. Returns a frozen record with a content-derived
 * id, or throws PitchValidationError listing every problem.
 */
export function buildPitch(input = {}) {
  const problems = [];
  const ticker = cleanText(input.ticker).toUpperCase();
  if (!TICKER_RE.test(ticker)) problems.push("ticker is invalid");

  const agentId = cleanText(input.agentId) || "agent-1";
  const pitchedAt = input.pitchedAt;
  const pitchedAtMs = isIso(pitchedAt) ? Date.parse(pitchedAt) : NaN;
  if (!Number.isFinite(pitchedAtMs)) problems.push("pitchedAt must be an ISO timestamp");

  const action = cleanText(input.action || "BUY").toUpperCase();
  if (!PITCH_ACTIONS.includes(action)) problems.push(`action must be one of ${PITCH_ACTIONS.join(", ")}`);

  const conviction = input.conviction;
  if (!Number.isInteger(conviction) || conviction < CONVICTION_MIN || conviction > CONVICTION_MAX) {
    problems.push(`conviction must be an integer ${CONVICTION_MIN}-${CONVICTION_MAX}`);
  }

  const entry = input.entryReference ?? {};
  const entryPrice = entry.price;
  if (!(typeof entryPrice === "number" && Number.isFinite(entryPrice) && entryPrice > 0)) problems.push("entryReference.price must be a positive number");
  if (!isIso(entry.asOf)) problems.push("entryReference.asOf must be an ISO timestamp");
  else if (Number.isFinite(pitchedAtMs) && Date.parse(entry.asOf) > pitchedAtMs) problems.push("entryReference.asOf is after pitchedAt (look-ahead)");

  const intendedHoldingDays = input.intendedHoldingDays ?? null;
  if (intendedHoldingDays != null && !(Number.isInteger(intendedHoldingDays) && intendedHoldingDays > 0)) {
    problems.push("intendedHoldingDays must be a positive integer or null");
  }

  const rationale = normalizeRationale(input.rationale, problems);
  const features = normalizeFeatures(input.features, pitchedAtMs, problems);
  const peers = normalizePeers(input.peers, pitchedAtMs, problems);

  const provenanceIn = input.provenance ?? {};
  const source = cleanText(provenanceIn.source);
  if (!PITCH_SOURCES.includes(source)) problems.push(`provenance.source must be one of ${PITCH_SOURCES.join(", ")}`);
  const provenance = {
    source,
    mandateVersion: cleanText(provenanceIn.mandateVersion) || null,
    promptVersion: cleanText(provenanceIn.promptVersion) || null,
    model: cleanText(provenanceIn.model) || null,
  };

  const contextIn = input.context ?? {};
  const selection = cleanText(contextIn.selection) || null;
  if (selection != null && !SELECTION_REASONS.includes(selection)) problems.push(`context.selection must be one of ${SELECTION_REASONS.join(", ")}`);
  const context = { sector: cleanText(contextIn.sector) || null, selection };

  if (problems.length) throw new PitchValidationError(problems);

  const body = {
    schemaVersion: PITCH_SCHEMA_VERSION,
    agentId,
    ticker,
    pitchedAt: new Date(pitchedAtMs).toISOString(),
    action,
    conviction,
    intendedHoldingDays,
    entryReference: { price: entryPrice, asOf: new Date(Date.parse(entry.asOf)).toISOString() },
    rationale,
    features,
    peers,
    context,
    provenance,
  };
  return deepFreeze({ id: `pitch_${contentHash(body).slice(0, 20)}`, ...body });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
