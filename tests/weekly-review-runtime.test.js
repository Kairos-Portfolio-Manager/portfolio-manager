import test from "node:test";
import assert from "node:assert/strict";
import { AGENTS } from "../config/agents.js";
import { runWeeklyReview } from "../jobs/weekly-review.js";

test("weekly review skips frozen agents with zero reads or model calls", async () => {
  const reads = [];
  const sends = [];
  let modelCalls = 0;
  let saved = null;
  const artifact = await runWeeklyReview({
    now: Date.parse("2026-10-09T22:30:00.000Z"),
    env: { PITCH_LAB_ENABLED: "0" },
    agents: AGENTS,
    monthlyBudget: {},
    getClients: () => ({ sheets: {}, drive: {} }),
    resolveSpreadsheet: async () => "sheet",
    listProposals: async () => [],
    getArtifact: async () => null,
    readOutcomes: async (_sheets, _spreadsheetId, agentId) => { reads.push(agentId); return []; },
    listMemories: async () => [],
    generate: async () => { modelCalls += 1; return { lessons: [], retire: [], parseError: false }; },
    applyLessons: async () => { throw new Error("no lessons should be written"); },
    setArtifact: async (_week, value) => { saved = value; },
    send: async (message) => { sends.push(message); },
  });

  assert.deepEqual(reads, ["agent-1"]);
  assert.equal(modelCalls, 0);
  assert.deepEqual(Object.keys(artifact.agents), ["agent-1"]);
  assert.equal(saved, artifact);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /agent-1: 0 proposals/);
});

test("Pitch Lab owns the weekly phone slot once enabled", async () => {
  let sends = 0;
  await runWeeklyReview({
    now: Date.parse("2026-10-09T22:30:00.000Z"),
    env: { PITCH_LAB_ENABLED: "1" },
    agents: [AGENTS[0]],
    monthlyBudget: {},
    getClients: () => ({ sheets: {}, drive: {} }),
    resolveSpreadsheet: async () => "sheet",
    listProposals: async () => [],
    getArtifact: async () => null,
    readOutcomes: async () => [],
    setArtifact: async () => {},
    send: async () => { sends += 1; },
  });
  assert.equal(sends, 0);
});
