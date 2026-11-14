import test from "node:test";
import assert from "node:assert/strict";
import { buildJudgment, JUDGMENT_VERSION } from "../lib/pitch-lab/judgment.js";
import { buildPitchLabSnapshot, EVIDENCE_BAR } from "../lib/pitch-lab/dashboard-snapshot.js";

const BAR = { minGraded: 6, minWeeks: 2 };
const weekDates = ["2026-10-05", "2026-10-12"]; // two ISO weeks

/** n pitches per conviction level; each gets one 10d outcome from `excessFor(conviction, index)`. */
function build({ levels, perLevel, excessFor, scale = 10 }) {
  const pitches = [];
  const outcomes = [];
  for (const level of levels) {
    for (let i = 0; i < perLevel; i += 1) {
      const id = `p-${level}-${i}`;
      pitches.push({ id, ticker: `T${level}${i}`, conviction: level, convictionScale: scale, pitchedAt: "2026-10-01T22:44:00.000Z" });
      outcomes.push({ pitchId: id, horizonDays: 10, excessReturn: excessFor(level, i), entryDate: weekDates[i % 2] });
    }
  }
  return { pitches, outcomes };
}

const judge = (input, extra = {}) => buildJudgment({ ...input, horizons: [10], evidenceBar: BAR, scoreOf: new Map(), ...extra });
const conviction = (j) => j.lenses.conviction.horizons["10"];

test("working both ways: higher-rated beat the benchmark and lower-rated lagged it", () => {
  const input = build({ levels: [2, 4, 6], perLevel: 4, excessFor: (level) => (level === 6 ? 0.05 : level === 2 ? -0.04 : 0) });
  const b = conviction(judge(input));
  assert.equal(b.cutoff, 4);
  assert.equal(b.higher.n, 4);
  assert.equal(b.lower.n, 4);
  assert.equal(b.middle.n, 4, "pitches at the median are shown, never compared");
  assert.equal(b.higher.meanExcess, 0.05);
  assert.equal(b.lower.meanExcess, -0.04);
  assert.equal(b.spread, 0.09);
  assert.equal(b.enoughEvidence, true);
  assert.equal(b.verdict.label, "working_both_ways");
});

test("working one way when the higher-rated beat but the lower-rated did not lag", () => {
  const input = build({ levels: [2, 4, 6], perLevel: 4, excessFor: (level) => (level === 6 ? 0.06 : level === 2 ? 0.01 : 0.02) });
  assert.equal(conviction(judge(input)).verdict.label, "working_one_way");
});

test("backwards: lower-rated pitches did better than higher-rated ones", () => {
  const input = build({ levels: [2, 4, 6], perLevel: 4, excessFor: (level) => (level === 6 ? -0.05 : level === 2 ? 0.05 : 0) });
  const b = conviction(judge(input));
  assert.equal(b.verdict.label, "backwards");
  assert.ok(b.spread < 0);
  assert.ok(b.rho < 0);
});

test("no signal when the two groups did about the same", () => {
  const input = build({ levels: [2, 4, 6], perLevel: 4, excessFor: () => 0.01 });
  assert.equal(conviction(judge(input)).verdict.label, "no_signal");
});

test("too early below the evidence bar: shows a lean, never a verdict", () => {
  const input = build({ levels: [2, 4, 6], perLevel: 1, excessFor: (level) => (level === 6 ? 0.05 : -0.05) });
  const b = conviction(judge(input));
  assert.equal(b.enoughEvidence, false);
  assert.equal(b.verdict.label, "too_early");
  assert.equal(b.verdict.lean, "right");
  assert.match(b.verdict.detail, /3 graded pitches \(need 6\), 1 independent week \(need 2\)/);
  assert.match(b.verdict.detail, /ahead of lower-rated by 10\.0 pts/);
});

test("too early and no lean when there is nothing to compare", () => {
  const b = conviction(judge({ pitches: [], outcomes: [] }));
  assert.equal(b.graded, 0);
  assert.equal(b.verdict.label, "too_early");
  assert.equal(b.verdict.lean, null);
  assert.equal(b.spread, null);
});

