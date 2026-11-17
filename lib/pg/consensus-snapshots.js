/**
 * Durable, append-only consensus-snapshot history (db/migrations/0008).
 *
 * WHY POSTGRES AND NOT REDIS: `estimateRevisions` is a change measured between
 * two instants this system observed. Redis peer metrics are a TTL cache, so an
 * expiry there would silently reset the 90-day window and present the reset as
 * "no revision signal" — indistinguishable from a genuinely flat consensus.
 * The same point-in-time argument lib/pg/research-observations.js makes for
 * score observations applies verbatim here.
 *
 * Reads are point-in-time (`asOf`) for the same reason proposal gating is: a
 * scoring pass must never difference against a snapshot collected after its own
 * decision time.
 */
import { TICKER_RE } from "../../contracts/proposal.js";
import { canonicalJson, contentHash } from "../research-version.js";
import { getPool, pgConfigured } from "./client.js";

const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * How far back a history read reaches. The longest window any agent's
 * estimateRevisions table asks for is 90 days (Agent 3); 240 bounds the row
 * count per ticker while leaving generous slack for collection gaps.
 */
export const HISTORY_LOOKBACK_DAYS = 240;

export class ConsensusStoreNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not configured — durable consensus history is unavailable.");
    this.name = "ConsensusStoreNotConfiguredError";
    this.code = "PG_CONSENSUS_NOT_CONFIGURED";
  }
}

function resolvePool(pool) {
  if (pool) return pool;
  if (!pgConfigured()) throw new ConsensusStoreNotConfiguredError();
  return getPool();
}

async function queryWith(options, text, params) {
  if (options.client) return options.client.query(text, params);
  return resolvePool(options.pool).query(text, params);
}

function requireText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized;
}

function requireIso(value, field) {
  const normalized = requireText(value, field);
  if (!ISO_WITH_OFFSET_RE.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw new TypeError(`${field} must be an ISO timestamp with an offset`);
  }
  return normalized;
}

function requireTicker(value) {
  const normalized = requireText(value, "ticker").toUpperCase();
  if (!TICKER_RE.test(normalized)) throw new TypeError("ticker must be a canonical ticker");
  return normalized;
}

/** True only when a database is configured (or a test pool has been injected). */
export function consensusStoreConfigured({ pool } = {}) {
  return Boolean(pool) || pgConfigured();
}

/**
 * Normalize one `consensusSnapshotRow()` result into a storable row.
 *
 * The identity hash covers ticker + period + retrieval instant only, NOT the
 * estimate values: re-collecting the same instant must be a no-op insert, while
 * a genuinely new observation of the same period at a later instant is a new
 * row. Hashing the values instead would let a duplicate pass whenever an
 * estimate happened to tick.
 */
export function normalizeConsensusSnapshot(snapshot) {
  const ticker = requireTicker(snapshot?.ticker);
  const period = requireText(snapshot?.period, "period");
  const retrievedAt = requireIso(snapshot?.retrievedAt, "retrievedAt");
  const identity = { ticker, period, retrievedAt };
  const hash = contentHash(identity);
  const periodEndDate = snapshot?.periodEndDate == null
    ? null
    : requireIso(snapshot.periodEndDate, "periodEndDate");
  const epsAvg = Number.isFinite(snapshot?.epsAvg) ? snapshot.epsAvg : null;
  const revenueAvg = Number.isFinite(snapshot?.revenueAvg) ? snapshot.revenueAvg : null;
  if (epsAvg == null && revenueAvg == null) {
    throw new TypeError("a consensus snapshot must carry at least one of epsAvg / revenueAvg");
  }
  // Round-trip through canonical JSON so a non-plain object (Date, class
  // instance, cycle) fails here rather than at the driver boundary.
  const payload = JSON.parse(canonicalJson({ ...snapshot, ticker, retrievedAt }));
  return {
    id: `cs_${hash.slice(0, 32)}`,
    ticker,
    period,
    retrievedAt,
    periodEndDate,
    epsAvg,
    revenueAvg,
    source: requireText(snapshot?.source ?? "yahoo_earnings_trend", "source"),
    payload,
    contentHash: hash,
  };
}

