/**
 * Pitch Lab daily candidate selection — which names Agent One is asked to pitch.
 *
 * Pure: takes the universe catalog (lib/universe.js short-key rows) and the
 * pitches already recorded, returns the day's picks plus a receipt that makes
 * the draw reproducible. Independent of the 17:15 research scan: the scan's
 * all-hold results cannot starve it and it changes no production candidate
 * selection.
 *
 * Two slots, reusing the production Agent One building blocks:
 *   screen — the top of Agent One's own attention ranking (rankScreenedCandidates)
 *            among names that pass its live catalog screen (screenCatalogForAgent,
 *            the same v3 sector-agnostic eligibility the 17:15 scan uses).
 *   random — a seeded uniform draw from the REST of that same screened pool, so
 *            the analysis can see what happens to names the ranking would have
 *            skipped. The slice is enforced here, not just labelled.
 * No "mover" slot yet: the catalog carries only a 52-week change, and a
 * days-to-weeks mover needs a quote fetch this module deliberately does not make.
 *
 * Rules: a name needs a quote price (an entry reference must exist); a name
 * pitched within `cooldownDays` is skipped; peer-readiness is NOT a filter
 * (gaps are recorded on the pitch, never used to skip a name).
 */
import { rankScreenedCandidates } from "../candidate-slate.js";
import { CATALOG_SCREEN_POLICY_VERSIONS, screenCatalogForAgent } from "../mandate-catalog-screen.js";
import { toScreenerCandidates } from "../universe.js";
import { seededRandom } from "./stats.js";

export const SELECTION_VERSION = "pitch-lab.selection.v1";
export const DEFAULT_SELECTION = Object.freeze({ size: 15, randomSlots: 5, cooldownDays: 14 });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Numeric seed for a trading date ("2026-10-02" → 20261002): the same date always draws the same names. */
export const seedForDate = (date) => Number(date.replaceAll("-", ""));

function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * @param {object} args
 * @param {{[ticker]: object}} args.catalog       universe catalog (getUniverseCatalog)
 * @param {string} args.date                      trading date, YYYY-MM-DD (ET)
 * @param {{ticker: string, pitchedAt: string}[]} [args.recentPitches]  existing pitches (any age; cooldown is applied here)
 * @param {object} [args.riskLimits]              Agent One risk limits (config/agents/agent-1/risk-limits.json)
 * @returns {{picks: object[], receipt: object}}
 */
export function selectPitchCandidates({
  catalog,
  date,
  recentPitches = [],
  riskLimits = {},
  size = DEFAULT_SELECTION.size,
  randomSlots = DEFAULT_SELECTION.randomSlots,
  cooldownDays = DEFAULT_SELECTION.cooldownDays,
} = {}) {
  if (!DATE_RE.test(String(date ?? ""))) throw new TypeError("selectPitchCandidates requires a YYYY-MM-DD date");
  if (!catalog || typeof catalog !== "object") throw new TypeError("selectPitchCandidates requires a catalog");
  if (!(Number.isInteger(size) && size > 0)) throw new TypeError("size must be a positive integer");
  if (!(Number.isInteger(randomSlots) && randomSlots >= 0 && randomSlots <= size)) throw new TypeError("randomSlots must be an integer between 0 and size");

  const universe = toScreenerCandidates(catalog);
  const quoted = universe.filter((c) => typeof c.price === "number" && Number.isFinite(c.price) && c.price > 0);
  const screened = screenCatalogForAgent("agent-1", quoted, riskLimits).passed;

  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const cooling = new Set(
    recentPitches
      .filter((p) => Number.isFinite(Date.parse(p.pitchedAt)) && dayStart - Date.parse(p.pitchedAt) < cooldownDays * DAY_MS)
      .map((p) => String(p.ticker).toUpperCase()),
  );
  const eligible = screened.filter((c) => !cooling.has(c.ticker));
  const ranked = rankScreenedCandidates(eligible, { agentId: "agent-1" });

  // Never pad with ineligible names: a short pool gives a short day, recorded in the receipt.
  const screenSlots = size - randomSlots;
  const nScreen = Math.min(screenSlots, ranked.length);
  const nRandom = Math.min(randomSlots, ranked.length - nScreen);
  const screenPicks = ranked.slice(0, nScreen);
  const rest = ranked.slice(nScreen).sort((a, b) => (a.ticker < b.ticker ? -1 : 1)); // order-independent of ranking
  const seed = seedForDate(date);
  const randomPicks = shuffled(rest, seededRandom(seed)).slice(0, nRandom);

  const toPick = (candidate, selection, rank = null) => ({
    ticker: candidate.ticker,
    selection,
    rank,
    sector: candidate.sector ?? null,
    industry: candidate.industry ?? null,
    marketCap: candidate.marketCap ?? null,
  });
  const picks = [
    ...screenPicks.map((c, index) => toPick(c, "screen", index + 1)),
    ...randomPicks.map((c) => toPick(c, "random")),
  ];

  const receipt = {
    version: SELECTION_VERSION,
    screenPolicyVersion: CATALOG_SCREEN_POLICY_VERSIONS["agent-1"] ?? null,
    date,
    seed,
    size,
    randomSlots,
    cooldownDays,
    universeCount: universe.length,
    quotedCount: quoted.length,
    screenedCount: screened.length,
    cooldownExcluded: screened.length - eligible.length,
    eligibleCount: eligible.length,
    shortfall: size - picks.length,
    picks: picks.map(({ ticker, selection, rank }) => ({ ticker, selection, rank })),
  };
  return { picks, receipt };
}
