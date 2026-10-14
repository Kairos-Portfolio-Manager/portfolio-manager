import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPhase0Observation, formatPhase0Observation } from "../lib/phase0-observer.js";
import { consumedResearchRunIds, deliverPhase0Telegram, deployedRevision, dueCriticalJobNames, dueObservedJobs, finalSentinelIsFresh, latestScheduledResearch, mapAnthropicBudgetReadiness, observationPersistenceWindowIsOpen, persistPhase0Observation, selectUnobservedScheduledResearch, shouldSendPhase0Telegram } from "../jobs/phase0-observer.js";
import { blankOutcomeCounts, RESEARCH_OUTCOME_VERSION } from "../lib/research-run-report.js";
import { buildHoldingMonitorCoverage } from "../lib/holding-monitor-coverage.js";
import { signPhase0Observation } from "../lib/phase0-observation-ledger.js";
import { expectedJobInvocationIds } from "../lib/job-invocation-history.js";
import { signMcpReadReceipt } from "../contracts/mcp-read-job.js";

const DATE = "2026-07-14";
const MCP_RECEIPT_SECRET = "phase0-mcp-receipt-test-secret";

test("Phase 0 stays internal unless trust fails or the legacy all-feed is explicit", () => {
  assert.equal(shouldSendPhase0Telegram({ trustVerdict: "PASS", skillVerdict: "FAIL" }, {}), false);
  assert.equal(shouldSendPhase0Telegram({ trustVerdict: "FAIL", skillVerdict: "PASS" }, {}), true);
  assert.equal(shouldSendPhase0Telegram({
    trustVerdict: "FAIL",
    checks: [{ name: "valuation_status", domain: "TRUST", status: "fail" }],
  }, {}), false);
  assert.equal(shouldSendPhase0Telegram({
    trustVerdict: "FAIL",
    checks: [
      { name: "valuation_status", domain: "TRUST", status: "fail" },
      { name: "open_p0_p1", domain: "TRUST", status: "fail" },
    ],
  }, {}), true);
  assert.equal(shouldSendPhase0Telegram({ trustVerdict: "PASS" }, { PHASE0_TELEGRAM_MODE: "all" }), true);
});

test("suppressed Phase 0 delivery writes the durable action-only marker", async () => {
  const values = new Map();
  let sends = 0;
  const redis = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); return "OK"; },
  };
  const result = await deliverPhase0Telegram(
    { dateET: DATE, trustVerdict: "PASS", skillVerdict: "FAIL" },
    { redis, env: {}, send: async () => { sends += 1; } },
  );
  assert.deepEqual(result, { status: "suppressed", marker: "suppressed:action-only" });
  assert.equal(values.get(`pm:phase0-observation:${DATE}:telegram-sent`), "suppressed:action-only");
  assert.equal(sends, 0);
});

test("deployed revision prefers the code identity pinned by the PM2 restart wrapper", async () => {
  let gitCalled = false;
  const revision = await deployedRevision({
    env: {
      SYSLOOP_DEPLOYED_COMMIT: "9397eef61879cc362328887f0e98802cad6a215d",
      SYSLOOP_DEPLOYED_BRANCH: "mandate-v3",
      SYSLOOP_DEPLOYED_AT: "2026-07-14T20:00:00.000Z",
    },
    exec: async () => { gitCalled = true; throw new Error("git should not be needed"); },
  });
  assert.deepEqual(revision, {
    commit: "9397eef61879cc362328887f0e98802cad6a215d",
    branch: "mandate-v3",
    startedAt: "2026-07-14T20:00:00.000Z",
  });
  assert.equal(gitCalled, false);
});

test("manual observer diagnostics recover the pinned identity from PM2", async () => {
  const revision = await deployedRevision({
    env: {},
    exec: async (command, args) => {
      assert.equal(command, "pm2");
      assert.deepEqual(args, ["jlist"]);
      return { stdout: JSON.stringify([{
        name: "portfolio-manager",
        pm2_env: {
          SYSLOOP_DEPLOYED_COMMIT: "abcdef1234567890",
          SYSLOOP_DEPLOYED_BRANCH: "mandate-v3",
          SYSLOOP_DEPLOYED_AT: "2026-07-16T14:37:23.064Z",
        },
      }]) };
    },
  });
  assert.deepEqual(revision, {
    commit: "abcdef1234567890",
    branch: "mandate-v3",
    startedAt: "2026-07-16T14:37:23.064Z",
  });
});

function researchReport(overrides = {}) {
  const counts = { ...blankOutcomeCounts(), investment_hold: 2, proposal_created: 1, ...(overrides.outcomeCounts ?? {}) };
  const attemptedReviews = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    classificationAvailable: true,
    classificationVersion: RESEARCH_OUTCOME_VERSION,
    runId: "run-1",
    status: overrides.status ?? "completed",
    totals: { attemptedReviews, outcomeCounts: counts },
  };
}

function passingSchedules() {
  return ["holdings-sync", "order-reconciliation", "intraday-monitor", "system-sentinel"].map((name) => {
    const expected = expectedJobInvocationIds(name, DATE);
    const records = expected.map((invocationId, index) => ({
      invocationId,
      slotET: invocationId.split("/")[1],
      dateET: DATE,
      ts: "2026-07-14T22:00:00.000Z",
      completedAt: "2026-07-14T22:00:00.000Z",
      ok: true,
      ...(name === "intraday-monitor" ? {
        evidence: { holdingMonitoring: buildHoldingMonitorCoverage({ expected: 1, monitored: 1, degraded: 0 }) },
      } : {}),
      ...(name === "system-sentinel" ? { evidence: { blockingAnomalies: [] } } : {}),
      ...(["holdings-sync", "order-reconciliation"].includes(name) ? signMcpReadReceipt({
        schemaVersion: "mcp-read-receipt-v2", source: "jetson-robinhood-mcp", kind: name, outcome: "ok", error: null,
        requestId: `00000000-0000-4000-8000-${String(index + (name === "order-reconciliation" ? 100 : 0)).padStart(12, "0")}`,
        requestedAt: "2026-07-14T21:55:00.000Z", completedAt: "2026-07-14T22:00:00.000Z",
        invocationId, accountVerified: true, accountPolicyVersion: "agentic-account-binding-v1", ok: true,
      }, MCP_RECEIPT_SECRET) : {}),
    }));
    return { name, expected, records };
  });
}

