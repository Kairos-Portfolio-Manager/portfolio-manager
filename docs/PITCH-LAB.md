# Pitch Lab — conviction & metric attribution framework

**Status:** built, runnable locally, **not deployed and not scheduled.** Paper only.
Nothing in `lib/pitch-lab/` or `scripts/pitch-lab.js` creates a proposal, calls a
broker, or writes Redis/Sheets/Postgres. Plan context:
`docs/roadmaps/AGENT-ONE-PITCH-LAB-PLAN.md` (sections 3–5 are what this implements).

## The question it answers

> Over a given time period, how much did Agent One's **conviction** rating — and
> each **metric** behind a pitch — actually go with beating the market? Positive,
> negative, or no detectable effect, and how sure are we?

## How it works

```
Agent One (or a human) ──► pitch record ──► pitches.jsonl      (append-only)
                              │
       market prices ──► grading at 5/10/20 trading days ──► outcomes.jsonl (append-only)
                              │
                         analysis ──► report.json  ──► website
                                  └─► report.html  (preview of the website view)
```

| Piece | File | What it does |
|---|---|---|
| Metric catalog | `lib/pitch-lab/features.js` | The fixed list recorded on **every** pitch: the mandate's 9 fundamentals (ids from `config/scoring/mandate-v2.js`) + 5 price features + company size. Missing = recorded as missing, never filled. |
| Pitch record | `lib/pitch-lab/pitch.js` | Validates and freezes a pitch. **Rejects any pitch without a rationale** (thesis ≥ 40 chars, ≥ 1 reason, ≥ 1 risk), conviction outside integer 1–5, unknown metric ids, or any data timestamp after the pitch time (look-ahead). Buy-only. Content-hash id. |
| Model contract | `lib/pitch-lab/pitch-prompt.js` | Prompt + JSON schema for Agent One. The **model supplies only judgment** (conviction on a fixed rubric, rationale whose reasons cite metric ids). The **system supplies every number**, so the model cannot invent the data it is graded on. |
| Grading | `lib/pitch-lab/grading.js` | Entry = first close after the pitch; exit = close N trading sessions later; success = return after round-trip costs **minus** the benchmark (SPY) over the same sessions. |
| Analysis | `lib/pitch-lab/analysis.js` | Per time period × holding period: conviction and per-metric correlation factors with uncertainty. |
| Statistics | `lib/pitch-lab/stats.js` | Spearman, clustered regression, cluster bootstrap, t-distribution, Benjamini–Hochberg. Pure, no dependencies. |
| Storage | `lib/pitch-lab/store.js` | Append-only JSON-lines files in `data/pitch-lab/` (git-ignored). No update/delete; duplicates refused. |
| Preview | `lib/pitch-lab/render-html.js` | Self-contained HTML view of a report. |
| CLI | `scripts/pitch-lab.js` | `demo`, `record`, `grade`, `analyze`. |

## Running it

```bash
npm run pitch-lab -- demo                 # synthetic data, no network, no keys → data/pitch-lab/demo/report.html
npm run pitch-lab -- record my-pitch.json # one pitch object or an array (see docs/examples/pitch-lab-example-pitch.json)
npm run pitch-lab -- grade                # needs Yahoo access; grades every pitch whose horizon has passed
npm run pitch-lab -- analyze              # writes data/pitch-lab/report.json + report.html
```

Options: `--dir=` (or `PITCH_LAB_DIR`), `--horizons=5,10,20`, `--benchmark=SPY`,
`--cost=0.001` (per side). The demo plants known effects (conviction +, revenue
growth +, forward P/E −, everything else noise) and the analysis recovers them —
that is also a test (`tests/pitch-lab.test.js`).

## Statistical method (and why)

- **Correlation factor = Spearman rank correlation** between the rating (or metric)
  and excess return, −1 to +1. Conviction is ordinal and returns are fat-tailed, so
  ranks are more honest than Pearson. **Negative is a valid finding** (higher
  conviction did worse).
