# Deploy: Mandate Review v2 + new daily digest (2026-11-20)

**For:** Sam H (Jetson deploy). **Approved by:** Sam C sends the release SHA once the
branch `claude/mandate-review-v2` is reviewed and merged into `mandate-v3`.
**Class:** Pitch Lab only. Paper only: nothing here touches proposals, approvals,
signatures, the broker, the ledger, execution, or the mandate config.

**Timing:** deploy and restart `pitch-lab` before **Fri 2026-11-20 19:40 ET** for the first
Friday review. Deployed later, the first review is the following Friday; nothing breaks.

## What ships

On top of the 2026-11-14 release (`1fd5637`):

- **Daily Telegram digest, new format.** Plain text, no emoji. The four pitches with the
  highest stored 0-100 mandate score, each walked through all nine mandate metrics (rank,
  points), summed to the score, then "Stands out" and "Biggest risk" taken from the numbers.
  Missing data is shown as "no data, not scored", never as zero. A long digest is sent in
  two messages rather than cut.
- **Mandate Review moves to 19:40 ET on the week's last trading day** (Friday; Thursday when
  Friday is a market holiday), one hour after that day's 18:40 run. The Saturday 11:00 slot
  is gone. `lib/pitch-lab/schedule.js` remains the one rule; the website's "next review"
  date follows it.
- **The Saturday 10:00 weekly learning digest is unchanged.**
- **Weekly matrix** on the report (`weeklyMatrix`): each mandate metric's correlation with
  excess return vs SPY per entry week and in aggregate, weekly tally, consistency score,
  top-vs-bottom spread, and whether a metric is clearly weaker than the others.
- **Suggested weight changes in bps** on the review (`adjustments`), one row per metric, and
  as the closing table of the review's Telegram message. Suggestions only: 100 bps when
  recommended, 50 bps when watch, the mandate stays at 100 points and each category keeps
  its total. A real "less weight" for a metric clearly weaker than the others.
- **Spreadsheet export**: `node jobs/pitch-lab-daily.js review-export` writes
  `data/pitch-lab/review-export/mandate-review-<date>.xlsx` plus a `.csv` per tab. Manual
  only; it stores and sends nothing.

Details: `docs/PITCH-LAB.md` ("Daily digest", "Weekly matrix", "Mandate Review adjustments").

Not changed: `package.json`/lockfile (no `npm install`), `server.js`, `scheduler.js`, any env
var, the database schema (**no migration**: the review row is JSONB and the new fields are
additive), pitch/grading/report schema versions, stored pitches and outcomes.

## Jetson steps

Same one-command deploy as the last release:

```bash
ssh <you>@<jetson>
cd ~/portfolio-manager && git fetch origin
bash scripts/deploy-jetson-release.sh <release SHA from Sam C>
```

It refuses a dirty tree or an unexpected SHA, shows what ships, asks for a `y`, runs
`npm test` (several minutes; the Mandate Review test files print nothing for a while, which
is not a hang), then `db:migrate` (a no-op here), the signed `deploy:restart`,
`pm2 restart pitch-lab`, health and sysloop checks, and prints a report to send back.

**`pm2 restart pitch-lab` is the step that matters for this release:** the review's new time
is a cron line in that process. Until it restarts, the old Saturday 11:00 job would still
fire (and on the new code would log "not the week's last trading day" and skip).

### Checks after the restart

```bash
pm2 logs pitch-lab --lines 30 --nostream     # "started — ENABLED"
node -e 'import("./lib/pitch-lab/schedule.js").then(m => console.log(m.nextMandateReviewAt()))'
                                             # → 2026-11-21T00:40:00.000Z (Fri Nov 20, 19:40 ET) before then
node jobs/pitch-lab-daily.js snapshot        # website "next review" date moves to Friday now
PITCH_LAB_ENABLED=1 node jobs/pitch-lab-daily.js review-export   # optional: writes the spreadsheet, sends nothing
```

- **Next weekday 18:40 ET:** the daily Telegram digest arrives in the new format (possibly as
  two messages). `pm2 logs pitch-lab` shows the daily cycle finished.
- **Friday 19:40 ET:** `pm2 logs pitch-lab` shows `mandate-review finished`; a "Weekly Mandate
  Review" Telegram arrives ending with "Suggested weight changes", unless there is not yet
  enough data (then it says so, with no table).
- **Saturday 10:00 ET:** the weekly learning digest arrives as before.

## Dashboard

Nothing is required for this deploy: the stored review only gains fields
(`adjustments`, `weeklyMatrix`), which the current site ignores. To show them, the
`portfolio-dashboard` Mandate Review page needs:

- a table from `review.adjustments.rows`: `label`, `currentBps`, `changeBps`, `suggestedBps`,
  `direction` (`more` / `less` / `offset` / `no_change` / `unavailable`), `confidenceLabel`,
  `basis`, `sized`, and `evidence` (aggregate correlation, q-value, weekly tally, consistency,
  spread);
- the matrix from `review.weeklyMatrix.horizons[]` (10-day first; 5 and 20 selectable):
  `weeks[]` for the column headers, `metrics[].cells[]` for the cells (shade only when
  `significant`), `metrics[].aggregate`, `weeksPositive` / `weeksUsed`, `consistency.score`,
  `spread`;
- `adjustments === null` means "no table" (insufficient data, or an older review).

A download button needs a server route or a published file; neither exists yet (the export is
a file on the Jetson). The "next review" date already comes from the snapshot.

## Rollback

```bash
git switch --detach <the HEAD you wrote down>
npm run deploy:restart
pm2 restart pitch-lab
```

Reviews stored by this release stay valid rows; the old code ignores the extra fields and
goes back to Saturday 11:00.

## Report back to Sam C

The SHA you loaded, the PM2 restart edge for both apps, `npm test` totals, `/health` output,
the `nextMandateReviewAt()` value, and after the first weekday 18:40 run whether the daily
digest arrived in the new format.