function passingInput() {
  const scheduledInvocations = passingSchedules();
  const intraday = scheduledInvocations.find((entry) => entry.name === "intraday-monitor");
  return {
    dateET: DATE,
    observedAt: "2026-07-15T00:15:00.000Z",
    tradingDay: true,
    criticalJobs: [
      { name: "verify-ledgers", run: { dateET: DATE, ok: true } },
      { name: "db-parity", run: { dateET: DATE, ok: true } },
    ],
    scheduledInvocations,
    holdingMonitoring: intraday.records.map((record) => ({
      name: "intraday-monitor", invocationId: record.invocationId, coverage: record.evidence.holdingMonitoring,
    })),
    sentinel: { fresh: true, anomalies: [{ severity: "P2", title: "advisory degradation" }] },
    openReconciliations: [],
    parity: {
      fresh: true,
      ok: false,
      transactional: { ok: true, comparedFields: ["shares", "costBasis"] },
      valuation: { ok: true, quoteSnapshotId: "quotes-1" },
      divergences: [],
    },
    research: { fresh: true, report: researchReport() },
    capacity: {
      monthly: {
        schemaVersion: "anthropic-budget-readiness-v1",
        monthUtc: "2026-07",
        status: "OK",
        capStatus: "CONFIGURED",
        remainingUsd: 20,
        pricingVersion: "anthropic-global-standard-2026-07-14",
        telemetryStatus: "COMPLETE",
        spentUsd: 5,
        reservedUsd: 0,
        thresholds: { ceilingUsd: 25, warnPct: 0.8, warningAtUsd: 20 },
        coverage: { pricedRecords: 10, issueCount: 0 },
        protectedCapacityDenied: false,
      },
      providerCapacityStatus: "AVAILABLE",
      preventedProtectedMonitoring: false,
    },
    proposalQueue: { total: 14, fulfilled: 1, byStatus: { Pending: 2, Rejected: 11, ApprovedForBrokerReview: 1 } },
    deployment: {
      commit: "abcdef123456",
      branch: "mandate-v3",
      startedAt: "2026-07-13T16:00:00.000Z",
      policies: {
        mandateVersions: { "agent-1": "3.0", "agent-2": "3.0", "agent-3": "3.0" },
        researchSelection: { policyVersion: "research-selection-v1", mode: "shadow" },
      },
    },
    mcpReceiptSecret: MCP_RECEIPT_SECRET,
  };
}

test("pure verdict passes only when every required evidence class passes", () => {
  const result = buildPhase0Observation(passingInput());
  assert.equal(result.schemaVersion, "phase0-observation-v2");
  assert.equal(result.verdict, "PASS_BOTH");
  assert.equal(result.trustVerdict, "PASS");
  assert.equal(result.skillVerdict, "PASS");
  assert.equal(result.countsTowardSafetyWindow, true);
  assert.equal(result.countsTowardResearchCohort, true);
  assert.equal(result.countsTowardWindow, true);
  assert.equal(result.reasons.length, 0);
  assert.ok(result.checks.every((row) => ["TRUST", "SKILL", "BOTH"].includes(row.domain)));
  assert.match(formatPhase0Observation(result), /TRUST PASS — safety day counts: YES/);
  assert.match(formatPhase0Observation(result), /SKILL PASS — research cohort samples retained: YES/);
});

test("the deployment day itself cannot count, while the next trading day can", () => {
  const sameDay = passingInput();
  sameDay.deployment.startedAt = "2026-07-14T14:00:00.000Z";
  const blocked = buildPhase0Observation(sameDay);
  assert.equal(blocked.trustVerdict, "FAIL");
  assert.equal(blocked.countsTowardSafetyWindow, false);
  assert.equal(blocked.checks.find((row) => row.name === "deployment_eligibility").status, "fail");

  const priorDay = passingInput();
  assert.equal(buildPhase0Observation(priorDay).countsTowardSafetyWindow, true);
});

test("observation persistence stays locked until the complete-day cutoff", () => {
  assert.equal(observationPersistenceWindowIsOpen(new Date("2026-07-15T00:19:59.000Z")), false);
  assert.equal(observationPersistenceWindowIsOpen(new Date("2026-07-15T00:20:00.000Z")), true);
});

test("unknown evidence fails closed and active P1s remain visible", () => {
  const input = passingInput();
  input.sentinel = { fresh: true, anomalies: [{ severity: "P1", title: "Unsigned approval", fingerprint: "x" }] };
  input.openReconciliations = null;
  input.research = { fresh: false, report: null };
  const result = buildPhase0Observation(input);
  assert.equal(result.verdict, "FAIL_BOTH");
  assert.equal(result.trustVerdict, "FAIL");
  assert.equal(result.skillVerdict, "FAIL");
  assert.equal(result.countsTowardSafetyWindow, false);
  assert.equal(result.countsTowardResearchCohort, false);
  assert.equal(result.countsTowardWindow, false);
  assert.ok(result.trustReasons.some((reason) => reason.includes("open_p0_p1")));
  assert.ok(result.trustReasons.some((reason) => reason.includes("reconciliation")));
  assert.ok(result.skillReasons.some((reason) => reason.includes("research_accounting")));
});

