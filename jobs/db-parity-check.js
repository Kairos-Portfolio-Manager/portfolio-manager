import { runParityCheck } from "../lib/pg/parity-runner.js";
import { getRedis } from "../lib/redis.js";
import { sendMessage } from "../lib/telegram.js";

const LATEST_KEY = "pm:pg-parity:latest";
const HISTORY_KEY = "pm:pg-parity:history";
const TELEGRAM_STATE_KEY = "pm:pg-parity:telegram-state";

export function parityStatusPayload(result) {
  const valuation = result?.valuation
    ? {
        status: result.valuation.status,
        comparable: result.valuation.comparable === true,
        reason: result.valuation.reason ?? null,
      }
    : null;
  return {
    ok: result?.ok === true,
    comparedAt: result?.comparedAt ?? null,
    matched: Array.isArray(result?.matched) ? result.matched : [],
    divergences: Array.isArray(result?.divergences) ? result.divergences : [],
    valuation,
  };
}

function parse(value) {
  if (!value) return null;
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
}

export function parityTelegramTransition(previous, result) {
  if (!result?.ok && previous?.status !== "diverged") {
    const affected = (result.divergences ?? []).map((row) => row.key).filter(Boolean).join(", ") || "accounting snapshot";
    return {
      status: "diverged",
      message:
        `🔧 Database accounting mirror is out of sync (${affected}).\n` +
        "Sheets and Redis still own live accounting, so this does not change balances, proposals, or trading. The mismatch is retained for repair; repeated identical checks will stay quiet.",
    };
  }
  if (result?.ok && previous?.status === "diverged") {
    return { status: "healthy", message: "✅ Database accounting mirror is back in sync with the live accounting record." };
  }
  return { status: result?.ok ? "healthy" : "diverged", message: null };
}

export async function runDailyDbParityCheck({ run = runParityCheck, redis = getRedis(), send = sendMessage } = {}) {
  const result = await run();
  console.log(`[Parity] ${result.report.replaceAll("\n", " | ")}`);

  let previous = null;
  if (redis) {
    previous = parse(await redis.get(TELEGRAM_STATE_KEY));
    // Persist only the aggregate valuation classification. Per-position values
    // and inventories stay out of operational Redis status/history.
    const payload = JSON.stringify(parityStatusPayload(result));
    await redis.set(LATEST_KEY, payload);
    await redis.lpush(HISTORY_KEY, payload);
    await redis.ltrim(HISTORY_KEY, 0, 89);
  }

  const transition = parityTelegramTransition(previous, result);
  let transitionDelivered = true;
  if (transition.message) {
    try {
      await send(transition.message);
    } catch (error) {
      transitionDelivered = false;
      console.warn(`[Parity] Telegram alert failed: ${error.message}`);
    }
  }
  if (redis && (!transition.message || transitionDelivered)) {
    await redis.set(TELEGRAM_STATE_KEY, JSON.stringify({ status: transition.status, changedAt: result.comparedAt ?? new Date().toISOString() }));
  }
  // The transition message is edge-triggered, but parity remains required Phase
  // 0 TRUST evidence while Sheets/Redis own the money path. A divergence stays
  // visible and blocks a clean observation day without repeating this direct
  // alert every night.
  return { ...result, phase0TrustBlocking: !result.ok };
}
