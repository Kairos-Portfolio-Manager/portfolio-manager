/**
 * Pitch Lab daily run — select candidates, have Agent One pitch each, record the pitches.
 *
 * Orchestration only, with every outside dependency injected (catalog, data
 * fetch, peer ranks, model call, notifier, clock, sleep). jobs/pitch-lab-daily.js
 * wires the real ones; the tests wire fakes. Nothing here imports a database,
 * a broker or a model SDK. Paper only: a pitch is appended to the local store
 * and never becomes a proposal.
 *
 * Safety properties:
 *   - The day's draw is recorded BEFORE any pitch is written, and a day is drawn
 *     once (store refuses a second receipt). A crashed run resumes the SAME picks;
 *     it can never re-roll the dice after seeing a partial result.
 *   - Resuming skips a name already pitched on that ET date, so re-running is safe.
 *   - One bad name never stops the rest: its failure is logged loudly and counted.
 *     A budget stop DOES stop the run (every later call would fail the same way).
 *   - The model supplies only judgment; every number comes from the system
 *     (pitchFromModelResponse), and a reply that is not exactly one valid JSON
 *     object, or that fails pitch validation, is dropped — never repaired.
 */
import { etDateString } from "../market-calendar.js";
import { PitchValidationError } from "./pitch.js";
import { PitchReplyError, buildPitchPrompt, buildPitchSystemPrompt, parsePitchReplyText, pitchFromModelResponse } from "./pitch-prompt.js";
import { DEFAULT_SELECTION, selectPitchCandidates } from "./selection.js";

const isBudgetStop = (error) => error?.code === "budget_exhausted" || String(error?.code ?? "").startsWith("monthly_budget");

/**
 * @returns {Promise<object>} summary: { status, date, selected, pitched, failed[], skipped[], spendUsd, requests, shortfall }
 */