test("legacy 1-5 pitches get their own lens and are never mixed into the 1-10 one", () => {
  const legacy = build({ levels: [1, 3, 5], perLevel: 4, excessFor: (level) => (level === 5 ? 0.05 : level === 1 ? -0.05 : 0), scale: 5 });
  const j = judge(legacy);
  assert.equal(conviction(j).graded, 0);
  const old = j.lenses.convictionLegacy.horizons["10"];
  assert.equal(old.graded, 12);
  assert.equal(old.cutoff, 3);
  assert.equal(old.verdict.label, "working_both_ways");
});

test("the Mandate Score lens reads the supplied scores and skips unscored pitches", () => {
  const input = build({ levels: [2, 4, 6], perLevel: 4, excessFor: (level) => (level === 6 ? 0.05 : level === 2 ? -0.04 : 0) });
  const scoreOf = new Map(input.pitches.map((p) => [p.id, p.conviction === 4 ? null : p.conviction]));
  const m = judge(input, { scoreOf }).lenses.mandateScore.horizons["10"];
  assert.equal(m.graded, 8, "the four unscored pitches are left out");
  assert.equal(m.higher.n, 4);
  assert.equal(m.lower.n, 4);
});

// ─── Regressions from the Codex review ───────────────────────────────────────

const BIG_BAR = { minGraded: 30, minWeeks: 8 };
/** n rows over 8 different ISO weeks. rating(i) and excess(i) give each row's rating and return. */
function wide({ n, rating, excess }) {
  const pitches = [];
  const outcomes = [];
  for (let i = 0; i < n; i += 1) {
    const id = `w-${i}`;
    pitches.push({ id, ticker: `W${i}`, conviction: rating(i), convictionScale: 10, pitchedAt: "2026-09-01T22:44:00.000Z" });
    outcomes.push({ pitchId: id, horizonDays: 10, excessReturn: excess(i), entryDate: ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"][i % 8] });
  }
  return { pitches, outcomes };
}
const wideJudge = (input) => buildJudgment({ ...input, horizons: [10], evidenceBar: BIG_BAR, scoreOf: new Map() }).lenses.conviction.horizons["10"];

test("Codex P1: enough evidence but every pitch at the same rating is 'no signal', never 'too early'", () => {
  const b = wideJudge(wide({ n: 32, rating: () => 5, excess: () => 0.01 }));
  assert.equal(b.enoughEvidence, true);
  assert.equal(b.higher.n, 0);
  assert.equal(b.verdict.label, "no_signal");
  assert.match(b.verdict.detail, /barely vary/);
});

test("Codex P1: the verdict uses unrounded means, so display rounding cannot tip the 5 bp threshold", () => {
  // lower-rated mean -0.000249, higher-rated mean 0.0002501: the true gap is 4.991 bp, below the 5 bp line.
  // Rounded to 4 places these become -0.0002 and 0.0003, which would read as exactly 5 bp.
  const b = wideJudge(wide({ n: 32, rating: (i) => (i < 16 ? 2 : 8), excess: (i) => (i < 16 ? -0.000249 : 0.0002501) }));
  assert.equal(b.enoughEvidence, true);
  assert.notEqual(b.verdict.label, "working_both_ways");
  assert.equal(b.verdict.label, "no_signal");
});

test("Codex P2: means that overflow are unavailable, not a spurious 'no signal'", () => {
  const b = wideJudge(wide({ n: 32, rating: (i) => (i < 16 ? 2 : 8), excess: (i) => (i < 16 ? -Number.MAX_VALUE : Number.MAX_VALUE) }));
  assert.equal(b.spread, null);
  assert.equal(b.verdict.label, "too_early");
  assert.match(b.verdict.detail, /could not be computed/);
});

test("the snapshot carries the judgment block under the real evidence bar", () => {
  const input = build({ levels: [2, 6], perLevel: 2, excessFor: () => 0.01 });
  const snap = buildPitchLabSnapshot({ pitches: input.pitches, outcomes: input.outcomes, now: new Date("2026-10-26T12:00:00Z") });
  assert.equal(snap.judgment.version, JUDGMENT_VERSION);
  assert.deepEqual(snap.judgment.evidenceBar, EVIDENCE_BAR);
  assert.deepEqual(Object.keys(snap.judgment.lenses), ["conviction", "convictionLegacy", "mandateScore"]);
  assert.deepEqual(Object.keys(snap.judgment.lenses.conviction.horizons), ["5", "10", "20"]);
});
