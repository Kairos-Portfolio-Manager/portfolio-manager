# Agent One Pitch Lab — Working Plan

**Status:** DRAFT, 2026-09-24 (decisions updated same day). **Reference, not binding.** This is a direction
to think against, not a gate. Steps can be reordered, skipped, or dropped as we
learn. It does not override `docs/INVARIANTS.md` or the hard rules in
`CLAUDE.md`, and it grants no trading authority.

**Relationship to the other roadmaps:** `portfolio-master-plan.md` and
`PM-REMAINING-PRIORITIES-2026-09-21.md` describe the three-agent, gate-heavy
path. That path is paused, not deleted. Agents Two and Three are frozen
(`researchStatus: "frozen"` in `config/agents.js`, commit `054fce2`). Their
data, lots, history, and mandates stay where they are.

---

## 1. The shift in one paragraph

Stop trying to make Agent One produce one perfect, fully evidenced proposal.
Instead, have it make **many small, buy-only paper pitches** on stocks of any
size, record every part of
every pitch in a structured form, let the market grade the pitches, and then
use statistics, AI review, and our own judgment to find which parts of the
pitch actually predict gains over Agent One's short-term holding window. The mandate becomes a hypothesis we test and
revise, not a fixed rulebook.

## 2. What we keep, what we simplify, where the gaps are

### Keep (the foundation)

| Asset | Where | Why it matters here |
| --- | --- | --- |
| Universe catalog and nightly refresh | `jobs/universe-refresh.js`, `lib/universe.js` | The pool we pitch from. |
| Mandate scoring engine and metrics | `config/scoring/mandate-v2.js`, `lib/mandate-score.js` | Each metric becomes a feature in the regression. |
| Evidence and data adapters (EDGAR, quotes, consensus snapshots) | `lib/`, `lib/pg/consensus-snapshots.js` | Feature inputs. Keep their source and "as of" dates. |
| Postgres research record | `db/migrations/0004`–`0009`, `lib/pg/research-*.js` | Already append-only and versioned. Pitches and outcomes go here. |
| Outcome tracking with costs | `lib/research-outcomes.js`, `backtest/metrics.js` | Already supports `evidence_class: paper` and forward returns after costs. |
| Backtest harness | `backtest/` | Lets us test a mandate change on history before trying it live. |
| Safety and money path | proposals, signatures, ledgers, executor | Unchanged. Only matters if a pitch is ever turned into a real order. |

### Candidates to simplify

- **Gate stack in front of a pitch.** Today's actionability bar, freshness
  gates, evaluator, and dossier rules mostly lead to HOLD. For a *paper* pitch
  we can record the gate results as features instead of letting them block.
  Missing data is recorded as missing, never filled in.
- **Prose-heavy pitch.** Ask the model for a short, structured pitch (fields
  below) plus a brief thesis, not a long dossier.
- **Three-agent orchestration** (candidate bus, fair budget split, parity
  telemetry). With one agent, much of this can stay idle or be removed later.
- **Documentation load.** One working plan (this file) and one results log,
  instead of several status documents.

### Known gaps (the empty spots)

- Agent One tops out around 63 of 100 points because consensus/revision and
  13F inputs are missing or not wired (`docs/AGENT-1-COVERAGE-INVENTORY-2026-09-21.md`).
  For regression purposes, a missing feature is data. We record it as missing
  and measure whether it matters before spending effort to fill it.
- No field-level pitch record exists. Scores and recommendations are stored,
  but not every individual claim and input in a pitch.
- No routine that grades a pitch against a benchmark at fixed horizons and
  feeds that back into a table.
- No analysis layer (regressions, feature importance, AI review of what
  worked).
- The new website is not in any repo yet, so it has no agreed data contract
  with this backend.

## 3. What a pitch is

Every pitch is one row, stored before any outcome is known, and never edited
afterwards.

- **Identity:** pitch id, ticker, timestamp, mandate version, prompt version,
  model id, data snapshot versions.
- **Call:** BUY (the only direction), conviction (1–5), intended holding
  period, entry reference price and its timestamp.
- **Features, each with its value, whether it was missing, and its "as of" date:**
  every mandate metric (revenue beat, revenue growth, EPS trajectory, estimate
  revisions, margin trend, peer valuation, balance sheet, institutional
  ownership, 13F), the price and volume features (vs 200-day average, relative
  volume, momentum 1m/3m, ATR distance), market cap, sector, and macro regime.
- **Pitch-structure features:** which thesis reasons were cited (from a fixed
  list, so they can be counted), catalyst present and its date, stated risks,
  kill criteria.
- **Selection context:** why this stock was pitched (mover, screen, random
  exploration). A random slice keeps the analysis honest.

