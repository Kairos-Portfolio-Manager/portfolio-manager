/**
 * Estimate revisions — SHADOW comparison of the vendor-reported 30-day change against the
 * change we measure ourselves. Never scored.
 *
 * WHY: the mandate scores estimate revisions only from our OWN stored consensus snapshots
 * (≥3 spanning ≥30 days), because a vendor's "estimate 30 days ago" is a claim we cannot
 * check later. Every snapshot already carries Yahoo's own trailing estimates
 * (`vendorEpsTrend`: current, 7/30/60/90 days ago), so a vendor-reported 30-day change is
 * available from the first snapshot of any ticker. This module computes it, and — once our
 * own history reaches 30 days — the self-measured change for the same ticker, and reports
 * how well the two agree. If they agree closely, switching to the vendor figure becomes an
 * evidence-based mandate change (an owner decision); if not, the rule was right.
 *
 * Both sides compare the SAME fiscal period (the vendor trend is per period; our pair must
 * share `periodEndDate`), so a quarter rollover can never pass for a revision.
 *
 * Pure. Reads only consensus rows (`lib/consensus-snapshot.js` shape). Writes nothing.
 */

export const VENDOR_REVISION_VERSION = "pitch-lab.vendor-revisions.v1";

export const VENDOR_REVISION_RULES = Object.freeze({
  targetDays: 30, // the mandate's window
  minDays: 25, // a self-measured pair must be this far apart...
  maxDays: 40, // ...and no further
  agreeWithinPoints: 1, // "close" = within this many percentage points of each other
  minPairsForVerdict: 20, // tickers compared before an agreement verdict is given
});

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const pctChange = (from, to) => (from == null || to == null || from === 0 ? null : ((to - from) / Math.abs(from)) * 100);

/** The mandate's magnitude bands for a 30-day EPS change, used to compare the two sides on what matters for scoring. */
export function revisionBand(changePct) {
  if (!Number.isFinite(changePct)) return null;
  if (changePct >= 5) return "up_5_plus";
  if (changePct >= 2) return "up_2_to_5";
  if (changePct >= 0) return "up_0_to_2";
  return "down";
}

/** Yahoo's own 30-day change in the EPS consensus for the snapshot's period, in percent. */
export function vendorRevisionFromSnapshot(snapshot) {
  const trend = snapshot?.vendorEpsTrend ?? null;
  const current = finite(trend?.current) ?? finite(snapshot?.epsAvg);
  const changePct = pctChange(finite(trend?.days30), current);
  if (changePct == null) return null;
  return {
    changePct: round(changePct),
    band: revisionBand(changePct),
    asOf: snapshot?.retrievedAt ?? null,
    periodEndDate: snapshot?.periodEndDate ?? null,
    up30: finite(snapshot?.vendorEpsRevisions?.up30),
    down30: finite(snapshot?.vendorEpsRevisions?.down30),
  };
}

/**
 * Our own 30-day change: the newest snapshot vs the snapshot closest to `targetDays` before it,
 * same fiscal period, between `minDays` and `maxDays` apart. Null when no such pair exists.
 */
export function selfMeasuredRevision(history = [], rules = VENDOR_REVISION_RULES) {
  const opts = { ...VENDOR_REVISION_RULES, ...rules };
  const rows = history
    .filter((row) => Number.isFinite(Date.parse(row?.retrievedAt ?? "")) && finite(row?.epsAvg) != null)
    .sort((a, b) => Date.parse(a.retrievedAt) - Date.parse(b.retrievedAt));
  const newest = rows.at(-1);
  if (!newest) return null;
  const newestAt = Date.parse(newest.retrievedAt);
  const candidates = rows.filter((row) => {
    if (row === newest || (row.periodEndDate ?? null) !== (newest.periodEndDate ?? null)) return false;
    const days = (newestAt - Date.parse(row.retrievedAt)) / 86_400_000;
    return days >= opts.minDays && days <= opts.maxDays;
  });
  if (!candidates.length) return null;
  const base = candidates.reduce((best, row) => {
    const gap = (r) => Math.abs((newestAt - Date.parse(r.retrievedAt)) / 86_400_000 - opts.targetDays);
    // Ties go to the more recent snapshot (rows are oldest first).
    return gap(row) <= gap(best) ? row : best;
  });
  const changePct = pctChange(finite(base.epsAvg), finite(newest.epsAvg));
  if (changePct == null) return null;
  return {
    changePct: round(changePct),
    band: revisionBand(changePct),
    fromAt: base.retrievedAt,
    toAt: newest.retrievedAt,
    days: round((newestAt - Date.parse(base.retrievedAt)) / 86_400_000, 1),
    periodEndDate: newest.periodEndDate ?? null,
  };
}

