import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { selectPitchCandidates, seedForDate } from "../lib/pitch-lab/selection.js";
import { openPitchStore } from "../lib/pitch-lab/store.js";
import { runDailyPitches } from "../lib/pitch-lab/daily-runner.js";
import { gradeMaturedPitches } from "../lib/pitch-lab/grade-runner.js";
import { buildFeatures, marketFeaturesFromBars } from "../lib/pitch-lab/features.js";
import { computePeerRanks } from "../lib/pitch-lab/peer-rank.js";
import { PitchReplyError, buildPitchPrompt, buildPitchSystemPrompt, parsePitchReplyText } from "../lib/pitch-lab/pitch-prompt.js";
import { buildPitch } from "../lib/pitch-lab/pitch.js";
import { PITCH_LAB_REPORT_KEY, publishPitchLabReport } from "../lib/pitch-lab-peer-bridge.js";
import { createModelCaller, loadMandateExcerpt, pitchLabEnabled, runPitchLabDaily } from "../jobs/pitch-lab-daily.js";

const DATE = "2026-10-02";
const NOW = () => new Date("2026-10-02T22:40:00Z"); // 18:40 ET, after the close
const RISK_LIMITS = { microCapMinAvgDollarVolume: 3_000_000, minAvgDollarVolume: 10_000_000 };

/** A catalog: `good` liquid, priced names with distinct 52-week changes, plus names the screen or quote filter must drop. */
function catalogOf(good = 40) {
  const catalog = {};
  for (let i = 1; i <= good; i += 1) {
    const t = `G${String(i).padStart(2, "0")}`.replace(/\d/g, (d) => "ABCDEFGHIJ"[d]);
    catalog[t] = { t, n: `Good ${i}`, x: "NASDAQ", s: "Technology", i: "Software - Application", mc: 2_000_000_000, advd: 50_000_000, p: 20 + i, c52: i * 0.01, qa: "2026-10-01", ea: "2026-09-30" };
  }
  catalog.THIN = { t: "THIN", n: "Illiquid", x: "NASDAQ", s: "Technology", i: "Software", mc: 2_000_000_000, advd: 100_000, p: 10, c52: 9, qa: "2026-10-01" };
  catalog.NOPX = { t: "NOPX", n: "No price", x: "NASDAQ", s: "Technology", i: "Software", mc: 2_000_000_000, advd: 50_000_000, c52: 9, qa: "2026-10-01" };
  catalog.NOMC = { t: "NOMC", n: "No cap", x: "NASDAQ", s: "Technology", i: "Software", advd: 50_000_000, p: 10, c52: 9, qa: "2026-10-01" };
  return catalog;
}

