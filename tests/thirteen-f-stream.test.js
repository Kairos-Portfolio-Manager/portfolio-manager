import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildZip } from "../lib/pitch-lab/xlsx-writer.js";
import { findZipEntry, listZipEntries, readZipEntryText, zipEntryLines } from "../lib/zip-stream.js";
import { aggregateInfotable, dataSetSortKey, headerIndex, includedAccessions, listDataSetFiles, parseSecDate, parseSmallTsv, REQUIRED_COLUMNS } from "../lib/thirteen-f-stream.js";
import { MAX_JOBS_PER_REQUEST, MAX_JOBS_PER_REQUEST_NO_KEY, normalizeTicker, parseFailsToDeliver, reconcileCusipMap, resolveTickersForCusips, tickerFromFigiResult } from "../lib/cusip-map.js";
import { listFtdFiles, runThirteenFDryRun } from "../jobs/thirteen-f-ingest.js";

const withDir = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pm-13f-test-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
async function collect(iterable) { const out = []; for await (const x of iterable) out.push(x); return out; }

// ─── ZIP streaming ───────────────────────────────────────────────────────────

test("the ZIP reader lists entries and streams one entry's lines without unpacking the archive", () => withDir(async (dir) => {
  const file = path.join(dir, "a.zip");
  const big = ["H1\tH2", ...Array.from({ length: 20_000 }, (_, i) => `${i}\tvalue ${i}`)].join("\r\n");
  writeFileSync(file, buildZip([{ name: "2026q1/INFOTABLE.tsv", data: big }, { name: "SUBMISSION.tsv", data: "A\tB\n1\t2\n" }, { name: "empty.txt", data: "" }]));
  const entries = await listZipEntries(file);
  assert.deepEqual(entries.map((e) => e.name), ["2026q1/INFOTABLE.tsv", "SUBMISSION.tsv", "empty.txt"]);
  const info = findZipEntry(entries, "infotable.TSV");
  assert.equal(info.size, Buffer.byteLength(big));
  const lines = await collect(zipEntryLines(file, info));
  assert.equal(lines.length, 20_001);
  assert.deepEqual([lines[0], lines.at(-1)], ["H1\tH2", "19999\tvalue 19999"]);
  assert.equal(await readZipEntryText(file, findZipEntry(entries, "submission.tsv")), "A\tB\n1\t2\n");
  assert.deepEqual(await collect(zipEntryLines(file, findZipEntry(entries, "empty.txt"))), []);
  await assert.rejects(() => readZipEntryText(file, info, { maxBytes: 10 }), /stream it with zipEntryLines/);
  writeFileSync(path.join(dir, "not.zip"), "hello");
  await assert.rejects(() => listZipEntries(path.join(dir, "not.zip")), /not a ZIP archive/);
}));

// ─── Dates, amendments, aggregation ─────────────────────────────────────────

test("SEC dates are normalized before any comparison", () => {
  assert.deepEqual(["31-MAR-2026", "05-may-2026", "2026-03-31", "3/31/2026", "", "31-XYZ-2026"].map(parseSecDate), ["2026-03-31", "2026-05-05", "2026-03-31", "2026-03-31", null, null]);
  // Compared as strings, 05-JUN sorts before 28-MAY; normalized, it does not.
  assert.ok(parseSecDate("05-JUN-2026") > parseSecDate("28-MAY-2026"));
});

const SUB = (rows) => ["ACCESSION_NUMBER\tFILING_DATE\tSUBMISSIONTYPE\tCIK\tPERIODOFREPORT", ...rows.map((r) => r.join("\t"))].join("\n");
const COVER = (rows) => ["ACCESSION_NUMBER\tREPORTCALENDARORQUARTER\tISAMENDMENT\tAMENDMENTNO\tAMENDMENTTYPE", ...rows.map((r) => r.join("\t"))].join("\n");

