// Pure aggregation + gating logic for the Research Testing Prototype's
// mechanical self-learning loop (docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md).
//
// Unlike production's weekly-review.js (which scores an agent from MATURED
// RETURN OUTCOMES), the prototype's feedback signal is Sam's and his investing
// partner's own structured grades of each proposal -- there is no outcome data
// yet, and the whole point of the prototype is to judge research quality
// directly, not wait for prices to prove it.
//
// No Redis, network, or LLM dependency in this file -- orchestration
// (jobs/proto-feedback.js) reads/writes via lib/proto-store.js and calls the
// model; this stays pure and unit-testable.

const DAY_MS = 86_400_000;

/**
 * One grade, as the prototype dashboard will write it:
 * {
 *   proposalId, grader ("sam" | "partner"), gradedAt (ISO),
 *   wouldApprove (boolean), reasoningSound (boolean), missedSomething (boolean),
 *   score (1-5 integer, overall quality), comment (string, optional)
 * }
 */
export function isValidGrade(grade) {
  return Boolean(
    grade
    && typeof grade.proposalId === "string" && grade.proposalId.trim()
    && ["sam", "partner"].includes(grade.grader)
    && typeof grade.gradedAt === "string" && Number.isFinite(Date.parse(grade.gradedAt))
    && typeof grade.wouldApprove === "boolean"
    && typeof grade.reasoningSound === "boolean"
    && typeof grade.missedSomething === "boolean"
    && Number.isInteger(grade.score) && grade.score >= 1 && grade.score <= 5,
  );
}

/**
 * Deterministic summary of graded proposals -- the ONLY thing that reaches the
 * lesson-writing model call. Never includes raw comments verbatim beyond a
 * bounded, truncated sample, to keep the prompt small and avoid the model
 * fixating on one grader's wording over the aggregate pattern.
 */
export function summarizeGrades(grades = []) {
  const valid = grades.filter(isValidGrade);
  const gradedCount = valid.length;
  // Distinct PROPOSALS graded, not grade submissions -- Sam and his partner
  // can both grade the same proposal, and the frozen-baseline window is
  // defined in terms of proposals ("first ~20 graded proposals"), not grade
  // rows. Codex flagged 2026-09-23 that using gradedCount for the window gate
  // let two graders on 10 proposals close a 20-proposal window early.
  const distinctProposalCount = new Set(valid.map((g) => g.proposalId)).size;
  if (!gradedCount) {
    return {
      gradedCount: 0,
      distinctProposalCount: 0,
      avgScore: null,
      wouldApproveRate: null,
      reasoningSoundRate: null,
      missedSomethingRate: null,
      sampleComments: [],
    };
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  const rate = (pred) => round2(valid.filter(pred).length / gradedCount);
  const avgScore = round2(valid.reduce((sum, g) => sum + g.score, 0) / gradedCount);
  const sampleComments = valid
    .filter((g) => typeof g.comment === "string" && g.comment.trim())
    .slice(0, 10)
    .map((g) => `[${g.grader}, score ${g.score}] ${g.comment.trim().slice(0, 300)}`);
  return {
    gradedCount,
    distinctProposalCount,
    avgScore,
    wouldApproveRate: rate((g) => g.wouldApprove),
    reasoningSoundRate: rate((g) => g.reasoningSound),
    missedSomethingRate: rate((g) => g.missedSomething),
    sampleComments,
  };
}

export function formatGradeSummaryForPrompt(summary, { proposalCount = null } = {}) {
  if (!summary.gradedCount) {
    return "No graded proposals yet.";
  }
  const lines = [
    `${summary.distinctProposalCount} distinct proposal(s) graded (${summary.gradedCount} grade submission(s) across both graders)${proposalCount != null ? ` out of ${proposalCount} produced` : ""}.`,
    `Average overall score: ${summary.avgScore}/5.`,
    `Would-approve rate: ${Math.round(summary.wouldApproveRate * 100)}%.`,
    `Reasoning-sound rate: ${Math.round(summary.reasoningSoundRate * 100)}%.`,
    `"Missed something" rate: ${Math.round(summary.missedSomethingRate * 100)}%.`,
  ];
  if (summary.sampleComments.length) {
    lines.push("Sample grader comments:", ...summary.sampleComments.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

/**
 * The frozen-baseline-window rule (docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md
 * step 5): feedback is COMPUTED from the first run, but not INJECTED into the
 * next scan's prompt until the window closes -- first ~2 weeks or ~20 graded
 * proposals, WHICHEVER COMES FIRST. This exists specifically because Sam chose
 * mechanical self-learning knowing the self-reinforcement risk; this is the
 * one mitigation that survives that choice: one clean, unassisted read of the
 * framework before the loop starts shaping the agent.
 */
export function isFrozenBaselineWindowOpen({
  firstRunAt,
  gradedCount = 0,
  now = new Date().toISOString(),
  windowDays = 14,
  windowGradedCount = 20,
} = {}) {
  if (!firstRunAt) return true; // no runs yet -> trivially still "open" (nothing to inject anyway)
  const elapsedMs = Date.parse(now) - Date.parse(firstRunAt);
  if (!Number.isFinite(elapsedMs)) return true;
  const daysElapsed = elapsedMs / DAY_MS;
  const windowClosed = daysElapsed >= windowDays || gradedCount >= windowGradedCount;
  return !windowClosed;
}
