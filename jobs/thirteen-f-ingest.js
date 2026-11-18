/**
 * 13F ingestion — DRY RUN ONLY in this release.
 *
 *   node jobs/thirteen-f-ingest.js dry-run [--file=<data-set zip name>] [--top=300] [--keep]
 *
 * Checks the real SEC data against everything the 13F code assumes, end to end, and prints a
 * report. It writes NOTHING to the database or Redis, changes no score, sends no message, and
 * deletes its temporary download when it finishes (unless --keep). Not scheduled.
 *
 *   1. Lists the 13F data-set files on the SEC page and how they are named.
 *   2. Downloads the newest (or --file) to a temporary folder and checks the real headers of
 *      SUBMISSION, COVERPAGE and INFOTABLE against the parser (fails closed, naming columns).
 *   3. Streams INFOTABLE once: report periods present, amendment handling, rows kept/skipped.
 *   4. Maps CUSIPs to tickers: the most-held CUSIPs plus the sample tickers' CUSIPs, through
 *      OpenFIGI (OPENFIGI_API_KEY if set; slower without) cross-checked with the newest SEC
 *      fails-to-deliver files.
 *   5. For ~10 well-known tickers prints institutional shares, positions, managers and the
 *      implied ownership % of shares outstanding (EDGAR), to compare with public figures.
 *   6. Prints what it cost: download size, rows, run time, peak memory.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { CONCEPTS, instantSeries } from "../lib/edgar-facts.js";
import { mergeFtdMaps, parseFailsToDeliver, reconcileCusipMap, resolveTickersForCusips } from "../lib/cusip-map.js";
import { REQUIRED_COLUMNS, aggregateInfotable, headerIndex, includedAccessions, listDataSetFiles, parseSmallTsv } from "../lib/thirteen-f-stream.js";
import { findZipEntry, listZipEntries, readZipEntryText, zipEntryLines } from "../lib/zip-stream.js";

export const THIRTEEN_F_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";
export const FTD_PAGE = "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data";
export const DEFAULT_SAMPLE_TICKERS = Object.freeze(["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "JPM", "XOM", "JNJ", "LUV", "BB"]);

/** fails-to-deliver zip names from the SEC page, newest first ("cnsfails202410b.zip"). */
export function listFtdFiles(html, baseUrl = "https://www.sec.gov") {
  const seen = new Map();
  for (const match of String(html ?? "").matchAll(/href="([^"]*?(cnsfails(\d{6})([ab])\.zip))"/gi)) {
    const [, href, name, yyyymm, half] = match;
    if (seen.has(name.toLowerCase())) continue;
    seen.set(name.toLowerCase(), { name, url: href.startsWith("http") ? href : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`, sortKey: `${yyyymm}${half.toLowerCase()}` });
  }
  return [...seen.values()].sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

async function download(url, file, { fetchImpl, userAgent }) {
  const response = await fetchImpl(url, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
  if (response.body && typeof response.body.getReader === "function") {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    await pipeline(Readable.from([bytes]), createWriteStream(file));
  }
  return (await stat(file)).size;
}

async function fetchText(url, { fetchImpl, userAgent }) {
  const response = await fetchImpl(url, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
  return response.text();
}

/** Period-end share count for one 13F period, never borrowed from another date (±10 days). */
function sharesOutstandingNear(series, periodEnd, toleranceDays = 10) {
  const target = Date.parse(periodEnd);
  let best = null;
  for (const fact of series) {
    const gap = Math.abs(Date.parse(fact.end) - target);
    if (!Number.isFinite(gap) || gap > toleranceDays * 86_400_000) continue;
    if (!best || gap < Math.abs(Date.parse(best.end) - target)) best = fact;
  }
  return best;
}

/**
 * @returns {Promise<object>} the dry-run report (also printed by the CLI)
 */
export async function runThirteenFDryRun({
  env = process.env,
  fetchImpl = fetch,
  getCompanyFacts,
  userAgent,
  file = null,
  top = 300,
  sampleTickers = DEFAULT_SAMPLE_TICKERS,
  keep = false,
  sleep,
  log = console,
} = {}) {
  const started = Date.now();
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 250);
  sampler.unref?.();
  const ua = userAgent ?? (await import("../lib/edgar.js")).SEC_USER_AGENT;
  const companyFacts = getCompanyFacts ?? (await import("../lib/edgar.js")).fetchCompanyFacts;
  const apiKey = env.OPENFIGI_API_KEY?.trim() || null;
  const dir = await mkdtemp(path.join(tmpdir(), "pm-13f-dryrun-"));
  const report = { status: "ok", writesNothing: true, problems: [] };
  try {
    // 1. What the SEC publishes, and how it is named.
    const files = listDataSetFiles(await fetchText(THIRTEEN_F_PAGE, { fetchImpl, userAgent: ua }));
    report.dataSetFiles = { count: files.length, newest: files.slice(0, 6).map((f) => f.name), namingStyle: files[0] ? (/q[1-4]/i.test(files[0].name) ? "quarterly" : "filing_window") : null };
    if (!files.length) throw new Error("no 13F data-set files found on the SEC page (the page layout may have changed)");
    const chosen = file ? files.find((f) => f.name.toLowerCase() === String(file).toLowerCase()) : files[0];
    if (!chosen) throw new Error(`data-set file ${file} not listed on the SEC page`);

    // 2. Download and check the real headers.
    const zipPath = path.join(dir, chosen.name);
    const t0 = Date.now();
    const bytes = await download(chosen.url, zipPath, { fetchImpl, userAgent: ua });
    report.download = { file: chosen.name, bytes, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    const entries = await listZipEntries(zipPath);
    report.archive = { entries: entries.map((e) => ({ name: e.name, bytes: e.size })) };
    const need = { SUBMISSION: "SUBMISSION.tsv", COVERPAGE: "COVERPAGE.tsv", INFOTABLE: "INFOTABLE.tsv" };
    const found = Object.fromEntries(Object.entries(need).map(([key, name]) => [key, findZipEntry(entries, name)]));
    const missingFiles = Object.entries(found).filter(([, entry]) => !entry).map(([key]) => need[key]);
    if (missingFiles.length) throw new Error(`archive is missing ${missingFiles.join(", ")}`);
    const submission = parseSmallTsv(await readZipEntryText(zipPath, found.SUBMISSION), REQUIRED_COLUMNS.SUBMISSION, "SUBMISSION");
    const coverpage = parseSmallTsv(await readZipEntryText(zipPath, found.COVERPAGE), REQUIRED_COLUMNS.COVERPAGE, "COVERPAGE");
    let infotableHeader = null;
    for await (const line of zipEntryLines(zipPath, found.INFOTABLE)) { infotableHeader = line; break; }
    const infotable = headerIndex(infotableHeader, REQUIRED_COLUMNS.INFOTABLE, "INFOTABLE");
    report.headers = { SUBMISSION: submission.columns, COVERPAGE: coverpage.columns, INFOTABLE: infotable.columns, requiredPresent: true };

    // 3. Amendments and one streaming pass over the holdings.
    const { included, stats } = includedAccessions(submission.rows, coverpage.rows);
    report.filings = { ...stats, includedFilings: included.size };
    const t1 = Date.now();
    const aggregate = await aggregateInfotable(zipEntryLines(zipPath, found.INFOTABLE), included);
    const periods = [...aggregate.byPeriod.entries()].map(([period, byCusip]) => ({ period, cusips: byCusip.size, positions: [...byCusip.values()].reduce((s, e) => s + e.positions, 0) })).sort((a, b) => b.positions - a.positions);
    report.holdings = { rows: aggregate.rows, skipped: aggregate.skipped, seconds: Math.round((Date.now() - t1) / 100) / 10, periods };
    const mainPeriod = periods[0]?.period ?? null;

    // 4. CUSIP ↔ ticker: most-held CUSIPs, plus the samples' CUSIPs found in fails-to-deliver.
    const ftdFiles = listFtdFiles(await fetchText(FTD_PAGE, { fetchImpl, userAgent: ua })).slice(0, 2);
    const ftdMaps = [];
    for (const ftd of ftdFiles) {
      const ftdZip = path.join(dir, ftd.name);
      await download(ftd.url, ftdZip, { fetchImpl, userAgent: ua });
      for (const entry of await listZipEntries(ftdZip)) ftdMaps.push(parseFailsToDeliver(await readZipEntryText(ftdZip, entry)));
    }
    const ftd = mergeFtdMaps(ftdMaps);
    const main = aggregate.byPeriod.get(mainPeriod) ?? new Map();
    const mostHeld = [...main.entries()].sort((a, b) => b[1].positions - a[1].positions).slice(0, top).map(([cusip]) => cusip);
    const samples = new Set(sampleTickers.map((t) => t.toUpperCase()));
    const sampleCusips = [...ftd.entries()].filter(([, symbols]) => [...symbols].some((s) => samples.has(s))).map(([cusip]) => cusip);
    const toMap = [...new Set([...mostHeld, ...sampleCusips])];
    const t2 = Date.now();
    const figi = await resolveTickersForCusips(toMap, { fetchImpl, apiKey, ...(sleep ? { sleep } : {}) });
    const figiForReconcile = Object.fromEntries(toMap.map((cusip) => [cusip, figi.tickerByCusip[cusip] ?? null]));
    const ftdForReconcile = new Map(toMap.filter((cusip) => ftd.has(cusip)).map((cusip) => [cusip, ftd.get(cusip)]));
    const reconciled = reconcileCusipMap({ figi: figiForReconcile, ftd: ftdForReconcile });
    report.mapping = {
      openFigiKey: apiKey ? "present" : "absent (slower limits)",
      cusipsLookedUp: toMap.length,
      openFigiResolved: figi.resolved,
      openFigiAmbiguous: figi.ambiguous.length,
      openFigiErrors: figi.errors.slice(0, 5),
      ftdFiles: ftdFiles.map((f) => f.name),
      ftdCusips: ftd.size,
      agreement: reconciled.counts,
      conflicts: reconciled.conflicts.slice(0, 10),
      mappedTickers: Object.keys(reconciled.cusipByTicker).length,
      seconds: Math.round((Date.now() - t2) / 100) / 10,
    };
    if (figi.errors.length) report.problems.push(`OpenFIGI errors: ${figi.errors.length} batch(es)`);

    // 5. Sanity table for well-known names.
    report.samples = [];
    for (const ticker of sampleTickers) {
      const mapped = reconciled.cusipByTicker[ticker.toUpperCase()] ?? null;
      const held = mapped ? main.get(mapped.cusip) ?? null : null;
      let ownershipPct = null;
      let sharesOutstanding = null;
      if (held && mainPeriod) {
        try {
          const facts = await companyFacts(ticker);
          const point = facts ? sharesOutstandingNear(instantSeries(facts, CONCEPTS.sharesOutstanding, "shares"), mainPeriod) : null;
          sharesOutstanding = point?.val ?? null;
          if (sharesOutstanding > 0) ownershipPct = Math.round((held.shares / sharesOutstanding) * 1000) / 10;
        } catch (error) {
          report.problems.push(`${ticker} shares outstanding: ${error.message}`);
        }
      }
      report.samples.push({
        ticker,
        cusip: mapped?.cusip ?? null,
        mappedBy: mapped?.sources ?? [],
        period: held ? mainPeriod : null,
        institutionalShares: held?.shares ?? null,
        positions: held?.positions ?? null,
        sharesOutstanding,
        ownershipPct,
      });
    }
    const unmapped = report.samples.filter((s) => !s.cusip).map((s) => s.ticker);
    if (unmapped.length) report.problems.push(`sample tickers not mapped: ${unmapped.join(", ")}`);
    if (report.problems.length) report.status = "ok_with_problems";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
  } finally {
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    report.cost = { seconds: Math.round((Date.now() - started) / 100) / 10, peakMemoryMb: Math.round(peakRss / 1048576) };
    if (keep) report.keptFiles = dir;
    else await rm(dir, { recursive: true, force: true });
  }
  log.log?.(`[13F] dry run ${report.status}${report.error ? `: ${report.error}` : ""} — ${report.cost.seconds}s, peak ${report.cost.peakMemoryMb} MB, nothing written`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await import("dotenv/config");
  const args = process.argv.slice(2);
  const [task] = args.filter((a) => !a.startsWith("--"));
  const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (task !== "dry-run") {
    console.error("usage: node jobs/thirteen-f-ingest.js dry-run [--file=<zip name>] [--top=300] [--keep]   (writes nothing)");
    process.exit(1);
  }
  const report = await runThirteenFDryRun({ file: flag("file") ?? null, top: Number(flag("top")) || 300, keep: args.includes("--keep") });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed") process.exitCode = 1;
}