test("holding coverage passes explicit degradation but fails silent skips and absent evidence", () => {
  const passing = buildPhase0Observation(passingInput());
  assert.equal(passing.checks.find((row) => row.name === "holding_monitoring").status, "pass");

  const allDegraded = passingInput();
  allDegraded.holdingMonitoring = [
    {
      name: "intraday-monitor",
      coverage: buildHoldingMonitorCoverage({
        expected: 3,
        monitored: 0,
        degraded: 3,
        reasons: { market_evidence_unavailable: 3 },
      }),
    },
  ];
  const insufficient = buildPhase0Observation(allDegraded);
  assert.equal(insufficient.trustVerdict, "FAIL");
  assert.equal(insufficient.countsTowardSafetyWindow, false);
  assert.equal(insufficient.checks.find((row) => row.name === "holding_monitoring").status, "insufficient");

  const skipped = passingInput();
  skipped.holdingMonitoring[0].coverage = buildHoldingMonitorCoverage({ expected: 3, monitored: 1, degraded: 1 });
  const failed = buildPhase0Observation(skipped);
  assert.equal(failed.trustVerdict, "FAIL");
  assert.equal(failed.checks.find((row) => row.name === "holding_monitoring").status, "fail");

  const absent = passingInput();
  absent.holdingMonitoring = null;
  assert.equal(buildPhase0Observation(absent).checks.find((row) => row.name === "holding_monitoring").status, "insufficient");
});

test("every scheduled invocation is required, with a recovered same-slot retry accepted", () => {
  const input = passingInput();
  const holdings = input.scheduledInvocations.find((entry) => entry.name === "holdings-sync");
  const initial = holdings.records[0];
  holdings.records.unshift({ ...initial, ok: false, outcome: "failed", error: "transient MCP failure" });
  const recovered = buildPhase0Observation(input);
  assert.equal(recovered.trustVerdict, "PASS");

  holdings.records.push({ ...initial, ok: false, outcome: "failed", error: "final MCP failure" });
  const failed = buildPhase0Observation(input);
  assert.equal(failed.trustVerdict, "FAIL");
  assert.match(failed.trustReasons.join(" "), /scheduled_invocations/);

  const missing = passingInput();
  missing.scheduledInvocations.find((entry) => entry.name === "holdings-sync").records.shift();
  assert.equal(buildPhase0Observation(missing).trustVerdict, "FAIL");
});

test("a Sam-approved operator capacity exception preserves the failed receipt but waives only its exact slot", () => {
  const input = passingInput();
  input.deployment.startedAt = "2026-07-14T14:00:00.000Z";
  const holdings = input.scheduledInvocations.find((entry) => entry.name === "holdings-sync");
  const failed = holdings.records.find((record) => record.invocationId.endsWith("/13:00"));
  Object.assign(failed, { ok: false, outcome: "failed", error: "Claude CLI weekly limit" });
  input.criticalJobs.push({ name: "holdings-sync", run: { dateET: DATE, invocationId: failed.invocationId, ok: false } });
  input.operatorExceptions = [{ dateET: DATE, kind: "operator_managed_claude_cli_capacity", job: "holdings-sync", invocationId: failed.invocationId, approvedBy: "sam" }];
  input.operatorPolicyRelease = { dateET: DATE, approvedBy: "sam", scope: "phase0_observer_only" };
  const result = buildPhase0Observation(input);
  assert.equal(result.trustVerdict, "PASS");
  assert.equal(result.checks.find((row) => row.name === "operator_exceptions").status, "warning");
  assert.equal(result.checks.find((row) => row.name === "deployment_eligibility").status, "pass");
});

test("an operator exception cannot waive another slot or an unrelated sentinel P1", () => {
  const input = passingInput();
  const holdings = input.scheduledInvocations.find((entry) => entry.name === "holdings-sync");
  const waived = holdings.records.find((record) => record.invocationId.endsWith("/13:00"));
  const unwaived = holdings.records.find((record) => record.invocationId.endsWith("/15:00"));
  Object.assign(waived, { ok: false, outcome: "failed", error: "Claude CLI weekly limit" });
  Object.assign(unwaived, { ok: false, outcome: "failed", error: "different failure" });
  input.criticalJobs.push({ name: "holdings-sync", run: { dateET: DATE, invocationId: unwaived.invocationId, ok: false } });
  input.operatorExceptions = [{ dateET: DATE, kind: "operator_managed_claude_cli_capacity", job: "holdings-sync", invocationId: waived.invocationId, approvedBy: "sam" }];
  input.sentinel = { fresh: true, anomalies: [{ severity: "P1", check: "cron", fingerprint: "holdings-sync:failed" }] };
  const result = buildPhase0Observation(input);
  assert.equal(result.trustVerdict, "FAIL");
  assert.equal(result.checks.find((row) => row.name === "scheduled_invocations").status, "fail");
  assert.equal(result.checks.find((row) => row.name === "open_p0_p1").status, "fail");
});

test("the exact exception can waive its linked cron sentinel finding, but not another P1", () => {
  const input = passingInput();
  const holdings = input.scheduledInvocations.find((entry) => entry.name === "holdings-sync");
  const failed = holdings.records.find((record) => record.invocationId.endsWith("/13:00"));
  Object.assign(failed, { ok: false, outcome: "failed", error: "Claude CLI weekly limit", mcpReceipt: null });
  input.criticalJobs.push({ name: "holdings-sync", run: { dateET: DATE, invocationId: failed.invocationId, ok: false } });
  input.operatorExceptions = [{ dateET: DATE, kind: "operator_managed_claude_cli_capacity", job: "holdings-sync", invocationId: failed.invocationId, approvedBy: "sam" }];
  input.sentinel = { fresh: true, anomalies: [{ severity: "P1", check: "cron", fingerprint: "holdings-sync:failed" }] };
  const sentinel = input.scheduledInvocations.find((entry) => entry.name === "system-sentinel");
  sentinel.records.forEach((record) => { record.evidence.blockingAnomalies = [{ severity: "P1", check: "cron", fingerprint: "holdings-sync:failed" }]; });
  const result = buildPhase0Observation(input);
  assert.equal(result.trustVerdict, "PASS");
  assert.equal(result.checks.find((row) => row.name === "scheduled_invocations").status, "pass");
  assert.equal(result.checks.find((row) => row.name === "open_p0_p1").status, "pass");
});

