import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConsensusFreshness, resolveQuoteFreshness, isThesisCritical } from "../lib/freshness-policy.js";

const NOW = "2026-09-23T15:00:00.000Z";

test("Q-002 consensus freshness: 30-day age limit", () => {
  const within = new Date(Date.parse(NOW) - 29 * 86_400_000).toISOString();
  const boundary = new Date(Date.parse(NOW) - 30 * 86_400_000).toISOString();
  const beyond = new Date(Date.parse(NOW) - 31 * 86_400_000).toISOString();
  assert.equal(resolveConsensusFreshness({ retrievedAt: within, now: NOW }), "fresh");
  assert.equal(resolveConsensusFreshness({ retrievedAt: boundary, now: NOW }), "fresh");
  assert.equal(resolveConsensusFreshness({ retrievedAt: beyond, now: NOW }), "stale");
});

test("Q-002 consensus freshness: event invalidation at next session open, regardless of age", () => {
  const retrievedAt = new Date(Date.parse(NOW) - 1 * 86_400_000).toISOString(); // 1 day old, would otherwise be fresh
  const nextSessionOpenAfterEvent = new Date(Date.parse(NOW) - 12 * 3_600_000).toISOString(); // 12h ago, before "now"
  assert.equal(
    resolveConsensusFreshness({ retrievedAt, now: NOW, nextSessionOpenAfterEvent }),
    "stale",
  );
  // A snapshot retrieved AFTER the event-invalidation cutoff is unaffected.
  const freshAfterEvent = new Date(Date.parse(NOW) - 1 * 3_600_000).toISOString();
  assert.equal(
    resolveConsensusFreshness({ retrievedAt: freshAfterEvent, now: NOW, nextSessionOpenAfterEvent }),
    "fresh",
  );
});

test("Q-002 consensus freshness: missing or future timestamps are unavailable, never fresh", () => {
  assert.equal(resolveConsensusFreshness({ retrievedAt: null, now: NOW }), "unavailable");
  assert.equal(resolveConsensusFreshness({ retrievedAt: undefined, now: NOW }), "unavailable");
  assert.equal(resolveConsensusFreshness({ retrievedAt: "not-a-date", now: NOW }), "unavailable");
  const future = new Date(Date.parse(NOW) + 3_600_000).toISOString();
  assert.equal(resolveConsensusFreshness({ retrievedAt: future, now: NOW }), "unavailable");
});

test("Q-003 quote freshness: 5-minute age limit during regular session", () => {
  const within = new Date(Date.parse(NOW) - 4 * 60_000).toISOString();
  const boundary = new Date(Date.parse(NOW) - 5 * 60_000).toISOString();
  const beyond = new Date(Date.parse(NOW) - 6 * 60_000).toISOString();
  assert.equal(resolveQuoteFreshness({ quoteTimestamp: within, now: NOW, inRegularSession: true }), "fresh");
  assert.equal(resolveQuoteFreshness({ quoteTimestamp: boundary, now: NOW, inRegularSession: true }), "fresh");
  assert.equal(resolveQuoteFreshness({ quoteTimestamp: beyond, now: NOW, inRegularSession: true }), "stale");
});

test("Q-003 quote freshness: outside regular hours is never fresh, even seconds old", () => {
  const secondsAgo = new Date(Date.parse(NOW) - 10_000).toISOString();
  assert.equal(resolveQuoteFreshness({ quoteTimestamp: secondsAgo, now: NOW, inRegularSession: false }), "stale");
});

test("Q-003 quote freshness: a material-event invalidation forces stale regardless of age or session", () => {
  const secondsAgo = new Date(Date.parse(NOW) - 10_000).toISOString();
  assert.equal(
    resolveQuoteFreshness({ quoteTimestamp: secondsAgo, now: NOW, inRegularSession: true, eventInvalidated: true }),
    "stale",
  );
});

test("Q-003 quote freshness: missing or future timestamps are unavailable", () => {
  assert.equal(resolveQuoteFreshness({ quoteTimestamp: null, now: NOW, inRegularSession: true }), "unavailable");
  const future = new Date(Date.parse(NOW) + 60_000).toISOString();
  assert.equal(resolveQuoteFreshness({ quoteTimestamp: future, now: NOW, inRegularSession: true }), "unavailable");
});

test("Q-004: only 13F metrics are non-thesis-critical; every other metric stays conservative", () => {
  assert.equal(isThesisCritical("instOwnershipDir"), false);
  assert.equal(isThesisCritical("thirteenF"), false);
  for (const metricId of ["balanceSheet", "epsTrajectory", "estimateRevisions", "marginTrend", "peerValuation", "revBeat", "revGrowth"]) {
    assert.equal(isThesisCritical(metricId), true, `${metricId} should remain thesis-critical absent a decision saying otherwise`);
  }
});
