/**
 * 13F data set, streaming edition — the pieces lib/thirteen-f-dataset.js could not do on a
 * real quarterly file:
 *
 *   1. DATES. The SEC data sets write dates as DD-MON-YYYY ("31-MAR-2026"). Comparing those
 *      as strings orders them alphabetically by day, not by date. Every date is normalized
 *      to YYYY-MM-DD first (`parseSecDate`).
 *   2. AMENDMENTS, PROPERLY. A 13F-HR/A is either a RESTATEMENT (it replaces the report) or
 *      NEW HOLDINGS (it adds positions the original left out). COVERPAGE.tsv says which.
 *      Keeping only the latest filing per manager and period — the earlier rule — silently
 *      drops every "new holdings" amendment. `includedAccessions` applies the real rule; an
 *      amendment whose type is unknown is left out and counted, never guessed.
 *   3. PERIODS, NOT FILES. Since 2024 a data-set file covers a filing-date window, so one
 *      file can hold several report periods and one period's filings can span two files.
 *      Aggregation is keyed by PERIODOFREPORT.
 *   4. SIZE. INFOTABLE.tsv is hundreds of MB. `aggregateInfotable` consumes an async line
 *      iterator (lib/zip-stream.js) and keeps only per-(period, CUSIP) totals.
 *
 * Header-driven and fail-closed like the original: a required column missing from a real
 * file stops the run with its name, rather than reading values by position.
 * Pure apart from consuming the iterator it is given.
 */

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

/** "31-MAR-2026" | "2026-03-31" | "03/31/2026" → "2026-03-31"; anything else → null. */
export function parseSecDate(value) {
  const text = String(value ?? "").trim().toUpperCase();
  let match = text.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (match && MONTHS[match[2]]) return `${match[3]}-${MONTHS[match[2]]}-${match[1].padStart(2, "0")}`;
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return null;
}

export const REQUIRED_COLUMNS = Object.freeze({
  SUBMISSION: Object.freeze(["ACCESSION_NUMBER", "CIK", "PERIODOFREPORT", "FILING_DATE", "SUBMISSIONTYPE"]),
  COVERPAGE: Object.freeze(["ACCESSION_NUMBER", "ISAMENDMENT", "AMENDMENTTYPE"]),
  INFOTABLE: Object.freeze(["ACCESSION_NUMBER", "CUSIP", "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL"]),
});

/** Column positions from a header line, by name. Throws, naming every missing required column. */
export function headerIndex(headerLine, required, fileLabel) {
  const columns = String(headerLine ?? "").replace(/^﻿/, "").split("\t").map((c) => c.trim().toUpperCase());
  const missing = required.filter((c) => !columns.includes(c));
  if (missing.length) throw new Error(`13F ${fileLabel}: missing required column(s) ${missing.join(", ")} (found: ${columns.join(", ")})`);
  return { columns, index: new Map(columns.map((c, i) => [c, i])) };
}

/** Parse a small TSV (SUBMISSION, COVERPAGE) fully, by column name. */
export function parseSmallTsv(text, required, fileLabel) {
  const lines = String(text ?? "").split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) throw new Error(`13F ${fileLabel}: empty file`);
  const { columns, index } = headerIndex(lines[0], required, fileLabel);
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    for (const [column, at] of index) row[column] = (cells[at] ?? "").trim();
    return row;
  });
  return { columns, rows };
}

/**
 * Which filings' holdings count, per manager (CIK) and report period.
 *   - 13F-NT (notice: holdings reported by another manager) and anything that is not a
 *     holdings report are skipped.
 *   - Walking each manager+period's filings in filing-date order: an original report or a
 *     RESTATEMENT replaces everything before it; a NEW HOLDINGS amendment adds to it.
 *   - An amendment whose type is missing or unknown is excluded and counted.
 *
 * @param {object[]} submissions  SUBMISSION.tsv rows (any number of files, merged)
 * @param {object[]} coverpages   COVERPAGE.tsv rows (same files)
 * @returns {{ included: Map<string,{cik,periodOfReport,filingDate,role}>, stats: object }}
 */