test("MCP receipts must be current, successful, and account-policy bound", () => {
  for (const mutate of [
    (row) => { row.source = "jetson-queued"; },
    (row) => { row.outcome = "failed"; },
    (row) => { row.requestId = ""; },
    (row) => { row.accountVerified = false; },
    (row) => { row.receiptHmac = "00".repeat(32); },
    (row) => { row.accountPolicyVersion = ""; },
    (row) => { row.accountPolicyVersion = "agentic-account-binding-v2"; },
    (row) => { row.completedAt = "2026-07-13T20:00:00.000Z"; },
  ]) {
    const input = passingInput();
    mutate(input.scheduledInvocations.find((entry) => entry.name === "holdings-sync").records[0]);
    assert.equal(buildPhase0Observation(input).trustVerdict, "FAIL");
  }
});

test("an earlier sentinel P1 remains blocking even if the final sentinel is green", () => {
  const input = passingInput();
  const sentinel = input.scheduledInvocations.find((entry) => entry.name === "system-sentinel");
  sentinel.records[0].evidence.blockingAnomalies = [{ severity: "P1", title: "earlier incident" }];
  assert.deepEqual(sentinel.records[1].evidence.blockingAnomalies, []);
  assert.equal(buildPhase0Observation(input).trustVerdict, "FAIL");
});

test("missing deployment or policy identity cannot produce a passing day", () => {
  const input = passingInput();
  input.deployment = { commit: null, branch: "mandate-v3", policies: { mandateVersions: {}, researchSelection: null } };
  const result = buildPhase0Observation(input);
  assert.equal(result.verdict, "TRUST_FAIL_SKILL_PASS");
  assert.equal(result.trustVerdict, "FAIL");
  assert.equal(result.skillVerdict, "PASS");
  assert.equal(result.countsTowardSafetyWindow, false);
  assert.equal(result.countsTowardResearchCohort, true);
  assert.equal(result.checks.find((row) => row.name === "deployment_identity").status, "insufficient");
});

test("legacy position digest divergence cannot be mislabeled transactional parity", () => {
  const input = passingInput();
  input.parity = {
    fresh: true,
    ok: false,
    divergences: [{ key: "positions", reason: "digest old vs new" }],
  };
  const result = buildPhase0Observation(input);
  assert.equal(result.verdict, "TRUST_FAIL_SKILL_PASS");
  assert.equal(result.trustVerdict, "FAIL");
  assert.equal(result.skillVerdict, "PASS");
  assert.equal(result.checks.find((row) => row.name === "transactional_parity").status, "insufficient");
  assert.equal(result.checks.find((row) => row.name === "valuation_status").status, "warning");
});

test("split parity accepts exact valuation and keeps non-comparable provenance non-blocking", () => {
  const exact = passingInput();
  exact.parity = { fresh: true, ok: true, valuation: { status: "EXACT_MATCH", comparable: true }, divergences: [] };
  assert.equal(buildPhase0Observation(exact).verdict, "PASS_BOTH");

  const nonComparable = passingInput();
  nonComparable.parity = { fresh: true, ok: true, valuation: { status: "NON_COMPARABLE", comparable: false }, divergences: [] };
  const result = buildPhase0Observation(nonComparable);
  assert.equal(result.verdict, "PASS_BOTH");
  assert.equal(result.checks.find((row) => row.name === "valuation_status").status, "warning");
});

test("valuation provenance and freshness mismatches are warnings, not accounting failures", () => {
  for (const status of ["PROVENANCE_MISMATCH", "FRESHNESS_MISMATCH"]) {
    const input = passingInput();
    input.parity = { fresh: true, ok: true, valuation: { status, comparable: false }, divergences: [] };
    const result = buildPhase0Observation(input);
    assert.equal(result.verdict, "PASS_BOTH");
    assert.equal(result.checks.find((row) => row.name === "valuation_status").status, "warning");
  }
});

test("unreadable valuation warns unless it explicitly prevented holding monitoring", () => {
  const input = passingInput();
  input.parity = {
    fresh: true,
    ok: false,
    matched: ["capital_entries", "lots", "positions", "proposals"],
    valuation: { status: "UNREADABLE", comparable: false },
    divergences: [{ key: "positions_valuation", reason: "valuation inventory unavailable" }],
  };
  const warning = buildPhase0Observation(input);
  assert.equal(warning.verdict, "PASS_BOTH");
  assert.equal(warning.checks.find((row) => row.name === "valuation_status").status, "warning");

  input.parity.valuation.preventedHoldingMonitoring = true;
  const blocked = buildPhase0Observation(input);
  assert.equal(blocked.verdict, "TRUST_FAIL_SKILL_PASS");
  assert.equal(blocked.checks.find((row) => row.name === "valuation_status").status, "fail");
});

test("a split valuation-only mismatch does not become a transaction failure", () => {
  const input = passingInput();
  input.parity = {
    fresh: true,
    ok: false,
    matched: ["capital_entries", "lots", "positions", "proposals"],
    valuation: { status: "VALUE_MISMATCH", comparable: true },
    divergences: [{ key: "positions_valuation", reason: "same snapshot, different values" }],
  };
  const result = buildPhase0Observation(input);
  assert.equal(result.checks.find((row) => row.name === "transactional_parity").status, "pass");
  assert.equal(result.checks.find((row) => row.name === "valuation_status").status, "fail");
  assert.equal(result.verdict, "TRUST_FAIL_SKILL_PASS");
});

