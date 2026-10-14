import "dotenv/config";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getRedis } from "../lib/redis.js";
import {
  PM2_DEPLOY_MARKER_SCHEMA,
  PM2_DEPLOY_MARKER_TTL_SECONDS,
  getSysloopDeployHmacSecret,
  pm2DeployMarkerKey,
  signPm2DeployMarker,
  validatePm2DeployMarkerChain,
} from "../lib/sysloop/deploy-marker.js";

const exec = promisify(execFile);

function parse(raw) {
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function gitValue(args, execFn) {
  return (await execFn("git", args, { timeout: 10_000 })).stdout.trim();
}

async function readPm2Process(processName, execFn) {
  const result = await execFn("pm2", ["jlist"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const list = JSON.parse(result.stdout);
  const process = list.find((entry) => entry?.name === processName);
  if (!process) throw new Error(`PM2 process ${processName} was not found.`);
  return process;
}

async function readPendingMarkers(redis, processName, previousRestarts, currentRestarts) {
  if (currentRestarts <= previousRestarts) return [];
  const keys = [];
  for (let after = previousRestarts + 1; after <= currentRestarts; after++) {
    keys.push(pm2DeployMarkerKey(processName, after));
  }
  const rows = await redis.mget(...keys);
  if (!Array.isArray(rows) || rows.length !== keys.length) throw new Error("deploy marker chain is unreadable.");
  return rows.map((raw) => {
    try { return parse(raw); } catch { return null; }
  });
}

export function buildRestartEnv(env, deployedIdentity) {
  const { PITCH_LAB_ENABLED: _sharedFileGate, ...baseEnv } = env;
  return { ...baseEnv, ...deployedIdentity };
}

export async function restartWithPm2DeployMarker({
  processName = process.env.SYSLOOP_PM2_NAME?.trim() || "portfolio-manager",
  target = process.env.SYSLOOP_DEPLOY_TARGET?.trim() || "jetson",
  host = os.hostname(),
  redis = getRedis(),
  secret = getSysloopDeployHmacSecret(),
  now = new Date(),
  execFn = exec,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!redis) throw new Error("Redis is not configured; trusted deploy restart cannot run.");
  const state = parse(await redis.get("pm:sysloop:state"));
  if (!Number.isInteger(state?.restarts) || !Number.isInteger(state?.unstableRestarts)) {
    throw new Error("A complete PM2 sentinel baseline is required before a trusted deploy restart.");
  }

  const before = await readPm2Process(processName, execFn);
  const beforeEnv = before.pm2_env ?? {};
  if (beforeEnv.status !== "online" || beforeEnv.exit_code !== 0) throw new Error("PM2 process is not clean before restart.");
  if (!Number.isInteger(beforeEnv.restart_time) || !Number.isInteger(beforeEnv.unstable_restarts)) {
    throw new Error("PM2 restart metadata is incomplete before restart.");
  }
  if (beforeEnv.unstable_restarts !== state.unstableRestarts) throw new Error("Unstable restart count differs from the sentinel baseline.");

  if (beforeEnv.restart_time < state.restarts) throw new Error("PM2 restart counter reset is untrusted.");
  if (beforeEnv.restart_time > state.restarts) {
    const pending = await readPendingMarkers(redis, processName, state.restarts, beforeEnv.restart_time);
    const chain = validatePm2DeployMarkerChain(pending, {
      secret,
      target,
      host,
      processName,
      previousRestarts: state.restarts,
      currentRestarts: beforeEnv.restart_time,
      previousUnstableRestarts: state.unstableRestarts,
      currentUnstableRestarts: beforeEnv.unstable_restarts,
      currentExitCode: beforeEnv.exit_code,
      currentStartedAt: beforeEnv.pm_uptime,
      currentBranch: beforeEnv.SYSLOOP_DEPLOYED_BRANCH,
      currentCommit: beforeEnv.SYSLOOP_DEPLOYED_COMMIT,
      nowMs: now.getTime(),
    });
    if (!chain.trusted) throw new Error(`Refusing to launder an unexplained restart gap: ${chain.reason}`);
  }

  const branch = await gitValue(["branch", "--show-current"], execFn);
  const commit = await gitValue(["rev-parse", "HEAD"], execFn);
  const restartEnv = buildRestartEnv(process.env, {
    SYSLOOP_DEPLOYED_BRANCH: branch,
    SYSLOOP_DEPLOYED_COMMIT: commit,
    SYSLOOP_DEPLOYED_AT: now.toISOString(),
    SYSLOOP_DEPLOY_TARGET: target,
  });
  await execFn("pm2", ["restart", processName, "--update-env", "--time"], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: restartEnv,
  });
  await execFn("pm2", ["save"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: restartEnv });
  await wait(2_000);

  const after = await readPm2Process(processName, execFn);
  const afterEnv = after.pm2_env ?? {};
  if (afterEnv.status !== "online") throw new Error("PM2 process is not online after restart.");
  if (afterEnv.restart_time !== beforeEnv.restart_time + 1) throw new Error("PM2 restart count did not advance by exactly one.");
  if (afterEnv.unstable_restarts !== beforeEnv.unstable_restarts) throw new Error("PM2 unstable restart count changed.");
  if (afterEnv.exit_code !== 0) throw new Error("PM2 exit code is non-zero after restart.");
  if (!Number.isFinite(afterEnv.pm_uptime) || afterEnv.pm_uptime <= beforeEnv.pm_uptime) throw new Error("PM2 process start time did not advance.");
  if (afterEnv.SYSLOOP_DEPLOYED_BRANCH !== branch
    || afterEnv.SYSLOOP_DEPLOYED_COMMIT !== commit
    || afterEnv.SYSLOOP_DEPLOYED_AT !== restartEnv.SYSLOOP_DEPLOYED_AT) {
    throw new Error("PM2 did not retain the deployed branch/commit/start-time identity.");
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PM2_DEPLOY_MARKER_TTL_SECONDS * 1000).toISOString();
  const markerId = createHash("sha256").update(JSON.stringify([
    PM2_DEPLOY_MARKER_SCHEMA, target, host, processName, beforeEnv.restart_time,
    afterEnv.restart_time, afterEnv.pm_uptime, branch, commit, createdAt,
  ])).digest("hex");
  const marker = signPm2DeployMarker({
    schemaVersion: PM2_DEPLOY_MARKER_SCHEMA,
    markerId,
    target,
    host,
    processName,
    beforeRestarts: beforeEnv.restart_time,
    afterRestarts: afterEnv.restart_time,
    beforeUnstableRestarts: beforeEnv.unstable_restarts,
    afterUnstableRestarts: afterEnv.unstable_restarts,
    exitCode: afterEnv.exit_code,
    startedAt: afterEnv.pm_uptime,
    branch,
    commit,
    createdAt,
    expiresAt,
  }, secret);
  const key = pm2DeployMarkerKey(processName, marker.afterRestarts);
  const inserted = await redis.set(key, JSON.stringify(marker), { nx: true, ex: PM2_DEPLOY_MARKER_TTL_SECONDS });
  if (!inserted) throw new Error(`Deploy marker edge ${marker.beforeRestarts}->${marker.afterRestarts} already exists; refusing overwrite.`);
  return marker;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  restartWithPm2DeployMarker()
    .then((marker) => {
      console.log(JSON.stringify({
        recorded: true,
        markerId: marker.markerId,
        processName: marker.processName,
        edge: `${marker.beforeRestarts}->${marker.afterRestarts}`,
        branch: marker.branch,
        commit: marker.commit,
      }));
    })
    .catch((error) => {
      console.error(`[DeployRestart] ${error.message}`);
      process.exit(1);
    });
}
