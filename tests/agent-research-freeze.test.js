import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AGENTS } from "../config/agents.js";
import { isResearchActive } from "../lib/research-run-health.js";

test("Agents Two and Three are research-frozen; Agent One stays active", () => {
  const status = Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.researchStatus]));
  assert.deepEqual(status, { "agent-1": "active", "agent-2": "frozen", "agent-3": "frozen" });
  assert.deepEqual(AGENTS.filter(isResearchActive).map((agent) => agent.id), ["agent-1"]);
});

test("research freeze fails closed on missing or unknown status", () => {
  assert.equal(isResearchActive({ id: "x", researchStatus: "active" }), true);
  assert.equal(isResearchActive({ id: "x", researchStatus: "frozen" }), false);
  assert.equal(isResearchActive({ id: "x", researchStatus: "Active" }), false);
  assert.equal(isResearchActive({ id: "x" }), false);
  assert.equal(isResearchActive(undefined), false);
});

test("every research entry point honours the freeze", () => {
  const scan = readFileSync(new URL("../jobs/research-scan.js", import.meta.url), "utf8");
  assert.match(scan, /DEFAULT_AGENT_IDS = AGENTS\.filter\(isResearchActive\)/);
  assert.match(scan, /requestedAgents\.filter\(isResearchActive\)/);
  assert.match(scan, /if \(!isResearchActive\(agent\)\) throw new Error\(`\$\{agent\.id\} is frozen/);
  // Budget partitions stay sized over all agents so a freeze does not triple agent-1's cap.
  assert.match(scan, /allocateFairAgentRunCaps\(\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*AGENTS\.map/);
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /isResearchActive\(AGENTS\.find/);
  const intraday = readFileSync(new URL("../jobs/intraday-monitor.js", import.meta.url), "utf8");
  assert.match(intraday, /!isResearchActive\(alertAgent\)/);
});
