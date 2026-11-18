/**
 * CUSIP ↔ ticker mapping for 13F ingestion, from two free sources.
 *
 * 13F information tables identify holdings by CUSIP. The CUSIP master file is licensed, and
 * OpenFIGI's ticker lookup does not return CUSIPs, so the direction is reversed: take the
 * CUSIPs that appear in the 13F data set itself and ask which ticker each one is.
 *
 *   1. OpenFIGI `ID_CUSIP` → ticker (free; an API key, OPENFIGI_API_KEY, raises the limits).
 *      Only US-listed equity share lines are accepted, and a CUSIP that maps to more than one
 *      distinct ticker is ambiguous, so it stays unmapped.
 *   2. The SEC fails-to-deliver files, which list CUSIP and SYMBOL side by side.
 *
 * `reconcileCusipMap` combines them: both agree → mapped; they disagree → unmapped and
 * reported; only one has it → mapped, with its source recorded. A ticker reached by two
 * CUSIPs keeps the one both sources confirm, otherwise none. FAILS CLOSED throughout: a wrong
 * CUSIP would attribute another company's ownership to this one, which is worse than a gap
 * (an unmapped ticker contributes no 13F rows, so the metric is rescaled out, never zero).
 */

const OPENFIGI_URL = "https://api.openfigi.com/v3/mapping";
/** OpenFIGI's batch ceilings: 100 jobs a request with a key, 10 without. */
export const MAX_JOBS_PER_REQUEST = 100;
export const MAX_JOBS_PER_REQUEST_NO_KEY = 10;
/** Pacing that stays inside the free limits (25 requests / 6 s with a key, 25 / minute without). */
export const PACE_MS_WITH_KEY = 300;
export const PACE_MS_NO_KEY = 2600;

/** Security types that are share ownership (not notes, warrants, funds' units, options). */
export const ACCEPTED_SECURITY_TYPES = Object.freeze(["Common Stock", "REIT", "ADR", "Depositary Receipt"]);

export const isCusip = (value) => typeof value === "string" && /^[0-9A-Z]{8}[0-9]$/.test(value.toUpperCase());

