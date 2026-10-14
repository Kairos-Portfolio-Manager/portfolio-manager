import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPm2 } from "../lib/sysloop/checks.js";
import {
  PM2_DEPLOY_MARKER_SCHEMA,
  getSysloopDeployHmacSecret,
  pm2DeployMarkerKey,
  signPm2DeployMarker,
  validatePm2DeployMarkerChain,
} from "../lib/sysloop/deploy-marker.js";
import { buildRestartEnv, restartWithPm2DeployMarker } from "../scripts/restart-with-pm2-deploy-marker.js";
import { persistSnapshot } from "../lib/sysloop/snapshot.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-07-15T00:30:00.000Z");
const HOST = "jetson-test";
const TARGET = "jetson";
const PROCESS = "portfolio-manager";
const COMMIT_1 = "1111111111111111111111111111111111111111";
const COMMIT_2 = "2222222222222222222222222222222222222222";

function markerEdge(before, {
  commit = COMMIT_1,
  branch = "mandate-v3",
  startedAt = NOW.getTime() - 60_000,
  createdAt = new Date(NOW.getTime() - 30_000).toISOString(),
  overrides = {},
} = {}) {
  const after = before + 1;
  return signPm2DeployMarker({
    schemaVersion: PM2_DEPLOY_MARKER_SCHEMA,
    markerId: String(after).padStart(64, "0"),
    target: TARGET,
    host: HOST,
    processName: PROCESS,
    beforeRestarts: before,
    afterRestarts: after,
    beforeUnstableRestarts: 0,
    afterUnstableRestarts: 0,
    exitCode: 0,
    startedAt,
    branch,
    commit,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 10 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  }, SECRET);
}

function chainOptions(currentRestarts, final, overrides = {}) {
  return {
    secret: SECRET,
    target: TARGET,
    host: HOST,
    processName: PROCESS,
    previousRestarts: 39,
    currentRestarts,
    previousUnstableRestarts: 0,
    currentUnstableRestarts: 0,
    currentExitCode: 0,
    currentStartedAt: final.startedAt,
    currentBranch: final.branch,
    currentCommit: final.commit,
    nowMs: NOW.getTime(),
    ...overrides,
  };
}

test("one exact signed restart edge is trusted and then addressable for consumption", () => {
  const marker = markerEdge(39);
  const result = validatePm2DeployMarkerChain([marker], chainOptions(40, marker));
  assert.equal(result.trusted, true);
  assert.deepEqual(result.markerIds, [marker.markerId]);
  assert.deepEqual(result.markerKeys, [pm2DeployMarkerKey(PROCESS, 40)]);
});

test("two deploys require a contiguous ordered marker chain", () => {
  const first = markerEdge(39, { commit: COMMIT_1, startedAt: NOW.getTime() - 120_000 });
  const second = markerEdge(40, { commit: COMMIT_2, startedAt: NOW.getTime() - 60_000 });
  assert.equal(validatePm2DeployMarkerChain([first, second], chainOptions(41, second)).trusted, true);

  for (const broken of [[second], [second, first], [first, first]]) {
    const result = validatePm2DeployMarkerChain(broken, chainOptions(41, second));
    assert.equal(result.trusted, false);
  }
});

test("marker chain rejects tampering, replay, stale data, and runtime mismatches", () => {
  const marker = markerEdge(39);
  const cases = [
    [{ ...marker, commit: COMMIT_2 }, chainOptions(40, marker), /HMAC/i],
    [[marker], chainOptions(41, marker), /incomplete/i],
    [[marker], chainOptions(40, marker, { host: "other-host" }), /host/i],
    [[marker], chainOptions(40, marker, { currentStartedAt: marker.startedAt + 1 }), /start/i],
    [[marker], chainOptions(40, marker, { currentCommit: COMMIT_2 }), /commit/i],
    [[marker], chainOptions(40, marker, { currentUnstableRestarts: 1 }), /unstable/i],
    [[marker], chainOptions(40, marker, { currentExitCode: 1 }), /exit code/i],
    [[marker], chainOptions(40, marker, { nowMs: NOW.getTime() + 11 * 24 * 60 * 60 * 1000 }), /stale/i],
  ];
  for (const [input, options, pattern] of cases) {
    const markers = Array.isArray(input) ? input : [input];
    const result = validatePm2DeployMarkerChain(markers, options);
    assert.equal(result.trusted, false);
    assert.match(result.reason, pattern);
  }
});

test("dedicated deploy secret never falls back to operational or audit secrets", () => {
  assert.throws(
    () => getSysloopDeployHmacSecret({ OPERATIONAL_LEDGER_HMAC_SECRET: SECRET, AUDIT_HMAC_SECRET: SECRET }),
    /SYSLOOP_DEPLOY_HMAC_SECRET/i,
  );
  assert.equal(getSysloopDeployHmacSecret({ SYSLOOP_DEPLOY_HMAC_SECRET: SECRET }), SECRET);
});

