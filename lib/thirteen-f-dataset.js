/**
 * SEC Form 13F Data Set parsing + aggregation.
 *
 * SUPERSEDED for ingestion by lib/thirteen-f-stream.js, which streams the real file,
 * normalizes the SEC's DD-MON-YYYY dates (compared as strings here), groups by report period
 * across filing-window files, and applies NEW HOLDINGS amendments instead of dropping them.
 * Kept for its existing callers and tests; do not build new ingestion on it.
 *
 * The SEC publishes one structured ZIP per quarter covering ALL filers
 * (https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets, ~3–4k managers
 * per quarter, 2013Q2 onward). That is why this is a per-QUARTER ingest of one file
 * rather than a per-ticker scrape: institutional ownership is a sum across every holder,
 * so there is no per-name filing to read, but the underlying data only changes 4x a year.
 *
 * Pure text→data, no I/O — the caller downloads and unzips (jobs/thirteen-f-ingest.js).
 * Kept pure precisely because it could not be validated against a live download from the
 * build environment; see UNVERIFIED below.
 *
 * UNVERIFIED AGAINST A LIVE FILE. The column names below come from the SEC's published
 * data-set documentation, not from an observed download — outbound access to sec.gov is
 * blocked in the environment this was written in. `parseTsv` therefore validates the
 * header and FAILS CLOSED on an unexpected shape rather than guessing at column
 * positions. Verify against a real quarterly ZIP before trusting the output.
 *
 * AMENDMENTS: a manager may file 13F-HR/A restating a quarter. Summing every row would
 * double-count those positions. `aggregateSharesByCusip` keeps only the latest filing per
 * (manager, period) before summing.
 *
 * WHAT COUNTS AS OWNERSHIP: only SSHPRNAMTTYPE "SH" (shares), and only rows with no
 * PUTCALL value. Option positions are reported in the same table but are not share
 * ownership, and principal amounts are not shares at all.
 */

const REQUIRED_INFOTABLE_COLUMNS = ["ACCESSION_NUMBER", "CUSIP", "SSHPRNAMT", "SSHPRNAMTTYPE"];
const REQUIRED_SUBMISSION_COLUMNS = ["ACCESSION_NUMBER", "CIK", "PERIODOFREPORT", "FILING_DATE"];

/**
 * Header-driven TSV parse. Columns are resolved by NAME, never by position, so a column
 * added or reordered between quarters cannot silently shift the values.
 *
 * @returns {{ rows: object[], columns: string[] }}
 * @throws {Error} when a required column is absent — fail closed, per the repo rule.
 */
export function parseTsv(text, requiredColumns = []) {
  if (typeof text !== "string" || !text.trim()) throw new Error("13F data set: empty file");
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) throw new Error("13F data set: no rows");

  const columns = lines[0].split("\t").map((c) => c.trim().toUpperCase());
  const missing = requiredColumns.filter((c) => !columns.includes(c));
  if (missing.length) throw new Error(`13F data set: missing required column(s) ${missing.join(", ")}`);

  const index = new Map(columns.map((c, i) => [c, i]));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const row = {};
    for (const [column, at] of index) row[column] = (cells[at] ?? "").trim();
    rows.push(row);
  }
  return { rows, columns };
}

/**
 * Latest filing per (manager, period), keyed by accession number.
 * @returns {Map<string,{cik:string, periodOfReport:string, filingDate:string}>}
 */
export function resolveLatestSubmissions(submissionText) {
  const { rows } = parseTsv(submissionText, REQUIRED_SUBMISSION_COLUMNS);
  const bestByManagerPeriod = new Map();
  for (const row of rows) {
    const accession = row.ACCESSION_NUMBER;
    const cik = row.CIK;
    const periodOfReport = row.PERIODOFREPORT;
    const filingDate = row.FILING_DATE;
    if (!accession || !cik || !periodOfReport) continue;
    const key = `${cik}|${periodOfReport}`;
    const existing = bestByManagerPeriod.get(key);
    // Ties keep the first seen; the SEC emits one row per submission so a true tie means
    // duplicate rows, not two distinct restatements.
    if (!existing || String(filingDate) > String(existing.filingDate)) {
      bestByManagerPeriod.set(key, { accession, cik, periodOfReport, filingDate });
    }
  }
  const kept = new Map();
  for (const entry of bestByManagerPeriod.values()) {
    kept.set(entry.accession, { cik: entry.cik, periodOfReport: entry.periodOfReport, filingDate: entry.filingDate });
  }
  return kept;
}