## 4. How pitches get graded

- Fixed horizons, decided in advance and never changed after a pitch is made.
  **The horizon is still open (decision D-1 below).** Agent One's mandate is
  days-to-weeks, so candidates are something like 5, 10, and 20 trading days.
- Return **relative to a benchmark** (sector ETF or SPY) after assumed costs,
  so a rising market does not make every pitch look good.
- Also record the result if the mandate's own exit rules had been followed (ATR
  stop, dead-trade timer), so exit rules can be tested too.
- Grading reuses `research-outcomes` with `evidence_class: paper`.

## 5. How we learn from it

A regular cycle, perhaps every two weeks:

1. **Statistics.** Regress benchmark-relative return on the pitch features.
   Keep it simple first: one feature at a time, then a small combined model.
   Report effect sizes with confidence intervals, not only "significant or not".
2. **AI review.** A model reads the best and worst pitches alongside the
   numbers and proposes hypotheses. Its ideas are hypotheses to test, not
   conclusions.
3. **Human review.** We decide what to **cut, adjust, or add** in the mandate,
   write the change down with its reason, and bump the mandate version.
4. **Check before adopting.** Where possible, backtest a proposed change on
   history before it goes live in the pitch loop.

### Statistical guardrails (so we do not fool ourselves)

- Pitches in the same week share one market, and overlapping holding periods
  are not independent. Group standard errors by date, or use non-overlapping
  windows.
- Testing many features means some will look good by luck. Hold out a
  time period for confirmation, and be skeptical of anything that only works
  in-sample.
- Keep a random or exploration slice of pitches so we can see what happens to
  stocks the pitch rules would have skipped.
- Never change a feature's definition in place. A new definition is a new
  feature or a new mandate version.
- Write the question down before running the numbers.
- Rough sense of scale: small effects need hundreds of graded pitches, not
  dozens. That sets how many pitches per day are useful.

## 6. Rough phases (reorder freely)

1. **Isolate Agent One.** Done: Agents Two and Three frozen.
2. **Define the pitch record** (section 3) as a contract in `contracts/` and a
   Postgres table. Add it on top of existing tables; do not replace them.
3. **Pitch loop.** Agent One makes N buy-only paper pitches per day. Features
   are logged whether or not the old gates would have passed.
4. **Grading job.** Mature pitches at each horizon; write graded outcomes.
5. **Website hookup.** The new site reads pitches, outcomes, and analysis
   results through a small read-only API from `server.js`.
6. **First analysis cycle** once enough pitches have matured. Produce the first
   cut/adjust/add list.
7. **Mandate v4 draft**, based on evidence rather than guesswork.
8. **Fill gaps that proved to matter.** Only build the missing data adapters
   whose features look useful.
9. **Later, optional:** send the best pitch types into the real, human-approved
   proposal queue. All existing money-path safety rules still apply.

## 7. What does not change

- No autonomous trade execution. Python broker code stays read-only.
- Paper pitches never touch the proposal queue, ledgers, NAV, or the executor.
- Pitch and outcome records are append-only.
- Missing data is recorded as missing, never invented.

## 8. Decisions

### Made (2026-09-24)

- **Paper money.** Pitches are tracked, never traded, and never enter the
  proposal queue.
- **Many small pitches, any company size.** "Micro" means small units of
  learning, not micro-cap stocks. The universe is not limited by market cap
  beyond the mandate's existing liquidity rules.
- **Buy only.** No avoid or short calls. To still learn about the stocks that
  were not pitched, keep a small random exploration slice (section 5) and
  grade it the same way.
- **Short-term mindset.** Agent One's existing days-to-weeks style stays the
  frame. Gains are measured over a fixed short window (D-1).

### Still to answer

- **D-1: Grading time frame.** Over what window do we measure a pitch's gain?
  One horizon or several (for example 5, 10, 20 trading days)? Is the result
  the raw return at a fixed date, or the return had the mandate's exit rules
  (ATR stop, dead-trade timer) been followed? Which benchmark (SPY, sector
  ETF)? This must be fixed before the first pitch is graded.
- **D-2: Volume and spend.** Roughly how many pitches per day, and what monthly
  model spend is acceptable? This sets how fast we reach the hundreds of
  graded pitches the statistics need.
- **D-3: Website.** Which stack, where it will live, and whether it only reads
  data or can also write (our own grades or notes on a pitch).
- **D-4: Review cadence.** Who does the human review (Sam and the investing
  partner?), and how often?
- **D-5: Master-plan authority.** `CLAUDE.md` calls the master plan the single
  north star. Should it get a short note pointing here while this experiment
  runs?
