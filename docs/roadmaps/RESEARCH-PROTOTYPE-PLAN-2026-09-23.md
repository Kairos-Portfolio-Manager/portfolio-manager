# Research Testing Prototype — Build Plan

**Status:** In progress, build session started 2026-09-23. This document is the
handoff context — a fresh session should be able to start from this file alone plus
the "Read first" list below and the current worktree state
(`~/All Claude Projects/pm-worktrees/research-lab`, branch `claude/research-lab-2026-09-23`).

**Naming note, important:** this is called the **Research Testing Prototype**, never
"the Lab" or "lab" in any code/keys/docs. Portfolio Manager already has a production
feature colloquially called "Lab" — an on-demand, single-ticker research tool wired to
the dashboard (`POST /research-ticker` in `server.js`, backed by
`researchTickerForAgentUnlocked` in `jobs/research-scan.js`, `lib/lab-research.js`) that
**writes real proposals into Sam's real approval queue**. Sam confirmed on 2026-09-23
this prototype must have **zero overlap** with that feature — different purpose
(automated batch research on a fixed universe vs. manual one-off lookups), different
behavior (paper-only vs. real proposals), and deliberately different vocabulary so
nobody ever confuses the two. Redis keys use a `proto:*` prefix, files are named
`proto-*`, never `lab-*`.

## Why this exists

Production Portfolio Manager has ~25k lines of `lib/`, a 4-agent architecture, and an
80-point/9-metric evidence-completeness gate — and has produced roughly two or three
real trades in three months. The 2026-09-21 session
([[2026-09-21 — Truthful Receipts, a Clobbered Catalog, and Why No Agent Can Act Yet]])
found the proximate causes are structural: `freshnessState` could never resolve to
`"fresh"` anywhere in the codebase (a hardcoded-true bug, **fixed on this branch,
commit `6605516`**), and even fixed, Agent 1's real coverage tops out at 63/80 points
until more evidence sources land. Those are real, fixable problems — but the deeper
issue Sam and his investing partner identified is that the system has been proving
*infrastructure completeness* instead of proving *research quality*, and the two got
coupled so tightly that nobody could see whether the underlying investment judgment
was any good at all.

**The prototype exists to answer one question, isolated from every other question:**
given a good framework and light guardrails, does Claude's research judgment — its
evidence use, its confidence calibration, its proposal quality — hold up well enough
that a human would trust it with real capital? Everything below is built to produce a
clean, gradable answer to that, as fast as possible, without touching or risking
production, and without overlapping the existing on-demand Lab feature.

## What this is not

- Not the existing dashboard "Lab" feature. No shared code path that can write a real
  proposal, no shared naming, no shared dashboard route.
- Not a fund. No real money, no broker, no signed order ever leaves this system.
- Not a replacement for the production build. Production's safety architecture
  (signed proposals, append-only ledgers, fail-closed checks, reconciliation) is not
  being second-guessed here and should not be touched by this work.
- Not a rewrite. It reuses production's data-fetch, evidence, and the **exact same
  generator → risk-engine → evaluator pipeline** (`reviewCandidateForAgent` in
  `jobs/research-scan.js`) as a library — the whole point is "run exactly how it runs
  normally, just on a smaller set of tickers," per Sam's explicit instruction.

## Decisions already made (do not re-litigate without Sam + partner)