/**
 * Aggregate share counts by CUSIP for one quarter.
 *
 * @param {string} infotableText   INFOTABLE.tsv contents
 * @param {string} submissionText  SUBMISSION.tsv contents
 * @param {Set<string>|string[]} [cusipFilter]  restrict to our candidate universe; omit for all
 * @returns {{ periodOfReport:string|null, byCusip: Map<string,{shares:number, holders:number}>,
 *             skipped: {options:number, nonShare:number, unmatchedAccession:number} }}
 */
export function aggregateSharesByCusip(infotableText, submissionText, cusipFilter = null) {
  const submissions = resolveLatestSubmissions(submissionText);
  const { rows } = parseTsv(infotableText, REQUIRED_INFOTABLE_COLUMNS);
  const wanted = cusipFilter == null ? null : new Set([...cusipFilter].map((c) => String(c).toUpperCase()));

  const byCusip = new Map();
  const skipped = { options: 0, nonShare: 0, unmatchedAccession: 0 };
  const periods = new Map();

  for (const row of rows) {
    const submission = submissions.get(row.ACCESSION_NUMBER);
    // Not an error: rows belonging to a superseded amendment land here by design.
    if (!submission) { skipped.unmatchedAccession++; continue; }

    if (row.PUTCALL) { skipped.options++; continue; }
    if (row.SSHPRNAMTTYPE && row.SSHPRNAMTTYPE.toUpperCase() !== "SH") { skipped.nonShare++; continue; }

    const cusip = (row.CUSIP || "").toUpperCase();
    if (!cusip) continue;
    if (wanted && !wanted.has(cusip)) continue;

    const shares = Number(row.SSHPRNAMT);
    if (!Number.isFinite(shares) || shares <= 0) continue;

    periods.set(submission.periodOfReport, (periods.get(submission.periodOfReport) ?? 0) + 1);
    const entry = byCusip.get(cusip) ?? { shares: 0, holders: 0 };
    entry.shares += shares;
    entry.holders += 1;
    byCusip.set(cusip, entry);
  }

  // One quarterly data set covers one period; if several appear, the dominant one wins
  // and the caller can compare it against the quarter it asked for.
  let periodOfReport = null;
  let bestCount = -1;
  for (const [period, count] of periods) if (count > bestCount) { periodOfReport = period; bestCount = count; }

  return { periodOfReport, byCusip, skipped };
}

/**
 * Reshape aggregated quarters into the per-ticker series lib/thirteen-f.js consumes.
 *
 * @param {{periodOfReport:string, publishedAt:string, byCusip:Map}[]} aggregatedQuarters
 * @param {Record<string,string>} cusipByTicker
 * @returns {Record<string, {periodEnd:string, publishedAt:string, institutionalShares:number}[]>}
 */
export function toTickerQuarters(aggregatedQuarters = [], cusipByTicker = {}) {
  const out = {};
  for (const [ticker, cusip] of Object.entries(cusipByTicker)) {
    if (!cusip) continue; // unmapped ticker → no rows → metric reports missing, rescaled out
    const key = String(cusip).toUpperCase();
    const rows = [];
    for (const quarter of aggregatedQuarters) {
      const entry = quarter.byCusip?.get?.(key);
      if (!entry) continue;
      rows.push({
        periodEnd: quarter.periodOfReport,
        publishedAt: quarter.publishedAt ?? null,
        institutionalShares: entry.shares,
        holders: entry.holders,
      });
    }
    if (rows.length) out[ticker] = rows.sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
  }
  return out;
}
