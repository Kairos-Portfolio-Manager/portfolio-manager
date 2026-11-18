// SEC EDGAR requires a descriptive User-Agent with contact info — no API key needed.
export const SEC_USER_AGENT = "Sam Huffard Portfolio Manager research@samhuffard.dev";

let tickerCikMapPromise = null;

/** Ticker -> 10-digit zero-padded CIK, loaded once per process and cached in memory (the source file is ~9MB and rarely changes). */
function loadTickerCikMap() {
  if (!tickerCikMapPromise) {
    tickerCikMapPromise = fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": SEC_USER_AGENT } })
      .then((res) => res.json())
      .then((data) => {
        const map = {};
        for (const row of Object.values(data)) map[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, "0");
        return map;
      })
      .catch((err) => {
        tickerCikMapPromise = null; // allow retry on next call instead of caching a failure
        throw err;
      });
  }
  return tickerCikMapPromise;
}

/** Most recent SEC filings (10-K, 10-Q, 8-K, Form 4, etc.) for a ticker, newest first. Returns [] on any failure (unknown ticker, network, rate limit). */
export async function fetchRecentFilings(ticker, { limit = 5 } = {}) {
  try {
    const map = await loadTickerCikMap();
    const cik = map[ticker.trim().toUpperCase()];
    if (!cik) return [];

    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { "User-Agent": SEC_USER_AGENT } });
    const data = await res.json();
    const recent = data.filings?.recent;
    if (!recent?.form?.length) return [];

    const filings = [];
    for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
      filings.push({
        form: recent.form[i],
        filed: recent.filingDate[i],
        description: recent.primaryDocDescription?.[i] || recent.form[i],
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${recent.accessionNumber[i].replace(/-/g, "")}/${recent.primaryDocument[i]}`,
      });
    }
    return filings;
  } catch (err) {
    console.warn(`[EDGAR] fetchRecentFilings(${ticker}) failed:`, err.message);
    return [];
  }
}

// --- XBRL companyfacts (Mandate v2.1 §8: primary free fundamentals source) --------
// Parsing/derivation are pure in lib/edgar-facts.js + lib/edgar-metrics.js; this is I/O.

const EDGAR_RATE_MS = Math.max(0, Number(process.env.EDGAR_RATE_MS?.trim()) || 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve a ticker to its 10-digit zero-padded CIK, or null. */
export async function cikForTicker(ticker) {
  const map = await loadTickerCikMap();
  return map[ticker.trim().toUpperCase()] ?? null;
}

/**
 * Full XBRL companyfacts JSON for a ticker (all us-gaap concepts, every reported
 * period). Returns null (and logs) on any failure — callers treat missing EDGAR data
 * as vendor-lag and never fabricate. Paced for SEC etiquette.
 */
export async function fetchCompanyFacts(ticker) {
  try {
    const cik = await cikForTicker(ticker);
    if (!cik) return null;
    await sleep(EDGAR_RATE_MS);
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { "User-Agent": SEC_USER_AGENT } });
    if (!res.ok) throw new Error(`companyfacts ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[EDGAR] fetchCompanyFacts(${ticker}) failed:`, err.message);
    return null;
  }
}

/** Paced batch companyfacts fetch, gentle on SEC. */
export async function fetchCompanyFactsBatch(tickers) {
  const out = {};
  for (const t of tickers) {
    out[t] = await fetchCompanyFacts(t);
    await sleep(EDGAR_RATE_MS);
  }
  return out;
}