| Decision | Choice |
|---|---|
| Isolation | Same repo, isolated data. Own branch/worktree, reusing existing code, writing to a **completely separate Redis key namespace** (`proto:*` vs `pm:*`), enforced at runtime by `lib/proto-store.js` — the only module allowed to touch Redis for prototype code, and it refuses any non-`proto:` key regardless of whether Redis is even configured. |
| Execution boundary | Paper-only. No broker call anywhere in this path, and — critically, discovered mid-build — **no real proposal write either.** `reviewCandidateForAgent` (the real per-candidate pipeline, shared with the scheduled scan) now takes an additive `ctx.dryRun` flag (default off, zero behavior change for every existing caller — verified, full suite 1147/1147). When true, it runs through the identical generator → risk-engine → evaluator → sizing logic and produces the identical would-be proposal shape, but skips the real `createProposal()` Redis/Sheets write and the real Kairos shadow write, returning the draft for the prototype to store in `proto:*` instead. |
| Pipeline reuse | **Not** the on-demand Lab entry point (`researchTickerForAgentUnlocked` / `lib/lab-research.js`) — that always writes a real proposal and is a different product. Reuses the lower-level, now-exported functions the scheduled scan itself uses: `loadAgentConfig`, `resolveCircuitBreaker`, `makeDateWindow`, `buildCandidate`, `buildAgentReviewContext`, `reviewCandidateForAgent`. This is "run exactly how it's running normally," per Sam, just fed a fixed ticker list instead of the discovery/candidate-slate machinery, and with `ctx.dryRun = true`. |
| Agent | Agent 1's mandate only (the faster-cadence one), as currently defined in `agent_mandates/Agent_One_Mandate_v3.md`. |
| Universe | Fixed, hand-picked ~50 tickers, chosen once by Sam + partner before build (open input, see below). Not the 4,500-name discovery universe — `buildSlate`/`candidate-slate.js`/universe-refresh are not used at all. |
| Cadence | Multiple scans per day (e.g. every 2-3 hours during market hours) against the 50-name universe, to accumulate a real sample fast. Own scheduler entry, not registered in production's `scheduler.js`. |
| Evidence gate | Reuses the existing 9-metric/100-point scorer (`lib/mandate-observation.js` + `lib/mandate-score.js`), now with the `freshnessState`/`thesisCritical` bug fixed (commit `6605516`), and a **lower point threshold set by Sam's partner** (open input, see below). |
| Feedback loop | **Mechanical self-learning**, modeled on production's `weekly-review.js` → `persistentMemory` pattern, scoped to `proto:*` keys only. **Known risk, stated plainly, not overridden:** a model learning from grades can start optimizing for what pleases the grader rather than for good research. Mitigation: a **frozen baseline window** (first ~2 weeks or ~20 graded proposals) where feedback is computed but not yet injected, so there's one clean unassisted read before the loop starts shaping the agent. |
| Dashboard | New standalone lightweight page/app, not a route inside `portfolio-dashboard` and absolutely not a route inside or near the existing "Lab" UI. |
| Access | Sam's investing partner already has full access to all PM code and dashboards as a co-owner. No separate access tier for the prototype. |

## Open inputs still needed before/at full wiring

1. **The 50 tickers.** Sam + partner pick these.
2. **The lower evidence-point threshold.** Partner's call. Can default to a clearly-marked placeholder (e.g. 40/100) that's a one-line config change to correct.
3. **How long / how many proposals before "proof."** Recommend defining loosely now (e.g. "~30-50 graded proposals") rather than leaving it fully open.

## Architecture

```
worktree: ~/All Claude Projects/pm-worktrees/research-lab
branch:   claude/research-lab-2026-09-23   (directory/branch names kept as-is;
                                             only user-facing/code vocabulary is
                                             "prototype", not "lab")

  reuses (imported, not forked):
    lib/edgar*.js, lib/yahoo.js, lib/consensus-snapshot.js, lib/ai-overlay.js,
    lib/mandate-observation.js, lib/mandate-score.js, lib/freshness-policy.js,
    jobs/research-scan.js: loadAgentConfig, resolveCircuitBreaker, makeDateWindow,
      buildCandidate, buildAgentReviewContext, reviewCandidateForAgent (all newly
      exported, additive, zero behavior change to existing callers)

  new:
    jobs/proto-research-scan.js   -- own scheduler entry, own cadence, builds ctx
                                      with dryRun:true, feeds the fixed 50-ticker
                                      list into the SAME reviewCandidateForAgent
                                      loop the scheduled scan uses
    lib/proto-store.js            -- DONE. All Redis access, proto:* keys only,
                                      runtime-guarded regardless of env state
    lib/proto-freshness-provenance.js -- thread real consensus/quote timestamps
                                      into metricProvenance so the Q-002/Q-003
                                      fix actually resolves "fresh"/"stale" instead
                                      of staying policy_unresolved
    lib/proto-feedback.js         -- grade -> lesson -> next-prompt injection,
                                      frozen-baseline-aware
    scripts/proto-export.js       -- read-only snapshot for Claude/Sam/partner
  dashboard: new standalone app, reads proto:* only, no write path to pm:*
```

## Build steps, status

### 1. Isolate the worktree and the data layer -- DONE
- Worktree created off `origin/mandate-v3`, no `.env` present (verified before every
  test run, per the 2026-09-21 incident lesson).
- `lib/proto-store.js`: runtime-guarded to `proto:*` keys, guard checked BEFORE Redis
  availability so it can never be silently skipped by environment state. Isolation
  test in `tests/proto-store-isolation.test.js` (4/4 passing) also asserts no other
  `proto-*` file imports `@upstash/redis` or `lib/redis.js` directly.

### 2. Fix the freshness bug, as its own reviewable change -- DONE, commit `6605516`
- `thesisCritical` derived per metric (`lib/freshness-policy.js: isThesisCritical`);
  only `instOwnershipDir`/`thirteenF` are non-critical, matching accepted Q-004
  exactly. Every other metric keeps the conservative default.
