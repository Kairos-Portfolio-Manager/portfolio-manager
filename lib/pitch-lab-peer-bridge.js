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
 *            PITCH_LAB_PEER_REQUESTS=1. It never writes peer metrics, proposals,
 *            ledgers or anything else, and never calls a model or an order path.
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
 * Dry run for one ticker: fetch what the research scan fetches (Yahoo
 * fundamentals, EDGAR facts, daily bars), build the metric list, rank it against
 * the peer table, and report. Records nothing and files no request unless
 * `requestsEnabled` is true. This is the Jetson check for real peer coverage.
 */
export async function peerCheck({
  ticker,
  now = () => new Date(),
  requestsEnabled = false,
  getFundamentals,
  getCompanyFacts,
  getBars,
  getMetrics,
  requestCoverage,
} = {}) {
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!symbol) throw new TypeError("peerCheck requires a ticker");
  const fetchFundamentals = getFundamentals ?? (await import("./yahoo.js")).fetchFundamentals;
  const fetchBars = getBars ?? (await import("./yahoo.js")).fetchDailyBars;
  const fetchFacts = getCompanyFacts ?? (await import("./edgar.js")).fetchCompanyFacts;

  const asOf = now().toISOString();
  const fundamentals = await fetchFundamentals(symbol);
  if (!fundamentals || fundamentals.error) throw new Error(`fundamentals unavailable for ${symbol}: ${fundamentals?.error ?? "no response"}`);
  let companyfacts = null;
  try {
    companyfacts = await fetchFacts(symbol);
  } catch (error) {
    console.warn(`[PitchLabPeers] EDGAR facts unavailable for ${symbol}: ${error?.message ?? error}`);
  }
  const bars = await fetchBars(symbol, { period1: new Date(Date.parse(asOf) - PRICE_HISTORY_DAYS * DAY_MS) });

  const features = buildFeatures({ fundamentals, companyfacts, bars, marketCap: fundamentals.marketCap ?? null, asOf });
  const { peers, request } = await peersForPitch({
    ticker: symbol,
    features,
    asOf,
    industry: fundamentals.industry ?? null,
    sector: fundamentals.sector ?? null,
    requestsEnabled,
    getMetrics,
    requestCoverage,
  });
  return { ticker: symbol, asOf, features, peers, request };
}
