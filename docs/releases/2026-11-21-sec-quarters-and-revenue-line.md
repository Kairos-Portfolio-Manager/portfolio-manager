# Deploy: SEC quarterly figures fixed + "no data" diagnostic (2026-11-21)

**For:** Sam H. **Approved by:** Sam C.
**Includes everything not yet on the Jetson:** the 2026-11-18 data-coverage release, the
2026-11-19 margin/wording/shadow release and the 2026-11-19 13F dry run. This branch
(`claude/edgar-q4-revenue`) is built on top of all of them, so one merge ships everything.
Read those three notes too.

## What ships in this part

**A declared research release** (R1): it changes values in the live mandate scorer, the
nightly peer table, Agent 3's history and Pitch Lab, so it opens a new research cohort.

1. **Missing quarters are derived from the company's own figures** (`lib/edgar-facts.js`).
   Companies file the fourth quarter only inside the 10-K's full year, and cash-flow lines
   (operating cash flow, depreciation) only year-to-date. Missing standalone quarters are now
   derived (fourth quarter = full year minus the three quarters; others = year-to-date
   differences) for revenue, gross profit, cost of revenue, operating income, net income,
   operating cash flow, interest expense and depreciation. Never for EPS or share counts. A
   reported 3-month figure always wins; a derived quarter carries the later filing date of its
   inputs, so it never exists before the filing that completes it.
   Effects: revenue growth acceleration and gross margin available far more often; revenue
   beat can pair a fourth-quarter actual with its consensus (needed for the January-March
   10-K season); twelve-month sums for balance-sheet scoring are real years.
2. **Twelve-month sums must be one contiguous year** (`ttm` in `lib/edgar-metrics.js`).
   Before, a line filed year-to-date summed four first quarters from different years. Where
   four contiguous quarters cannot be formed, the value is now null (rescaled out, never zero).
3. **The revenue line with the most recent data wins** (revenue and cost-of-revenue chains
   only), instead of the first tag with any data, which could be a tag the company stopped
   using years ago. Two standard revenue tags added. One series is never stitched together.
4. **Diagnostic** (read-only): `node scripts/pitch-lab-missing-data.js` explains every "no data"
   for revenue growth, gross-margin trend and revenue beat on recent pitches: the reason at pitch
   time, and which change (if any) fills it with today's code.

Not changed: dependencies, env vars, `scheduler.js`, `server.js`, database schema (no
migration), mandate rules.

## Jetson steps

Use Sam C's prompt. After the deploy:

```bash
node scripts/pitch-lab-missing-data.js --days=14 > /tmp/missing-data.txt 2>&1; head -60 /tmp/missing-data.txt
```

About a minute (it re-reads public SEC filings for the affected tickers, paced). Send the whole
file. "At pitch time" is the before picture; "with today's code" shows what this release fills.

## Rollback

```bash
git switch --detach <the HEAD you wrote down>
npm run deploy:restart
pm2 restart pitch-lab
```
