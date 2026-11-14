/**
 * Pitch Lab judgment view — "is the rating telling us anything?" for the website.
 *
 * Pure: pitches and outcomes in, one JSON object out. No I/O, no model call.
 *
 * Question answered, both ways: do the pitches we rated HIGHER do better than the
 * ones we rated LOWER? Each lens (the model's conviction, the Mandate Score) splits
 * the graded pitches at its own median into a higher-rated group and a lower-rated
 * group (pitches at the median are shown separately and never used in the
 * comparison), then compares the two groups' results against the benchmark.
 *
 *   spread  = higher-rated mean excess return minus lower-rated mean excess return
 *   bothWays = the higher-rated group beat the benchmark AND the lower-rated group lagged it
 *
 * Nothing here is a significance test: the verdict is withheld ("too_early") until the
 * same evidence bar the weekly report uses (graded pitches and independent weeks) is
 * met, and the existing Mandate Review remains the place for formal statistics.
 *
 * Contract (`version: "pitch-lab.judgment.v1"`): adding fields is fine; renaming or
 * removing one is a new version. Returns are decimals (0.012 = 1.2%). Paper only.
 */
import { isoWeekKey } from "./analysis.js";
import { CONVICTION_SCALE, LEGACY_CONVICTION_SCALE, convictionScaleOf } from "./pitch.js";
import { mean, median, round, spearman } from "./stats.js";

export const JUDGMENT_VERSION = "pitch-lab.judgment.v1";
const SPREAD_EPSILON = 0.0005; // 5 bps: a smaller gap is "flat", not a direction

const LENSES = Object.freeze([
  { id: "conviction", label: "Model conviction", unit: "/10" },
  { id: "convictionLegacy", label: "Model conviction (original 1-5 scale)", unit: "/5" },
  { id: "mandateScore", label: "Mandate Score", unit: "/10" },
]);

function groupStats(rows) {
  const ys = rows.map((r) => r.y);
  const xs = rows.map((r) => r.x);
  const hits = ys.filter((y) => y > 0).length;
  return {
    n: rows.length,
    meanExcess: rows.length ? round(mean(ys), 4) : null,
    medianExcess: rows.length ? round(median(ys), 4) : null,
    hitRate: rows.length ? round(hits / rows.length, 4) : null,
    ratingMin: rows.length ? Math.min(...xs) : null,
    ratingMax: rows.length ? Math.max(...xs) : null,
  };
}

const pts = (value) => `${Math.abs(value * 100).toFixed(1)} pts`;

function verdictFor({ enough, graded, weeks, bar, higher, lower, spread, rho }) {
  if (!higher.n || !lower.n || spread == null) {
    return { label: "too_early", lean: null, headline: "Too early to judge", detail: `Not enough spread in the ratings yet to compare higher- and lower-rated pitches (${graded} graded).` };
  }
  const lean = Math.abs(spread) < SPREAD_EPSILON ? "flat" : spread > 0 ? "right" : "wrong";
  if (!enough) {
    const leanText =
      lean === "right" ? `Early lean: higher-rated pitches are ahead of lower-rated by ${pts(spread)}.`
        : lean === "wrong" ? `Early lean: higher-rated pitches are behind lower-rated by ${pts(Math.abs(spread))}.`
          : "Early lean: no visible difference between higher- and lower-rated pitches.";
    return {
      label: "too_early",
      lean,
      headline: "Too early to judge",
      detail: `${leanText} Evidence so far: ${graded} graded pitches (need ${bar.minGraded}), ${weeks} independent week${weeks === 1 ? "" : "s"} (need ${bar.minWeeks}). Not a result yet.`,
    };
  }
  const topBeats = higher.meanExcess > 0;
  const bottomLags = lower.meanExcess < 0;
  const direction = spread >= SPREAD_EPSILON && (rho == null || rho > 0);
  if (direction && topBeats && bottomLags) {
    return { label: "working_both_ways", lean, headline: "Working, both ways", detail: `Higher-rated pitches beat the benchmark and lower-rated ones lagged it, a ${pts(spread)} gap.` };
  }
  if (direction) {
    const side = topBeats ? "Higher-rated pitches beat the benchmark, but lower-rated ones did not lag it" : bottomLags ? "Lower-rated pitches lagged the benchmark, but higher-rated ones did not beat it" : "Higher-rated did better than lower-rated, but both trailed the benchmark";
    return { label: "working_one_way", lean, headline: "Working, one way", detail: `${side}. Gap ${pts(spread)}.` };
  }
  if (lean === "wrong") {
    return { label: "backwards", lean, headline: "Backwards", detail: `Lower-rated pitches have done BETTER than higher-rated ones, by ${pts(Math.abs(spread))}.` };
  }
  return { label: "no_signal", lean, headline: "No signal", detail: "Higher- and lower-rated pitches have done about the same." };
}