/**
 * Append a batch of observed snapshots. Duplicate instants are ignored rather
 * than raising: a collection pass that overlaps a previous one is normal
 * operation, not a replay conflict, because the identity hash is value-free.
 *
 * The whole batch is normalized before any write, so a malformed later row
 * cannot leave earlier rows committed.
 */
export async function writeConsensusSnapshots(snapshots, options = {}) {
  if (!Array.isArray(snapshots)) throw new TypeError("snapshots must be an array");
  const normalized = snapshots.map(normalizeConsensusSnapshot);
  let inserted = 0;
  for (const row of normalized) {
    const result = await queryWith(options, `
      INSERT INTO consensus_snapshots (
        id, ticker, period, retrieved_at, period_end_date, eps_avg, revenue_avg, source, payload, content_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [
      row.id, row.ticker, row.period, row.retrievedAt, row.periodEndDate,
      row.epsAvg, row.revenueAvg, row.source, row.payload, row.contentHash,
    ]);
    inserted += result?.rowCount ?? result?.rows?.length ?? 0;
  }
  return { attempted: normalized.length, inserted };
}

function toHistoryRow(row) {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  // `retrievedAt` is what every downstream span/difference calculation keys on,
  // so it comes from the indexed column rather than the payload copy: the
  // column is what the uniqueness guarantee and the ordering were built on.
  const retrievedAt = row.retrieved_at instanceof Date
    ? row.retrieved_at.toISOString()
    : String(row.retrieved_at);
  return { ...payload, ticker: row.ticker, period: row.period, retrievedAt };
}

/**
 * Read observed history for many tickers in one query, oldest → newest per
 * ticker, bounded to `HISTORY_LOOKBACK_DAYS` before `asOf`.
 *
 * Batched deliberately: the whole-market scoring pass covers thousands of
 * names, and a per-ticker round trip would put a query storm in front of every
 * run for evidence that is advisory only.
 *
 * @returns {Promise<Map<string, object[]>>} ticker → snapshots, oldest first
 */
export async function readConsensusHistories({ tickers = [], asOf, lookbackDays = HISTORY_LOOKBACK_DAYS } = {}, options = {}) {
  const normalizedAsOf = requireIso(asOf, "asOf");
  const normalizedTickers = [...new Set(tickers.map((ticker) => requireTicker(ticker)))];
  const histories = new Map();
  if (!normalizedTickers.length) return histories;
  const since = new Date(Date.parse(normalizedAsOf) - lookbackDays * 86_400_000).toISOString();
  const result = await queryWith(options, `
    SELECT ticker, period, retrieved_at, payload
    FROM consensus_snapshots
    WHERE ticker = ANY($1) AND retrieved_at <= $2 AND retrieved_at >= $3
    ORDER BY ticker ASC, retrieved_at ASC
  `, [normalizedTickers, normalizedAsOf, since]);
  for (const row of result?.rows ?? []) {
    const list = histories.get(row.ticker) ?? [];
    list.push(toHistoryRow(row));
    histories.set(row.ticker, list);
  }
  return histories;
}

/**
 * When each ticker was last observed, for collectors that rotate through a large list.
 * Tickers that are not canonical are skipped rather than failing the whole read.
 *
 * @returns {Promise<Map<string, string>>} ticker → ISO instant of its newest snapshot
 */
export async function readLatestConsensusTimes({ tickers = [] } = {}, options = {}) {
  const normalized = [...new Set(tickers.map((ticker) => String(ticker ?? "").trim().toUpperCase()).filter((ticker) => TICKER_RE.test(ticker)))];
  const latest = new Map();
  if (!normalized.length) return latest;
  const result = await queryWith(options, `
    SELECT ticker, MAX(retrieved_at) AS latest
    FROM consensus_snapshots
    WHERE ticker = ANY($1)
    GROUP BY ticker
  `, [normalized]);
  for (const row of result?.rows ?? []) {
    latest.set(row.ticker, row.latest instanceof Date ? row.latest.toISOString() : String(row.latest));
  }
  return latest;
}
