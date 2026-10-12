/**
 * Pitch Lab ↔ peer-data bridge.
 *
 * Pitch Lab (lib/pitch-lab/) is deliberately database-free: a test fails if it
 * imports Redis, Sheets, Postgres or a broker. This module is the single, narrow
 * seam between it and the peer table the main pipeline already maintains:
 *
 *   READ   — `getPeerMetrics()`  (pm:peer-metrics, written by the nightly peer jobs)
 *   WRITE  — `requestPeerCoverage()` (the existing bounded, ticker-keyed request
 *            queue the 5:30 PM peer-coverage-refresh job consumes), and only when
 *            PITCH_LAB_PEER_REQUESTS=1; and `publishPitchLabReport()`, one constant
 *            namespaced key (`pitchlab:report`) for the website. It never writes
 *            peer metrics, proposals, ledgers or anything else, and never calls a
 *            model or an order path.
 *
 * Nothing imports this module from lib/pitch-lab/ (tested), and nothing schedules it.
 * Every dependency is injectable so the logic is unit-tested without Redis or network.
 */
import { buildFeatures } from "./pitch-lab/features.js";
import { computePeerRanks, hasCoverageGap } from "./pitch-lab/peer-rank.js";

export const PEER_REQUEST_SOURCE = "pitch-lab";
const PRICE_HISTORY_DAYS = 330; // ~220 sessions, enough for the 200-day average
const DAY_MS = 86_400_000;

export const peerRequestsEnabled = (env = process.env) => env.PITCH_LAB_PEER_REQUESTS?.trim() === "1";

/**
 * Peer ranks for one candidate pitch, plus (optionally) a coverage request for
 * any metric that could not be ranked.
 *
 * @returns {Promise<{peers: object, request: {filed: boolean, reason: string|null}}>}
 *   `peers` is the block to pass to buildPitch. `request` is for the caller's log
 *   only: it is not stored on the (immutable, content-hashed) pitch.
 */
export async function peersForPitch({
  ticker,
  features,
  asOf,
  industry = null,
  sector = null,
  requestsEnabled = peerRequestsEnabled(),
  getMetrics,
  requestCoverage,
} = {}) {
  const read = getMetrics ?? (await import("./redis.js")).getPeerMetrics;
  let peerMetrics = null;
  try {
    peerMetrics = await read();
  } catch (error) {
    console.error(`[PitchLabPeers] could not read the peer table for ${ticker}: ${error?.message ?? error}`);
  }

  const peers = computePeerRanks({ ticker, features, peerMetrics, asOf, industry, sector });
  const request = { filed: false, reason: null };
  // An outage is reported as one even though no individual metric shows a "gap".
  if (peers.reason === "peer_data_unavailable") return { peers, request: { filed: false, reason: "peer_data_unavailable" } };
  if (!hasCoverageGap(peers)) return { peers, request };

  if (!requestsEnabled) request.reason = "requests_disabled";
  else if (!peers.industry && !peers.sector) request.reason = "no_classification";
  else {
    try {
      const file = requestCoverage ?? (await import("./redis.js")).requestPeerCoverage;
      const stored = await file({ ticker, industry: peers.industry, sector: peers.sector, source: PEER_REQUEST_SOURCE });
      if (stored) request.filed = true;
      else request.reason = "request_not_stored";
    } catch (error) {
      request.reason = "request_failed";
      console.error(`[PitchLabPeers] peer coverage request for ${ticker} FAILED (its cohort will not be collected): ${error?.message ?? error}`);
    }
  }
  return { peers, request };
}

/**
 * Everything a pitch needs about one company, fetched the way the research scan
 * fetches it (Yahoo fundamentals, EDGAR facts, daily bars) and stamped at one
 * instant. Bars dated after `asOf` are dropped so no price feature looks ahead.
 * Throws when fundamentals or price bars are unavailable: a pitch with no entry
 * reference cannot be graded, so the caller must drop it loudly, not pitch blind.
 */