export async function runDailyPitches({
  date,
  now = () => new Date(),
  store,
  getCatalog,
  riskLimits = {},
  gatherData,
  getPeers,
  callModel,
  notify = async () => {},
  sleep = async () => {},
  mandateExcerpt = "",
  mandateVersion = null,
  model = null,
  size = DEFAULT_SELECTION.size,
  randomSlots = DEFAULT_SELECTION.randomSlots,
  maxPitches = size,
  maxUsd = Infinity,
  dryRun = false,
  paceMs = 250,
} = {}) {
  const runDate = date ?? etDateString(now());
  const say = async (text) => {
    try {
      await notify(text);
    } catch (error) {
      console.error(`[PitchLab] notification failed (${error?.message ?? error}); message was: ${text}`);
    }
  };
  const summary = { status: "ok", date: runDate, selected: 0, pitched: 0, failed: [], skipped: [], spendUsd: 0, requests: { filed: 0, notFiled: {} }, shortfall: 0, dryRun };

  // 1. The day's draw — recorded once, reused on any re-run.
  let receipt = store.listSelections().find((r) => r.date === runDate) ?? null;
  let picksByTicker = new Map();
  if (!receipt) {
    const catalog = await getCatalog();
    if (!catalog || !Object.keys(catalog).length) {
      console.error(`[PitchLab] ${runDate}: universe catalog unavailable — no pitches today.`);
      await say(`⚠️ Pitch Lab ${runDate}: universe catalog unavailable — no pitches today.`);
      return { ...summary, status: "no_catalog" };
    }
    const drawn = selectPitchCandidates({ catalog, date: runDate, recentPitches: store.listPitches(), riskLimits, size, randomSlots });
    receipt = drawn.receipt;
    picksByTicker = new Map(drawn.picks.map((p) => [p.ticker, p]));
    if (!dryRun) store.appendSelection(receipt);
  } else {
    // Resuming: the receipt fixes WHICH names; sector/industry are re-read from the catalog below when available.
    const catalog = await getCatalog();
    for (const entry of receipt.picks) {
      const row = catalog?.[entry.ticker];
      picksByTicker.set(entry.ticker, { ...entry, sector: row?.s ?? null, industry: row?.i ?? null });
    }
  }
  summary.selected = receipt.picks.length;
  summary.shortfall = receipt.shortfall ?? 0;
  if (!receipt.picks.length) {
    console.error(`[PitchLab] ${runDate}: selection is empty (eligible ${receipt.eligibleCount}).`);
    await say(`⚠️ Pitch Lab ${runDate}: no eligible candidates (screened ${receipt.screenedCount}, in cooldown ${receipt.cooldownExcluded}).`);
    return { ...summary, status: "empty_selection" };
  }

  // 2. Pitch each pick, skipping any already pitched on this ET date.
  const doneToday = new Set(store.listPitches().filter((p) => etDateString(new Date(p.pitchedAt)) === runDate).map((p) => p.ticker));
  const system = buildPitchSystemPrompt();
  let attempts = 0;
  for (const [index, entry] of receipt.picks.entries()) {
    const pick = picksByTicker.get(entry.ticker) ?? entry;
    if (doneToday.has(pick.ticker)) {
      summary.skipped.push({ ticker: pick.ticker, reason: "already_pitched_today" });
      continue;
    }
    if (attempts >= maxPitches) {
      summary.skipped.push({ ticker: pick.ticker, reason: "max_pitches_reached" });
      continue;
    }
    if (summary.spendUsd >= maxUsd) {
      summary.skipped.push({ ticker: pick.ticker, reason: "run_spend_cap_reached" });
      continue;
    }
    attempts += 1;
    if (index > 0) await sleep(paceMs);
    try {
      const data = await gatherData({ ticker: pick.ticker, now });
      const { peers, request } = await getPeers({ ticker: data.ticker, features: data.features, asOf: data.asOf, industry: data.industry, sector: data.sector });
      if (request?.filed) summary.requests.filed += 1;
      else if (request?.reason) summary.requests.notFiled[request.reason] = (summary.requests.notFiled[request.reason] ?? 0) + 1;

      const prompt = buildPitchPrompt({ ticker: data.ticker, features: data.features, entryReference: data.entryReference, mandateExcerpt, peers });
      if (dryRun) {
        summary.pitched += 1;
        continue;
      }
      const reply = await callModel({ ticker: data.ticker, system, prompt });
      summary.spendUsd = Number((summary.spendUsd + (Number(reply?.costUsd) || 0)).toFixed(6));
      const pitch = pitchFromModelResponse(parsePitchReplyText(reply?.text), {
        ticker: data.ticker,
        pitchedAt: now().toISOString(),
        features: data.features,
        peers,
        entryReference: data.entryReference,
        source: "live",
        mandateVersion,
        model,
        context: { sector: pick.sector ?? data.sector ?? null, selection: pick.selection },
      });
      store.appendPitch(pitch); // validates again and refuses a duplicate id
      summary.pitched += 1;
    } catch (error) {
      if (isBudgetStop(error)) {
        console.error(`[PitchLab] ${runDate}: budget stop at ${pick.ticker} — ending the run: ${error.message}`);
        summary.failed.push({ ticker: pick.ticker, reason: "budget_stop" });
        summary.status = "budget_stop";
        for (const rest of receipt.picks.slice(index + 1)) summary.skipped.push({ ticker: rest.ticker, reason: "budget_stop" });
        break;
      }
      const reason =
        error instanceof PitchValidationError ? `invalid_pitch: ${error.problems.join("; ")}`
        : error instanceof PitchReplyError ? `malformed_reply: ${error.message}`
        : `error: ${String(error?.message ?? error).slice(0, 200)}`;
      console.error(`[PitchLab] ${runDate}: ${pick.ticker} pitch DROPPED — ${reason}`);
      summary.failed.push({ ticker: pick.ticker, reason });
    }
  }

  if (summary.status === "ok" && summary.failed.length) summary.status = "partial";
  console.log(`[PitchLab] ${runDate}: ${summary.pitched}/${summary.selected} pitched, ${summary.failed.length} dropped, ${summary.skipped.length} skipped, spend $${summary.spendUsd.toFixed(4)}, peer requests filed ${summary.requests.filed}${dryRun ? " (dry run)" : ""}`);
  if (summary.failed.length || summary.shortfall || summary.status === "budget_stop") {
    await say(`⚠️ Pitch Lab ${runDate}: ${summary.pitched}/${summary.selected} pitched; ${summary.failed.length} dropped (${summary.failed.slice(0, 5).map((f) => `${f.ticker}: ${f.reason.slice(0, 60)}`).join("; ")}); shortfall ${summary.shortfall}; status ${summary.status}.`);
  }
  return summary;
}
