# Plan: 13F ingestion (institutional ownership + 13F accumulation)

**Status:** plan only, nothing built. Written 2026-11-18. Owner decisions are marked **DECIDE**.
Everything here uses free, public sources.

## Why this is the next build

The two 13F metrics are worth **15 of Agent One's 100 mandate points** (institutional ownership
direction 9, latest 13F accumulation 6) and are "no data" on **every** pitch today. Beyond score
quality, they decide live eligibility: the mandate allows rescaling only when ≥80 of 100 points
are available (§5, enforced as `actionable` in `lib/mandate-score.js`). With 13F always missing,
a stock that also lacks estimate revisions has 73 available and is `NO_TRADE`; with 13F
ingested it would have 88. 13F is also the one dataset that covers **every** company at once
(it is a sum across all institutional filers), so it can be peer-ranked from day one.

## What already exists (and what is wrong with it)

| Piece | File | State |
|---|---|---|
| Parse + aggregate the SEC data set | `lib/thirteen-f-dataset.js` | Pure, tested on fixtures, **never run against a real file**. Assumes one ZIP = one quarter, picks the "dominant" period, and keeps only the latest filing per manager+period. |
| Turn quarters into mandate evidence | `lib/thirteen-f.js` `deriveThirteenFEvidence` | Pure, owner-signed definitions (2026-08-02): ownership change in percentage points of shares outstanding (date-matched denominator), aggregate-share % change, two quarters + publication lag, never scored zero. Sound. |
| Ticker → CUSIP | `lib/cusip-map.js` | **Cannot work as written:** it asks OpenFIGI for a ticker's CUSIP and reads a `cusip` field; to our knowledge OpenFIGI never returns CUSIPs (licensed). Must be reversed (below). |
| Scoring hook | `lib/mandate-evidence.js` `applySharedEvidence({ thirteenF })`, `jobs/mandate-scoring.js` (`thirteenFByTicker`) | Ready: binds both metrics when handed the evidence. |
| Ingest job, storage, schedule | `jobs/thirteen-f-ingest.js` (referenced in a comment) | **Does not exist.** |

## Phase 0: verify on the Jetson (no code)

