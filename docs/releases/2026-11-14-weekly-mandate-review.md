# Deploy: weekly Mandate Review + best/worst pitches (2026-11-14)

**For:** Sam H (Jetson deploy). **Approved by:** Sam C (2026-11-13).
**Release SHA:** the `mandate-v3` head after the `grading-system` merge PR lands. Sam C sends it.
**Class:** Pitch Lab only. Paper only: nothing here touches proposals, approvals,
signatures, the broker, the ledger or execution.

**Deadline:** deployed and `pitch-lab` restarted before **Sat 2026-11-14 11:00 ET**,
so the first weekly review runs on schedule.

## What ships

On top of the 2026-11-08 Pitch Lab scoring release (`cbb9a84`):

- **Mandate Review is weekly**: every Saturday 11:00 ET (was: first Saturday of the
  month). `lib/pitch-lab/schedule.js` is the one rule; the scheduler and the
  website's "next review" date both read it.
- **Review period = that Saturday** (`2026-11-14`). Reviews stored before this keep
  their month (`2026-11`); the store accepts both. No migration.
- **The website keeps 104 reviews** (two years of weeks) in its history index (was 36),
  and each index row carries `mandateScoreVerdict`.
- **Snapshot `performers`**: top 5 and worst 5 pitches by raw return (before costs,
  no benchmark) over each pitch's longest matured holding period, with the entry date.
  Additive: snapshot stays `pitch-lab.snapshot.v2`.
- **New CLI task `snapshot`** republishes the website snapshot from Postgres on
  demand. The Saturday review now also republishes it, so the site's "next review"
  date moves to the following Saturday right away.
- Telegram review digest says "Weekly".

**Also in this deploy: `grading-system` (live 0-100 mandate scorer, `e735838`)**

- Each new pitch freezes its `mandateInputs` (metric vector, EDGAR derived bundle,
  point-in-time consensus, industry-peer distributions) and a `mandateScore` 0-100
  computed from them by the live scorer. Pitch schema **v4**; v3 pitches and the
  peer-only /10 breakdown are untouched.
- The daily run now reads consensus history (`consensus_snapshots`, migration `0009`,
  already applied) per pitched ticker. A failed read is logged and those metrics score
  as missing; it does not stop the run.
- The weekly report analyses the 0-100 total as its own `mandateTotal` family. The
  Mandate Review and the website do not use it yet (still the /10 score).
- 13F inputs are not wired yet (follow-up).

Not changed: `package.json`/lockfile, `server.js`, `scheduler.js`, any env var,
the database schema. No `npm install`.

## Jetson steps

```bash
ssh <you>@<jetson>
cd ~/portfolio-manager
git status --short                 # must be empty; stop if not
git rev-parse --short HEAD         # write this down (rollback target)
git fetch origin
git log --oneline --first-parent HEAD..origin/mandate-v3
```

**Stop check:** that list should show the `grading-system` merge, the weekly-review
merge (`1068570`), and possibly the
11-08 release merge (`cbb9a84`) if that was never deployed. Anything else older
means the Jetson is further behind than this release assumes. **Stop and tell Sam.**

```bash
git switch mandate-v3
git pull --ff-only origin mandate-v3
git rev-parse HEAD                 # must equal the release SHA from Sam
npm test                           # several minutes; pitch-lab-mandate-review* print nothing for a while: not a hang
npm run db:migrate                 # only does anything if 11-08's 0011 was never applied; harmless otherwise
npm run deploy:restart             # signed restart of portfolio-manager — never plain pm2 restart for it
pm2 restart pitch-lab              # the scheduler process; this is what makes the review weekly
curl -sS http://localhost:3200/health
npm run sysloop:check
```

### Pitch Lab checks

```bash
pm2 logs pitch-lab --lines 30 --nostream     # "started — ENABLED"
node -e 'import("./lib/pitch-lab/schedule.js").then(m => console.log(m.nextMandateReviewAt()))'
                                             # → 2026-11-14T16:00:00.000Z before Sat 11:00 ET
node jobs/pitch-lab-daily.js snapshot        # republish the website snapshot now:
                                             # shows Sat Nov 14 and the best/worst lists today, not Monday night
```

After Saturday 11:00 ET: `pm2 logs pitch-lab` shows `mandate-review finished`, a
Telegram "Weekly Mandate Review" arrives, and the website's Mandate Review page
lists "Week of Nov 14, 2026" with the next review on Nov 21.

### Monday's first v4 pitch run (18:40 ET)

```bash
pm2 logs pitch-lab --lines 80 --nostream | grep -iE "consensus|mandate|error"
```

`consensus history unavailable for X` lines are expected for tickers without
consensus rows (those metrics score as missing). Anything else erroring: tell Sam C.

## Dashboard

Merge the `portfolio-dashboard` PR, then from a checkout with the sibling backend:
`npm run predeploy && npx vercel --prod --scope samuelhuffard-9533s-projects`.
Order does not matter: the new site handles a snapshot without `performers`
(it says the rankings are coming), and the old site ignores the new fields.

## Rollback

```bash
git switch --detach <the HEAD you wrote down>
npm run deploy:restart
pm2 restart pitch-lab
```

Weekly reviews already stored stay valid rows; the old code just won't run another
until the first Saturday of the month. Its store check rejects `YYYY-MM-DD` periods,
so do not run `mandate-review` manually on the old code.

## Report back to Sam C

The SHA you loaded (must equal the release SHA), the stop-check output, the PM2
restart edge (N→N+1), `npm test` totals, `/health` output, and the `snapshot`
task's output. After Saturday 11:00 ET: whether the review ran (`pm2 logs pitch-lab`).