- **Effect size in returns:** excess return per conviction point, and per one
  standard deviation of each metric (so metrics are comparable), from a regression
  with **cluster-robust standard errors**.
- **Clustering:** pitches made in the same ISO week share a market and overlapping
  holding periods, so they are not independent. Standard errors, p-values (df =
  weeks − 1) and the bootstrap interval all treat a week as the unit. Configurable
  to `day`.
- **Many metrics at once:** metric verdicts use Benjamini–Hochberg q-values
  (false-discovery rate 10%), so ~15 metrics don't produce a lucky "winner".
- **Minimums:** under 30 graded pitches or 8 independent weeks, the verdict is
  `insufficient_data` — numbers are shown but no conclusion is drawn.
- **Missing data:** each metric also reports the result gap between pitches where
  it was present vs missing — missingness itself can carry information.
- Verdicts: `positive` / `negative` require both the regression test and the
  bootstrap interval to exclude zero; otherwise `inconclusive`.

Rough scale: an effect as small as 0.5% per conviction point needs a few hundred
graded pitches spread over months to show up. The per-month view will say
"insufficient data" for a long time; that is correct, not a bug.

## Report contract (what the website reads)

`report.json`, `schemaVersion: "pitch-lab.report.v1"`:

```
{ schemaVersion, gradingVersion, generatedAt, dataSources[], isSyntheticDemo,
  totals: { pitches, gradedByHorizon: { "5": n, ... } },
  assumptions: { benchmark[], costPerSide[], success },
  options, convictionRubric,
  periods: [ { id, label, from, to, pitchCount,
    horizons: [ { horizonDays, graded, meanExcessReturn, hitRate,
      conviction: { n, clusters, spearman: { rho, ci95 }, excessReturnPerPoint: { estimate, se, ci95, pValue, df },
                    buckets: [ { conviction, meaning, n, meanExcessReturn, medianExcessReturn, hitRate, hitRateCi95 } ],
                    verdict: { label, summary } },
      metrics: [ { id, label, group, coverage: { present, missing }, clusters, spearman: { rho, ci95 },
                   excessReturnPerSd: { estimate, se, ci95, pValue, qValue },
                   missingVsPresent: { meanExcessPresent, meanExcessMissing, difference },
                   verdict: { label, summary } } ]   // sorted by |rho|
    } ] } ] }
```

Returns are decimals (0.012 = 1.2%). A website must show the `isSyntheticDemo`
banner when true. Adding fields is fine; renaming/removing one is a new
`schemaVersion`.

## Getting it onto the website (when ready)

The site (`samuelhuffard/proto-dashboard`, Vercel) already reads the shared
Upstash Redis. Simplest path, no new server surface:

1. On the Jetson, a scheduled job runs `grade` then `analyze` daily after the close.
2. It publishes `report.json` to one Redis key (e.g. `proto:pitch-lab:report`)
   through the prototype's `proto:*`-only store.
3. The site adds a page that reads that key and renders it (the layout in
   `render-html.js` can be ported directly).

Alternative: a read-only `GET /pitch-lab/report` on `server.js`. Either way the
site only ever reads.

## Next steps (not done yet)

1. **Generate pitches from Agent One.** Wire `buildPitchPrompt` → Anthropic call
   (through the existing budget + usage telemetry, `lib/anthropic-monthly-budget.js`,
   `lib/anthropic-usage.js`) → `pitchFromModelResponse` → store, fed by
   `buildFeatures` from data the research scan already fetches. Sam Huffard's
   prototype branch (`claude/research-lab-2026-09-23`) has a dry-run research path
   that could supply the candidates; decide together before building a second one.
2. **Decide the horizon (plan D-1).** Defaults are 5/10/20 trading days.
3. **Move storage** from local files to Postgres (`db/migrations/`) or `proto:*`
   Redis once it runs on the Jetson; `store.js` keeps the same four functions.
4. **Conviction beyond the metrics:** a multivariate model to test whether
   conviction adds information the metrics don't already carry.
5. Schedule it (`scheduler.js`) only after 1–3 are reviewed.
