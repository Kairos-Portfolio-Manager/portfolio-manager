# Deploy: Pitch Lab data coverage + review upgrades (2026-11-18)

**For:** Sam H (Jetson deploy). **Approved by:** Sam C sends the release SHA once
`claude/pitch-lab-data-coverage` is merged into `mandate-v3`.
**Class:** Pitch Lab, paper only. Nothing touches proposals, approvals, signatures, the
broker, the ledger, execution, or the mandate config. One thing is shared with production
research, called out below (the consensus history).

## What ships

On top of the 2026-11-20 Mandate Review v2 release (`6b9b0e2`):

- **Consensus collector (new job, default OFF).** 07:10 ET Mon-Fri in the `pitch-lab`
  process: observes Yahoo consensus for the pool Agent One pitches from (250 names a pass)
  and appends it to `consensus_snapshots`. This is what lets *estimate revisions* (needs 3
  snapshots over 30 days per ticker) and *revenue beat* score on more pitches. It needs
  `PITCH_LAB_CONSENSUS_COLLECT=1`.
  **Shared data:** `consensus_snapshots` is the same append-only history the universe and peer
  jobs already write and the live mandate scorer reads. More names will have consensus evidence
  over time, in production scoring as well as Pitch Lab. Same source, same row builder, no new
  adapter; it is flag-gated so turning it on is a deliberate step.
- **Metrics with no peer rank can now be reviewed.** Revenue beat, estimate revisions and the
  13F pair are scored on fixed bands; the weekly matrix reads them on their share of mandate
  points instead of showing "no data" forever.
- **Daily digest** gains "Data behind today's scores": how many of the day's pitches had each
  metric. The line to watch as data improves.
- **Mandate Review** now: reads the mandate weights fresh from disk on every run and records
  them (and warns on Telegram if the running process is behind the file); adds soft "Metric
  ideas" (features worth adding, metrics with no data / no effect / overlap); and the export
  gains a paste-ready **Change request** (tab + `.txt`) and a **Metric ideas** tab.
- No 13F data yet: that needs a new ingestion job (see `todo/TODO.md`).

Not changed: `package.json`/lockfile (no `npm install`), `server.js`, `scheduler.js`, the
database schema (**no migration**), pitch/grading/report schema versions.

## Jetson steps

```bash
ssh <you>@<jetson>
cd ~/portfolio-manager && git fetch origin
bash scripts/deploy-jetson-release.sh <release SHA from Sam C>
```

Then turn on the two data flags in the shared `.env` (add the lines if absent) and restart
`pitch-lab` so it reads them:

```bash
grep -E '^(PITCH_LAB_PEER_REQUESTS|PITCH_LAB_CONSENSUS_COLLECT|PEER_METRICS_ENABLED|PEER_METRICS_EDGAR)=' .env
# set:  PITCH_LAB_CONSENSUS_COLLECT=1   and   PITCH_LAB_PEER_REQUESTS=1
pm2 restart pitch-lab
pm2 logs pitch-lab --lines 10 --nostream     # "started — ENABLED"
```

- `PITCH_LAB_PEER_REQUESTS=1`: a pitch with a thin peer set asks the existing 17:30
  `peer-coverage-refresh` job to collect that industry (it only acts when
  `PEER_METRICS_ENABLED=1` and `PEER_METRICS_EDGAR=1`, which the grep shows).

### Start the 30-day clock now (do not wait for 07:10)

```bash
node jobs/pitch-lab-daily.js consensus-collect
```

About 2-3 minutes. Expect JSON like `{"status":"ok","poolSize":…,"planned":250,"observed":…,"stored":…}`.
Send the output back. `observed` well below `planned` means Yahoo is refusing: tell Sam C.
Running it again the same day does nothing for names already observed (20-hour gap).

### Tomorrow (Wed Nov 18) after the 18:40 daily run finishes, ~19:40 ET: the first review on record

```bash
node jobs/pitch-lab-daily.js mandate-review    # stores it, publishes it, sends the Telegram
node jobs/pitch-lab-daily.js review-export     # spreadsheet + change-request text, sends nothing
ls data/pitch-lab/review-export/
```

Send Sam C the `.xlsx` from `data/pitch-lab/review-export/`. The scheduled review still runs
Friday 19:40 ET by itself.

### What to expect

- **07:10 ET each weekday:** `pm2 logs pitch-lab` shows `consensus-collect finished`.
- **18:40 ET:** the daily Telegram digest ends with "Data behind today's scores".
- **Estimate revisions** stay mostly "no data" for about 30 days: that is the activation rule,
  not a fault. Revenue beat improves as quarters report after a snapshot exists.

## Checks worth sending back (for the 13F work that comes next)

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -A 'portfolio-manager research' https://www.sec.gov/files/dera/data/form-13f-data-sets/2025q1_form13f.zip
curl -sS -m 20 -X POST https://api.openfigi.com/v3/mapping -H 'Content-Type: application/json' -d '[{"idType":"TICKER","idValue":"AAPL","exchCode":"US"}]' | head -c 300
```

## Rollback

```bash
git switch --detach <the HEAD you wrote down>
npm run deploy:restart
pm2 restart pitch-lab
```

Or just set `PITCH_LAB_CONSENSUS_COLLECT=0` and `pm2 restart pitch-lab` to stop the collector.
Snapshots already stored are valid history and stay.