test("explicit research failure outcomes fail the daily observation", () => {
  const input = passingInput();
  input.research.report = researchReport({ outcomeCounts: { review_error: 1 } });
  const result = buildPhase0Observation(input);
  const research = result.checks.find((row) => row.name === "research_accounting");
  assert.equal(result.verdict, "TRUST_PASS_SKILL_FAIL");
  assert.equal(result.trustVerdict, "PASS");
  assert.equal(result.skillVerdict, "FAIL");
  assert.equal(result.countsTowardSafetyWindow, true);
  assert.equal(result.countsTowardResearchCohort, false);
  assert.equal(research.status, "fail");
  assert.equal(research.domain, "SKILL");
  assert.equal(research.evidence.failures, 1);
  assert.equal(research.evidence.attemptedReviews, 4);
});

test("budget exhaustion is explicit but still invalidates a clean research day", () => {
  const input = passingInput();
  input.research.report = researchReport({ outcomeCounts: { budget_exhausted: 1 } });
  const result = buildPhase0Observation(input);
  const research = result.checks.find((row) => row.name === "research_accounting");
  assert.equal(result.verdict, "TRUST_PASS_SKILL_FAIL");
  assert.equal(result.countsTowardSafetyWindow, true);
  assert.equal(result.countsTowardResearchCohort, false);
  assert.equal(research.status, "fail");
  assert.equal(research.evidence.failures, 1);
});

test("zero proposal throughput fails SKILL but preserves valid HOLD samples and TRUST day", () => {
  const input = passingInput();
  input.research.report = researchReport({ outcomeCounts: { proposal_created: 0, investment_hold: 3 } });
  const result = buildPhase0Observation(input);
  assert.equal(result.verdict, "TRUST_PASS_SKILL_FAIL");
  assert.equal(result.trustVerdict, "PASS");
  assert.equal(result.skillVerdict, "FAIL");
  assert.equal(result.countsTowardSafetyWindow, true);
  assert.equal(result.countsTowardResearchCohort, true);
  assert.equal(result.skillProgress.validResearchSamples, 3);
  assert.equal(result.skillProgress.actionableProposals, 0);
  assert.equal(result.checks.find((row) => row.name === "proposal_throughput").status, "fail");
  assert.match(formatPhase0Observation(result), /TRUST PASS — safety day counts: YES/);
  assert.match(formatPhase0Observation(result), /SKILL FAIL — research cohort samples retained: YES/);
});

test("a TRUST failure never erases a valid SKILL sample", () => {
  const input = passingInput();
  input.openReconciliations = [{ orderId: "order-1", verified: true }];
  const result = buildPhase0Observation(input);
  assert.equal(result.verdict, "TRUST_FAIL_SKILL_PASS");
  assert.equal(result.countsTowardSafetyWindow, false);
  assert.equal(result.countsTowardResearchCohort, true);
  assert.equal(result.checks.find((row) => row.name === "reconciliation").domain, "TRUST");
  assert.equal(result.checks.find((row) => row.name === "research_accounting").domain, "SKILL");
});

test("readable proposal counts alone do not prove SKILL", () => {
  const input = passingInput();
  input.research = { fresh: false, report: null };
  const result = buildPhase0Observation(input);
  assert.equal(result.trustVerdict, "PASS");
  assert.equal(result.skillVerdict, "FAIL");
  assert.equal(result.countsTowardResearchCohort, false);
  assert.equal(result.checks.find((row) => row.name === "proposal_counts").status, "pass");
  assert.equal(result.checks.find((row) => row.name === "research_accounting").status, "insufficient");
});

test("NOT_CONFIGURED monthly capacity is an explicit G0 insufficiency on both clocks", () => {
  const input = passingInput();
  input.capacity.monthly = {
    monthUtc: "2026-07", status: "NOT_CONFIGURED", capStatus: "NOT_CONFIGURED", remainingUsd: null,
    pricingVersion: "anthropic-global-standard-2026-07-14", telemetryStatus: "COMPLETE",
    spentUsd: 5, reservedUsd: 0, thresholds: { ceilingUsd: null, warnPct: 0.8, warningAtUsd: null },
  };
  const result = buildPhase0Observation(input);
  assert.equal(result.verdict, "FAIL_BOTH");
  assert.equal(result.countsTowardSafetyWindow, false);
  assert.equal(result.countsTowardResearchCohort, true);
  const readiness = result.checks.find((row) => row.name === "capacity_readiness");
  assert.equal(readiness.domain, "BOTH");
  assert.equal(readiness.status, "insufficient");
  assert.match(readiness.detail, /NOT_CONFIGURED/);
});

test("exhausted monthly capacity is SKILL-only unless protected monitoring was deprived", () => {
  const input = passingInput();
  input.capacity.monthly.status = "EXHAUSTED";
  input.capacity.monthly.remainingUsd = 0;
  input.capacity.providerCapacityStatus = "EXHAUSTED";
  const skillOnly = buildPhase0Observation(input);
  assert.equal(skillOnly.verdict, "TRUST_PASS_SKILL_FAIL");
  assert.equal(skillOnly.countsTowardSafetyWindow, true);
  assert.equal(skillOnly.countsTowardResearchCohort, true);
  assert.equal(skillOnly.checks.find((row) => row.name === "monthly_capacity").domain, "SKILL");

  input.capacity.preventedProtectedMonitoring = true;
  const both = buildPhase0Observation(input);
  assert.equal(both.verdict, "FAIL_BOTH");
  assert.equal(both.countsTowardSafetyWindow, false);
  assert.equal(both.checks.find((row) => row.name === "protected_monitoring_capacity").domain, "TRUST");
});