- Pure `resolveConsensusFreshness` (Q-002) / `resolveQuoteFreshness` (Q-003)
  resolvers, wired through an additive, optional `metricProvenance` argument on
  `buildAgentOneObservation`/`metricObservation`. No existing caller passes
  provenance yet, so behavior is unchanged until one does (verified: full suite
  1143/1143 before this step, 1147/1147 after).
- Deliberately does NOT touch the four EDGAR-companyfacts metrics or 13F's own
  freshness — no policy exists for either yet.
- **Needs Codex review before this is trusted in anything production-adjacent** —
  flagged on the coordination board 2026-09-23.

### 3. Reuse the real pipeline in dry-run mode -- DONE, needs a dedicated test
- `reviewCandidateForAgent` now accepts `ctx.dryRun`. When true: identical logic up
  through sizing, then builds the same proposal draft, skips the real
  `createProposal()` and `recordAgent4ShadowReview()` calls, and returns
  `{ ...draft, id: null, status: "DryRun", dryRun: true }` as `createdProposal` with
  `proposalDisposition: "would_create"`. The real branch's exact source shape
  (pinned by `tests/agent-parity-proof.test.js`) was preserved unchanged — the
  dry-run branch builds its own draft rather than sharing the literal call.
- Six more production functions exported (additive `export` keyword only, zero
  logic change): `loadAgentConfig`, `resolveCircuitBreaker`, `makeDateWindow`,
  `buildCandidate`, `buildAgentReviewContext`, `reviewCandidateForAgent`.
- Full suite re-verified after this change: **1147/1147**, no `.env` in the tree.
- **Gap, disclosed rather than hidden:** there is no existing unit-test harness for
  `reviewCandidateForAgent` with a fully-constructed `ctx` (it's normally only
  exercised end-to-end via the scheduled scan, which needs heavy mocking of
  `getAIRecommendation`/`evaluateProposal`). A dedicated dry-run-path test should be
  added before this is trusted — flagged for the build session and for Codex review,
  not silently skipped. Running `jobs/proto-research-scan.js` for real against live
  data will also exercise this path directly (watch for `[dry run] would queue...`
  log lines and confirm zero writes to `pm:proposal:*`).

### 4. Wire the prototype scan job -- DONE, commit `b37fe3d`
- `jobs/proto-research-scan.js` builds `ctx` the same way `researchTickerForAgentUnlocked`
  does (agent config, circuit breaker, boundary token, budget, holdings/lots read
  for context, research ledger, real macro/holdings context) but sources candidates
  from `config/proto/universe.json` (**placeholder 50 tickers -- Sam+partner still
  need to pick the real list**) instead of `buildSlate`/candidate-slate, sets
  `ctx.dryRun = true`, and loops `reviewCandidateForAgent` per ticker. Persists every
  result (including data-unavailable / peer-coverage-pending / errored tickers, not
  just reviewed ones) to `proto:*` via `lib/proto-store.js`.
- Own cadence: no cron registered yet, no scheduler wiring -- currently manual
  (`node jobs/proto-research-scan.js`). Multiple-scans/day cron scheduling is a
  small remaining task, deliberately left for after real tickers/threshold land so
  it isn't scheduled against placeholder data.
- **Still open:** real per-metric timestamp provenance is not threaded through, so
  the Q-002/Q-003 freshness fix built in step 2 resolves `"policy_unresolved"`
  rather than `"fresh"`/`"stale"` for every candidate this job scores today. This
  is a real gap, not cosmetic -- it means `complete`/`actionable` on the underlying
  observation contract still can't be reached from this job's output alone, though
  it's not blocking for the prototype's actual purpose (Sam/partner grade the
  *proposal itself*, not the mechanical completeness flag).
- **Not run against live data yet** -- needs real Sheets/Redis credentials and an
  Anthropic API key, neither present in the build environment. Import resolution,
  syntax, and the dry-run branch logic are verified; a real end-to-end run against
  live data is the next actual verification step, not yet done.

### 5. Grading + feedback loop -- DONE, commit `2b8d28e`
- `lib/proto-feedback.js`: pure grade validation/aggregation (`isValidGrade`,
  `summarizeGrades`) and `isFrozenBaselineWindowOpen` (first ~14 days or ~20 graded
  proposals, whichever comes first). 9/9 unit tests.
- `jobs/proto-feedback.js`: orchestration -- reads all `proto:*` grades, always
  stores the summary, calls the model (reusing `parseWeeklyLessons`) only once the
  window closes. `jobs/proto-research-scan.js` reads the resulting lessons and
  layers them on top of real (read-only) Agent 1 production memory.
- **Not run against live data yet** -- same credential gap as step 4.

### 6. Dashboard -- DONE, but NOT in this repo (superseded design, see below)

