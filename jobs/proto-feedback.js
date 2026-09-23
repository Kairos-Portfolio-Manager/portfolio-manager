// Research Testing Prototype feedback cycle (docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md
// step 5). Turns Sam's and his investing partner's graded proposals into at
// most 3 durable "lessons," gated by the frozen-baseline window
// (lib/proto-feedback.js: isFrozenBaselineWindowOpen). Modeled on production's
// jobs/weekly-review.js, but the input signal is human grades, not matured
// return outcomes -- there are no outcomes yet, and the prototype's whole
// point is to judge research quality directly.
//
// Everything this job reads/writes goes through lib/proto-store.js
// (proto:* only). It reuses lib/weekly-scorecard.js's parseWeeklyLessons --
// that parser is agent-agnostic pure JSON parsing, not production-specific,
// so reusing it here is not a fork of production's feedback logic, just of a
// small, already-shared text-parsing utility.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { parseWeeklyLessons } from "../lib/weekly-scorecard.js";
import { summarizeGrades, formatGradeSummaryForPrompt, isFrozenBaselineWindowOpen } from "../lib/proto-feedback.js";
import { protoGet, protoSet, protoListRange, protoKey } from "../lib/proto-store.js";
import { recordAnthropicUsage } from "../lib/anthropic-usage.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim(), maxRetries: 0 });
const PROTO_FEEDBACK_MODEL = "claude-sonnet-4-6";

const LESSON_PROMPT_RULES = `You write calibration lessons for an investment research agent under active human evaluation, based ONLY on the deterministic grade summary provided. These grades come directly from the humans reviewing the agent's work, not from matured trading outcomes. Rules:
- At most 3 new lessons. Zero is a fine answer -- few graded proposals deserve zero.
- Each lesson must reference the actual summary numbers or sample comments given, state what the agent should do differently, and be checkable later.
- If an existing lesson is contradicted by this summary, list its exact text under "retire".
- Never restate the agent's mandate, never invent a comment or number not in the summary, never store prices or point-in-time market facts as durable lessons.
- Do not write a lesson that amounts to "produce answers graders will rate higher" -- lessons must be about research quality (evidence use, reasoning, calibration), never about pleasing the grader.
Respond with ONLY a single JSON object: {"lessons": ["<lesson>"], "retire": ["<exact text of an existing lesson to remove>"]}`;

async function readAllGrades() {
  const proposalIds = await protoListRange(protoKey.proposalsAll());
  const grades = [];
  for (const proposalId of proposalIds) {
    const graders = await protoListRange(protoKey.gradesByProposal(proposalId));
    for (const grader of graders) {
      const g = await protoGet(protoKey.grade(proposalId, grader));
      if (g) grades.push(g);
    }
  }
  return { proposalCount: proposalIds.length, grades };
}

export async function generateProtoLessons(summary, existingLessons, { anthropicClient = anthropic } = {}) {
  const existingBlock = existingLessons.length
    ? `Existing lessons from prior prototype feedback cycles (candidates for "retire" if contradicted):\n${existingLessons.map((l) => `- ${l}`).join("\n")}`
    : "No existing prototype lessons.";
  const request = {
    model: PROTO_FEEDBACK_MODEL,
    max_tokens: 500,
    system: [{ type: "text", text: LESSON_PROMPT_RULES }],
    messages: [{ role: "user", content: `${formatGradeSummaryForPrompt(summary)}\n\n${existingBlock}` }],
  };
  const response = await anthropicClient.messages.create(request);
  await recordAnthropicUsage({
    role: "proto_feedback",
    agentId: "agent-1",
    model: PROTO_FEEDBACK_MODEL,
    stopReason: response.stop_reason,
    usage: response.usage,
    pricingVersion: null,
    now: new Date(),
  }).catch((err) => console.warn("[ProtoFeedback] usage recording failed (non-fatal):", err.message));
  if (response.stop_reason === "max_tokens") {
    console.warn("[ProtoFeedback] lesson response hit max_tokens -- discarding (fail closed).");
    return { lessons: [], retire: [], parseError: true };
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseWeeklyLessons(text);
}

/**
 * Full cycle: read all grades, always compute+store the summary (so the
 * baseline window has real data to measure against), but only call the model
 * and update the injectable lesson set once the frozen window has closed.
 */
export async function runProtoFeedbackCycle({ now = new Date().toISOString() } = {}) {
  const { proposalCount, grades } = await readAllGrades();
  const summary = summarizeGrades(grades);

  const state = (await protoGet(protoKey.feedbackState())) ?? { firstRunAt: now, lessons: [] };
  if (!state.firstRunAt) state.firstRunAt = now;

  const windowOpen = isFrozenBaselineWindowOpen({ firstRunAt: state.firstRunAt, gradedCount: summary.gradedCount, now });

  const result = {
    computedAt: now,
    proposalCount,
    summary,
    frozenBaselineWindowOpen: windowOpen,
    lessonsInjected: false,
    lessons: state.lessons ?? [],
  };

  if (!windowOpen && summary.gradedCount > 0) {
    const generated = await generateProtoLessons(summary, state.lessons ?? []);
    if (!generated.parseError) {
      const retained = (state.lessons ?? []).filter((l) => !generated.retire.includes(l));
      const merged = [...retained, ...generated.lessons].slice(-3);
      state.lessons = merged;
      result.lessons = merged;
      result.lessonsInjected = true;
    }
  }

  await protoSet(protoKey.feedbackState(), state);
  await protoSet(protoKey.weeklyLessons(now.slice(0, 10)), result);
  console.log(`[ProtoFeedback] ${summary.gradedCount} graded / ${proposalCount} total; window ${windowOpen ? "OPEN (not injecting)" : "closed"}; ${result.lessons.length} active lesson(s).`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProtoFeedbackCycle()
    .then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(0); })
    .catch((err) => { console.error("[ProtoFeedback] cycle failed:", err); process.exit(1); });
}