test("stable budget readiness mapping is privacy-safe and preserves explicit capacity overrides", () => {
  const mapped = mapAnthropicBudgetReadiness({
    schemaVersion: "anthropic-budget-readiness-v1",
    monthUtc: "2026-07",
    status: "EXHAUSTED",
    capStatus: "CONFIGURED",
    telemetryStatus: "COMPLETE",
    pricingVersion: "anthropic-global-standard-2026-07-14",
    spentUsd: 24,
    reservedUsd: 1,
    remainingUsd: 0,
    thresholds: { ceilingUsd: 25, warnPct: 0.8, warningAtUsd: 20 },
    coverage: { retentionDays: 120, startUtc: "2026-07-01", endUtc: "2026-07-14", pricedRecords: 10, issueCount: 0 },
    protectedCapacityDenied: true,
    protectedCapacityLastDeniedAt: "2026-07-14T20:00:00.000Z",
    byModel: { secret_model_breakdown: 24 },
    byRole: { secret_role_breakdown: 24 },
  }, { providerCapacityStatus: "THROTTLED" }, DATE);
  assert.equal(mapped.monthly.status, "EXHAUSTED");
  assert.equal(mapped.monthly.spentUsd, 24);
  assert.equal(mapped.monthly.thresholds.warningAtUsd, 20);
  assert.equal("byModel" in mapped.monthly, false);
  assert.equal("byRole" in mapped.monthly, false);
  assert.equal(mapped.providerCapacityStatus, "THROTTLED");
  assert.equal(mapped.preventedProtectedMonitoring, true);

  const overridden = mapAnthropicBudgetReadiness({
    protectedCapacityDenied: true,
    protectedCapacityLastDeniedAt: "2026-07-14T20:00:00.000Z",
  }, {
    preventedProtectedMonitoring: false,
  }, DATE);
  assert.equal(overridden.preventedProtectedMonitoring, false);
});

test("a prior protected denial remains visible without poisoning a later safety day", () => {
  const mapped = mapAnthropicBudgetReadiness({
    protectedCapacityDenied: true,
    protectedCapacityLastDeniedAt: "2026-07-13T20:00:00.000Z",
  }, {}, DATE);
  assert.equal(mapped.monthly.protectedCapacityDenied, true);
  assert.equal(mapped.preventedProtectedMonitoring, null);
});

test("UNREADY blocks G0 while WARNING remains readable and non-blocking", () => {
  const unready = passingInput();
  unready.capacity.monthly.status = "UNREADY";
  assert.equal(buildPhase0Observation(unready).verdict, "FAIL_BOTH");

  const warning = passingInput();
  warning.capacity.monthly.status = "WARNING";
  warning.capacity.monthly.remainingUsd = 4;
  const result = buildPhase0Observation(warning);
  assert.equal(result.verdict, "PASS_BOTH");
  assert.match(result.checks.find((row) => row.name === "monthly_capacity").detail, /warning threshold/);
});

test("unknown or unpriced provider capacity fails TRUST only when monitoring impact is explicit", () => {
  const input = passingInput();
  input.capacity.providerCapacityStatus = "UNPRICED_MODEL";
  const skillOnly = buildPhase0Observation(input);
  assert.equal(skillOnly.trustVerdict, "PASS");
  assert.equal(skillOnly.skillVerdict, "FAIL");

  input.capacity.preventedProtectedMonitoring = true;
  const withMonitoringFailure = buildPhase0Observation(input);
  assert.equal(withMonitoringFailure.trustVerdict, "FAIL");
  assert.equal(withMonitoringFailure.skillVerdict, "FAIL");
});

test("non-trading dates are recorded as skips and never count", () => {
  const result = buildPhase0Observation({ dateET: "2026-07-18", observedAt: "2026-07-19T00:15:00.000Z", tradingDay: false });
  assert.equal(result.verdict, "SKIP");
  assert.equal(result.trustVerdict, "SKIP");
  assert.equal(result.skillVerdict, "SKIP");
  assert.equal(result.countsTowardSafetyWindow, false);
  assert.equal(result.countsTowardResearchCohort, false);
  assert.equal(result.countsTowardWindow, false);
});

test("weekday observer roster follows the Sun-Thu scheduler without making Sunday a safety day", () => {
  const thursday = dueCriticalJobNames(new Date("2026-07-16T23:00:00.000Z"));
  const friday = dueCriticalJobNames(new Date("2026-07-17T23:00:00.000Z"));
  assert.ok(thursday.includes("research-scan"));
  assert.ok(thursday.includes("exit-monitor"));
  assert.ok(!friday.includes("research-scan"));
  assert.ok(!friday.includes("exit-monitor"));
  assert.ok(friday.includes("db-parity"));
  const domains = Object.fromEntries(dueObservedJobs(new Date("2026-07-16T23:00:00.000Z")).map((job) => [job.name, job.domain]));
  assert.equal(domains["holdings-sync"], "TRUST");
  assert.equal(domains["exit-monitor"], "TRUST");
  assert.equal(domains["research-scan"], "SKILL");
  assert.equal(domains["performance-review"], "SKILL");
  assert.equal(domains["premarket-check"], undefined);
});

test("a failed SKILL job does not reset an otherwise clean TRUST day", () => {
  const input = passingInput();
  input.criticalJobs.push({ name: "research-scan", domain: "SKILL", run: { dateET: DATE, ok: false } });
  const result = buildPhase0Observation(input);
  assert.equal(result.trustVerdict, "PASS");
  assert.equal(result.skillVerdict, "FAIL");
  assert.equal(result.countsTowardSafetyWindow, true);
  assert.equal(result.checks.find((row) => row.name === "skill_jobs").status, "fail");
});

