#!/usr/bin/env node
/**
 * Pitch Lab command line. Paper only: reads market data, writes local files.
 * Nothing here creates a proposal, touches a broker, or writes production state.
 *
 *   npm run pitch-lab -- demo                 synthetic data → report (no network, no keys)
 *   npm run pitch-lab -- record <file.json>   validate + append pitch(es) from a JSON file
 *   npm run pitch-lab -- grade                fetch prices, grade every pitch that has matured
 *   npm run pitch-lab -- analyze              build report.json + report.html from stored data
 *
 * Options: --dir=<path> (default $PITCH_LAB_DIR or ./data/pitch-lab)
 *          --horizons=5,10,20  --benchmark=SPY  --cost=0.001
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { generateDemoData } from "../lib/pitch-lab/demo-data.js";
import { DEFAULT_BENCHMARK, DEFAULT_COST_PER_SIDE, DEFAULT_HORIZONS, gradePitch } from "../lib/pitch-lab/grading.js";
import { PitchValidationError } from "../lib/pitch-lab/pitch.js";
import { renderReportHtml } from "../lib/pitch-lab/render-html.js";
import { defaultPitchLabDir, openPitchStore } from "../lib/pitch-lab/store.js";

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--")).slice(1);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : fallback;
};

const dir = path.resolve(flag("dir", defaultPitchLabDir()));
const horizons = flag("horizons", null)?.split(",").map(Number) ?? [...DEFAULT_HORIZONS];
const benchmark = flag("benchmark", DEFAULT_BENCHMARK).toUpperCase();
const costPerSide = Number(flag("cost", String(DEFAULT_COST_PER_SIDE)));

if (!horizons.every((h) => Number.isInteger(h) && h > 0)) fail("--horizons must be positive integers, e.g. 5,10,20");
if (!(Number.isFinite(costPerSide) && costPerSide >= 0 && costPerSide < 1)) fail("--cost must be a decimal fraction, e.g. 0.001");

function fail(message) {
  console.error(`[pitch-lab] ${message}`);
  process.exit(1);
}

function writeReport(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "report.json");
  const htmlPath = path.join(outDir, "report.html");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(htmlPath, renderReportHtml(report));
  return { jsonPath, htmlPath };
}

function printSummary(report) {
  const all = report.periods.find((p) => p.id === "all");
  console.log(`\nPitch Lab — ${report.totals.pitches} pitches${report.isSyntheticDemo ? " (SYNTHETIC DEMO DATA)" : ""}`);
  for (const h of all?.horizons ?? []) {
    const c = h.conviction;
    console.log(`\n  ${h.horizonDays}-day: ${h.graded} graded, avg vs ${report.assumptions.benchmark.join("/")} ${(100 * (h.meanExcessReturn ?? 0)).toFixed(2)}%`);
    console.log(`    conviction: rho=${c.spearman.rho ?? "—"} ${c.spearman.ci95 ? `[${c.spearman.ci95.join(", ")}]` : ""}, per point=${c.excessReturnPerPoint.estimate ?? "—"}, p=${c.excessReturnPerPoint.pValue ?? "—"} → ${c.verdict.label}`);
    for (const m of h.metrics.filter((m) => m.verdict.label === "positive" || m.verdict.label === "negative")) {
      console.log(`    ${m.id}: rho=${m.spearman.rho}, per SD=${m.excessReturnPerSd.estimate}, q=${m.excessReturnPerSd.qValue} → ${m.verdict.label}`);
    }
  }
}

async function grade(store) {
  const { fetchDailyBars } = await import("../lib/yahoo.js");
  const pitches = store.listPitches();
  const done = new Set(store.listOutcomes().map((o) => `${o.pitchId}:${o.horizonDays}`));
  const pending = pitches.filter((p) => horizons.some((h) => !done.has(`${p.id}:${h}`)));
  if (!pending.length) return console.log("[pitch-lab] nothing to grade");

  const earliest = new Date(Math.min(...pending.map((p) => Date.parse(p.pitchedAt))) - 7 * 86_400_000);
  const benchmarkBars = await fetchDailyBars(benchmark, { period1: earliest });
  if (!benchmarkBars.length) fail(`no ${benchmark} bars returned — cannot grade anything (check network / ticker)`);

  const barsByTicker = new Map();
  let stored = 0;
  let failedTickers = 0;
  for (const pitch of pending) {
    if (!barsByTicker.has(pitch.ticker)) {
      const bars = await fetchDailyBars(pitch.ticker, { period1: earliest });
      if (!bars.length) {
        console.error(`[pitch-lab] no price data for ${pitch.ticker}; its pitches stay ungraded`);
        failedTickers += 1;
      }
      barsByTicker.set(pitch.ticker, bars);
    }
    const rows = gradePitch({ pitch, bars: barsByTicker.get(pitch.ticker), benchmarkBars, horizons, benchmark, costPerSide });
    for (const row of rows) {
      if (row.status !== "matured" || done.has(`${row.pitchId}:${row.horizonDays}`)) continue;
      store.appendOutcome(row);
      done.add(`${row.pitchId}:${row.horizonDays}`);
      stored += 1;
    }
  }
  console.log(`[pitch-lab] graded ${stored} new outcome(s) across ${pending.length} pitch(es)${failedTickers ? `; ${failedTickers} ticker(s) had no data` : ""}`);
}

switch (command) {
  case "demo": {
    const outDir = path.resolve(flag("out", path.join(dir, "demo")));
    const { pitches, outcomes } = generateDemoData({ horizons });
    const report = analyzePitchLab({ pitches, outcomes, horizons });
    const paths = writeReport(report, outDir);
    printSummary(report);
    console.log(`\nWrote ${paths.jsonPath}\n      ${paths.htmlPath}`);
    break;
  }
  case "record": {
    if (!positional[0]) fail("usage: pitch-lab record <file.json>   (one pitch object or an array)");
    const store = openPitchStore(dir);
    const parsed = JSON.parse(readFileSync(positional[0], "utf8"));
    const inputs = Array.isArray(parsed) ? parsed : [parsed];
    let ok = 0;
    for (const [i, input] of inputs.entries()) {
      try {
        const pitch = store.appendPitch(input);
        ok += 1;
        console.log(`[pitch-lab] recorded ${pitch.id} ${pitch.ticker} conviction ${pitch.conviction}`);
      } catch (error) {
        const detail = error instanceof PitchValidationError ? error.problems.map((p) => `\n    - ${p}`).join("") : ` ${error.message}`;
        console.error(`[pitch-lab] pitch #${i + 1} rejected:${detail}`);
      }
    }
    if (ok < inputs.length) process.exitCode = 1;
    break;
  }
  case "grade": {
    await grade(openPitchStore(dir));
    break;
  }
  case "analyze": {
    const store = openPitchStore(dir);
    const report = analyzePitchLab({ pitches: store.listPitches(), outcomes: store.listOutcomes(), horizons });
    const paths = writeReport(report, path.resolve(flag("out", dir)));
    printSummary(report);
    console.log(`\nWrote ${paths.jsonPath}\n      ${paths.htmlPath}`);
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 13).map((l) => l.replace(/^ \*\s?/, "")).join("\n"));
    if (command) process.exitCode = 1;
}
