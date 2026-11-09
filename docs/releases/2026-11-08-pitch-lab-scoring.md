# Deploy: Pitch Lab scoring + Mandate Review (2026-11-08)

**For:** whoever deploys the Jetson backend. **Approved by:** Sam.
**Class:** R1 + R2, Pitch Lab only (see the declaration in
`docs/roadmaps/portfolio-master-plan.md` §5). Paper only: nothing here touches
proposals, approvals, signatures, the broker, the ledger or execution.

## What ships

Compared with the previous `mandate-v3` tip (`40ee20b`):

- **Mandate Review** (monthly statistical memo from Pitch Lab to the mandate), with
  a new append-only Postgres table: migration `0011_pitch_lab_mandate_review.sql`.
- **Mandate Score /10** on every new pitch, computed by code from stored peer
  percentiles; the model never sees it.
- **Conviction 1–10** (pitch v3, prompt v4). Old 1–5 pitches are kept as they are
  and analysed separately. This opens a new Pitch Lab research cohort.
- Report v3, website snapshot v2, review-history keys
  (`pitchlab:mandate-reviews`, `pitchlab:mandate-review:<id>`), and Telegram updates.

Not changed: `package.json`/lockfile, `server.js`, `scheduler.js`,
`ops-watch-scheduler.js`, any env var. No `npm install` needed.

## Order

1. **Dashboard first** (Sam): deploy `portfolio-dashboard` `main` with PR #1 merged
   (`npx vercel --prod --scope samuelhuffard-9533s-projects`). The new site
   shows an empty Pitch Lab status page until the backend publishes snapshot v2.
   The old site does not check the snapshot version, so deploying the backend
   first could break its Pitch Lab page.
2. **Backend** (Jetson), below.

## Jetson steps

Sam gives you the release SHA: the `mandate-v3` head after the release PR merges.

```bash
ssh <you>@<jetson>
cd ~/portfolio-manager
git status --short                 # must be empty; stop if not
git rev-parse --short HEAD         # write this down (rollback target)
git fetch origin
git log --oneline --first-parent HEAD..origin/mandate-v3
```

**Stop check:** that last command should list only the release merge (plus
`40ee20b todo: …` if HEAD is `f431b02`). If it lists more, the Jetson is behind
what this release assumes, and deploying would also ship older, unrelated
releases (including money/control changes). **Stop and tell Sam.**

```bash
git switch mandate-v3
git pull --ff-only origin mandate-v3
git rev-parse HEAD                 # must equal the release SHA from Sam
npm test                           # expect 1337/1337; ~8 min on a Mac, longer on the Jetson. The pitch-lab-mandate-review* files print nothing for several minutes: not a hang
npm run db:migrate                 # applies 0011 (new table only, additive)
npm run deploy:restart             # signed restart of portfolio-manager — never plain pm2 restart for it
pm2 restart pitch-lab              # separate process; it does not restart on its own
curl -sS http://localhost:3200/health
npm run sysloop:check
```

Healthy means the usual (see `docs/RUNBOOK.md` → Deploys): `/health` ok with
every dependency true, PM2 online with zero unstable restarts, a fresh startup
log, and the loaded SHA equal to the release.

### Pitch Lab checks

```bash
pm2 logs pitch-lab --lines 30 --nostream   # scheduler started, reports enabled/disabled as before
grep '^PITCH_LAB_ENABLED' .env              # unchanged by this release
# Only if PITCH_LAB_ENABLED=1:
node jobs/pitch-lab-daily.js daily --dry-run   # builds prompts (v4, 1–10), calls no model, records nothing
```

After the next 18:40 ET daily run, the website's Pitch Lab page should show
pitches with a Mandate Score breakdown.

### Optional: November's Mandate Review

The first review was due Sat 2026-11-07 but this code was not on the Jetson, so it
did not run. The next scheduled one is Sat 2026-12-05 11:00 ET. To make up
November, **only if Sam asks**:

```bash
node jobs/pitch-lab-daily.js mandate-review   # stores, publishes and sends one review; rerun is idempotent
node jobs/pitch-lab-daily.js review-history   # refreshes the website's review list
```

## Rollback

```bash
git switch --detach <the HEAD you wrote down>
npm run deploy:restart
pm2 restart pitch-lab
```

Leave migration `0011` in place (an unused table is harmless). Pitches recorded
as v3 stay valid; the old code ignores the fields it doesn't know.

## Report back to Sam

Release SHA loaded, the PM2 restart edge (N→N+1), `/health` output, `npm test`
totals, and the `db:migrate` output.
