# Mandate Review v2 — weekly metric matrix, bps adjustments, Friday run, spreadsheet export

**Status:** PLAN ONLY. Nothing here is built. Agreed with Sam C in conversation 2026-11-16.
**Scope:** Pitch Lab only (`lib/pitch-lab/`, `jobs/pitch-lab-daily.js`, `pitch-lab-scheduler.js`,
`scripts/pitch-lab.js`) plus the dashboard page in `../portfolio-dashboard`.
**Hard rules still apply:** suggestions only. Nothing here may modify the mandate config
(`config/scoring/mandate-v2.js`), create a proposal, write a ledger, or call a broker. Paper
only. Fail closed: missing/malformed report fields give "unavailable", never a made-up value.
Read `CLAUDE.md`, `docs/PITCH-LAB.md`, `docs/CHANGE_MAP.md`, `docs/INVARIANTS.md` first.

The review that exists today is documented in `docs/releases/2026-11-14-weekly-mandate-review.md`
and implemented in `lib/pitch-lab/mandate-review.js` (schema `pitch-lab.mandate-review.v1`).
This plan extends it; keep the existing fields working (additive changes).

## 1. What Sam wants

1. A **weekly matrix**: one row per metric (all nine, every week), one column per week
   (week 1 … week n) plus an **Aggregate** column. Each cell is the correlation between the
   metric and the pitch's **excess return vs SPY** (the existing grading, unchanged).
2. The **aggregate drives the suggestions** and carries the most weight. One bad week must not
   hurt a metric. The weekly columns inform *consistency/confidence*, not the weight change.
3. For each metric, a **suggestion in bps of mandate weight**: more, less, no change, and
   (Phase 2) a range change. The table ends the review: metric on the left, change on the right.
4. A real **"less weight"** option: a metric whose effect is clearly weaker than the other
   metrics, even when none of the others is strong yet.
5. **Extra statistics:** a consistency score, and the top-vs-bottom spread with its history
   across weeks.
6. **Spreadsheet export** of all of it.
7. Runs **Friday end of day** instead of Saturday, as one chain that replaces the two Saturday
   jobs.

"Success" means outperformance vs SPY over the holding period (what the grading measures), NOT
subsequent earnings results. A metric-vs-later-earnings analysis would need different data and is
out of scope (note it as a possible future item).

## 2. Weights and bps

Weights are points out of 100 (categories A 25, B 30, C 30, D 15 for Agent 1; see
`config/scoring/mandate-v2.js`). **1 point = 100 bps of the total mandate score.**
Show `currentBps`, `changeBps`, `suggestedBps`. The mandate total must stay 100 points.

## 3. The weekly matrix

- **Row:** each of the nine mandate metrics (`METRIC_IDS` in `config/scoring/mandate-v2.js`).
  List all nine every week, including ones with no data (show "n/a").
- **Value correlated:** the company's **peer percentile** for the metric (already direction-adjusted
  by Pitch Lab: 0.9 = better than 90% of peers), so a **positive number always means the metric
  worked the way the mandate expects**, including lower-is-better ones like peerValuation. If the
  peer percentile is missing for a pitch, that pitch is simply absent from that cell (never filled).
- **Weekly cell:** Spearman correlation within that week's pitches, vs excess return at the
  selected horizon. **Default horizon 10 trading days**; 5 and 20 selectable on the website and in
  the export.
- **Which week a pitch belongs to:** the ISO week of its **entry date**, matching how
  `lib/pitch-lab/analysis.js` already clusters. Pitches made Friday after the close enter Monday, so
  they belong to the following week's column.
- **Maturity:** a cell can only use pitches whose horizon has passed. Immature pitches are left out
  and the cell shows how many pitches it used. In the 20-day view a week's cell fills about four
  weeks late. A cell with fewer than ~10 usable pitches shows "n/a" (make the threshold a named
  constant). A week has ~75 pitches and peer coverage is ~40-50%, so a weekly cell has a standard
  error of roughly 0.12-0.17: shade a cell only when its confidence interval excludes zero;
  otherwise treat it as descriptive.
- **Aggregate cell:** the existing pooled analysis (Spearman across all graded pitches, weeks as the
  clustering unit, cluster bootstrap CI, Benjamini-Hochberg q-value across the nine metrics). The
  aggregate is the only number that can create a suggestion.