const withDir = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pitch-lab-daily-"));
  try {
    return await fn(openPitchStore(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const quiet = async (fn) => {
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const logged = { log: [], error: [], warn: [] };
  for (const k of Object.keys(originals)) console[k] = (...args) => logged[k].push(args.join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    Object.assign(console, originals);
  }
};

// --- selection -----------------------------------------------------------

test("selection draws 10 ranked + 5 random from the screened pool, and never ineligible names", () => {
  const { picks, receipt } = selectPitchCandidates({ catalog: catalogOf(), date: DATE, riskLimits: RISK_LIMITS });
  assert.equal(picks.length, 15);
  assert.equal(new Set(picks.map((p) => p.ticker)).size, 15);
  assert.equal(picks.filter((p) => p.selection === "screen").length, 10);
  assert.equal(picks.filter((p) => p.selection === "random").length, 5);
  for (const bad of ["THIN", "NOPX", "NOMC"]) assert.ok(!picks.some((p) => p.ticker === bad), `${bad} must be excluded`);
  // The screen slice is the top of Agent One's own attention ranking (highest 52-week change here).
  const ranked = picks.filter((p) => p.selection === "screen").map((p) => p.rank);
  assert.deepEqual(ranked, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(receipt.shortfall, 0);
  assert.equal(receipt.eligibleCount, 40);
  assert.equal(receipt.screenedCount, 40);
  assert.equal(receipt.quotedCount, 42); // 40 good + THIN + NOMC; NOPX has no price
  assert.equal(receipt.seed, seedForDate(DATE));
  assert.match(receipt.screenPolicyVersion, /agent-1/);
  assert.deepEqual(receipt.picks.map((p) => p.ticker), picks.map((p) => p.ticker));
});

test("random picks come from the rest of the pool, are reproducible per date, and change with the date", () => {
  const catalog = catalogOf();
  const a = selectPitchCandidates({ catalog, date: DATE, riskLimits: RISK_LIMITS });
  const b = selectPitchCandidates({ catalog, date: DATE, riskLimits: RISK_LIMITS });
  assert.deepEqual(a.picks, b.picks);
  const topTen = new Set(a.picks.filter((p) => p.selection === "screen").map((p) => p.ticker));
  for (const p of a.picks.filter((x) => x.selection === "random")) assert.ok(!topTen.has(p.ticker));
  const other = selectPitchCandidates({ catalog, date: "2026-10-05", riskLimits: RISK_LIMITS });
  const randoms = (r) => r.picks.filter((p) => p.selection === "random").map((p) => p.ticker).join();
  assert.notEqual(randoms(a), randoms(other));
});

test("a name pitched inside the cooldown is skipped, an older pitch is not", () => {
  const catalog = catalogOf();
  const first = selectPitchCandidates({ catalog, date: DATE, riskLimits: RISK_LIMITS }).picks[0].ticker;
  const recent = selectPitchCandidates({ catalog, date: DATE, riskLimits: RISK_LIMITS, recentPitches: [{ ticker: first, pitchedAt: "2026-09-25T20:00:00Z" }] });
  assert.ok(!recent.picks.some((p) => p.ticker === first));
  assert.equal(recent.receipt.cooldownExcluded, 1);
  const old = selectPitchCandidates({ catalog, date: DATE, riskLimits: RISK_LIMITS, recentPitches: [{ ticker: first, pitchedAt: "2026-09-10T20:00:00Z" }] });
  assert.ok(old.picks.some((p) => p.ticker === first));
});

test("a short pool gives a short day, recorded as a shortfall — never padded with ineligible names", () => {
  const { picks, receipt } = selectPitchCandidates({ catalog: catalogOf(8), date: DATE, riskLimits: RISK_LIMITS });
  assert.equal(picks.length, 8);
  assert.ok(picks.every((p) => p.selection === "screen"));
  assert.equal(receipt.shortfall, 7);
  const mid = selectPitchCandidates({ catalog: catalogOf(12), date: DATE, riskLimits: RISK_LIMITS });
  assert.equal(mid.picks.length, 12);
  assert.equal(mid.picks.filter((p) => p.selection === "random").length, 2);
  assert.equal(selectPitchCandidates({ catalog: {}, date: DATE }).picks.length, 0);
  assert.throws(() => selectPitchCandidates({ catalog: catalogOf(), date: "10/02/2026" }), /YYYY-MM-DD/);
  assert.throws(() => selectPitchCandidates({ catalog: catalogOf(), date: DATE, size: 5, randomSlots: 9 }), /randomSlots/);
});

test("a day can only be drawn once", async () => {
  await withDir((store) => {
    const { receipt } = selectPitchCandidates({ catalog: catalogOf(), date: DATE, riskLimits: RISK_LIMITS });
    store.appendSelection(receipt);
    assert.throws(() => store.appendSelection(receipt), /already recorded/);
    assert.throws(() => store.appendSelection({ date: "bad", picks: [] }), /YYYY-MM-DD/);
    assert.equal(openPitchStore(store.dir).listSelections().length, 1);
  });
});

// --- features / prompt ---------------------------------------------------

test("distance below the 20-day high is measured in ATRs", () => {
  const flat = Array.from({ length: 30 }, () => ({ close: 100, high: 102, low: 98, volume: 1 })); // ATR 4, 20-day high 102
  assert.equal(marketFeaturesFromBars(flat).atrBelow20dHigh, 0.5);
  assert.equal(marketFeaturesFromBars(flat.slice(0, 10)).atrBelow20dHigh, null);
  assert.equal(marketFeaturesFromBars(flat.map(({ high, ...rest }) => rest)).atrBelow20dHigh, null);
  assert.equal(buildFeatures({ bars: flat.slice(0, 5), asOf: "2026-10-02T22:00:00Z" }).atrBelow20dHigh.missingReason, "insufficient_price_history");
});

test("the model reply parser accepts one JSON object and rejects everything else", () => {
  assert.deepEqual(parsePitchReplyText('{"a":1}'), { a: 1 });
  assert.deepEqual(parsePitchReplyText('```json\n{"a":1}\n```'), { a: 1 });
  for (const bad of ["", "   ", "Sure! {\"a\":1}", "[1]", "null", "{not json}", '{"a":1} trailing']) {
    assert.throws(() => parsePitchReplyText(bad), PitchReplyError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.match(buildPitchSystemPrompt(), /ONLY a single JSON object/);
  assert.match(buildPitchSystemPrompt(), /"conviction"/);
});

// --- daily runner --------------------------------------------------------

const BARS = Array.from({ length: 260 }, (_, i) => ({ date: new Date(Date.parse("2026-10-02T13:30:00Z") - (259 - i) * 86_400_000), open: 100, close: 100 + i * 0.05, high: 101 + i * 0.05, low: 99 + i * 0.05, volume: 1000 }));
const PEERS = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`P${i + 1}`, { industry: "Software - Application", sector: "Technology", metrics: { revGrowth: (i + 1) * 0.05, peerValuation: (i + 1) * 10 }, retrievedAt: "2026-10-02T01:00:00Z" }]));

const goodReply = (overrides = {}) => JSON.stringify({
  conviction: 3,
  intended_holding_days: 10,
  thesis: "Accelerating revenue with a price pullback toward the recent high gives a short-term setup.",
  reasons: [{ claim: "Revenue growth ranks well versus peers.", features: ["revGrowth"] }],
  risks: ["Guidance could disappoint."],
  kill_criteria: ["Growth decelerates next quarter."],
  ...overrides,
});

function deps(store, overrides = {}) {
  const calls = { gather: [], model: [], notify: [] };
  return {
    calls,
    args: {
      date: DATE,
      now: NOW,
      store,
      getCatalog: async () => catalogOf(),
      riskLimits: RISK_LIMITS,
      gatherData: async ({ ticker }) => {
        calls.gather.push(ticker);
        const asOf = NOW().toISOString();
        const features = buildFeatures({ fundamentals: { industry: "Software - Application", raw: { financialData: { revenueGrowth: 0.42 }, summaryDetail: { forwardPE: 25 } } }, bars: BARS, marketCap: 2e9, asOf });
        return { ticker, asOf, features, entryReference: { price: 112, asOf: "2026-10-02T13:30:00.000Z" }, industry: "Software - Application", sector: "Technology" };
      },
      getPeers: async ({ ticker, features, asOf, industry, sector }) => ({
        peers: computePeerRanks({ ticker, features, peerMetrics: PEERS, asOf, industry, sector }),
        request: { filed: false, reason: null },
      }),
      callModel: async ({ ticker }) => {
        calls.model.push(ticker);
        return { text: goodReply(), costUsd: 0.01 };
      },
      notify: async (text) => { calls.notify.push(text); },
      mandateExcerpt: "Agent One identity.",
      mandateVersion: "agent_one_v3.0",
      model: "test-model",
      ...overrides,
    },
  };
}

test("a daily run records the draw, then one valid pitch per pick with peers, provenance and selection context", async () => {
  await withDir(async (store) => {
    const { args, calls } = deps(store);
    const { result: summary } = await quiet(() => runDailyPitches(args));
    assert.equal(summary.status, "ok");
    assert.equal(summary.selected, 15);
    assert.equal(summary.pitched, 15);
    assert.equal(summary.spendUsd, 0.15);
    assert.equal(calls.model.length, 15);
    assert.equal(calls.notify.length, 0);
    assert.equal(store.listSelections().length, 1);
    const pitches = store.listPitches();
    assert.equal(pitches.length, 15);
    const p = pitches[0];
    assert.equal(p.agentId, "agent-1");
    assert.equal(p.provenance.source, "live");
    assert.equal(p.provenance.mandateVersion, "agent_one_v3.0");
    assert.equal(p.provenance.model, "test-model");
    assert.equal(p.provenance.promptVersion, "pitch-lab.prompt.v3");
    assert.equal(p.context.sector, "Technology");
    assert.ok(["screen", "random"].includes(p.context.selection));
    assert.equal(p.peers.ranks.revGrowth.status, "ranked");
    assert.equal(p.features.revBeat.missingReason, "not_supplied_to_pitch_lab");
    assert.equal(pitches.filter((x) => x.context.selection === "random").length, 5);
    assert.ok(Date.parse(p.pitchedAt) >= Date.parse(p.entryReference.asOf));
  });
});

test("re-running the same day never re-draws and never double-pitches", async () => {
  await withDir(async (store) => {
    const first = deps(store);
    await quiet(() => runDailyPitches(first.args));
    const second = deps(store);
    const { result } = await quiet(() => runDailyPitches(second.args));
    assert.equal(result.pitched, 0);
    assert.equal(result.skipped.length, 15);
    assert.ok(result.skipped.every((s) => s.reason === "already_pitched_today"));
    assert.equal(second.calls.model.length, 0);
    assert.equal(store.listSelections().length, 1);
    assert.equal(store.listPitches().length, 15);
  });
});

test("a budget stop ends the run loudly, and the next run resumes the SAME picks", async () => {
  await withDir(async (store) => {
    let n = 0;
    const stopping = deps(store, {
      callModel: async () => {
        n += 1;
        if (n > 3) throw Object.assign(new Error("monthly budget exhausted"), { code: "monthly_budget_exhausted" });
        return { text: goodReply(), costUsd: 0.01 };
      },
    });
    const { result, logged } = await quiet(() => runDailyPitches(stopping.args));
    assert.equal(result.status, "budget_stop");
    assert.equal(result.pitched, 3);
    assert.equal(result.skipped.filter((s) => s.reason === "budget_stop").length, 11);
    assert.ok(logged.error.some((line) => line.includes("budget stop")));
    assert.equal(stopping.calls.notify.length, 1);
    const drawn = store.listSelections()[0].picks.map((p) => p.ticker);

    const resumed = deps(store);
    const { result: second } = await quiet(() => runDailyPitches(resumed.args));
    assert.equal(second.pitched, 12);
    assert.equal(store.listSelections().length, 1);
    assert.deepEqual(store.listSelections()[0].picks.map((p) => p.ticker), drawn);
    assert.equal(store.listPitches().length, 15);
  });
});

test("one bad reply drops that pitch loudly and the rest still land", async () => {
  await withDir(async (store) => {
    let n = 0;
    const { args, calls } = deps(store, {
      callModel: async () => {
        n += 1;
        if (n === 1) return { text: "Here is my pitch: BUY!", costUsd: 0.01 }; // not JSON
        if (n === 2) return { text: goodReply({ conviction: 9 }), costUsd: 0.01 }; // out of range
        if (n === 3) throw new Error("reply hit max_tokens — discarded (fail closed)");
        return { text: goodReply(), costUsd: 0.01 };
      },
    });
    const { result, logged } = await quiet(() => runDailyPitches(args));
    assert.equal(result.status, "partial");
    assert.equal(result.pitched, 12);
    assert.deepEqual(result.failed.map((f) => f.reason.split(":")[0]), ["malformed_reply", "invalid_pitch", "error"]);
    assert.equal(logged.error.filter((line) => line.includes("DROPPED")).length, 3);
    assert.equal(calls.notify.length, 1);
    assert.match(calls.notify[0], /12\/15 pitched; 3 dropped/);
    assert.equal(store.listPitches().length, 12);
  });
});

test("the per-run spend cap and pitch cap stop further pitches", async () => {
  await withDir(async (store) => {
    const capped = deps(store, { callModel: async () => ({ text: goodReply(), costUsd: 0.4 }), maxUsd: 1 });
    const { result } = await quiet(() => runDailyPitches(capped.args));
    assert.equal(result.pitched, 3); // 0.4, 0.8, 1.2 → cap reached
    assert.equal(result.skipped.filter((s) => s.reason === "run_spend_cap_reached").length, 12);
  });
  await withDir(async (store) => {
    const limited = deps(store, { maxPitches: 4 });
    const { result } = await quiet(() => runDailyPitches(limited.args));
    assert.equal(result.pitched, 4);
    assert.equal(result.skipped.filter((s) => s.reason === "max_pitches_reached").length, 11);
  });
});

test("an unavailable catalog is a loud no-op that records no draw", async () => {
  await withDir(async (store) => {
    const { args, calls } = deps(store, { getCatalog: async () => null });
    const { result, logged } = await quiet(() => runDailyPitches(args));
    assert.equal(result.status, "no_catalog");
    assert.equal(store.listSelections().length, 0);
    assert.equal(calls.model.length, 0);
    assert.equal(calls.notify.length, 1);
    assert.ok(logged.error.some((line) => line.includes("catalog unavailable")));
  });
});

test("a dry run builds every prompt but calls no model and records nothing", async () => {
  await withDir(async (store) => {
    const { args, calls } = deps(store, { dryRun: true });
    const { result } = await quiet(() => runDailyPitches(args));
    assert.equal(result.dryRun, true);
    assert.equal(result.pitched, 15);
    assert.equal(calls.model.length, 0);
    assert.equal(store.listPitches().length, 0);
    assert.equal(store.listSelections().length, 0);
  });
});

test("a failing notifier never breaks the run, and peer-request outcomes are tallied", async () => {
  await withDir(async (store) => {
    let n = 0;
    const { args } = deps(store, {
      notify: async () => { throw new Error("telegram down"); },
      callModel: async () => {
        n += 1;
        return n === 1 ? { text: "nope", costUsd: 0 } : { text: goodReply(), costUsd: 0.01 };
      },
      getPeers: async ({ ticker, features, asOf, industry, sector }) => ({
        peers: computePeerRanks({ ticker, features, peerMetrics: PEERS, asOf, industry, sector }),
        request: ticker < "GC" ? { filed: true, reason: null } : { filed: false, reason: "requests_disabled" },
      }),
    });
    const { result, logged } = await quiet(() => runDailyPitches(args));
    assert.equal(result.pitched, 14);
    assert.ok(result.requests.filed > 0);
    assert.ok(result.requests.notFiled.requests_disabled > 0);
    assert.ok(logged.error.some((line) => line.includes("telegram down")));
  });
});

// --- grade runner --------------------------------------------------------

test("the grade runner stores matured outcomes once, lists tickers with no data, and refuses to run with no benchmark", async () => {
  await withDir(async (store) => {
    const features = buildFeatures({ bars: [], asOf: "2026-09-21T13:00:00Z" });
    const input = (ticker) => ({
      ticker, pitchedAt: "2026-09-21T14:00:00Z", conviction: 3, intendedHoldingDays: 5,
      entryReference: { price: 100, asOf: "2026-09-21T13:00:00Z" }, features,
      rationale: { thesis: "A thesis that is comfortably longer than forty characters.", reasons: [{ claim: "c", features: [] }], risks: ["r"], killCriteria: [] },
      provenance: { source: "manual" },
    });
    store.appendPitch(input("AAA"));
    store.appendPitch(input("ZZZ"));
    const dates = ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"];
    const bars = { SPY: dates.map((date, i) => ({ date, close: 400 + i })), AAA: dates.map((date, i) => ({ date, close: 100 + i * 2 })), ZZZ: [] };
    const fetchBars = async (symbol) => bars[symbol];
    const log = { log: () => {}, error: () => {} };
    const first = await gradeMaturedPitches({ store, fetchBars, horizons: [2, 5], now: () => new Date("2026-09-29T00:00:00Z"), log });
    assert.equal(first.stored, 2);
    assert.deepEqual(first.failedTickers, ["ZZZ"]);
    const again = await gradeMaturedPitches({ store, fetchBars, horizons: [2, 5], now: () => new Date("2026-09-29T00:00:00Z"), log });
    assert.equal(again.stored, 0);
    assert.equal(store.listOutcomes().length, 2);
    await assert.rejects(() => gradeMaturedPitches({ store, fetchBars: async () => [], horizons: [2, 5], log }), /no SPY bars/);
    const empty = await withDir((fresh) => gradeMaturedPitches({ store: fresh, fetchBars, log }));
    assert.deepEqual(empty, { pending: 0, stored: 0, failedTickers: [] });
  });
});

// --- job wiring ----------------------------------------------------------

test("the job is off unless PITCH_LAB_ENABLED=1, and skips market holidays", async () => {
  assert.equal(pitchLabEnabled({}), false);
  assert.equal(pitchLabEnabled({ PITCH_LAB_ENABLED: " 1 " }), true);
  assert.deepEqual(await runPitchLabDaily({ env: {} }), { status: "disabled" });
  const { result } = await quiet(() => runPitchLabDaily({ env: { PITCH_LAB_ENABLED: "1" }, now: () => new Date("2026-12-25T23:40:00Z") }));
  assert.deepEqual(result, { status: "holiday" });
});

test("the job wires the real mandate excerpt, version and model into a run", async () => {
  await withDir(async (store, dir) => {
    const { args, calls } = deps(store);
    const { result } = await quiet(() => runPitchLabDaily({
      env: { PITCH_LAB_ENABLED: "1", PITCH_LAB_DIR: dir, PITCH_LAB_MAX_PITCHES: "2", PITCH_LAB_MODEL: "claude-sonnet-4-6" },
      now: NOW,
      store,
      monthlyBudget: {},
      getCatalog: args.getCatalog,
      gatherData: args.gatherData,
      getPeers: args.getPeers,
      callModel: args.callModel,
      notify: args.notify,
      sleep: async () => {},
    }));
    assert.equal(result.pitched, 2);
    assert.equal(calls.model.length, 2);
    const pitch = store.listPitches()[0];
    assert.equal(pitch.provenance.mandateVersion, "agent_one_v3.0");
    assert.equal(pitch.provenance.model, "claude-sonnet-4-6");
  });
  assert.match(loadMandateExcerpt(), /^## 1\. IDENTITY[\s\S]*Agent One/);
  assert.throws(() => loadMandateExcerpt(tmpdir()), /ENOENT/);
});

test("the model caller authorises, calls, records usage and settles, and fails closed on a truncated reply", async () => {
  const order = [];
  const budget = {
    authorizeCall: async (call) => { order.push(`authorize:${call.role}`); return { id: "a1", configured: true, pricingVersion: null, authorizedAt: NOW().toISOString() }; },
    settleCall: async () => { order.push("settle"); },
    settleProviderFailure: async () => { order.push("settleFailure"); },
  };
  const reply = (stop_reason) => ({ stop_reason, usage: { input_tokens: 1000, output_tokens: 500 }, content: [{ type: "text", text: "{}" }] });
  const ok = createModelCaller({ client: { messages: { create: async () => { order.push("create"); return reply("end_turn"); } } }, monthlyBudget: budget, model: "claude-sonnet-4-6" });
  const { result } = await quiet(() => ok({ ticker: "AAA", system: "s", prompt: "p" }));
  assert.equal(result.text, "{}");
  assert.ok(result.costUsd > 0);
  assert.deepEqual(order.slice(0, 2), ["authorize:pitch_lab", "create"]);
  assert.equal(order.at(-1), "settle");

  const truncated = createModelCaller({ client: { messages: { create: async () => reply("max_tokens") } }, monthlyBudget: budget, model: "claude-sonnet-4-6" });
  await quiet(() => assert.rejects(() => truncated({ ticker: "AAA", system: "s", prompt: "p" }), /max_tokens/));

  order.length = 0;
  const failing = createModelCaller({ client: { messages: { create: async () => { throw new Error("overloaded"); } } }, monthlyBudget: budget, model: "claude-sonnet-4-6" });
  await assert.rejects(() => failing({ ticker: "AAA", system: "s", prompt: "p" }), /overloaded/);
  assert.deepEqual(order, ["authorize:pitch_lab", "settleFailure"]);
});

// --- report publish + isolation -----------------------------------------

test("the report is published to one fixed namespaced key and nothing else", async () => {
  const writes = [];
  const redis = { set: async (key, value) => { writes.push([key, value]); } };
  const report = { schemaVersion: "pitch-lab.report.v2", totals: { pitches: 0 } };
  assert.equal(await publishPitchLabReport(report, { redis, now: NOW }), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], PITCH_LAB_REPORT_KEY);
  assert.ok(!PITCH_LAB_REPORT_KEY.startsWith("pm:"));
  assert.equal(JSON.parse(writes[0][1]).report.schemaVersion, "pitch-lab.report.v2");
  await assert.rejects(() => publishPitchLabReport({}, { redis }), /schemaVersion/);
  await assert.rejects(() => publishPitchLabReport(null, { redis }), /schemaVersion/);
});

test("the scheduler process and job reach only what Pitch Lab is allowed to", () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const forbidden = /createProposal|robinhood|fill-processing|proposal-signature|research-scan|sheets\.js|lib\/pg\//;
  for (const file of ["jobs/pitch-lab-daily.js", "pitch-lab-scheduler.js", "lib/pitch-lab-peer-bridge.js"]) {
    assert.ok(!forbidden.test(read(file).replace(/\/\*[\s\S]*?\*\//g, "")), `${file} reaches a production write path`);
  }
  // The job's only redis import is the read-only universe catalog; the scheduler never touches redis at all.
  assert.deepEqual([...read("jobs/pitch-lab-daily.js").matchAll(/import \{([^}]*)\} from "\.\.\/lib\/redis\.js"/g)].map((m) => m[1].trim()), ["getUniverseCatalog"]);
  assert.ok(!/redis/.test(read("pitch-lab-scheduler.js").replace(/\/\*[\s\S]*?\*\//g, "")));
  // Not registered in the production scheduler.
  assert.ok(!/pitch-lab/i.test(read("scheduler.js")), "scheduler.js must not register Pitch Lab jobs");
  // Buy-only paper record: nothing here builds a SELL.
  assert.throws(() => buildPitch({ action: "SELL" }), /action/);
});