test("a Sunday scheduled research run is selected once on Monday and never again Tuesday", () => {
  const sunday = { runId: "sun-run", source: "scheduled", completedAt: "2026-07-12T21:15:00.000Z" };
  const monday = { runId: "mon-run", source: "scheduled", completedAt: "2026-07-13T21:15:00.000Z" };
  const mondaySelected = selectUnobservedScheduledResearch([monday, sunday, sunday], [], new Date("2026-07-14T00:15:00.000Z"));
  assert.deepEqual(mondaySelected.map((row) => row.runId), ["mon-run", "sun-run"]);
  const tuesdaySelected = selectUnobservedScheduledResearch(
    [monday, sunday], ["sun-run", "mon-run"], new Date("2026-07-15T00:15:00.000Z")
  );
  assert.deepEqual(tuesdaySelected, []);
});

test("consumed research run IDs come only from HMAC-verified retained observations", async () => {
  const secret = "phase0-consumed-run-secret";
  const signed = signPhase0Observation({
    dateET: DATE,
    checks: [{ name: "research_accounting", evidence: { runIds: ["sun-run", "mon-run"] } }],
  }, secret);
  const redis = {
    async lrange() { return [DATE]; },
    async mget() { return [JSON.stringify(signed)]; },
  };
  assert.deepEqual(await consumedResearchRunIds(redis, secret), ["sun-run", "mon-run"]);
  redis.mget = async () => [JSON.stringify({ ...signed, checks: [] })];
  await assert.rejects(() => consumedResearchRunIds(redis, secret), /hash mismatch/);
});

test("consumed research history fails closed on index, MGET, or missing-row reads", async () => {
  const secret = "phase0-consumed-read-failure-secret";
  await assert.rejects(
    () => consumedResearchRunIds({ async lrange() { throw new Error("index unavailable"); } }, secret),
    /index unavailable/,
  );
  await assert.rejects(
    () => consumedResearchRunIds({ async lrange() { return [DATE]; }, async mget() { throw new Error("mget unavailable"); } }, secret),
    /mget unavailable/,
  );
  await assert.rejects(
    () => consumedResearchRunIds({ async lrange() { return [DATE]; }, async mget() { return [null]; } }, secret),
    /indexed Phase 0 observations are unreadable/,
  );
});

test("Sunday research is retained once but cannot mask a missing or failed Monday run", async () => {
  const sundayReport = researchReport();
  sundayReport.runId = "sun-run";

  const missingMonday = passingInput();
  missingMonday.research = { fresh: false, requiredRunPresent: false, newSample: true, reports: [sundayReport] };
  const missingResult = buildPhase0Observation(missingMonday);
  assert.equal(missingResult.skillVerdict, "FAIL");
  assert.equal(missingResult.countsTowardResearchCohort, true);
  assert.equal(missingResult.skillProgress.validResearchSamples, 3);

  const failedMondayReport = { ...researchReport(), runId: "mon-run", status: "failed", classificationAvailable: false };
  const failedMonday = passingInput();
  failedMonday.research = {
    fresh: true, requiredRunPresent: true, newSample: true,
    reports: [failedMondayReport, sundayReport],
  };
  const failedResult = buildPhase0Observation(failedMonday);
  assert.equal(failedResult.skillVerdict, "FAIL");
  assert.equal(failedResult.countsTowardResearchCohort, true);
  assert.equal(failedResult.skillProgress.validResearchSamples, 3);

  const redis = { async lrange() { return [{ source: "scheduled", runId: "sun-run", completedAt: "2026-07-12T21:15:00.000Z" }]; } };
  const gathered = await latestScheduledResearch(redis, new Date("2026-07-14T00:15:00.000Z"), "Mon", []);
  assert.equal(gathered.requiredRunPresent, false);
  assert.deepEqual(gathered.reports.map((report) => report.runId), ["sun-run"]);
});

test("a prior run can remain Friday context without counting as a new research sample", () => {
  const input = passingInput();
  input.research.newSample = false;
  const result = buildPhase0Observation(input);
  assert.equal(result.countsTowardResearchCohort, false);
  assert.equal(result.skillProgress.validResearchSamples, 0);
});

test("final sentinel evidence must be same-day, recent, and not future-dated", () => {
  const now = new Date("2026-07-15T00:15:00.000Z");
  assert.equal(finalSentinelIsFresh({ date: DATE, ts: "2026-07-15T00:10:00.000Z" }, now, DATE), true);
  assert.equal(finalSentinelIsFresh({ date: DATE, ts: "2026-07-14T22:15:00.000Z" }, now, DATE), false);
  assert.equal(finalSentinelIsFresh({ date: "2026-07-13", ts: "2026-07-15T00:10:00.000Z" }, now, DATE), false);
  assert.equal(finalSentinelIsFresh({ date: DATE, ts: "2026-07-15T00:16:00.000Z" }, now, DATE), false);
});

test("daily persistence is create-once and history is bounded", async () => {
  const secret = "phase0-persistence-test-secret";
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase0-observer-"));
  const values = new Map();
  const lists = new Map();
  const redis = {
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async get(key) { return values.get(key) ?? null; },
    async eval(_script, [key], [value, max]) {
      lists.set(key, [value, ...(lists.get(key) ?? []).filter((item) => item !== value)].slice(0, Number(max)));
      return 1;
    },
    async lrange(key, start, end) { return (lists.get(key) ?? []).slice(start, end + 1); },
    async ltrim(key, start, end) { lists.set(key, (lists.get(key) ?? []).slice(start, end + 1)); },
    async expire() { return 1; },
  };
  const firstRecord = signPhase0Observation({ dateET: DATE, verdict: "FAIL", reasons: ["first"] }, secret);
  const secondRecord = signPhase0Observation({ dateET: DATE, verdict: "PASS", reasons: [] }, secret);
  const first = await persistPhase0Observation(firstRecord, { redis, secret, archiveDir });
  const second = await persistPhase0Observation(secondRecord, { redis, secret, archiveDir });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.record.verdict, "FAIL");
  assert.deepEqual(lists.get("pm:phase0-observation:index"), [DATE]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archiveDir, `${DATE}.json`), "utf8")).rowHmac, firstRecord.rowHmac);
});