- **Extra header rows:** pitches graded per week and that week's SPY return, so up/down weeks are
  visible.
- **Extra columns:** "weeks positive" (e.g. 4/5) and the consistency score below.

Illustrative layout (numbers are made up):

| Metric | Wk 1 | Wk 2 | Wk 3 | … | Aggregate | Weeks positive | Consistency |
|---|---|---|---|---|---|---|---|
| Revenue growth | +0.22 | +0.05 | +0.18 | | +0.14 | 4/5 | 1.1 |
| Forward P/E (peer valuation) | −0.08 | +0.12 | −0.02 | | +0.03 | 3/5 | 0.3 |

## 4. Extra statistics

1. **Consistency score** (information-coefficient information ratio): mean of the weekly
   correlations divided by their week-to-week standard deviation. Higher = more reliable. Weeks
   with too few pitches are excluded and the count of weeks used is shown.
2. **Top-vs-bottom spread:** mean excess return of the top fifth of pitches by the metric's peer
   percentile minus the bottom fifth, in percent, overall and **per week** (a history row).
   - The spread itself should be **large and positive** (the metric separates winners from losers).
   - Its **week-to-week variation** should be **small** (stable). Report both. (Sam said "we want
     this to be small"; the intended meaning is the variation, not the spread. Confirm in review.)
   - Weeks too thin for quintiles use the same n-threshold rule and show "n/a".
3. **Later, not in the first version:** overlap between metrics (partial correlation, so weight is
   not double counted), out-of-sample scoring of frozen suggestions on later weeks, a sector-
   neutral excess-return check column (SPY stays the primary benchmark), and signal decay across
   5/10/20-day horizons.

## 5. How suggestions are decided (extends the current rules)

Keep what exists: minimum 30 graded pitches and 8 independent weeks else `insufficient_data`;
only aggregate findings with a clear verdict and q-value <= 0.10 count; confidence labels
`recommended` / `watch` / `no_change` / `unavailable`; opposite-direction horizons are a conflict,
not a recommendation; `review_direction` when the data contradicts the metric's expected direction.

Add:
- **A change is actionable after one week** (no multi-week wait). The aggregate carries the weight;
  the weekly columns only adjust confidence: a significant aggregate whose sign held in most weeks
  (use the consistency score and weeks-positive) is `recommended`; a significant aggregate with an
  unstable sign is `watch`. A single bad week never downgrades a metric by itself.
- **"Less weight":** compare each metric's standardized effect (excess return per SD) with the
  others. Mark `less` when its effect is clearly below the median of the others (the bootstrap CI of
  the difference excludes zero), even if no metric is strong. A relative `less` is capped at
  `watch` until the metric also has its own significant finding.
- **Size in bps:** target weight from each metric's effect size, shrunk toward the current weight
  (more shrinkage for `watch` than `recommended`); cap each step (start at +/-100 bps per review),
  round to 50 bps; changes must net to zero so the total stays 100 points; keep category totals
  fixed unless Sam decides otherwise. Metrics with no finding show `no change`.
- **Relative to the live config weights, not cumulative.** If last week's suggestion was not
  applied, this week's table shows the change from the current config, not stacked on top.
- Conviction and the composite Mandate Score stay **informational rows** (they have no weight to
  move): show their verdict and consistency, outside the adjustment table.

Final table (end of the review and on the website): `Metric | Suggested change`, where the change is
`no change`, `+X bps`, `-X bps`, or (Phase 2) `range up/down by X percentile points`.

## 6. Phase 2: range changes (needs new analysis first)

The report has no data on WHERE in a metric's range the effect shows up. Extend
`lib/pitch-lab/analysis.js` to report mean excess return by scoring band (the peer-percentile
bands in `lib/peer-scoring.js` and the absolute cut points in `config/scoring/absolute-thresholds.js`)
and suggest threshold moves from that. Needs a larger sample than weights and a report schema
version bump. Do not build until Phase 1 is accepted and enough pitches have graded.

## 7. Spreadsheet export

- CLI: `npm run pitch-lab -- review-export` writes a file (CSV set or XLSX; choose the simplest that
  opens cleanly in Excel and Google Sheets). A download button on the website page uses the same
  data.
- Tabs/sheets: (1) weekly correlation matrix, (2) adjustment table (current bps, change bps,
  suggested bps, confidence), (3) top-vs-bottom spread by week, (4) consistency and weeks-positive,
  (5) raw per-pitch data (pitch id, entry date, week, each metric's peer percentile, excess return
  at 5/10/20) so every number can be audited. No secrets in the export.
- Direct push to a Google Sheet is NOT in scope (needs credentials on the Jetson).

## 8. Schedule: Friday end of day, one chain

Today (`lib/pitch-lab/schedule.js`, `pitch-lab-scheduler.js`): Saturday 10:00 ET runs the report
(analyse, publish, weekly learning digest); Saturday 11:00 ET runs the Mandate Review, which
recomputes the report itself from Postgres. Replace both with **one Friday job at ~20:00 ET**:

1. Confirm the 18:40 ET daily run (pitch + grade) finished; if not, alert and retry rather than
   reviewing stale data.
2. Analyse, publish the website report (keep the existing publish).
3. Generate, store, and publish the Mandate Review.
4. Send **one** Telegram message (the review) and republish the dashboard snapshot so "next review"
   moves to the following Friday. The separate weekly learning digest is retired; the review
   message replaces it.

Details:
- Holiday weeks: run on the **last trading day of the week** (use `lib/market-calendar.js`).
- `schedule.js` is the single source for the scheduler and the website's "next review" date: change
  it there (`WEEKLY_REPORT_ET` / `MANDATE_REVIEW_ET`, `isMandateReviewDay`, `nextMandateReviewAt`) and
  update its tests.
- Review `period` is the ET date of the run (Friday). Existing Saturday and monthly rows stay valid.
- The docstring on `runPitchLabMandateReview` still says "first Saturday of the month"; fix it.
- Keep Pitch Lab out of `scheduler.js` (a test forbids it).

## 9. Telegram vs website

- **Telegram:** short. Header with sample size, one bottom-line sentence, the adjustment table
  (metric | change, all nine), conviction and Mandate Score verdicts, and the "suggestions only"
  footer. Add aggregate correlation and weeks-positive per metric only if it stays readable on a
  phone.
- **Website:** the full matrix (all weeks), spread history, evidence per non-"no change" metric,
  data-quality/coverage, caveats, review history, and the export button. Dashboard repo is separate
  (`../portfolio-dashboard`): follow its conventions, run its tests and typecheck. Check
  `docs/CHANGE_MAP.md` before touching any cross-repo contract (`contracts/` + `npm run contracts:sync`).

## 10. Files likely touched

`lib/pitch-lab/analysis.js` (weekly cells, consistency, spread), `lib/pitch-lab/stats.js`,
`lib/pitch-lab/mandate-review.js` (adjustments, less, bps), `lib/pitch-lab/telegram.js`,
`lib/pitch-lab/schedule.js`, `pitch-lab-scheduler.js`, `jobs/pitch-lab-daily.js`,
`scripts/pitch-lab.js`, a new export module, `docs/PITCH-LAB.md`, a release note under
`docs/releases/`, tests under `tests/`, and the dashboard page. Check whether the Postgres review
store (`db/migrations/0011_pitch_lab_mandate_review.sql`) accepts the additive fields; if it needs
a migration, it must be reviewed before anything is deployed.

## 11. Tests (pure functions first)

Fixtures with planted strong, weak, flat, and negative metrics; a "less" case where every metric is
weak; conflicting horizons; one bad week inside a good aggregate (must not downgrade); immature
cells; thin cells; insufficient data (no table); bps changes net to zero and respect the cap and
rounding; the schedule moves to Friday and handles holidays; the export contains every tab and
round-trips the numbers; and a test that nothing in the review module imports or writes the mandate
config, proposals, ledgers, or any order path.

## 12. Process

Show a short plan and wait for Sam's OK before writing code. New branch; no deploy, no Jetson, no
PR unless asked. Run `npm test` (the Mandate Review tests print nothing for minutes; that is not a
hang). Re-read the diff for anything that could touch proposals, execution, or the mandate.
