import test from "node:test";
import assert from "node:assert/strict";
import { isValidGrade, summarizeGrades, formatGradeSummaryForPrompt, isFrozenBaselineWindowOpen } from "../lib/proto-feedback.js";

function grade(overrides = {}) {
  return {
    proposalId: "proto-run-1:AAPL",
    grader: "sam",
    gradedAt: "2026-09-23T15:00:00.000Z",
    wouldApprove: true,
    reasoningSound: true,
    missedSomething: false,
    score: 4,
    comment: "Solid thesis, cited the right filing.",
    ...overrides,
  };
}

test("isValidGrade rejects malformed grades instead of silently accepting them", () => {
  assert.equal(isValidGrade(grade()), true);
  assert.equal(isValidGrade(null), false);
  assert.equal(isValidGrade(grade({ grader: "someone-else" })), false);
  assert.equal(isValidGrade(grade({ score: 6 })), false);
  assert.equal(isValidGrade(grade({ score: 0 })), false);
  assert.equal(isValidGrade(grade({ score: 3.5 })), false);
  assert.equal(isValidGrade(grade({ wouldApprove: "yes" })), false);
  assert.equal(isValidGrade(grade({ gradedAt: "not-a-date" })), false);
  assert.equal(isValidGrade(grade({ proposalId: "" })), false);
});

test("summarizeGrades computes rates and averages only over valid grades", () => {
  const grades = [
    grade({ proposalId: "p1", score: 5, wouldApprove: true, reasoningSound: true, missedSomething: false }),
    grade({ proposalId: "p2", score: 3, wouldApprove: false, reasoningSound: true, missedSomething: true }),
    grade({ proposalId: "p3", score: 1, grader: "notavalidgrader" }), // invalid, must be excluded
  ];
  const summary = summarizeGrades(grades);
  assert.equal(summary.gradedCount, 2);
  assert.equal(summary.distinctProposalCount, 2);
  assert.equal(summary.avgScore, 4);
  assert.equal(summary.wouldApproveRate, 0.5);
  assert.equal(summary.reasoningSoundRate, 1);
  assert.equal(summary.missedSomethingRate, 0.5);
});

test("summarizeGrades: distinctProposalCount counts proposals, not grade submissions -- both graders on one proposal count as one", () => {
  // Codex 2026-09-23: using gradedCount for the frozen-baseline window let two
  // graders on 10 proposals (20 grade rows) close a 20-proposal window early.
  const grades = [
    grade({ proposalId: "p1", grader: "sam" }),
    grade({ proposalId: "p1", grader: "partner" }),
    grade({ proposalId: "p2", grader: "sam" }),
  ];
  const summary = summarizeGrades(grades);
  assert.equal(summary.gradedCount, 3, "3 grade submissions");
  assert.equal(summary.distinctProposalCount, 2, "but only 2 distinct proposals");
});

test("summarizeGrades with zero valid grades returns nulls, not NaN or a crash", () => {
  const summary = summarizeGrades([]);
  assert.equal(summary.gradedCount, 0);
  assert.equal(summary.distinctProposalCount, 0);
  assert.equal(summary.avgScore, null);
  assert.equal(summary.wouldApproveRate, null);
});

test("summarizeGrades bounds and truncates the comment sample so the prompt can't blow up", () => {
  const grades = Array.from({ length: 30 }, (_, i) => grade({ proposalId: `p${i}`, comment: "x".repeat(1000) }));
  const summary = summarizeGrades(grades);
  assert.equal(summary.gradedCount, 30);
  assert.ok(summary.sampleComments.length <= 10);
  for (const c of summary.sampleComments) assert.ok(c.length < 400);
});

test("formatGradeSummaryForPrompt handles the no-grades case without dividing by zero", () => {
  assert.equal(formatGradeSummaryForPrompt(summarizeGrades([])), "No graded proposals yet.");
});

test("frozen baseline window: open with no runs yet", () => {
  assert.equal(isFrozenBaselineWindowOpen({ firstRunAt: null }), true);
});

test("frozen baseline window: stays open before either threshold, closes at 14 days", () => {
  const firstRunAt = "2026-09-01T00:00:00.000Z";
  assert.equal(isFrozenBaselineWindowOpen({ firstRunAt, gradedCount: 5, now: "2026-09-10T00:00:00.000Z" }), true); // 9 days, 5 graded
  assert.equal(isFrozenBaselineWindowOpen({ firstRunAt, gradedCount: 5, now: "2026-09-15T00:00:00.000Z" }), false); // 14 days elapsed
});

test("frozen baseline window: closes at 20 graded proposals even if well under 14 days", () => {
  const firstRunAt = "2026-09-23T00:00:00.000Z";
  assert.equal(isFrozenBaselineWindowOpen({ firstRunAt, gradedCount: 19, now: "2026-09-24T00:00:00.000Z" }), true);
  assert.equal(isFrozenBaselineWindowOpen({ firstRunAt, gradedCount: 20, now: "2026-09-24T00:00:00.000Z" }), false);
});

test("frozen baseline window respects custom thresholds", () => {
  const firstRunAt = "2026-09-23T00:00:00.000Z";
  assert.equal(
    isFrozenBaselineWindowOpen({ firstRunAt, gradedCount: 3, now: "2026-09-24T00:00:00.000Z", windowDays: 1, windowGradedCount: 100 }),
    false,
  );
});
