# Plan: real values for Revenue beat and Estimate revisions

**Status:** saved for later. Nothing here is built. Written 2026-11-18 after the first daily
digests with the consensus collector on. Owner decisions are marked **DECIDE**.

These two metrics are worth 22 of Agent One's 100 mandate points (revenue beat 10, estimate
revisions 12). Both come from consensus history (`consensus_snapshots`, Yahoo `earningsTrend`
via `lib/consensus-snapshot.js`), not from filings. The same code feeds Pitch Lab **and** the
live mandate scorer, so every step below that changes a value is a declared research release
(R1 in `docs/roadmaps/portfolio-master-plan.md`: new research cohort).

## Where they stand

| | Revenue beat | Estimate revisions |
|---|---|---|
| Mandate definition (Agent One v3 §5) | Reported revenue vs the consensus standing before the print: beat ≥5% / 2-<5% / 0-<2% / miss | **Next-12-month** EPS consensus change **over 30 days** plus revision breadth (up vs down) |
| How it is computed today | `selectRevenueBeatPair` + `revenueBeatPct`: EDGAR quarterly revenue vs the latest snapshot retrieved *before* the 10-Q/10-K was filed, period ends within 20 days. Leakage-safe. | `assembleConsensusEvidence`: % change in **current-quarter** (`0q`) EPS consensus from the **oldest to the newest** stored snapshot, plus Yahoo's 30-day up/down revision counts. Activates at ≥3 snapshots over ≥30 days. |
| Peer-ranked? | Never: the peer table (`pm:peer-metrics`) does not carry it, so it always uses the absolute bands (the mandate's own fallback below 6 peers) | Same |
| Coverage limit | Needs a snapshot taken before the quarter was reported, so a ticker first gets a value at its first earnings after collection began | Needs 30 days of our own snapshots per ticker (the mandate's rule; kept on purpose) |

## Phase 0: correctness of Estimate revisions (do first; affects values already scored)

Three mismatches with the mandate, found reading `lib/consensus-snapshot.js`:

1. **Window.** The change is measured from the oldest stored snapshot to the newest, which can
   be up to 240 days apart (`HISTORY_LOOKBACK_DAYS`). The mandate says over 30 days. Fix: compare
   the newest snapshot with the snapshot closest to 30 days before it (within a tolerance, e.g.
   25-40 days); no such pair → `insufficient_history`.
2. **Quarter rollover.** Snapshots are not checked for the same fiscal period. When `0q` rolls to
   the next quarter, the oldest and newest rows describe different quarters, and the "revision"
   is the gap between two quarters' EPS. Fix: only difference two snapshots with the same
   `periodEndDate` (or the same NTM construction, below). This alone can turn scores that
   look strong today (e.g. 12/12) into missing or different values.
3. **Horizon.** The mandate says next-12-month EPS; the code uses the current quarter. Yahoo's
   trend carries `0q`, `+1q`, `0y`, `+1y`. Options:
   - **A (recommended):** NTM = time-weighted blend of `0y` and `+1y` by the fraction of the
     fiscal year remaining (standard practice). Needs `0y`/`+1y` stored on each snapshot (today
     only `0q` is stored, so this starts a fresh history for the metric).
   - **B:** sum of the next four quarters (`0q`, `+1q`, then annual remainder): more fragile.
   - **C:** keep current quarter and document it as a deviation. **DECIDE.**
   Whichever is chosen is a new metric definition: give it a new feature id in Pitch Lab
   (`features.js` rule: never change a definition in place) and bump the scorer's version.
4. Breadth: the code uses Yahoo's own 30-day up/down counts from the newest snapshot. That is
   vendor-reported, not our history; keep it (the mandate asks for breadth and there is no
   free alternative) but record it as vendor-sourced in the evidence.

Tests: a rollover between two snapshots must not produce a revision; a 240-day-old snapshot
must not be the base; two snapshots 31 days apart in the same period produce the mandate's
bands exactly. Re-run the Mandate Review afterwards and note the cohort break.

## Phase 1: coverage (collect more of the right history)

- The 07:10 collector (`PITCH_LAB_CONSENSUS_COLLECT=1`) covers Agent One's screened pool,
  250 names a pass. Keep it. Store **`0q`, `+1q`, `0y`, `+1y`** on every snapshot (one fetch
  already returns all four) so Phase 0's NTM and later peer work have what they need.
- Extend it to **the industry peers of the names most likely to be pitched**: for the top ~60
  of the pool, resolve the peer set the scorer would use (`resolvePeerSet`) and add those
  tickers to the rotation. Bounded by `PITCH_LAB_CONSENSUS_LIMIT`; measure the pass time.
- Revenue beat timing: make sure every pool name has a snapshot in the ~2 weeks **before** its
  earnings date (Yahoo `calendarEvents.earnings`). A pre-earnings sweep each morning for names
  reporting in the next 10 days gives each print a fresh pre-report consensus.
- KPI: the digest's "Data behind today's scores" line; target ≥ 10/15 pitches with revenue beat
  within one earnings season, and estimate revisions climbing after day 30.

## Phase 2: peer-rank both metrics (so they stop living on fixed bands)

- A nightly step after the peer refresh: for every ticker in the peer table that has consensus
  history, compute revenue beat (`selectRevenueBeatPair` with the peer row's stored
  `_revenueQuarterSeries`, which is already persisted) and estimate revisions (Phase 0 rules),
  and write them into that ticker's peer row with the snapshot instants they came from.
- `peer-rank.js` and the scorer's `peerDistributions` then pick them up unchanged once ≥8
  peers in an industry carry a value (6-7 → blended, <6 → absolute, as the mandate says).
- Point-in-time: a peer's value may only use snapshots and filings dated before the pitch.
  The existing `excludedPeers` / `peerDataAsOf` checks cover peer rows; extend them to the
  consensus fields.
- **DECIDE:** peer-rank revenue beat on the beat % alone (mandate wording), and estimate
  revisions on the NTM % change alone, with breadth only in the absolute bands? (Recommended:
  yes, one number per metric keeps ranking well defined.)

## Phase 3: quality and backstops

- Second check on Yahoo period alignment: compare the snapshot's `periodEndDate` with EDGAR's
  quarter end and log mismatches beyond the 20-day tolerance (52/53-week filers).
- Alert when a pass observes far fewer tickers than planned (already: "partial" below half).
- Free alternatives were considered and rejected for now: SEC has no consensus data; free
  tiers elsewhere give EPS surprises but not revenue estimates or revision history. Yahoo
  `earningsHistory` gives past EPS surprises (EPS, not revenue): could be an interim proxy for
  revenue beat, but it is a different metric. **DECIDE** only if revenue-beat coverage stays
  low after one full earnings season.
- Declined: using Yahoo's own 7/30/60/90-days-ago EPS to skip the 30-day wait. Sam C kept the
  mandate's 30-day local-history rule (2026-11-18).

## Order and size

| Step | Size | Changes values? | Release |
|---|---|---|---|
| Phase 0.1-0.2 window + rollover | small, pure, tested | yes (estimate revisions) | R1 research release |
| Phase 0.3 NTM + store `+1q/0y/+1y` | medium | yes, new metric id | R1 |
| Phase 1 peers of top names + pre-earnings sweep | medium | more coverage only | research data |
| Phase 2 peer ranks for both | larger (nightly step, peer-row fields) | yes | R1 |
| Phase 3 | small items | no | plumbing |

Files: `lib/consensus-snapshot.js`, `lib/pg/consensus-snapshots.js`, `jobs/pitch-lab-daily.js`
(collector), `lib/pitch-lab/consensus-plan.js`, `jobs/peer-coverage-refresh.js` /
`jobs/universe-refresh.js` (peer rows), `lib/mandate-metrics.js` (`DEFERRED_METRICS`),
`lib/pitch-lab/features.js` (new ids), tests for each.