export async function gatherCandidateData({
  ticker,
  now = () => new Date(),
  getFundamentals,
  getCompanyFacts,
  getBars,
} = {}) {
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!symbol) throw new TypeError("gatherCandidateData requires a ticker");
  const fetchFundamentals = getFundamentals ?? (await import("./yahoo.js")).fetchFundamentals;
  const fetchBars = getBars ?? (await import("./yahoo.js")).fetchDailyBars;
  const fetchFacts = getCompanyFacts ?? (await import("./edgar.js")).fetchCompanyFacts;

  const asOf = now().toISOString();
  const asOfMs = Date.parse(asOf);
  const fundamentals = await fetchFundamentals(symbol);
  if (!fundamentals || fundamentals.error) throw new Error(`fundamentals unavailable for ${symbol}: ${fundamentals?.error ?? "no response"}`);
  let companyfacts = null;
  try {
    companyfacts = await fetchFacts(symbol);
  } catch (error) {
    console.warn(`[PitchLabPeers] EDGAR facts unavailable for ${symbol}: ${error?.message ?? error}`);
  }
  const fetched = await fetchBars(symbol, { period1: new Date(asOfMs - PRICE_HISTORY_DAYS * DAY_MS) });
  const bars = (Array.isArray(fetched) ? fetched : []).filter((bar) => {
    const at = bar?.date instanceof Date ? bar.date.getTime() : Date.parse(bar?.date);
    return Number.isFinite(at) && at <= asOfMs;
  });
  const last = bars.at(-1);
  const price = last?.close;
  if (!(typeof price === "number" && Number.isFinite(price) && price > 0)) throw new Error(`no price bars for ${symbol}: no entry reference`);
  const lastAt = last.date instanceof Date ? last.date : new Date(last.date);

  const features = buildFeatures({ fundamentals, companyfacts, bars, marketCap: fundamentals.marketCap ?? null, asOf });
  return {
    ticker: symbol,
    asOf,
    fundamentals,
    companyfacts,
    bars,
    features,
    entryReference: { price, asOf: lastAt.toISOString() },
    industry: fundamentals.industry ?? null,
    sector: fundamentals.sector ?? null,
  };
}

/**
 * Dry run for one ticker: gather the data the scan gathers, rank it against
 * the peer table, and report. Records nothing and files no request unless
 * `requestsEnabled` is true. This is the Jetson check for real peer coverage.
 */
export async function peerCheck({ ticker, requestsEnabled = false, getMetrics, requestCoverage, ...fetchers } = {}) {
  const data = await gatherCandidateData({ ticker, ...fetchers });
  const { peers, request } = await peersForPitch({
    ticker: data.ticker,
    features: data.features,
    asOf: data.asOf,
    industry: data.industry,
    sector: data.sector,
    requestsEnabled,
    getMetrics,
    requestCoverage,
  });
  return { ticker: data.ticker, asOf: data.asOf, features: data.features, peers, request };
}

export const PITCH_LAB_REPORT_KEY = "pitchlab:report";

/**
 * Publish the weekly report for the website to read. The ONLY write besides
 * the coverage-request queue, and confined to one namespaced key: the key is a
 * constant, never caller-supplied, so this cannot touch a pm:* production key.
 * Returns true when stored; false (and loud) when Redis is not configured.
 */
export async function publishPitchLabReport(report, { redis, now = () => new Date() } = {}) {
  if (!report || typeof report !== "object" || !report.schemaVersion) throw new TypeError("publishPitchLabReport requires a report with a schemaVersion");
  const client = redis ?? (await import("./redis.js")).getRedis();
  if (!client) {
    console.error("[PitchLabPeers] Redis not configured — Pitch Lab report NOT published.");
    return false;
  }
  await client.set(PITCH_LAB_REPORT_KEY, JSON.stringify({ publishedAt: now().toISOString(), report }));
  return true;
}
