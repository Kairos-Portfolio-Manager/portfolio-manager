/**
 * Ops-watch scheduler — a SEPARATE process from scheduler.js (PM2 app `ops-watch`).
 *
 * Watches what the evening sentinel cannot: the Pitch Lab process, the Jetson broker
 * reader, and the sentinel itself. Kept out of scheduler.js so it cannot change the
 * Phase 0 safety clock, and out of the Pitch Lab process so it can notice that
 * process dying. Read-only except pm:opswatch:* keys and Telegram (jobs/ops-watch.js).
 *
 * Start:  pm2 start ops-watch-scheduler.js --name ops-watch && pm2 save
 *
 * Schedule: every 30 minutes, 08:00-20:30 ET, Mon-Fri. The 08:00 run carries the
 * morning digest of anything still open; the 20:30 run is the last chance to notice a
 * missed 18:40 Pitch Lab cycle or a missed 20:10 sentinel.
 */
import "dotenv/config";
import cron from "node-cron";
import { runOpsWatch } from "./jobs/ops-watch.js";
import { sendMessage } from "./lib/telegram.js";

const TZ = { timezone: "America/New_York" };
let running = false;
let lastFailurePageMs = 0;

async function guarded() {
  if (running) {
    console.warn("[OpsWatchScheduler] previous run still in progress; skipping this tick");
    return;
  }
  running = true;
  try {
    await runOpsWatch();
  } catch (error) {
    console.error(`[OpsWatchScheduler] run FAILED: ${error?.stack ?? error}`);
    // A persistent fault would otherwise page every 30 minutes; one page per 6 hours is enough.
    if (Date.now() - lastFailurePageMs < 6 * 60 * 60 * 1000) return;
    lastFailurePageMs = Date.now();
    try {
      await sendMessage(`🚨 Ops watch itself failed: ${String(error?.message ?? error).slice(0, 300)}`);
    } catch (notifyError) {
      console.error(`[OpsWatchScheduler] notification failed: ${notifyError?.message ?? notifyError}`);
    }
  } finally {
    running = false;
  }
}

cron.schedule("0,30 8-20 * * 1-5", guarded, TZ);
console.log("[OpsWatchScheduler] started — every 30 min, 08:00-20:30 ET, Mon-Fri");