**Revised 2026-09-23:** the original plan (and commit `20b45d3`) built a standalone
`node:http` server inside this repo at `proto-dashboard/` (port 3201). Sam then asked
for a real Vercel-hosted dashboard with password protection instead, and Codex's
round-2 review separately flagged the local server's `/api/grades` as unauthenticated.
**`proto-dashboard/` was deleted from this repo in commit `8f7dbdc`.** It is not a
local entry point anymore -- do not tell anyone to run `node proto-dashboard/server.js`.

The real dashboard now lives in a **separate repository and deployment**:
- Repo: `~/All Claude Projects/proto-dashboard` (its own git history, own `package.json`,
  Next.js on Vercel). Not a subdirectory of this backend repo.
- Live URL: `https://proto-dashboard-pi.vercel.app` (Vercel project
  `samuelhuffard-9533s-projects/proto-dashboard`).
- Auth: `proxy.js` gates every route except `/login` behind a `PROTO_DASHBOARD_PASSWORD`
  cookie check (set in Vercel project env vars). If that env var is unset, the app is
  open with no gate at all -- Sam confirmed this is acceptable until he sets a password
  himself ("I'm not worried about anyone getting into it").
- Data access: hand-synced copies of `lib/proto-store.js` and `lib/proto-feedback.js`
  (kept small on purpose, same reasoning as this repo's originals) reading/writing the
  SAME Upstash Redis instance via `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`
  set as Vercel Production+Preview env vars. **Keep both copies in sync by hand** when
  either `proto:*` schema changes -- there is no cross-repo contracts package for this,
  deliberately, for a prototype tool this small.
- Per proposal: ticker, action badge, quant score, evaluator verdict, full rationale
  text, inline grading form (grader, would-approve, reasoning-sound, missed-something,
  1-5 score, comment), existing grades shown per proposal. Summary bar: distinct
  graded-proposal count, average score, would-approve rate, active lesson count,
  feedback-window status.
- **Verified:** clean `next build`; local `next dev` run confirming the password gate
  redirects/accepts correctly and renders the dashboard; deployed to Vercel production
  and confirmed live (`curl .../api/summary` returns real Redis-backed empty state, not
  an error) -- this is a genuine live connection to the same Redis the backend uses.
- **Not yet built:** the trend view (volume/approval-rate/grade-distribution over time)
  from the original spec -- the summary bar covers the all-time aggregate, not a time
  series. Small addition once there's enough real run history to make it meaningful.

### 7. Claude visibility -- DONE, commit `f307b9c`
`scripts/proto-export.js`: read-only markdown/JSON snapshot of recent proposals,
grades, and trend stats, same pattern as the ops "measure agent coverage" script.
Verified it runs cleanly with no Redis configured (prints the correct empty state).

## Explicit non-goals / do not touch

- Do not modify `contracts/`, `lib/redis.js` production paths, the broker/executor,
  the signed-approval pipeline, or anything under `docs/INVARIANTS.md`.
- Do not add Agents 2/3/4. Agent 1 only.
- Do not connect to nightly universe-refresh or candidate-slate discovery. Fixed
  ~50-name list only.
- Do not let any prototype key/flag/module share a name with production's or with
  the existing on-demand Lab feature's (`lab-research`, `research-ticker`, etc.) --
  this is the exact class of collision that caused the 2026-09-21 catalog incident
  and the vault slug collision the same week, and it's specifically what Sam asked
  to avoid by renaming away from "Lab" on 2026-09-23.

## Review requirements for the build session

Two pieces are shared/money-adjacent and need Codex review before they're trusted in
anything production-adjacent, even though neither is being deployed to production
right now:
1. The freshness/Q-004 fix (`lib/freshness-policy.js`, `lib/mandate-observation.js`) --
   flagged on the coordination board 2026-09-23, commit `6605516`.
2. The `reviewCandidateForAgent` dry-run path and the six newly-exported functions
   in `jobs/research-scan.js` -- not yet flagged, should be before this branch is
   considered done, and definitely before any code from this branch is ever merged
   toward `mandate-v3`.

## Handoff -- read first, in a fresh session

1. This file, and the "Build steps, status" section specifically -- it says exactly
   what's done vs. not.
2. `~/Claude Memory/Dev Logs/2026-09-21 — Truthful Receipts, a Clobbered Catalog, and Why No Agent Can Act Yet.md`.
3. `~/Claude Memory/Projects/pm-codex-claude-conversation.md` -- the 2026-09-23
   entries, for the naming-collision discovery and its resolution.
4. `docs/CHANGE_MAP.md` and `docs/INVARIANTS.md` in this repo.
5. `agent_mandates/Agent_One_Mandate_v3.md` -- the philosophy this prototype is testing.
6. Confirm the three open inputs (tickers, threshold, proof target) before finishing
   step 4's wiring -- placeholders are fine to keep scaffolding moving, but flag
   loudly, don't silently assume.
