import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_PUBLISHED_REVIEWS, PITCH_LAB_REVIEW_INDEX_KEY, PITCH_LAB_REVIEW_KEY_PREFIX, publishMandateReviewHistory, reviewIndexEntry,
} from "../lib/pitch-lab-review-publisher.js";
import { refreshReviewHistory } from "../jobs/pitch-lab-daily.js";

const id = (n) => `mr_${String(n).padStart(20, "0")}`;

function review(n, overrides = {}) {
  return {
    id: id(n),
    schemaVersion: "pitch-lab.mandate-review.v1",
    agentId: "agent-1",
    period: `2027-${String(n).padStart(2, "0")}`,
    generatedAt: `2027-${String(n).padStart(2, "0")}-06T16:00:00.000Z`,
    status: "has_suggestions",
    gradedPitches: 40 + n,
    independentWeeks: 9,
    metrics: [{ confidenceLabel: "recommended" }, { confidenceLabel: "watch" }, { confidenceLabel: "watch" }, { confidenceLabel: "no_change" }],
    ...overrides,
  };
}

function fakeRedis() {
  const writes = [];
  return { writes, set: async (key, value) => { writes.push([key, value]); return "OK"; } };
}

test("history publishes every review, then a newest-first index", async () => {
  const redis = fakeRedis();
  const ok = await publishMandateReviewHistory([review(1), review(3), review(2)], { redis, now: () => new Date("2027-04-01T00:00:00Z") });
  assert.equal(ok, true);
  assert.deepEqual(redis.writes.map(([key]) => key), [
    `${PITCH_LAB_REVIEW_KEY_PREFIX}${id(3)}`,
    `${PITCH_LAB_REVIEW_KEY_PREFIX}${id(2)}`,
    `${PITCH_LAB_REVIEW_KEY_PREFIX}${id(1)}`,
    PITCH_LAB_REVIEW_INDEX_KEY,
  ]);
  const index = JSON.parse(redis.writes.at(-1)[1]);
  assert.equal(index.schemaVersion, "pitch-lab.review-history.v1");
  assert.deepEqual(index.reviews.map((r) => r.period), ["2027-03", "2027-02", "2027-01"]);
  assert.deepEqual([index.reviews[0].recommended, index.reviews[0].watch], [1, 2]);
  assert.equal(JSON.parse(redis.writes[0][1]).review.id, id(3));
});

test("an empty history publishes an empty index (the site shows no periods)", async () => {
  const redis = fakeRedis();
  await publishMandateReviewHistory([], { redis });
  assert.deepEqual(redis.writes.map(([key]) => key), [PITCH_LAB_REVIEW_INDEX_KEY]);
  assert.deepEqual(JSON.parse(redis.writes[0][1]).reviews, []);
});

test("an insufficient-data period is listed with its counts, not hidden", () => {
  const entry = reviewIndexEntry(review(1, { status: "insufficient_data", gradedPitches: undefined, independentWeeks: undefined, metrics: [], insufficientData: { gradedPitches: 12, independentWeeks: 3 } }));
  assert.deepEqual([entry.status, entry.gradedPitches, entry.independentWeeks, entry.recommended, entry.watch], ["insufficient_data", 12, 3, 0, 0]);
});

test("history is capped and refuses ids that are not stored review ids", async () => {
  const redis = fakeRedis();
  const many = Array.from({ length: MAX_PUBLISHED_REVIEWS + 4 }, (_, i) => review(i + 1, { generatedAt: new Date(Date.UTC(2027, 0, 1) + i * 86_400_000).toISOString() }));
  await publishMandateReviewHistory(many, { redis });
  assert.equal(JSON.parse(redis.writes.at(-1)[1]).reviews.length, MAX_PUBLISHED_REVIEWS);
  await assert.rejects(() => publishMandateReviewHistory([review(1, { id: "../pm:positions" })], { redis: fakeRedis() }), /not a stored review id/);
});

test("the history publisher writes only under pitchlab: and only through its constants", () => {
  const source = readFileSync(new URL("../lib/pitch-lab-review-publisher.js", import.meta.url), "utf8");
  const sets = [...source.matchAll(/client\.set\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual(sets, ["`${PITCH_LAB_REVIEW_KEY_PREFIX}${review.id}`", "PITCH_LAB_REVIEW_INDEX_KEY"]);
  assert.ok(PITCH_LAB_REVIEW_INDEX_KEY.startsWith("pitchlab:"));
  assert.ok(PITCH_LAB_REVIEW_KEY_PREFIX.startsWith("pitchlab:"));
  assert.doesNotMatch(source, /\.del\(|\.hset\(|\.lpush\(|pm:/);
});

test("a history publish failure is loud but returns false instead of failing the review", async () => {
  const errors = [];
  const notes = [];
  const ok = await refreshReviewHistory({
    store: { listMandateReviews: async () => { throw new Error("pg down"); } },
    redis: fakeRedis(),
    notify: async (text) => notes.push(text),
    log: { error: (text) => errors.push(text) },
  });
  assert.equal(ok, false);
  assert.match(errors[0], /NOT published: pg down/);
  assert.match(notes[0], /history could not be published/);
});
