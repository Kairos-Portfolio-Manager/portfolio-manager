# Deploy: gross-margin fallback + clearer daily wording (2026-11-19)

**For:** Sam H (Jetson deploy). **Approved by:** Sam C.
**Includes the 2026-11-18 data-coverage release** (`695b0b8`, branch
`claude/pitch-lab-data-coverage`) if it is not deployed yet: this branch is built on top of it,
so merging this one ships both. Read `docs/releases/2026-11-18-pitch-lab-data-coverage.md` too.

## What ships

- **Gross margin when a company does not file `GrossProfit`** (`lib/edgar-metrics.js`): computed
  as revenue minus cost of revenue for both quarters of the year-on-year comparison (never mixed
  with the filed line), source recorded as `_grossMarginSource`. Companies with neither line
  (airlines, banks, many service firms) stay "no data".
  **Shared with production research:** the live mandate scorer and the nightly peer table use
  the same function, so more companies (and more peers) get a margin value. This is an
  evidence-adapter change: a declared research release that opens a new research cohort
  (`docs/roadmaps/portfolio-master-plan.md`, R1). Agent 3's long-horizon margin history is
  unchanged.
- **Daily digest wording:**
  - unscored estimate revisions say how far the ticker is from the mandate's rule, e.g.
    `building history (2 of 3 snapshots, 4 of 30 days), not scored` (rule unchanged);
  - fixed-band metrics say `fixed bands (no peer data for this metric)` or
    `fixed bands (only 4 peers, too few to rank)` instead of always "too few peers";
  - the data line shows how many pitches are still building estimate-revision history.
- `docs/roadmaps/consensus-metrics-plan.md`: saved plan for real revenue-beat and
  estimate-revision values (not built).

Not changed: dependencies, env vars, `scheduler.js`, `server.js`, database schema (no migration).

## Jetson steps

```bash
cd ~/portfolio-manager && git fetch origin
bash scripts/deploy-jetson-release.sh <release SHA from Sam C>
```

If the 2026-11-18 release was not deployed before, also do its `.env` steps
(`PITCH_LAB_CONSENSUS_COLLECT=1`, `PITCH_LAB_PEER_REQUESTS=1`, `pm2 restart pitch-lab`, then
`node jobs/pitch-lab-daily.js consensus-collect` once).

Check LUV's margin lines (tells us whether it files a cost-of-revenue line at all):

```bash
node -e 'import("./lib/edgar.js").then(async m => { const f = await m.fetchCompanyFacts("LUV"); const g = f?.facts?.["us-gaap"] ?? {}; console.log(["GrossProfit","CostOfRevenue","CostOfGoodsAndServicesSold","CostOfGoodsSold","OperatingIncomeLoss"].map(k => `${k}: ${k in g}`).join("\n")); })'
```

The next 18:40 ET digest shows the new wording. The nightly peer refresh picks up the margin
fallback for peers over the following nights.

## Rollback

```bash
git switch --detach <the HEAD you wrote down>
npm run deploy:restart
pm2 restart pitch-lab
```
