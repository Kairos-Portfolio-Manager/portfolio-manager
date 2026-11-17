/**
 * Which tickers the Pitch Lab consensus collector should observe today.
 *
 * WHY: the mandate's estimate-revisions metric only activates once a ticker has at
 * least three consensus snapshots spanning thirty days, and revenue beat needs a
 * snapshot taken before the quarter was reported. Snapshots were only being taken for
 * names the universe and peer jobs happened to touch, so most pitched names had no
 * history and both metrics came back "no data". This plans a daily pass over the pool
 * Agent One actually pitches from.
 *
 * Pure: a ranked pool and last-seen times in, an ordered list of tickers out.
 *   1. The top of Agent One's attention ranking — the names most likely to be pitched
 *      soon — every day.
 *   2. Then everything else, least recently observed first (never-observed first), so the
 *      whole pool is revisited every pool/limit days.
 * A ticker observed within `minGapHours` is skipped: a second snapshot the same day adds
 * nothing to a thirty-day span.
 */
export const DEFAULT_CONSENSUS_PLAN = Object.freeze({ limit: 250, topPriority: 60, minGapHours: 20 });

const HOUR_MS = 3_600_000;

/**
 * @param {object} args
 * @param {string[]} args.rankedTickers  the pool, best first
 * @param {Map<string,string>|object} [args.lastSeen]  ticker → ISO instant of its newest snapshot
 * @param {Date} [args.now]
 * @returns {{ tickers: string[], poolSize: number, fresh: number, neverSeen: number, priority: number, daysToCoverPool: number|null }}
 */
export function planConsensusCollection({ rankedTickers = [], lastSeen = new Map(), now = new Date(), limit = DEFAULT_CONSENSUS_PLAN.limit, topPriority = DEFAULT_CONSENSUS_PLAN.topPriority, minGapHours = DEFAULT_CONSENSUS_PLAN.minGapHours } = {}) {
  if (!(Number.isInteger(limit) && limit > 0)) throw new TypeError("limit must be a positive integer");
  const seenAt = (ticker) => {
    const value = lastSeen instanceof Map ? lastSeen.get(ticker) : lastSeen?.[ticker];
    const at = Date.parse(value ?? "");
    return Number.isFinite(at) ? at : null;
  };
  const nowMs = new Date(now).getTime();
  const pool = [...new Set(rankedTickers.map((ticker) => String(ticker ?? "").trim().toUpperCase()).filter(Boolean))];
  const rank = new Map(pool.map((ticker, index) => [ticker, index]));
  const due = pool.filter((ticker) => {
    const at = seenAt(ticker);
    return at == null || nowMs - at >= minGapHours * HOUR_MS;
  });
  const priority = due.filter((ticker) => rank.get(ticker) < topPriority);
  const rest = due
    .filter((ticker) => rank.get(ticker) >= topPriority)
    .sort((a, b) => (seenAt(a) ?? -Infinity) - (seenAt(b) ?? -Infinity) || rank.get(a) - rank.get(b));
  const tickers = [...priority, ...rest].slice(0, limit);
  const rotating = Math.max(1, limit - Math.min(topPriority, pool.length));
  return {
    tickers,
    poolSize: pool.length,
    fresh: pool.length - due.length,
    neverSeen: pool.filter((ticker) => seenAt(ticker) == null).length,
    priority: Math.min(priority.length, tickers.length),
    // Rough days for the rotating part to visit the whole pool once.
    daysToCoverPool: pool.length ? Math.ceil(Math.max(0, pool.length - topPriority) / rotating) : null,
  };
}