function blockFor({ rows, bar }) {
  const graded = rows.length;
  const weeks = new Set(rows.map((r) => r.week).filter(Boolean)).size;
  const enough = graded >= bar.minGraded && weeks >= bar.minWeeks;
  const base = { graded, independentWeeks: weeks, enoughEvidence: enough };
  if (!graded) {
    return { ...base, cutoff: null, higher: groupStats([]), middle: groupStats([]), lower: groupStats([]), spread: null, rho: null, verdict: verdictFor({ enough, graded, weeks, bar, higher: groupStats([]), lower: groupStats([]), spread: null, rho: null }) };
  }
  const cutoff = median(rows.map((r) => r.x));
  const higher = groupStats(rows.filter((r) => r.x > cutoff));
  const lower = groupStats(rows.filter((r) => r.x < cutoff));
  const middle = groupStats(rows.filter((r) => r.x === cutoff));
  const spread = higher.n && lower.n ? round(higher.meanExcess - lower.meanExcess, 4) : null;
  const rho = round(spearman(rows.map((r) => r.x), rows.map((r) => r.y)), 4);
  return { ...base, cutoff, higher, middle, lower, spread, rho, verdict: verdictFor({ enough, graded, weeks, bar, higher, lower, spread, rho }) };
}

/**
 * @param {object} args
 * @param {Array}  args.pitches    valid stored pitches
 * @param {Array}  args.outcomes   matured outcomes ({ pitchId, horizonDays, excessReturn, entryDate })
 * @param {number[]} args.horizons holding periods to report
 * @param {{minGraded:number,minWeeks:number}} args.evidenceBar
 * @param {Map<string, number>} args.scoreOf  pitch id → Mandate Score /10 (missing/non-finite when unscored)
 */
export function buildJudgment({ pitches = [], outcomes = [], horizons = [], evidenceBar, scoreOf = new Map() } = {}) {
  const pitchById = new Map(pitches.map((p) => [p.id, p]));
  const lensX = {
    // Each conviction scale is its own lens: 1-5 and 1-10 ratings are never mixed or rescaled.
    conviction: (pitch) => (convictionScaleOf(pitch) === CONVICTION_SCALE ? pitch.conviction : null),
    convictionLegacy: (pitch) => (convictionScaleOf(pitch) === LEGACY_CONVICTION_SCALE ? pitch.conviction : null),
    mandateScore: (pitch) => scoreOf.get(pitch.id) ?? null,
  };
  const lenses = {};
  for (const lens of LENSES) {
    const byHorizon = {};
    for (const horizon of horizons) {
      const rows = [];
      for (const o of outcomes) {
        if (o.horizonDays !== horizon || !Number.isFinite(o.excessReturn)) continue;
        const pitch = pitchById.get(o.pitchId);
        if (!pitch) continue;
        const x = lensX[lens.id](pitch);
        if (!Number.isFinite(x)) continue;
        rows.push({ x, y: o.excessReturn, week: typeof o.entryDate === "string" && o.entryDate ? isoWeekKey(o.entryDate) : null });
      }
      byHorizon[String(horizon)] = blockFor({ rows, bar: evidenceBar });
    }
    lenses[lens.id] = { id: lens.id, label: lens.label, unit: lens.unit, horizons: byHorizon };
  }
  return { version: JUDGMENT_VERSION, evidenceBar, lenses };
}
