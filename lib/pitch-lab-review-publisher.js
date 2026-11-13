/**
 * Publishes the Mandate Review HISTORY for the website: one index of every review
 * period plus one key per review, so past periods stay readable after the next
 * week's review replaces `pitchlab:mandate-review` (the latest-only key the
 * bridge still writes).
 *
 * Kept out of pitch-lab-peer-bridge.js for the same reason as the snapshot
 * publisher: the bridge's write surface is pinned by tests/pitch-lab.test.js; this
 * module carries its own pin (tests/pitch-lab-review-history.test.js). Keys are a
 * constant index plus a constant prefix and a content-hash id that must match
 * REVIEW_ID_RE, so a caller can never steer a write outside `pitchlab:`.
 * Postgres (pitch_lab_mandate_reviews) stays canonical; this is presentation only.
 */
export const PITCH_LAB_REVIEW_INDEX_KEY = "pitchlab:mandate-reviews";
export const PITCH_LAB_REVIEW_KEY_PREFIX = "pitchlab:mandate-review:";
export const REVIEW_HISTORY_SCHEMA_VERSION = "pitch-lab.review-history.v1";
export const MAX_PUBLISHED_REVIEWS = 104; // two years of weekly periods
const REVIEW_ID_RE = /^mr_[0-9a-f]{20}$/;

const count = (review, label) => (review.metrics ?? []).filter((m) => m?.confidenceLabel === label).length;

/** One index row: enough to list a period without loading the review. */
export function reviewIndexEntry(review) {
  const insufficient = review.status === "insufficient_data" ? review.insufficientData ?? {} : null;
  return {
    id: review.id,
    period: review.period,
    generatedAt: review.generatedAt,
    status: review.status,
    gradedPitches: insufficient ? insufficient.gradedPitches ?? null : review.gradedPitches ?? null,
    independentWeeks: insufficient ? insufficient.independentWeeks ?? null : review.independentWeeks ?? null,
    recommended: count(review, "recommended"),
    watch: count(review, "watch"),
    // Does the Mandate Score go with beating SPY? (positive / negative / inconclusive; null before enough data)
    mandateScoreVerdict: review.mandateScore?.overallVerdict ?? null,
  };
}

/**
 * @param {object[]} reviews  stored reviews (listMandateReviews output), any order
 * @returns {Promise<boolean>} true when stored; false (and loud) when Redis is not configured
 */
export async function publishMandateReviewHistory(reviews, { redis, now = () => new Date() } = {}) {
  if (!Array.isArray(reviews)) throw new TypeError("publishMandateReviewHistory requires an array of reviews");
  for (const review of reviews) {
    if (!REVIEW_ID_RE.test(String(review?.id ?? ""))) throw new TypeError(`publishMandateReviewHistory: review id "${review?.id}" is not a stored review id`);
  }
  const client = redis ?? (await import("./redis.js")).getRedis();
  if (!client) {
    console.error("[PitchLabReviews] Redis not configured — Mandate Review history NOT published.");
    return false;
  }
  const newestFirst = [...reviews]
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt) || String(a.id).localeCompare(String(b.id)))
    .slice(0, MAX_PUBLISHED_REVIEWS);
  const publishedAt = now().toISOString();
  // Each review first, then the index, so the index never lists a review the site cannot open.
  for (const review of newestFirst) {
    await client.set(`${PITCH_LAB_REVIEW_KEY_PREFIX}${review.id}`, JSON.stringify({ publishedAt, review }));
  }
  await client.set(PITCH_LAB_REVIEW_INDEX_KEY, JSON.stringify({
    schemaVersion: REVIEW_HISTORY_SCHEMA_VERSION,
    publishedAt,
    reviews: newestFirst.map(reviewIndexEntry),
  }));
  return true;
}
