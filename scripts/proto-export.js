#!/usr/bin/env node
// Read-only snapshot of the Research Testing Prototype's state, for a Claude
// session (this one or a fresh one) to catch up in one call without needing
// dashboard credentials or a live SSH session -- docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md
// step 7 ("Claude visibility"). Reads only, via lib/proto-store.js (proto:* only).
//
// Usage: node scripts/proto-export.js [--runs=N] [--json]

import "dotenv/config";
import { protoGet, protoListRange, protoKey } from "../lib/proto-store.js";
import { summarizeGrades, formatGradeSummaryForPrompt } from "../lib/proto-feedback.js";

function parseArgs(argv) {
  const args = { runs: 10, json: false };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg.startsWith("--runs=")) args.runs = Math.max(1, Number(arg.slice("--runs=".length)) || 10);
  }
  return args;
}

async function loadRecentRuns(limit) {
  const runRows = await protoListRange(protoKey.runList(), { start: 0, end: limit - 1 });
  const receipts = [];
  for (const row of runRows) {
    const receipt = await protoGet(protoKey.runReceipt(row.runId));
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

async function loadRunProposals(runId) {
  const proposalIds = await protoListRange(protoKey.proposalsByRun(runId));
  const proposals = [];
  for (const id of proposalIds) {
    const p = await protoGet(protoKey.proposal(id));
    if (p) proposals.push(p);
  }
  return proposals;
}

async function loadAllGrades() {
  const proposalIds = await protoListRange(protoKey.proposalsAll());
  const grades = [];
  for (const proposalId of proposalIds) {
    const graders = await protoListRange(protoKey.gradesByProposal(proposalId));
    for (const grader of graders) {
      const g = await protoGet(protoKey.grade(proposalId, grader));
      if (g) grades.push(g);
    }
  }
  return grades;
}

function formatMarkdown({ runs, runsWithProposals, gradeSummary, feedbackState, universeCount }) {
  const lines = [];
  lines.push(`# Research Testing Prototype -- snapshot as of ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Universe size: ${universeCount ?? "unknown"} tickers. Runs shown: ${runs.length}.`);
  lines.push("");
  lines.push("## Grading summary (all-time)");
  lines.push(formatGradeSummaryForPrompt(gradeSummary));
  lines.push("");
  if (feedbackState) {
    lines.push("## Feedback loop state");
    lines.push(`First run: ${feedbackState.firstRunAt ?? "n/a"}. Active lessons: ${feedbackState.lessons?.length ?? 0}.`);
    for (const lesson of feedbackState.lessons ?? []) lines.push(`- ${lesson}`);
    lines.push("");
  }
  lines.push("## Recent runs");
  for (const run of runs) {
    lines.push(`### ${run.runId} (${run.startedAt} -> ${run.completedAt})`);
    lines.push(`Universe: ${run.universeSize}. Reviewed: ${run.counts.reviewed}. Would-create-proposal: ${run.counts.wouldCreateProposal}. Data-unavailable: ${run.counts.dataUnavailable}. Peer-coverage-pending: ${run.counts.peerCoveragePending}. Errors: ${run.counts.error}.`);
    const proposals = runsWithProposals[run.runId] ?? [];
    const wouldCreate = proposals.filter((p) => p.createdProposal?.dryRun);
    if (wouldCreate.length) {
      lines.push("Would-create proposals:");
      for (const p of wouldCreate) {
        lines.push(`- **${p.ticker}** ${p.createdProposal.side} $${p.createdProposal.amountDollars} -- evaluator: ${p.evaluatorVerdict ?? "n/a"}, quant score ${p.quantScore ?? "n/a"}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const universeConfig = await import("../config/proto/universe.json", { with: { type: "json" } }).catch(() => null);

  const runs = await loadRecentRuns(args.runs);
  const runsWithProposals = {};
  for (const run of runs) {
    runsWithProposals[run.runId] = await loadRunProposals(run.runId);
  }
  const grades = await loadAllGrades();
  const gradeSummary = summarizeGrades(grades);
  const feedbackState = await protoGet(protoKey.feedbackState());

  if (args.json) {
    console.log(JSON.stringify({ runs, runsWithProposals, gradeSummary, feedbackState }, null, 2));
    return;
  }
  console.log(formatMarkdown({
    runs,
    runsWithProposals,
    gradeSummary,
    feedbackState,
    universeCount: universeConfig?.default?.tickers?.length ?? null,
  }));
}

main().catch((err) => {
  console.error("[ProtoExport] failed:", err);
  process.exit(1);
});
