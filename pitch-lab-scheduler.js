/**
 * Pitch Lab scheduler — a SEPARATE process from scheduler.js (PM2 app `pitch-lab`).
 *
 * Kept apart on purpose: scheduler.js carries the Phase 0 critical-job schedule,
 * sentinel evidence and parity meaning. Registering paper-only research jobs
 * there would change that surface; running them here cannot. Nothing in this
 * file or the jobs it calls creates a proposal, touches a broker, or writes a
 * pm:* key (see jobs/pitch-lab-daily.js).
 *
 * Start:  PITCH_LAB_ENABLED=1 pm2 start pitch-lab-scheduler.js --name pitch-lab
 * With PITCH_LAB_ENABLED unset the process idles and every job reports "disabled".
 *
 * Schedule (ET; the slots avoid the 18:00-20:20 production jobs' start times):
 *   18:40 Mon-Fri  daily pitches   (after the 17:15 scan and 17:30 peer-coverage refresh)
 *   after daily      grade matured pitches + send the digest (never races daily)
 *   10:00 Sat      weekly report -> report.json/html + published key for the website
 *   11:00 Sat (1st of month only)  monthly mandate review
 */
import "dotenv/config";
import cron from "node-cron";
import { runPitchLabDailyCycle, runPitchLabReport, runPitchLabMandateReview, pitchLabEnabled } from "./jobs/pitch-lab-daily.js";
import { sendMessage } from "./lib/telegram.js";

const TZ = { timezone: "America/New_York" };

function guarded(name, job) {
  return async () => {
    const started = Date.now();
    try {
      const result = await job();
      console.log(`[PitchLabScheduler] ${name} finished in ${Math.round((Date.now() - started) / 1000)}s: ${result?.status ?? "ok"}`);
    } catch (error) {
      console.error(`[PitchLabScheduler] ${name} FAILED: ${error?.stack ?? error}`);
      try {
        await sendMessage(`🚨 Pitch Lab ${name} failed: ${String(error?.message ?? error).slice(0, 300)}`);
      } catch (notifyError) {
        console.error(`[PitchLabScheduler] notification failed: ${notifyError?.message ?? notifyError}`);
      }
    }
  };
}

cron.schedule("40 18 * * 1-5", guarded("daily", () => runPitchLabDailyCycle()), TZ);
cron.schedule("0 10 * * 6", guarded("report", () => runPitchLabReport()), TZ);
// Monthly: first Saturday only (getDate() ≤ 7). Runs after the weekly report.
cron.schedule("0 11 * * 6", guarded("mandate-review", () => {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  if (now.getDate() > 7) { console.log("[PitchLabScheduler] mandate-review: not the first Saturday, skipping."); return Promise.resolve({ status: "skipped" }); }
  return runPitchLabMandateReview();
}), TZ);

console.log(`[PitchLabScheduler] started — ${pitchLabEnabled() ? "ENABLED" : "idle (PITCH_LAB_ENABLED not set)"}`);
