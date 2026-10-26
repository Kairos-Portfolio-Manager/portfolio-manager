/**
 * Publishes the Pitch Lab dashboard snapshot (lib/pitch-lab/dashboard-snapshot.js) for
 * the website. Kept out of pitch-lab-peer-bridge.js on purpose: that module's
 * write surface is pinned by tests/pitch-lab.test.js, and this one carries its own
 * pin (tests/pitch-lab-snapshot.test.js). One constant, namespaced key — never
 * caller-supplied, so it cannot touch a pm:* production key. Presentation only.
 */
export const PITCH_LAB_SNAPSHOT_KEY = "pitchlab:snapshot";

/** Returns true when stored; false (and loud) when Redis is not configured. */
export async function publishPitchLabSnapshot(snapshot, { redis, now = () => new Date(), timeoutMs = 5000 } = {}) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.schemaVersion !== "pitch-lab.snapshot.v1") {
    throw new TypeError("publishPitchLabSnapshot requires a pitch-lab.snapshot.v1 snapshot");
  }
  const client = redis ?? (await import("./redis.js")).getRedis();
  if (!client) {
    console.error("[PitchLabSnapshot] Redis not configured — Pitch Lab snapshot NOT published.");
    return false;
  }
  // Bounded: a Redis call that hangs instead of failing must not hold the daily cycle open.
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`snapshot publish timed out after ${timeoutMs}ms`)), timeoutMs); });
  try {
    await Promise.race([client.set(PITCH_LAB_SNAPSHOT_KEY, JSON.stringify({ publishedAt: now().toISOString(), snapshot })), deadline]);
  } finally {
    clearTimeout(timer);
  }
  return true;
}