test("amendments: a restatement replaces, new holdings add, an unknown type is left out", () => {
  const submission = parseSmallTsv(SUB([
    ["A-ORIG", "10-MAY-2026", "13F-HR", "1", "31-MAR-2026"],
    ["A-ADD", "28-MAY-2026", "13F-HR/A", "1", "31-MAR-2026"], // adds positions
    ["B-ORIG", "11-MAY-2026", "13F-HR", "2", "31-MAR-2026"],
    ["B-ADD", "20-MAY-2026", "13F-HR/A", "2", "31-MAR-2026"], // adds…
    ["B-RESTATE", "05-JUN-2026", "13F-HR/A", "2", "31-MAR-2026"], // …then a full restatement replaces both
    ["C-ORIG", "12-MAY-2026", "13F-HR", "3", "31-MAR-2026"],
    ["C-ODD", "13-MAY-2026", "13F-HR/A", "3", "31-MAR-2026"], // amendment of unknown type
    ["D-NT", "14-MAY-2026", "13F-NT", "4", "31-MAR-2026"], // notice: holdings filed by someone else
    ["E-OLD", "10-FEB-2026", "13F-HR", "5", "31-DEC-2025"], // a different period
  ]), REQUIRED_COLUMNS.SUBMISSION, "SUBMISSION").rows;
  const cover = parseSmallTsv(COVER([
    ["A-ADD", "31-MAR-2026", "Y", "1", "NEW HOLDINGS"],
    ["B-ADD", "31-MAR-2026", "Y", "1", "NEW HOLDINGS"],
    ["B-RESTATE", "31-MAR-2026", "Y", "2", "RESTATEMENT"],
    ["C-ODD", "31-MAR-2026", "Y", "1", ""],
  ]), REQUIRED_COLUMNS.COVERPAGE, "COVERPAGE").rows;
  const { included, stats } = includedAccessions(submission, cover);
  assert.deepEqual([...included.keys()].sort(), ["A-ADD", "A-ORIG", "B-RESTATE", "C-ORIG", "E-OLD"]);
  assert.equal(included.get("A-ADD").role, "new_holdings");
  assert.equal(included.get("A-ADD").periodOfReport, "2026-03-31");
  assert.deepEqual({ notices: stats.notices, unknown: stats.unknownAmendments, restatements: stats.restatements }, { notices: 1, unknown: 1, restatements: 1 });
});

const INFO = (rows) => ["ACCESSION_NUMBER\tINFOTABLE_SK\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP\tVALUE\tSSHPRNAMT\tSSHPRNAMTTYPE\tPUTCALL", ...rows.map((r) => r.join("\t"))];

