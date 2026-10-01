# Pitch Lab — conviction & metric attribution framework

**Status:** built, runnable locally, **not deployed and not scheduled.** Paper only.
Nothing in `lib/pitch-lab/` or `scripts/pitch-lab.js` creates a proposal, calls a
broker, or writes Redis/Sheets/Postgres. The one place that touches the peer
table is the separate, narrow bridge (see "Peer-relative metrics"). Plan context:
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
| Peer ranks | `lib/pitch-lab/peer-rank.js` | Pure. Ranks each of the 9 mandate metrics against the company's industry peers (see below). |
| Peer bridge | `lib/pitch-lab-peer-bridge.js` | The **only** module that touches the database: reads `pm:peer-metrics`, and (flag-gated) files peer-coverage requests. Not imported by anything in `lib/pitch-lab/`. |
| Preview | `lib/pitch-lab/render-html.js` | Self-contained HTML view of a report. |
| CLI | `scripts/pitch-lab.js` | `demo`, `record`, `grade`, `analyze`, `coverage`. |
| Peer dry run | `scripts/pitch-lab-peer-check.js` | One-ticker check of peer coverage against the real peer table (run on the Jetson). Records nothing. |

## Running it

```bash
npm run pitch-lab -- demo                 # synthetic data, no network, no keys → data/pitch-lab/demo/report.html
npm run pitch-lab -- record my-pitch.json # one pitch object or an array (see docs/examples/pitch-lab-example-pitch.json)
npm run pitch-lab -- grade                # needs Yahoo access; grades every pitch whose horizon has passed
npm run pitch-lab -- analyze              # writes data/pitch-lab/report.json + report.html
npm run pitch-lab -- coverage             # fill rates: how often each metric was peer-ranked, and why not
node scripts/pitch-lab-peer-check.js NET  # dry run: fetch like the scan, rank against the live peer table (Jetson)
```

Options: `--dir=` (or `PITCH_LAB_DIR`), `--horizons=5,10,20`, `--benchmark=SPY`,
`--cost=0.001` (per side). The demo plants known effects (conviction +, revenue
growth +, forward P/E −, everything else noise) and the analysis recovers them —
that is also a test (`tests/pitch-lab.test.js`).

## Peer-relative metrics

A raw number ("revenue growth 27%") says nothing about whether that is strong *for
its industry*. Every pitch therefore also records, for each of the nine mandate
metrics, where the company sits among its industry peers at pitch time.

- **Same maths as the main pipeline.** The peer set comes from `resolvePeerSet`
  (industry first, widening to sector when the industry has fewer than 8 data-complete
  peers) and the rank from `percentileRank`, using Agent One's own metric directions
  (`config/scoring/mandate-v2.js` — a *lower* forward P/E is better). No second
  implementation.
- **Percentile = share of peers the company beats**, 0–1, direction-adjusted, so 0.9
  always means "better than 90% of peers".
- **A rank is only recorded when at least 8 peers have a value for that metric.**
  Otherwise the status says why and the percentile is null. Statuses:
  `ranked`, `thin_peers`, `no_peers`, `missing_value` (the company's own value is
  missing), `peer_data_unavailable` (the peer table could not be read — an outage is
  never confused with "no peers"). Nothing is filled in or guessed.
- **No look-ahead.** Peer rows stamped after the pitch time, and legacy rows without a
  full-instant retrieval timestamp, are ignored (counted in `excludedPeers`).
  `peerDataAsOf` records the newest peer row used, and validation rejects one after
  the pitch.
- **Only the nine mandate fundamentals are ranked.** Peer rows carry no price or
  market-cap fields, so those five features stay raw-only.
- **The model sees the ranks.** The prompt (`pitch-lab.prompt.v2`) shows each rank (or
  "unavailable") and forbids describing a metric as above or below peers unless one is
  listed.
- **The analysis tests ranks as their own family** (`peerMetrics` per horizon, with its
  own Benjamini–Hochberg correction), next to the raw metrics. Old pitches without a
  `peers` block simply count as missing there.
- **Why a raw value is missing is recorded** (`missingReason` on each feature):
  `not_supplied_to_pitch_lab` (consensus / 13F metrics — `revBeat`, `estimateRevisions`,
  `instOwnershipDir`, `thirteenF` — which the main scan has but Pitch Lab is not yet
  handed), `no_fundamentals_supplied`, `no_edgar_facts`, `not_reported`, `no_pe_ratio`,
  `insufficient_price_history`, `no_market_cap`.
- **`dataCoverage` in the report** (and `npm run pitch-lab -- coverage`) shows, per
  metric, how many pitches were ranked / thin / unranked / unrecorded and the missing
  reasons — the real peer coverage, once pitches come from live data.

### The bridge (the only database contact)

Pitch Lab stays database-free (a test fails if it imports Redis, Sheets, Postgres or a
broker). `lib/pitch-lab-peer-bridge.js` is the one seam, and a test pins what it may use:

- **Read:** `getPeerMetrics()` — the peer table the nightly peer jobs maintain.
- **Write:** `requestPeerCoverage()` — the existing bounded, ticker-keyed request queue
  that the 5:30 PM `peer-coverage-refresh` job consumes. Filed **only** when
  `PITCH_LAB_PEER_REQUESTS=1` (default off), only when a metric came back
  `thin_peers`/`no_peers`, never during a peer-table outage, and never for a company
  with no industry or sector. It never writes peer metrics, proposals, ledgers or
  anything else, and never calls a model or an order path. The coverage then arrives
  on the next refresh, so a pitch ranked before that shows the gap honestly instead of
  waiting.

Nothing imports the bridge from `lib/pitch-lab/` and nothing schedules it. Callers pass
its `peers` result to `buildPitch` / `pitchFromModelResponse`.

### Not covered (still open)

- **Grading is still against SPY only.** A pitch that beat SPY because its whole sector
  rallied still counts as a win. Sector-relative grading needs sector return data and is
  a separate step.
- **Consensus and 13F metrics are still null in Pitch Lab** (`not_supplied_to_pitch_lab`).
  Handing them in from the snapshot store / `lib/thirteen-f.js` is a separate step.
- **Real coverage is unknown from here.** It depends on `PEER_METRICS_ENABLED` /
  `PEER_METRICS_EDGAR` being on at the Jetson and on the cohorts having filled. Run the
  dry run there and read `coverage`.

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

`report.json`, `schemaVersion: "pitch-lab.report.v2"` (v2 adds `peerMetrics` per horizon and `dataCoverage`; pitch records are `pitch-lab.pitch.v2`):

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
                   verdict: { label, summary } } ],   // sorted by |rho|
      peerMetrics: [ ...same shape, one per mandate metric, tested on its industry-peer percentile; group: "peer_rank" ]
    } ] } ],
  dataCoverage: { pitches, pitchesWithPeerData, peerSetLevel, peerSetMode, peerSetReason,
    peerRankStatus: { [metricId]: { ranked, thin_peers, no_peers, missing_value, peer_data_unavailable, not_recorded, rankedShare } },
    missingReasons: { [featureId]: { present, missing: { [reason]: n } } } } }
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