/**
 * The vendor figure to compare with a self-measured change: the vendor's 30-day change as it
 * stood on the SAME day our newest snapshot was taken (that snapshot's own vendor trend), so
 * both sides describe the same 30 days.
 */
function vendorAtSameInstant(history, self) {
  const newest = history.find((row) => row?.retrievedAt === self.toAt);
  return newest ? vendorRevisionFromSnapshot(newest) : null;
}

/**
 * Shadow summary over pitches. Each ticker counts once, from its most recent pitch's frozen
 * consensus inputs (point-in-time, exactly what that pitch saw).
 *
 * @param {object[]} pitches stored pitches (only `mandateInputs.consensus` is read)
 * @returns {object} { version, status, tickersWithVendor, pairsCompared, agreement, rows[] }
 *   status: "no_vendor_data" | "collecting" (vendor figures, no 30-day self pairs yet) |
 *           "comparing" (some pairs, below the verdict minimum) | "verdict"
 */
export function buildVendorRevisionShadow(pitches = [], rules = VENDOR_REVISION_RULES) {
  const opts = { ...VENDOR_REVISION_RULES, ...rules };
  const latestByTicker = new Map();
  for (const pitch of pitches) {
    if (!pitch?.ticker || !pitch?.mandateInputs?.consensus) continue;
    const seen = latestByTicker.get(pitch.ticker);
    if (!seen || Date.parse(pitch.pitchedAt) > Date.parse(seen.pitchedAt)) latestByTicker.set(pitch.ticker, pitch);
  }

  const rows = [];
  for (const [ticker, pitch] of [...latestByTicker.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const consensus = pitch.mandateInputs.consensus;
    const history = Array.isArray(consensus.history) ? consensus.history : [];
    const latest = consensus.snapshot ?? history.at(-1) ?? null;
    const vendorNow = vendorRevisionFromSnapshot(latest);
    const self = selfMeasuredRevision(history, opts);
    const vendorSame = self ? vendorAtSameInstant(history, self) : null;
    if (!vendorNow && !self) continue;
    const difference = self && vendorSame ? round(vendorSame.changePct - self.changePct) : null;
    rows.push({
      ticker,
      pitchedAt: pitch.pitchedAt ?? null,
      vendorChangePct: vendorNow?.changePct ?? null,
      vendorBand: vendorNow?.band ?? null,
      selfChangePct: self?.changePct ?? null,
      selfBand: self?.band ?? null,
      selfDays: self?.days ?? null,
      vendorChangePctSameWindow: vendorSame?.changePct ?? null,
      differencePoints: difference,
      sameBand: self && vendorSame ? self.band === vendorSame.band : null,
    });
  }

  const pairs = rows.filter((row) => row.differencePoints != null);
  const absDiffs = pairs.map((row) => Math.abs(row.differencePoints)).sort((a, b) => a - b);
  const median = absDiffs.length ? (absDiffs.length % 2 ? absDiffs[(absDiffs.length - 1) / 2] : (absDiffs[absDiffs.length / 2 - 1] + absDiffs[absDiffs.length / 2]) / 2) : null;
  const share = (predicate) => (pairs.length ? round(pairs.filter(predicate).length / pairs.length) : null);
  const agreement = pairs.length ? {
    pairs: pairs.length,
    medianAbsDifferencePoints: round(median),
    withinPoints: opts.agreeWithinPoints,
    shareWithin: share((row) => Math.abs(row.differencePoints) <= opts.agreeWithinPoints),
    shareSameBand: share((row) => row.sameBand),
    shareSameDirection: share((row) => Math.sign(row.vendorChangePctSameWindow) === Math.sign(row.selfChangePct)),
  } : null;

  let status = "no_vendor_data";
  if (rows.some((row) => row.vendorChangePct != null)) status = "collecting";
  if (pairs.length) status = pairs.length >= opts.minPairsForVerdict ? "verdict" : "comparing";
  let verdict = null;
  if (status === "verdict") {
    verdict = agreement.shareSameBand >= 0.9 && agreement.shareWithin >= 0.8 ? "vendor_matches"
      : agreement.shareSameBand >= 0.7 ? "vendor_mostly_matches" : "vendor_differs";
  }

  return {
    version: VENDOR_REVISION_VERSION,
    status,
    verdict,
    rules: { ...opts },
    tickersWithVendor: rows.filter((row) => row.vendorChangePct != null).length,
    pairsCompared: pairs.length,
    agreement,
    rows,
  };
}