test("holdings are totalled per report period and CUSIP, shares only, from included filings only", async () => {
  const included = new Map([
    ["A-ORIG", { cik: "1", periodOfReport: "2026-03-31" }],
    ["A-ADD", { cik: "1", periodOfReport: "2026-03-31" }],
    ["B", { cik: "2", periodOfReport: "2026-03-31" }],
    ["OLD", { cik: "2", periodOfReport: "2025-12-31" }],
  ]);
  const lines = INFO([
    ["A-ORIG", "1", "APPLE", "COM", "037833100", "1", "500", "SH", ""],
    ["A-ADD", "2", "APPLE", "COM", "037833100", "1", "100", "SH", ""], // new holdings add
    ["B", "3", "APPLE", "COM", "037833100", "1", "1,000", "SH", ""],
    ["B", "4", "APPLE", "COM", "037833100", "1", "999", "SH", "Call"], // option
    ["B", "5", "APPLE NOTE", "NOTE", "037833AA0", "1", "50", "PRN", ""], // principal, not shares
    ["SUPERSEDED", "6", "APPLE", "COM", "037833100", "1", "7777", "SH", ""],
    ["OLD", "7", "APPLE", "COM", "037833100", "1", "900", "SH", ""],
    ["B", "8", "NVIDIA", "COM", "67066G104", "1", "0", "SH", ""], // no shares
  ]);
  const all = await aggregateInfotable(lines, included);
  assert.deepEqual([...all.byPeriod.keys()].sort(), ["2025-12-31", "2026-03-31"]);
  assert.deepEqual(all.byPeriod.get("2026-03-31").get("037833100"), { shares: 1600, positions: 3, managers: null });
  assert.equal(all.byPeriod.get("2025-12-31").get("037833100").shares, 900);
  assert.deepEqual(all.skipped, { notIncluded: 1, options: 1, nonShare: 1, badAmount: 1, noCusip: 0, filtered: 0 });
  assert.equal(all.rows, 8);
  // With a filter, only those CUSIPs are kept and distinct managers are counted.
  const filtered = await aggregateInfotable(lines, included, { cusipFilter: ["037833100"] });
  assert.deepEqual(filtered.byPeriod.get("2026-03-31").get("037833100"), { shares: 1600, positions: 3, managers: 2 });
  await assert.rejects(() => aggregateInfotable(["ACCESSION_NUMBER\tCUSIP"], included), /missing required column\(s\) SSHPRNAMT, SSHPRNAMTTYPE, PUTCALL/);
  await assert.rejects(() => aggregateInfotable([], included), /empty file/);
  assert.throws(() => headerIndex("﻿ACCESSION_NUMBER\tX", ["CUSIP"], "INFOTABLE"), /missing required column\(s\) CUSIP \(found: ACCESSION_NUMBER, X\)/);
});

test("data-set files are listed newest first under either naming style", () => {
  const html = [
    '<a href="/files/structureddata/data/form-13f-data-sets/2023q4_form13f.zip">2023 Q4</a>',
    '<a href="/files/structureddata/data/form-13f-data-sets/01sep2024-30nov2024_form13f.zip">Sep-Nov 2024</a>',
    '<a href="https://www.sec.gov/files/x/01jun2024-31aug2024_form13f.zip">Jun-Aug</a>',
    '<a href="/files/structureddata/data/form-13f-data-sets/01sep2024-30nov2024_form13f.zip">dup</a>',
  ].join("\n");
  const files = listDataSetFiles(html);
  assert.deepEqual(files.map((f) => f.name), ["01sep2024-30nov2024_form13f.zip", "01jun2024-31aug2024_form13f.zip", "2023q4_form13f.zip"]);
  assert.equal(files[0].url, "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/01sep2024-30nov2024_form13f.zip");
  assert.deepEqual([dataSetSortKey("2023q4_form13f.zip"), dataSetSortKey("01sep2024-30nov2024_form13f.zip"), dataSetSortKey("x.zip")], ["2023-12-31", "2024-11-30", null]);
  assert.deepEqual(listFtdFiles('<a href="/files/data/fails-deliver-data/cnsfails202410a.zip">a</a><a href="/files/data/fails-deliver-data/cnsfails202410b.zip">b</a><a href="/files/data/fails-deliver-data/cnsfails202409b.zip">c</a>').map((f) => f.name), ["cnsfails202410b.zip", "cnsfails202410a.zip", "cnsfails202409b.zip"]);
});

// ─── CUSIP ↔ ticker ──────────────────────────────────────────────────────────

const figiData = (ticker, over = {}) => ({ data: [{ figi: "BBG000B9XRY4", ticker, exchCode: "US", marketSector: "Equity", securityType: "Common Stock", ...over }] });

test("an OpenFIGI answer gives a ticker only for one US equity share line", () => {
  assert.equal(tickerFromFigiResult(figiData("AAPL")), "AAPL");
  assert.equal(tickerFromFigiResult(figiData("BRK/B")), "BRK-B");
  assert.equal(tickerFromFigiResult(figiData("XYZ", { exchCode: "LN" })), null, "not US-listed");
  assert.equal(tickerFromFigiResult(figiData("XYZ", { securityType: "Corp Bond" })), null, "not shares");
  assert.equal(tickerFromFigiResult({ data: [...figiData("AAA").data, ...figiData("BBB").data] }), null, "two tickers is ambiguous");
  assert.equal(tickerFromFigiResult({ warning: "No identifier found." }), null);
  assert.equal(normalizeTicker(" brk/a "), "BRK-A");
});

