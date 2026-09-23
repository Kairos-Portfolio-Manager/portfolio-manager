// Pure freshness-policy resolver for the two source families Sam and his
// investing partner have actually decided (Q-002 consensus estimates,
// Q-003 entry quotes), recorded verbatim in docs/RESEARCH-DECISION-REGISTER.md
// and ~/Claude Memory/Projects/pm-codex-claude-conversation.md (2026-09-21).
//
// Deliberately does NOT resolve freshness for the four EDGAR-companyfacts
// metrics (balanceSheet, epsTrajectory, marginTrend, revGrowth) or for 13F's
// own freshness (separate from its thesis-critical status) — no policy exists
// for either yet. Inventing one here would be exactly the mistake the 2026-09-21
// session flagged: "do not ask an implementation agent to invent a threshold."
//
// No Redis, Postgres, network, or LLM dependency. Pass real timestamps in.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function parseIso(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Q-002 — consensus estimate freshness (revBeat, estimateRevisions).
 *
 * Decided policy:
 *   - Age limit: fresh only if the provider snapshot is <= 30 calendar days
 *     old at observation time (Choice C).
 *   - Event invalidation: after reported earnings, new guidance, or a material
 *     filing, the prior snapshot goes stale at the next regular-market session
 *     open and stays stale until a newer provider timestamp is observed
 *     (Choice A).
 *   - Consequence: missing/stale required estimate -> "stale"/"unavailable";
 *     the candidate cannot be actionable on that metric (Choice A).
 *
 * `retrievedAt` is accepted as the provider-timestamp proxy for a live-queried
 * endpoint (Yahoo does not expose a separate provider stamp) per the accepted
 * reasoning on 2026-09-21: "the retrieval instant IS a sound proxy for
 * provider currency" for this source family specifically.
 */
export function resolveConsensusFreshness({ retrievedAt, now, nextSessionOpenAfterEvent = null } = {}) {
  const retrievedMs = parseIso(retrievedAt);
  const nowMs = parseIso(now);
  if (retrievedMs === null || nowMs === null) return "unavailable";
  if (retrievedMs > nowMs) return "unavailable"; // future timestamp is not evidence

  const eventCutoffMs = parseIso(nextSessionOpenAfterEvent);
  if (eventCutoffMs !== null && nowMs >= eventCutoffMs && retrievedMs < eventCutoffMs) {
    return "stale"; // superseded by a reported event, regardless of age
  }

  const ageMs = nowMs - retrievedMs;
  return ageMs <= 30 * DAY_MS ? "fresh" : "stale";
}

/**
 * Q-003 — entry quote freshness (peerValuation, and any future metric priced
 * off a live quote).
 *
 * Decided policy:
 *   - Regular session: fresh only if the quote timestamp is <= 5 minutes old
 *     (Choice A).
 *   - Outside regular hours: a last-regular-close quote may support
 *     research-only use but never an execution-ready read at proposal
 *     creation (Choice A, confirmed applicable because execution readiness is
 *     evaluated at Sam's approval, not at scan time — docs commit `ae957b2`).
 *   - Material-event invalidation: reported earnings, new guidance, or a
 *     material filing makes the proposal research-only until refreshed
 *     (Choice A now).
 *
 * `inRegularSession` must be supplied by the caller from the market calendar —
 * this module has no calendar dependency by design (stays pure/testable).
 */
export function resolveQuoteFreshness({ quoteTimestamp, now, inRegularSession, eventInvalidated = false } = {}) {
  const quoteMs = parseIso(quoteTimestamp);
  const nowMs = parseIso(now);
  if (quoteMs === null || nowMs === null) return "unavailable";
  if (quoteMs > nowMs) return "unavailable";
  if (eventInvalidated) return "stale";

  if (inRegularSession) {
    const ageMs = nowMs - quoteMs;
    return ageMs <= 5 * MINUTE_MS ? "fresh" : "stale";
  }
  // Outside regular hours: never "fresh" for an execution-ready read at
  // creation time. The scan may still record the candidate as research-only;
  // that disposition is the caller's concern, not this resolver's.
  return "stale";
}

/**
 * Per-metric thesis-critical derivation, replacing the previous hardcoded
 * `true` at every call site (the exact contradiction with accepted Q-004
 * flagged on 2026-09-21: "13F... required for full coverage but never
 * blocking" while the code let its absence veto a candidate).
 *
 * Only 13F is decided as non-critical today. Every other metric keeps the
 * conservative default (thesis-critical) until a policy says otherwise —
 * this function must never be extended to soften another metric without a
 * cited decision.
 */
const NON_CRITICAL_METRICS = new Set(["instOwnershipDir", "thirteenF"]);

export function isThesisCritical(metricId) {
  return !NON_CRITICAL_METRICS.has(metricId);
}
