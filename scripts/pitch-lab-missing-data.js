#!/usr/bin/env node
/**
 * Read-only diagnostic: why recent Pitch Lab pitches said "no data" for revenue growth,
 * gross-margin trend and revenue beat, and which of the SEC-data fixes fills each gap.
 *
 *   node scripts/pitch-lab-missing-data.js [--days=14] [--max-tickers=80]
 *
 * Reads pitches from Postgres and re-reads public SEC filings (paced, like the nightly jobs).
 * Writes nothing, sends nothing, changes no score. See lib/pitch-lab/missing-data.js.
 */
import "dotenv/config";
import { openPostgresPitchStore } from "../lib/pg/pitch-lab-store.js";
import { fetchCompanyFacts } from "../lib/edgar.js";
import { DIAGNOSED_METRICS, diagnoseMissingData, tickersToRecheck } from "../lib/pitch-lab/missing-data.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => Number(args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)) || fallback;
const days = flag("days", 14);
const maxTickers = flag("max-tickers", 80);

const since = Date.now() - days * 86_400_000;
const pitches = (await openPostgresPitchStore().listPitches()).filter((p) => Date.parse(p.pitchedAt) >= since);
const tickers = tickersToRecheck(pitches).slice(0, maxTickers);
console.error(`[missing-data] ${pitches.length} pitches in the last ${days} days; re-reading SEC filings for ${tickers.length} tickers (about ${Math.ceil(tickers.length * 0.3)}s)…`);
const facts = new Map();
for (const ticker of tickers) facts.set(ticker, await fetchCompanyFacts(ticker));

const report = diagnoseMissingData(pitches, facts);
const labels = { revGrowth: "Revenue growth", marginTrend: "Gross-margin trend", revBeat: "Revenue beat" };
for (const id of DIAGNOSED_METRICS) {
  const m = report.metrics[id];
  console.log(`\n${labels[id]}: no data on ${m.missing} of ${report.pitches} scored pitches`);
  console.log("  at pitch time:");
  for (const [reason, { count, tickers: t }] of Object.entries(m.before).sort((a, b) => b[1].count - a[1].count)) console.log(`    ${reason.padEnd(28)} ${String(count).padStart(3)}  ${t.slice(0, 8).join(", ")}`);
  console.log("  with today's code:");
  for (const [reason, { count, tickers: t }] of Object.entries(m.now).sort((a, b) => b[1].count - a[1].count)) console.log(`    ${reason.padEnd(40)} ${String(count).padStart(3)}  ${t.slice(0, 8).join(", ")}`);
}
console.log(`\n${JSON.stringify({ days, ...report }, null, 2)}`);
process.exit(0);