test("CUSIP → ticker lookups batch by the key's limits, pace themselves, and never cache a failure", async () => {
  const cusips = Array.from({ length: 25 }, (_, i) => `00000${String(i).padStart(3, "0")}0`);
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    const jobs = JSON.parse(init.body);
    calls.push({ size: jobs.length, key: init.headers["X-OPENFIGI-APIKEY"] ?? null, idType: jobs[0].idType });
    if (calls.length === 2) throw new Error("rate limited");
    return { ok: true, json: async () => jobs.map((j) => figiData(`T${j.idValue.slice(5, 8)}`)) };
  };
  const noKey = await resolveTickersForCusips(cusips, { fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(calls.map((c) => c.size), [10, 10, 5]);
  assert.equal(calls[0].idType, "ID_CUSIP");
  assert.equal(calls[0].key, null);
  assert.deepEqual(sleeps, [2600, 2600]);
  assert.equal(noKey.resolved, 15);
  assert.equal(noKey.errors.length, 1);
  assert.equal(cusips[10] in noKey.tickerByCusip, false, "a failed batch is left out so the next run retries it");
  assert.equal(noKey.tickerByCusip[cusips[0]], "T000");

  calls.length = 0;
  sleeps.length = 0;
  const withKey = await resolveTickersForCusips(cusips, { fetchImpl: async (url, init) => { const jobs = JSON.parse(init.body); calls.push({ size: jobs.length, key: init.headers["X-OPENFIGI-APIKEY"] }); return { ok: true, json: async () => jobs.map(() => ({ warning: "No identifier found." })) }; }, apiKey: " secret ", sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(calls, [{ size: 25, key: "secret" }]);
  assert.equal(withKey.resolved, 0);
  assert.equal(withKey.tickerByCusip[cusips[0]], null, "a CUSIP OpenFIGI does not know is cached as unknown");
  assert.equal(MAX_JOBS_PER_REQUEST, 100);
  assert.equal(MAX_JOBS_PER_REQUEST_NO_KEY, 10);
  // Cached CUSIPs are not asked again; a misaligned reply is discarded.
  const cached = await resolveTickersForCusips([cusips[0]], { cache: noKey.tickerByCusip, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(cached.requested, 0);
  const misaligned = await resolveTickersForCusips(cusips.slice(0, 2), { fetchImpl: async () => ({ ok: true, json: async () => [figiData("AAPL")] }), sleep: async () => {} });
  assert.match(misaligned.errors[0], /1 results for 2 jobs/);
  assert.equal(misaligned.resolved, 0);
});

test("fails-to-deliver files give CUSIP and symbol side by side", () => {
  const ftd = parseFailsToDeliver(["SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE", "20261001|037833100|AAPL|1200|APPLE INC|230.1", "20261002|037833100|AAPL|800|APPLE INC|231", "20261001|084670702|BRK/B|5|BERKSHIRE|400", "20261001|BADCUSIP|X|1|BAD|1", "Trailer record count 4"].join("\n"));
  assert.deepEqual([...ftd.keys()], ["037833100", "084670702"]);
  assert.deepEqual([...ftd.get("084670702")], ["BRK-B"]);
  assert.throws(() => parseFailsToDeliver("A|B\n1|2"), /missing CUSIP\/SYMBOL/);
});

test("the map keeps agreements, refuses conflicts, and records which source each mapping came from", () => {
  const { cusipByTicker, conflicts, counts } = reconcileCusipMap({
    figi: { "037833100": "AAPL", "594918104": "MSFT", "111111111": "AAA", "222222222": "OLDCO", "333333333": "DUAL", "444444444": "DUAL" },
    ftd: new Map([
      ["037833100", new Set(["AAPL"])], // agree
      ["111111111", new Set(["ZZZ"])], // disagree → unmapped
      ["555555555", new Set(["LUV"])], // fails-to-deliver only
      ["333333333", new Set(["DUAL"])], // DUAL reached by two CUSIPs; only this one is confirmed by both
    ]),
    tickers: ["AAPL", "MSFT", "AAA", "LUV", "DUAL"],
  });
  assert.deepEqual(cusipByTicker, {
    AAPL: { cusip: "037833100", sources: ["openfigi", "sec_ftd"] },
    DUAL: { cusip: "333333333", sources: ["openfigi", "sec_ftd"] },
    LUV: { cusip: "555555555", sources: ["sec_ftd"] },
    MSFT: { cusip: "594918104", sources: ["openfigi"] },
  });
  assert.deepEqual(conflicts, [{ cusip: "111111111", openfigi: "AAA", sec_ftd: "ZZZ" }]);
  assert.equal(counts.outsideUniverse, 1, "OLDCO is not in the catalog");
  // Two unconfirmed CUSIPs for one ticker: neither is trusted.
  const twoUnconfirmed = reconcileCusipMap({ figi: { "333333333": "DUAL", "444444444": "DUAL" } });
  assert.deepEqual(twoUnconfirmed.cusipByTicker, {});
  assert.deepEqual(twoUnconfirmed.conflicts, [{ ticker: "DUAL", cusips: ["333333333", "444444444"] }]);
});

// ─── Dry run, end to end on fakes ────────────────────────────────────────────

test("the dry run checks a real-shaped data set end to end and writes nothing", () => withDir(async (dir) => {
  const dataSet = buildZip([
    { name: "SUBMISSION.tsv", data: SUB([["A1", "10-MAY-2026", "13F-HR", "1", "31-MAR-2026"], ["B1", "11-MAY-2026", "13F-HR", "2", "31-MAR-2026"], ["B2", "20-MAY-2026", "13F-HR/A", "2", "31-MAR-2026"]]) },
    { name: "COVERPAGE.tsv", data: COVER([["B2", "31-MAR-2026", "Y", "1", "NEW HOLDINGS"]]) },
    { name: "INFOTABLE.tsv", data: INFO([
      ["A1", "1", "APPLE", "COM", "037833100", "1", "6000000000", "SH", ""],
      ["B1", "2", "APPLE", "COM", "037833100", "1", "3000000000", "SH", ""],
      ["B2", "3", "SOUTHWEST", "COM", "844741108", "1", "400000000", "SH", ""],
    ]).join("\n") },
  ]);
  const ftdZip = buildZip([{ name: "cnsfails202610b.txt", data: "SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE\n20261020|037833100|AAPL|10|APPLE|230\n20261020|844741108|LUV|10|SOUTHWEST|30\n" }]);
  const served = [];
  const fetchImpl = async (url, init = {}) => {
    served.push(url);
    const ok = (body) => ({ ok: true, status: 200, text: async () => body, arrayBuffer: async () => body, json: async () => JSON.parse(body) });
    if (url.endsWith("form-13f-data-sets")) return ok('<a href="/files/x/01mar2026-31may2026_form13f.zip">x</a><a href="/files/x/2025q4_form13f.zip">y</a>');
    if (url.endsWith("fails-deliver-data")) return ok('<a href="/files/d/cnsfails202610b.zip">b</a>');
    if (url.endsWith("01mar2026-31may2026_form13f.zip")) return ok(dataSet);
    if (url.endsWith("cnsfails202610b.zip")) return ok(ftdZip);
    if (url.includes("openfigi")) {
      const jobs = JSON.parse(init.body);
      return { ok: true, json: async () => jobs.map((j) => (j.idValue === "037833100" ? figiData("AAPL") : j.idValue === "844741108" ? figiData("LUV") : { warning: "No identifier found." })) };
    }
    return { ok: false, status: 404 };
  };
  const facts = (shares) => ({ facts: { "us-gaap": { CommonStockSharesOutstanding: { units: { shares: [{ end: "2026-03-31", val: shares, filed: "2026-05-01", form: "10-Q", fy: 2026, fp: "Q1" }] } } } } });
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("pm-13f-dryrun-")).length;
  const report = await runThirteenFDryRun({
    env: {}, fetchImpl, userAgent: "test", sleep: async () => {}, log: {},
    sampleTickers: ["AAPL", "LUV", "NOPE"],
    getCompanyFacts: async (ticker) => (ticker === "AAPL" ? facts(15_000_000_000) : ticker === "LUV" ? facts(600_000_000) : null),
  });
  assert.equal(report.status, "ok_with_problems", JSON.stringify(report.error ?? report.problems));
  assert.equal(report.writesNothing, true);
  assert.deepEqual(report.dataSetFiles.newest, ["01mar2026-31may2026_form13f.zip", "2025q4_form13f.zip"]);
  assert.equal(report.dataSetFiles.namingStyle, "filing_window");
  assert.equal(report.headers.requiredPresent, true);
  assert.equal(report.filings.newHoldings, 1);
  assert.deepEqual(report.holdings.periods.map((p) => p.period), ["2026-03-31"]);
  assert.equal(report.mapping.openFigiKey, "absent (slower limits)");
  const aapl = report.samples.find((s) => s.ticker === "AAPL");
  assert.deepEqual({ cusip: aapl.cusip, sources: aapl.mappedBy, shares: aapl.institutionalShares, pct: aapl.ownershipPct }, { cusip: "037833100", sources: ["openfigi", "sec_ftd"], shares: 9_000_000_000, pct: 60 });
  assert.equal(report.samples.find((s) => s.ticker === "LUV").ownershipPct, 66.7);
  assert.deepEqual(report.problems, ["sample tickers not mapped: NOPE"]);
  assert.ok(report.cost.seconds >= 0 && report.cost.peakMemoryMb > 0);
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("pm-13f-dryrun-")).length, before, "the temporary download is deleted");
  assert.ok(!served.some((url) => /redis|postgres|telegram/i.test(url)));

  // A data set whose columns do not match fails closed and says which.
  const broken = buildZip([{ name: "SUBMISSION.tsv", data: "ACCESSION_NUMBER\tCIK\n1\t2" }, { name: "COVERPAGE.tsv", data: "x" }, { name: "INFOTABLE.tsv", data: "x" }]);
  const failed = await runThirteenFDryRun({
    env: {}, userAgent: "test", log: {}, sleep: async () => {}, getCompanyFacts: async () => null,
    fetchImpl: async (url, init) => (url.endsWith("01mar2026-31may2026_form13f.zip") ? { ok: true, arrayBuffer: async () => broken } : fetchImpl(url, init)),
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /SUBMISSION: missing required column\(s\) PERIODOFREPORT, FILING_DATE, SUBMISSIONTYPE/);
}));

test("13F modules stay off the money path and out of storage", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../lib/thirteen-f-stream.js", "../lib/cusip-map.js", "../lib/zip-stream.js", "../jobs/thirteen-f-ingest.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const imports = [...src.matchAll(/from ["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) assert.ok(!/redis|\/pg\/|proposal|ledger|broker|order|telegram|robinhood/.test(spec), `${file} must not import ${spec}`);
  }
  assert.doesNotMatch(readFileSync(new URL("../scheduler.js", import.meta.url), "utf8"), /thirteen-f-ingest/);
  assert.doesNotMatch(readFileSync(new URL("../pitch-lab-scheduler.js", import.meta.url), "utf8"), /thirteen-f-ingest/, "not scheduled in this release");
});