test("trusted marker suppresses only the untrusted-cause anomaly", () => {
  const process = {
    name: PROCESS,
    pm2_env: { status: "online", restart_time: 40, unstable_restarts: 0, exit_code: 0 },
  };
  assert.deepEqual(checkPm2({
    processes: [process], prevRestarts: 39, prevUnstableRestarts: 0,
    deployMarkerTrust: { trusted: true },
  }), []);
  const unsafe = checkPm2({
    processes: [{ ...process, pm2_env: { ...process.pm2_env, unstable_restarts: 1 } }],
    prevRestarts: 39, prevUnstableRestarts: 0, deployMarkerTrust: { trusted: true },
  });
  assert.match(unsafe[0].title, /flapping/i);
  const offline = checkPm2({
    processes: [{ ...process, pm2_env: { ...process.pm2_env, status: "offline" } }],
    prevRestarts: 39, prevUnstableRestarts: 0, deployMarkerTrust: { trusted: true },
  });
  assert.match(offline[0].title, /offline/i);
});

test("trusted restart helper observes and signs only the restart it performs", async () => {
  let restarted = false;
  let deployedEnv = {};
  const writes = [];
  const redis = {
    get: async () => JSON.stringify({ restarts: 39, unstableRestarts: 0 }),
    mget: async () => [],
    set: async (...args) => { writes.push(args); return "OK"; },
  };
  const execFn = async (command, args, options = {}) => {
    if (command === "git" && args[0] === "branch") return { stdout: "mandate-v3\n" };
    if (command === "git" && args[0] === "rev-parse") return { stdout: `${COMMIT_1}\n` };
    if (command === "pm2" && args[0] === "restart") {
      restarted = true;
      deployedEnv = options.env ?? {};
      return { stdout: "restarted" };
    }
    if (command === "pm2" && args[0] === "save") return { stdout: "saved" };
    if (command === "pm2" && args[0] === "jlist") {
      const count = restarted ? 40 : 39;
      return { stdout: JSON.stringify([{
        name: PROCESS,
        pm2_env: {
          status: "online", restart_time: count, unstable_restarts: 0, exit_code: 0,
          pm_uptime: NOW.getTime() - (restarted ? 10_000 : 120_000),
          SYSLOOP_DEPLOYED_BRANCH: restarted ? deployedEnv.SYSLOOP_DEPLOYED_BRANCH : undefined,
          SYSLOOP_DEPLOYED_COMMIT: restarted ? deployedEnv.SYSLOOP_DEPLOYED_COMMIT : undefined,
          SYSLOOP_DEPLOYED_AT: restarted ? deployedEnv.SYSLOOP_DEPLOYED_AT : undefined,
        },
      }]) };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  const marker = await restartWithPm2DeployMarker({
    redis, secret: SECRET, now: NOW, host: HOST, target: TARGET, execFn, wait: async () => {},
  });
  assert.equal(marker.beforeRestarts, 39);
  assert.equal(marker.afterRestarts, 40);
  assert.equal(deployedEnv.SYSLOOP_DEPLOYED_AT, NOW.toISOString());
  assert.equal(writes[0][0], pm2DeployMarkerKey(PROCESS, 40));
  assert.equal(writes[0][2].nx, true);
});

test("trusted restart helper leaves the shared Pitch Lab gate out of PM2's saved environment", () => {
  const restartEnv = buildRestartEnv({
    PATH: "/usr/bin",
    PITCH_LAB_ENABLED: "1",
  }, {
    SYSLOOP_DEPLOYED_BRANCH: "mandate-v3",
    SYSLOOP_DEPLOYED_COMMIT: COMMIT_1,
  });
  assert.deepEqual(restartEnv, {
    PATH: "/usr/bin",
    SYSLOOP_DEPLOYED_BRANCH: "mandate-v3",
    SYSLOOP_DEPLOYED_COMMIT: COMMIT_1,
  });
});

test("restart helper refuses to launder an unexplained gap before invoking PM2 restart", async () => {
  let restartCalled = false;
  const redis = {
    get: async () => JSON.stringify({ restarts: 39, unstableRestarts: 0 }),
    mget: async () => [null],
  };
  const execFn = async (command, args) => {
    if (command === "pm2" && args[0] === "jlist") {
      return { stdout: JSON.stringify([{
        name: PROCESS,
        pm2_env: { status: "online", restart_time: 40, unstable_restarts: 0, exit_code: 0, pm_uptime: NOW.getTime() - 60_000 },
      }]) };
    }
    if (command === "pm2" && args[0] === "restart") restartCalled = true;
    throw new Error("unexpected command");
  };
  await assert.rejects(
    restartWithPm2DeployMarker({ redis, secret: SECRET, now: NOW, host: HOST, target: TARGET, execFn, wait: async () => {} }),
    /Refusing to launder/i,
  );
  assert.equal(restartCalled, false);
});

test("snapshot state advancement and marker consumption use one atomic Redis script", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-sysloop-marker-"));
  const calls = [];
  const redis = { eval: async (...args) => { calls.push(args); return 1; } };
  try {
    await persistSnapshot({
      snapshot: { date: "2026-07-14", ts: NOW.toISOString(), anomalies: [] },
      nextState: { restarts: 40, unstableRestarts: 0 },
      repoRoot: root,
      consumedDeployMarkerKeys: [pm2DeployMarkerKey(PROCESS, 40)],
      redis,
    });
    assert.equal(calls.length, 1);
    const [, keys, args] = calls[0];
    assert.deepEqual(keys.slice(0, 3), [
      "pm:sysloop:snapshot:2026-07-14",
      "pm:sysloop:state",
      "pm:sysloop:last-run",
    ]);
    assert.equal(keys[3], pm2DeployMarkerKey(PROCESS, 40));
    assert.equal(JSON.parse(args[1]).restarts, 40);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