Sam runs and sends back (some are in the current deploy prompt):
1. **File naming.** `curl -sS https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets -A 'portfolio-manager research' | grep -o 'href="[^"]*form13f[^"]*\.zip"' | head`
   Expectation to confirm: since 2024 the SEC publishes **by filing-date window**
   (e.g. `01jun2024-31aug2024_form13f.zip`), not by calendar quarter. If so, one file holds
   several report periods (mainly one quarter's filings plus late filers and amendments).
2. **OpenFIGI reply fields** (the AAPL `curl` in step 5 of the deploy prompt): confirm there is
   no `cusip` field, and try the reverse: `-d '[{"idType":"ID_CUSIP","idValue":"037833100"}]'`
   should return AAPL.
3. **Tools and room:** `which unzip; df -h ~; free -m` (a quarterly ZIP is tens of MB;
   `INFOTABLE.tsv` inside is several hundred MB uncompressed: it must be streamed).
4. **One real file's headers:** download one ZIP, `unzip -l`, and `head -2` of
   `SUBMISSION.tsv`, `COVERPAGE.tsv`, `INFOTABLE.tsv`, so the parser is checked against reality
   (it fails closed on unexpected columns, by design).

## Phase 1: CUSIP ↔ ticker map (reversed direction)

- Source of CUSIPs: the 13F data set itself (`INFOTABLE.CUSIP` + `NAMEOFISSUER` + `TITLEOFCLASS`).
  Keep share-class rows (`COM`, `CL A`, etc.); drop notes, warrants, preferreds by
  `TITLEOFCLASS` and by `SSHPRNAMTTYPE = SH` only.
- **Primary map: OpenFIGI `ID_CUSIP` → ticker**, `exchCode: "US"`, common stock only. Free; a
  free API key raises limits a lot (without one: small batches, slow but workable once a
  quarter). **DECIDE:** register a free OpenFIGI key (stored as `OPENFIGI_API_KEY` in the Jetson
  `.env`, never printed).
- **Cross-check (free, already reachable host):** the SEC fails-to-deliver files list
  `CUSIP | SYMBOL` side by side twice a month. Use them to confirm mappings and to fill gaps;
  a disagreement between the two sources leaves the ticker **unmapped** (fail closed: a wrong
  CUSIP would attribute another company's ownership).
- Only tickers in the universe catalog are kept. CUSIPs are stable, so the map is cached and
  only new CUSIPs are looked up each quarter. Corporate actions (ticker change, new CUSIP after
  a reorganisation) are re-checked when a ticker's CUSIP stops appearing.

## Phase 2: ingest job

`jobs/thirteen-f-ingest.js`, in the `pitch-lab` process or a manual task at first (it feeds the
live scorer too, so its schedule is a release decision):

1. List the data-set files from the SEC page; download any not yet ingested (SEC fair-access
   rules: a descriptive User-Agent, ≤10 requests/second; this is a handful of files).
2. **Stream** the ZIP: read the central directory, inflate `INFOTABLE.tsv` with
   `zlib.createInflateRaw`, and process it line by line (no dependency needed; `unzip -p` is
   an acceptable alternative if present). Never load the whole table into memory.
3. Filter rows to mapped CUSIPs as they stream. Keep `SH` share rows without `PUTCALL`
   (existing rule).
4. **Aggregate per report period, across files.** Because a filing window can contain several
   periods and a quarter's filings can span two windows, group by `PERIODOFREPORT`, not by file.
5. **Amendments, done properly.** `COVERPAGE.tsv` says whether an amendment is a
   `RESTATEMENT` (replaces the original) or `NEW HOLDINGS` (adds to it). The current code keeps
   only the latest filing per manager+period, which **drops** "new holdings" additions. Fix:
   restatements replace; new-holdings amendments add.
6. `publishedAt` for a period = the date of the data-set file that completed it (what the
   evidence code's point-in-time rule keys on), not the statutory due date.
7. Store, then hand per-ticker quarters to `deriveThirteenFEvidence`.

Sanity check before trusting it: a dry-run that prints aggregate institutional shares and
holder counts for ~10 large, well-known names and compares the implied ownership % with
publicly reported figures (rough agreement, e.g. within ~10 points, is the bar; 13F excludes
some holders by design).

## Phase 3: storage (new migration, reviewed)

`db/migrations/0012_thirteen_f.sql`, append-only like the other evidence tables:
- `thirteen_f_files` (file name, filing window, downloaded_at, row counts, checksum)
- `thirteen_f_holdings` (cusip, period_of_report, institutional_shares, holders,
  completed_by_file, published_at, computed_at) — a recomputation is a new row, never an update
- `cusip_map` (ticker, cusip, source `openfigi`/`sec_ftd`, verified_at, conflict flag)

## Phase 4: wiring

- **Shares outstanding** for the denominator: EDGAR `CommonStockSharesOutstanding` (balance-sheet
  date = period end) is already a defined concept. The cover-page `dei` count is dated at the
  cover date and is excluded by the existing 10-day rule; that is correct, not a bug. Companies
  without a period-end share count get the accumulation metric only (ownership change stays
  null).
- **Live scorer:** `jobs/mandate-scoring.js` already accepts `thirteenFByTicker`; feed it from
  storage.
- **Pitch Lab:** add a `thirteenF` bundle to the frozen `mandateInputs` (bump
  `MANDATE_INPUTS_VERSION`), pass it to `assembleMandateInputs`. Point-in-time: only periods
  published before `pitchedAt`.
- **Peer ranking:** write each ticker's `instOwnershipDir` and `thirteenF` values into its peer
  row; because 13F covers everyone, most industries will clear the 8-peer bar immediately.
  Move both out of `DEFERRED_METRICS` in `lib/mandate-metrics.js`.
- Digest: the "Data behind today's scores" line shows the two counts rise from 0.

## Phase 5: release

A declared research release (R1: new evidence adapter changes live scores → new research
cohort), with the migration reviewed first. Deploy order: migration → map → one backfill of the
last 3 report periods (two changes need three quarters) → wiring → scheduled refresh.

## Order, size, risks

| Step | Size | Needs |
|---|---|---|
| Phase 0 checks | none | Sam, 15 minutes |
| Phase 1 CUSIP map | medium | OpenFIGI key decision; FTD cross-check |
| Phase 2 streaming ingest + amendments | larger | Phase 0 file shape |
| Phase 3 migration | small | review |
| Phase 4 wiring (scorer, Pitch Lab, peers) | medium | Phases 1-3 |

Risks: SEC file format drift (parser fails closed); mapping errors (two-source agreement or
unmapped); Jetson disk/memory (streaming, delete ZIPs after ingest); 13F lag (data is 1.5-4
months old by design: the mandate labels it "delayed ownership confirmation").

**DECIDE:**
1. OpenFIGI free key: yes/no.
2. Run the refresh weekly (cheap no-op when nothing new) or only on demand at first.
3. Backfill depth: 3 periods (minimum for both metrics) or 8 (two years, for the matrix).