/** OpenFIGI writes share classes with "/" (BRK/B); the catalog uses "-" (BRK-B). */
export const normalizeTicker = (value) => String(value ?? "").trim().toUpperCase().replace(/\//g, "-").replace(/\s+/g, "");

export function chunk(items, size = MAX_JOBS_PER_REQUEST) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The single ticker an OpenFIGI result names for a US equity share line, or null (none / ambiguous). */
export function tickerFromFigiResult(result) {
  const data = Array.isArray(result?.data) ? result.data : [];
  const tickers = new Set(
    data
      .filter((d) => d?.exchCode === "US" && (d?.marketSector == null || d.marketSector === "Equity") && ACCEPTED_SECURITY_TYPES.includes(d?.securityType))
      .map((d) => normalizeTicker(d.ticker))
      .filter(Boolean),
  );
  return tickers.size === 1 ? [...tickers][0] : null;
}

/**
 * @param {string[]} cusips
 * @param {object} [options]
 * @param {Record<string,string|null>} [options.cache]  previously resolved { CUSIP: TICKER|null }
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string|null} [options.apiKey]
 * @param {(ms:number)=>Promise<void>} [options.sleep]
 * @returns {Promise<{ tickerByCusip: Record<string,string|null>, requested: number, resolved: number, ambiguous: string[], errors: string[] }>}
 */
export async function resolveTickersForCusips(cusips = [], { cache = {}, fetchImpl = fetch, apiKey = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const key = String(apiKey ?? "").trim() || null;
  const tickerByCusip = { ...cache };
  const errors = [];
  const ambiguous = [];
  const pending = [...new Set(cusips.map((c) => String(c ?? "").trim().toUpperCase()).filter(isCusip))].filter((c) => !(c in tickerByCusip));
  const batches = chunk(pending, key ? MAX_JOBS_PER_REQUEST : MAX_JOBS_PER_REQUEST_NO_KEY);

  for (const [i, batch] of batches.entries()) {
    if (i > 0) await sleep(key ? PACE_MS_WITH_KEY : PACE_MS_NO_KEY);
    const jobs = batch.map((cusip) => ({ idType: "ID_CUSIP", idValue: cusip }));
    let payload;
    try {
      const response = await fetchImpl(OPENFIGI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "X-OPENFIGI-APIKEY": key } : {}) },
        body: JSON.stringify(jobs),
      });
      if (!response.ok) throw new Error(`OpenFIGI HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      // Left out of the result (not cached as null) so a later run retries them.
      errors.push(`${batch[0]}..${batch.at(-1)}: ${error.message}`);
      continue;
    }
    if (!Array.isArray(payload) || payload.length !== jobs.length) {
      // Positional contract broken: we cannot tell which answer belongs to which CUSIP.
      errors.push(`OpenFIGI returned ${Array.isArray(payload) ? payload.length : "non-array"} results for ${jobs.length} jobs`);
      continue;
    }
    batch.forEach((cusip, j) => {
      const ticker = tickerFromFigiResult(payload[j]);
      const usTickers = new Set((payload[j]?.data ?? []).filter((d) => d?.exchCode === "US").map((d) => normalizeTicker(d.ticker)).filter(Boolean));
      if (!ticker && usTickers.size > 1) ambiguous.push(cusip);
      tickerByCusip[cusip] = ticker;
    });
  }
  const resolvedCount = pending.filter((c) => tickerByCusip[c]).length;
  return { tickerByCusip, requested: pending.length, resolved: resolvedCount, ambiguous, errors };
}

/**
 * SEC fails-to-deliver file (pipe-separated, header first, trailer lines ignored).
 * @returns {Map<string, Set<string>>} CUSIP → symbols seen for it
 */
export function parseFailsToDeliver(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("fails-to-deliver: empty file");
  const header = lines[0].split("|").map((c) => c.trim().toUpperCase());
  const cusipAt = header.indexOf("CUSIP");
  const symbolAt = header.indexOf("SYMBOL");
  if (cusipAt < 0 || symbolAt < 0) throw new Error(`fails-to-deliver: missing CUSIP/SYMBOL columns (found: ${header.join(", ")})`);
  const out = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split("|");
    const cusip = String(cells[cusipAt] ?? "").trim().toUpperCase();
    const symbol = normalizeTicker(cells[symbolAt]);
    if (!isCusip(cusip) || !symbol) continue;
    if (!out.has(cusip)) out.set(cusip, new Set());
    out.get(cusip).add(symbol);
  }
  return out;
}

/** Merge several fails-to-deliver maps. */
export function mergeFtdMaps(maps = []) {
  const out = new Map();
  for (const map of maps) for (const [cusip, symbols] of map) {
    if (!out.has(cusip)) out.set(cusip, new Set());
    for (const symbol of symbols) out.get(cusip).add(symbol);
  }
  return out;
}

/**
 * @param {object} args
 * @param {Record<string,string|null>} args.figi   CUSIP → ticker from OpenFIGI
 * @param {Map<string,Set<string>>} args.ftd        CUSIP → symbols from fails-to-deliver
 * @param {Iterable<string>|null} [args.tickers]    keep only these (the universe catalog)
 * @returns {{ cusipByTicker: Record<string,{cusip:string, sources:string[]}>, conflicts: object[], counts: object }}
 */
export function reconcileCusipMap({ figi = {}, ftd = new Map(), tickers = null } = {}) {
  const universe = tickers == null ? null : new Set([...tickers].map(normalizeTicker));
  const conflicts = [];
  const candidates = new Map(); // ticker → [{cusip, sources}]
  const cusips = new Set([...Object.keys(figi), ...ftd.keys()]);
  const counts = { both: 0, figiOnly: 0, ftdOnly: 0, disagree: 0, ftdAmbiguous: 0, outsideUniverse: 0 };
  for (const cusip of cusips) {
    const fromFigi = figi[cusip] ? normalizeTicker(figi[cusip]) : null;
    const ftdSymbols = ftd.get(cusip) ?? new Set();
    const fromFtd = ftdSymbols.size === 1 ? [...ftdSymbols][0] : null;
    if (ftdSymbols.size > 1) counts.ftdAmbiguous += 1;
    let ticker = null;
    let sources = [];
    if (fromFigi && fromFtd) {
      if (fromFigi === fromFtd) { ticker = fromFigi; sources = ["openfigi", "sec_ftd"]; counts.both += 1; }
      else { conflicts.push({ cusip, openfigi: fromFigi, sec_ftd: fromFtd }); counts.disagree += 1; continue; }
    } else if (fromFigi) { ticker = fromFigi; sources = ["openfigi"]; counts.figiOnly += 1; }
    else if (fromFtd) { ticker = fromFtd; sources = ["sec_ftd"]; counts.ftdOnly += 1; }
    if (!ticker) continue;
    if (universe && !universe.has(ticker)) { counts.outsideUniverse += 1; continue; }
    if (!candidates.has(ticker)) candidates.set(ticker, []);
    candidates.get(ticker).push({ cusip, sources });
  }
  const cusipByTicker = {};
  for (const [ticker, options] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (options.length === 1) { cusipByTicker[ticker] = options[0]; continue; }
    const confirmed = options.filter((option) => option.sources.length === 2);
    if (confirmed.length === 1) cusipByTicker[ticker] = confirmed[0];
    else conflicts.push({ ticker, cusips: options.map((option) => option.cusip) });
  }
  return { cusipByTicker, conflicts, counts };
}
