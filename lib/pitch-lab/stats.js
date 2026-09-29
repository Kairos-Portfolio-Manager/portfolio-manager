/**
 * Pitch Lab statistics — pure, dependency-free, deterministic.
 *
 * Why these methods (docs/PITCH-LAB.md "Statistical method"):
 *   - Conviction is ordinal (1–5), and returns are fat-tailed, so the headline
 *     correlation is Spearman's rank correlation, not Pearson.
 *   - Pitches made in the same week share one market and their holding periods
 *     overlap, so they are NOT independent observations. Every uncertainty
 *     figure here is clustered: the regression uses cluster-robust (CR1)
 *     standard errors with G-1 degrees of freedom, and the rank-correlation
 *     interval is a cluster bootstrap (whole clusters resampled).
 *   - Testing many metrics at once makes some look good by luck, so metric
 *     p-values also get Benjamini–Hochberg q-values.
 *
 * No function here fabricates a value: undersized inputs return null fields.
 */

const round = (value, digits = 6) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

export function mean(xs) {
  if (!xs.length) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Sample variance (n-1). */
export function variance(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return ss / (xs.length - 1);
}

export function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function quantile(sortedXs, q) {
  if (!sortedXs.length) return null;
  const pos = (sortedXs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedXs[lo] + (sortedXs[hi] - sortedXs[lo]) * (pos - lo);
}

export function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null; // a constant series has no correlation
  return sxy / Math.sqrt(sxx * syy);
}

/** Ranks with ties given their average rank (1-based). */
export function averageRanks(xs) {
  const order = xs.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k].index] = rank;
    i = j + 1;
  }
  return ranks;
}

export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

// ---------------------------------------------------------------------------
// Student-t distribution (via the regularized incomplete beta function).
// ---------------------------------------------------------------------------

function logGamma(z) {
  // Lanczos approximation, g=7, n=9.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a, b, x) {
  const MAX_ITER = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-sided p-value for a t statistic with df degrees of freedom. */
export function tTwoSidedP(t, df) {
  if (!Number.isFinite(t) || !(df > 0)) return null;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** Critical t value for a two-sided test at level alpha (bisection on the CDF). */
export function tCritical(df, alpha = 0.05) {
  if (!(df > 0)) return null;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (tTwoSidedP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Clustered inference.
// ---------------------------------------------------------------------------

/**
 * Simple OLS y = a + b·x with cluster-robust (CR1) standard error on b.
 * clusters[i] is any string key (e.g. the ISO week of the pitch's entry date).
 * Degrees of freedom are G-1 (number of clusters minus one), the standard
 * conservative choice when clusters are few.
 */
export function clusteredSlope(xs, ys, clusters) {
  const n = xs.length;
  if (n !== ys.length || n !== clusters.length || n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  const scoreByCluster = new Map();
  for (let i = 0; i < n; i += 1) {
    const residual = ys[i] - intercept - slope * xs[i];
    const key = String(clusters[i]);
    scoreByCluster.set(key, (scoreByCluster.get(key) ?? 0) + (xs[i] - mx) * residual);
  }
  const g = scoreByCluster.size;
  if (g < 2) return { slope, intercept, n, clusters: g, se: null, t: null, df: null, p: null, ci95: null };
  let meat = 0;
  for (const score of scoreByCluster.values()) meat += score * score;
  const correction = (g / (g - 1)) * ((n - 1) / (n - 2));
  const se = Math.sqrt((correction * meat) / (sxx * sxx));
  const df = g - 1;
  const t = se > 0 ? slope / se : null;
  const crit = tCritical(df);
  return {
    slope,
    intercept,
    n,
    clusters: g,
    se,
    t,
    df,
    p: t == null ? null : tTwoSidedP(t, df),
    ci95: se > 0 ? [slope - crit * se, slope + crit * se] : null,
  };
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cluster bootstrap percentile interval for a statistic of paired (x, y).
 * Resamples whole clusters with replacement so within-cluster dependence is
 * preserved. Replicates where the statistic is undefined (e.g. a resample with
 * constant x) are dropped and counted.
 */
export function clusterBootstrapInterval(xs, ys, clusters, statistic, { iterations = 2000, seed = 1, level = 0.95 } = {}) {
  const groups = new Map();
  for (let i = 0; i < xs.length; i += 1) {
    const key = String(clusters[i]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const keys = [...groups.keys()];
  if (keys.length < 2) return null;
  const random = seededRandom(seed);
  const replicates = [];
  let dropped = 0;
  for (let b = 0; b < iterations; b += 1) {
    const bx = [];
    const by = [];
    for (let k = 0; k < keys.length; k += 1) {
      const pick = groups.get(keys[Math.floor(random() * keys.length)]);
      for (const i of pick) {
        bx.push(xs[i]);
        by.push(ys[i]);
      }
    }
    const value = statistic(bx, by);
    if (Number.isFinite(value)) replicates.push(value);
    else dropped += 1;
  }
  if (replicates.length < iterations * 0.5) return { lower: null, upper: null, replicates: replicates.length, dropped };
  replicates.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { lower: quantile(replicates, tail), upper: quantile(replicates, 1 - tail), replicates: replicates.length, dropped };
}

/**
 * Benjamini–Hochberg q-values. Nulls pass through as null and are not counted
 * in the number of tests.
 */
export function benjaminiHochberg(pValues) {
  const indexed = pValues
    .map((p, index) => ({ p, index }))
    .filter((row) => Number.isFinite(row.p))
    .sort((a, b) => a.p - b.p);
  const m = indexed.length;
  const q = new Array(pValues.length).fill(null);
  let running = 1;
  for (let r = m - 1; r >= 0; r -= 1) {
    running = Math.min(running, (indexed[r].p * m) / (r + 1));
    q[indexed[r].index] = Math.min(1, running);
  }
  return q;
}

export { round };
