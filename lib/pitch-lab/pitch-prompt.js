/**
 * Pitch Lab model contract — what Agent One is asked to produce for a pitch,
 * and how its answer becomes a pitch record.
 *
 * Division of labour (so the model cannot fabricate the numbers it is graded on):
 *   - The SYSTEM supplies every feature value, the entry reference price, and
 *     the timestamps, from real data (lib/pitch-lab/features.js).
 *   - The MODEL supplies only judgment: a conviction level on the fixed rubric
 *     and a structured rationale whose reasons cite feature ids.
 *
 * Pure: builds the prompt text + JSON schema and parses the reply. Making the
 * Anthropic call (with the repo's budget + usage telemetry) is the caller's job
 * and is intentionally not wired yet — see docs/PITCH-LAB.md "Next steps".
 */
import { FEATURE_CATALOG } from "./features.js";
import { CONVICTION_MAX, CONVICTION_MIN, CONVICTION_RUBRIC, RATIONALE_LIMITS, buildPitch } from "./pitch.js";

export const PITCH_PROMPT_VERSION = "pitch-lab.prompt.v1";

export const PITCH_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    conviction: { type: "integer", minimum: CONVICTION_MIN, maximum: CONVICTION_MAX },
    intended_holding_days: { type: "integer", minimum: 1 },
    thesis: { type: "string" },
    reasons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          features: { type: "array", items: { type: "string", enum: FEATURE_CATALOG.map((f) => f.id) } },
        },
        required: ["claim", "features"],
      },
    },
    risks: { type: "array", items: { type: "string" } },
    kill_criteria: { type: "array", items: { type: "string" } },
  },
  required: ["conviction", "intended_holding_days", "thesis", "reasons", "risks", "kill_criteria"],
});

function formatValue(entry) {
  if (!entry || entry.value == null) return "MISSING";
  const v = entry.value;
  return Math.abs(v) >= 1000 ? v.toExponential(3) : Number(v.toFixed(4)).toString();
}

/** The instruction block shown to the model for one ticker. */
export function buildPitchPrompt({ ticker, features, entryReference, mandateExcerpt = "" }) {
  const featureLines = FEATURE_CATALOG.map((f) => `- ${f.id} (${f.label}): ${formatValue(features?.[f.id])}`).join("\n");
  const rubric = Object.entries(CONVICTION_RUBRIC).map(([level, text]) => `${level} = ${text}`).join("\n");
  return `You are Agent One writing a PAPER pitch (no money moves) to BUY ${ticker}.
Reference price: ${entryReference?.price} as of ${entryReference?.asOf}.
${mandateExcerpt ? `\nMandate excerpt:\n${mandateExcerpt}\n` : ""}
Data available to you (MISSING means we do not have it — do not guess it):
${featureLines}

Rate your conviction on this fixed scale. Use the whole scale honestly; a
pitch you doubt should get a low number, not be dressed up:
${rubric}

Write a thesis of at least ${RATIONALE_LIMITS.thesisMinChars} characters, then
1-${RATIONALE_LIMITS.maxReasons} reasons. Each reason is one claim plus the
feature ids above that support it (empty list if it rests on no listed data).
Give at least ${RATIONALE_LIMITS.minRisks} concrete risk and your kill criteria.
Your conviction will later be compared with how the stock actually did versus
the market, so calibration matters more than enthusiasm.`;
}

/**
 * Turn the model's JSON reply plus system-supplied facts into a validated pitch
 * record. Throws PitchValidationError if the reply breaks the contract.
 */
export function pitchFromModelResponse(response, { ticker, pitchedAt, features, entryReference, agentId = "agent-1", source = "live", mandateVersion = null, model = null, context = {} }) {
  const reply = typeof response === "string" ? JSON.parse(response) : response ?? {};
  return buildPitch({
    ticker,
    agentId,
    pitchedAt,
    action: "BUY",
    conviction: reply.conviction,
    intendedHoldingDays: reply.intended_holding_days ?? null,
    entryReference,
    rationale: {
      thesis: reply.thesis,
      reasons: reply.reasons,
      risks: reply.risks,
      killCriteria: reply.kill_criteria,
    },
    features,
    context,
    provenance: { source, mandateVersion, promptVersion: PITCH_PROMPT_VERSION, model },
  });
}
