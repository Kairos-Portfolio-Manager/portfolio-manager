/**
 * Synthetic Pitch Lab data for trying the framework end to end without market
 * data or an API key. Every pitch is marked provenance.source="synthetic_demo"
 * and the report carries isSyntheticDemo=true, so demo output can never be
 * mistaken for real results.
 *
 * Planted relationships (so the analysis can be checked against a known truth):
 *   conviction    → +0.8% excess return per point at 5 days (a real, modest edge)
 *   revGrowth     → +1.5% per standard deviation (strong positive)
 *   peerValuation → -1.5% per standard deviation (expensive stocks lag: negative)
 *   everything else → pure noise
 * Returns also share a weekly market shock, which is why clustering matters.
 */
import { FEATURE_IDS } from "./features.js";
import { buildPitch } from "./pitch.js";
import { GRADING_VERSION } from "./grading.js";
import { seededRandom } from "./stats.js";

const TICKERS = ["MDB", "NET", "ZS", "HUBS", "AXON", "FIX", "CSWI", "DECK", "CROX", "CAVA", "ELF", "PODD", "TMDX", "SOFI", "AFRM", "MTDR", "CF", "TTD", "ROKU", "CUBE"];
const MOSTLY_MISSING = new Set(["revBeat", "estimateRevisions", "instOwnershipDir", "thirteenF"]);

function normal(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function addTradingDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

export function generateDemoData({ pitchCount = 400, start = "2025-11-03", seed = 7, horizons = [5, 10, 20] } = {}) {
  const random = seededRandom(seed);
  const weeklyShock = new Map();
  const shockFor = (dateStr) => {
    const key = dateStr.slice(0, 8) + String(Math.floor(Number(dateStr.slice(8, 10)) / 7));
    if (!weeklyShock.has(key)) weeklyShock.set(key, normal(random) * 0.02);
    return weeklyShock.get(key);
  };

  const pitches = [];
  const outcomes = [];
  let day = new Date(`${start}T15:00:00Z`);
  for (let i = 0; i < pitchCount; i += 1) {
    if (i % 2 === 0) day = addTradingDays(day, 1); // ~2 pitches per trading day
    const ticker = TICKERS[Math.floor(random() * TICKERS.length)];
    const conviction = 1 + Math.floor(random() * 5);
    const z = Object.fromEntries(FEATURE_IDS.map((id) => [id, normal(random)]));
    const features = Object.fromEntries(FEATURE_IDS.map((id) => {
      const missing = MOSTLY_MISSING.has(id) ? random() < 0.8 : random() < 0.1;
      return [id, { value: missing ? null : Number((z[id] * 0.1 + 0.1).toFixed(6)), asOf: missing ? null : day.toISOString() }];
    }));
    const pitchedAt = day.toISOString();
    const pitch = buildPitch({
      ticker,
      pitchedAt,
      conviction,
      intendedHoldingDays: 10,
      entryReference: { price: Number((20 + random() * 200).toFixed(2)), asOf: pitchedAt },
      rationale: {
        thesis: `Synthetic demo pitch #${i + 1} for ${ticker}: accelerating revenue and reasonable valuation.`,
        reasons: [{ claim: "Revenue growth is accelerating.", features: ["revGrowth"] }],
        risks: ["Synthetic data — not a real opinion."],
        killCriteria: ["Demo only."],
      },
      features,
      context: { selection: "universe" },
      provenance: { source: "synthetic_demo", mandateVersion: "demo", promptVersion: "demo", model: "none" },
    });
    pitches.push(pitch);

    const entryDate = day.toISOString().slice(0, 10);
    const idiosyncratic = normal(random) * 0.05;
    for (const h of horizons) {
      const scale = Math.sqrt(h / 5);
      const revZ = features.revGrowth.value == null ? 0 : z.revGrowth;
      const valZ = features.peerValuation.value == null ? 0 : z.peerValuation;
      const horizonNoise = normal(random) * 0.02; // each horizon adds its own noise on top of the shared path
      const excess = scale * (0.008 * (conviction - 3) + 0.015 * revZ - 0.015 * valZ + shockFor(entryDate) + idiosyncratic + horizonNoise);
      const benchmarkReturn = scale * 0.002 + shockFor(entryDate) * 0.5;
      outcomes.push({
        pitchId: pitch.id,
        ticker,
        benchmark: "SPY",
        costPerSide: 0.001,
        gradingVersion: GRADING_VERSION,
        gradedAt: addTradingDays(day, h).toISOString(),
        horizonDays: h,
        status: "matured",
        entryDate,
        exitDate: addTradingDays(day, h).toISOString().slice(0, 10),
        benchmarkReturn,
        netReturn: excess + benchmarkReturn,
        excessReturn: excess,
      });
    }
  }
  return { pitches, outcomes };
}