export function includedAccessions(submissions = [], coverpages = []) {
  const cover = new Map(coverpages.map((row) => [row.ACCESSION_NUMBER, row]));
  const groups = new Map();
  const stats = { filings: 0, notices: 0, originals: 0, restatements: 0, newHoldings: 0, unknownAmendments: 0, undated: 0 };
  for (const row of submissions) {
    const type = String(row.SUBMISSIONTYPE ?? "").toUpperCase();
    const accession = row.ACCESSION_NUMBER;
    const periodOfReport = parseSecDate(row.PERIODOFREPORT);
    const filingDate = parseSecDate(row.FILING_DATE);
    if (!accession || !row.CIK) continue;
    stats.filings += 1;
    if (!type.startsWith("13F-HR")) { stats.notices += 1; continue; }
    if (!periodOfReport || !filingDate) { stats.undated += 1; continue; }
    const coverRow = cover.get(accession);
    const isAmendment = type.endsWith("/A") || String(coverRow?.ISAMENDMENT ?? "").toUpperCase() === "Y";
    let role = "original";
    if (isAmendment) {
      const kind = String(coverRow?.AMENDMENTTYPE ?? "").toUpperCase().replace(/\s+/g, " ").trim();
      if (kind === "RESTATEMENT") role = "restatement";
      else if (kind === "NEW HOLDINGS") role = "new_holdings";
      else { stats.unknownAmendments += 1; continue; }
    }
    const key = `${row.CIK}|${periodOfReport}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ accession, cik: row.CIK, periodOfReport, filingDate, role });
  }

  const included = new Map();
  for (const filings of groups.values()) {
    filings.sort((a, b) => a.filingDate.localeCompare(b.filingDate) || a.accession.localeCompare(b.accession));
    let kept = [];
    for (const filing of filings) {
      if (filing.role === "new_holdings") {
        kept.push(filing);
        stats.newHoldings += 1;
      } else {
        kept = [filing];
        if (filing.role === "restatement") stats.restatements += 1;
        else stats.originals += 1;
      }
    }
    for (const filing of kept) included.set(filing.accession, filing);
  }
  return { included, stats };
}

/**
 * Stream INFOTABLE.tsv and total share holdings per (report period, CUSIP).
 * Shares only (SSHPRNAMTTYPE "SH"), no option rows (PUTCALL empty), positive amounts, and only
 * filings in `included`. `positions` counts holding rows; `managers` distinct filers (only
 * tracked when a CUSIP filter is given, to bound memory).
 *
 * @param {AsyncIterable<string>|Iterable<string>} lines  INFOTABLE lines, header first
 * @param {Map} included  from includedAccessions
 * @param {{ cusipFilter?: Iterable<string>|null }} [options]
 * @returns {Promise<{ columns, byPeriod: Map<string, Map<string,{shares,positions,managers}>>, rows, skipped }>}
 */
export async function aggregateInfotable(lines, included, { cusipFilter = null } = {}) {
  const wanted = cusipFilter == null ? null : new Set([...cusipFilter].map((c) => String(c).toUpperCase()));
  const byPeriod = new Map();
  const managerSets = new Map();
  const skipped = { notIncluded: 0, options: 0, nonShare: 0, badAmount: 0, noCusip: 0, filtered: 0 };
  let index = null;
  let columns = null;
  let rows = 0;
  for await (const line of lines) {
    if (index == null) {
      ({ index, columns } = headerIndex(line, REQUIRED_COLUMNS.INFOTABLE, "INFOTABLE"));
      continue;
    }
    if (!line) continue;
    rows += 1;
    const cells = line.split("\t");
    const cell = (name) => (cells[index.get(name)] ?? "").trim();
    const filing = included.get(cell("ACCESSION_NUMBER"));
    if (!filing) { skipped.notIncluded += 1; continue; }
    if (cell("PUTCALL")) { skipped.options += 1; continue; }
    if (cell("SSHPRNAMTTYPE").toUpperCase() !== "SH") { skipped.nonShare += 1; continue; }
    const cusip = cell("CUSIP").toUpperCase();
    if (!cusip) { skipped.noCusip += 1; continue; }
    if (wanted && !wanted.has(cusip)) { skipped.filtered += 1; continue; }
    const shares = Number(cell("SSHPRNAMT").replace(/,/g, ""));
    if (!Number.isFinite(shares) || shares <= 0) { skipped.badAmount += 1; continue; }

    if (!byPeriod.has(filing.periodOfReport)) byPeriod.set(filing.periodOfReport, new Map());
    const period = byPeriod.get(filing.periodOfReport);
    const entry = period.get(cusip) ?? { shares: 0, positions: 0, managers: wanted ? 0 : null };
    entry.shares += shares;
    entry.positions += 1;
    if (wanted) {
      const key = `${filing.periodOfReport}|${cusip}`;
      if (!managerSets.has(key)) managerSets.set(key, new Set());
      const set = managerSets.get(key);
      if (!set.has(filing.cik)) { set.add(filing.cik); entry.managers += 1; }
    }
    period.set(cusip, entry);
  }
  if (index == null) throw new Error("13F INFOTABLE: empty file");
  return { columns, byPeriod, rows, skipped };
}

/**
 * Data-set file names from the SEC's listing page, newest first. Understands both the older
 * quarterly names ("2024q1_form13f.zip") and the filing-window names
 * ("01jun2024-31aug2024_form13f.zip").
 */
export function listDataSetFiles(html, baseUrl = "https://www.sec.gov") {
  const seen = new Map();
  for (const match of String(html ?? "").matchAll(/href="([^"]*?([^"/]*form13f[^"/]*\.zip))"/gi)) {
    const [, href, name] = match;
    if (seen.has(name.toLowerCase())) continue;
    const url = href.startsWith("http") ? href : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
    seen.set(name.toLowerCase(), { name, url, sortKey: dataSetSortKey(name) });
  }
  return [...seen.values()].sort((a, b) => (b.sortKey ?? "").localeCompare(a.sortKey ?? "") || a.name.localeCompare(b.name));
}

/** Sortable end date of a data-set file, from its name; null when the name is not recognised. */
export function dataSetSortKey(name) {
  const text = String(name).toLowerCase();
  const quarter = text.match(/(\d{4})q([1-4])/);
  if (quarter) return `${quarter[1]}-${String(Number(quarter[2]) * 3).padStart(2, "0")}-31`;
  const window = text.match(/(\d{1,2})([a-z]{3})(\d{4})-(\d{1,2})([a-z]{3})(\d{4})/);
  if (window) return parseSecDate(`${window[4]}-${window[5]}-${window[6]}`);
  return null;
}