test("daily persistence repairs a partial index failure exactly once on retry", async () => {
  const secret = "phase0-index-repair-secret";
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase0-index-repair-"));
  const values = new Map();
  const lists = new Map();
  let failEval = true;
  const redis = {
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async get(key) { return values.get(key) ?? null; },
    async eval(_script, [key], [value, max]) {
      if (failEval) { failEval = false; throw new Error("transient atomic index write failure"); }
      lists.set(key, [value, ...(lists.get(key) ?? []).filter((item) => item !== value)].slice(0, Number(max)));
      return 1;
    },
    async ltrim(key, start, end) { lists.set(key, (lists.get(key) ?? []).slice(start, end + 1)); },
    async expire() { return 1; },
  };
  const record = signPhase0Observation({ dateET: DATE, verdict: "PASS", reasons: [] }, secret);
  await assert.rejects(() => persistPhase0Observation(record, { redis, secret, archiveDir }), /atomic index write failure/);
  const retry = await persistPhase0Observation(record, { redis, secret, archiveDir });
  assert.equal(retry.created, false);
  assert.deepEqual(lists.get("pm:phase0-observation:index"), [DATE]);
});

test("daily persistence replays the archived canonical record after Redis SET failure", async () => {
  const secret = "phase0-archive-replay-secret";
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase0-archive-replay-"));
  const values = new Map();
  let failSet = true;
  const redis = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) {
      if (failSet) { failSet = false; throw new Error("transient daily SET failure"); }
      values.set(key, value);
      return "OK";
    },
    async eval() { return 1; },
  };
  const first = signPhase0Observation({ dateET: DATE, observedAt: "2026-07-15T00:15:00Z", verdict: "FAIL" }, secret);
  const regenerated = signPhase0Observation({ dateET: DATE, observedAt: "2026-07-15T00:16:00Z", verdict: "PASS" }, secret);
  await assert.rejects(() => persistPhase0Observation(first, { redis, secret, archiveDir }), /daily SET failure/);
  const retry = await persistPhase0Observation(regenerated, { redis, secret, archiveDir });
  assert.equal(retry.created, true);
  assert.equal(retry.record.rowHmac, first.rowHmac);
  assert.equal(retry.record.observedAt, first.observedAt);
  assert.equal(JSON.parse(values.get(`pm:phase0-observation:${DATE}`)).rowHmac, first.rowHmac);
});

test("daily persistence rejects an unsigned or tampered retained record", async () => {
  const secret = "phase0-tamper-test-secret";
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase0-observer-tamper-"));
  const signed = signPhase0Observation({ dateET: DATE, verdict: "PASS", reasons: [] }, secret);
  const redis = {
    async get() { return JSON.stringify({ ...signed, verdict: "FAIL" }); },
  };
  await assert.rejects(() => persistPhase0Observation(signed, { redis, secret, archiveDir }), /hash mismatch/);
});

test("scheduled ledger verification turns a false diagnostic result into a failed job", () => {
  const scheduler = fs.readFileSync(new URL("../scheduler.js", import.meta.url), "utf8");
  assert.match(scheduler, /verified !== true/);
  assert.match(scheduler, /Signed-ledger verification reported problems/);
  assert.match(scheduler, /20 20 \* \* 1-5/);
  assert.match(scheduler, /runPhase0Observer\(\{ persist: true \}\)/);
  assert.match(scheduler, /10 20 \* \* 1-5/);
  assert.match(scheduler, /15 17 \* \* 0-4/);
  assert.match(scheduler, /HOLDING_COVERAGE/);
  assert.match(scheduler, /holdingMonitoring: result\?\.holdingMonitoring/);
});

test("an empty unconsumed history cannot pass when the same-day run was due", () => {
  const input = passingInput();
  input.research = { fresh: false, requiredRunPresent: false, newSample: false, reports: [] };
  const result = buildPhase0Observation(input);
  const research = result.checks.find((row) => row.name === "research_accounting");
  assert.equal(research.status, "fail");
  assert.equal(research.evidence.reason, "cadence_missing");
  assert.equal(result.skillVerdict, "FAIL");
  assert.equal(result.countsTowardResearchCohort, false);
});

test("a day with no required run and an empty consumed history passes accounting without sample credit", () => {
  const input = passingInput();
  input.research = { fresh: false, requiredRunPresent: true, newSample: false, reports: [] };
  const result = buildPhase0Observation(input);
  const research = result.checks.find((row) => row.name === "research_accounting");
  assert.equal(research.status, "pass");
  assert.equal(result.countsTowardResearchCohort, false);
  assert.equal(result.skillProgress.validResearchSamples, 0);
  const throughput = result.checks.find((row) => row.name === "proposal_throughput");
  assert.equal(throughput.status, "fail");
});

test("unreadable or unknown research history is insufficient, never a pass", async () => {
  const input = passingInput();
  input.research = { fresh: false, requiredRunPresent: null, newSample: false, reports: [] };
  const research = buildPhase0Observation(input).checks.find((row) => row.name === "research_accounting");
  assert.equal(research.status, "insufficient");
  assert.equal(research.evidence.reason, "history_unreadable");

  const gathered = await latestScheduledResearch(
    { async lrange() { throw new Error("history unavailable"); } },
    new Date("2026-07-14T00:15:00.000Z"),
    "Tue",
    [],
  );
  assert.equal(gathered.requiredRunPresent, null);
  assert.equal(gathered.newSample, false);
  assert.deepEqual(gathered.reports, []);
});
