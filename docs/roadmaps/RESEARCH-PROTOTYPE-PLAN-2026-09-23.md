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

### 4. Wire the prototype scan job -- NOT STARTED
- `jobs/proto-research-scan.js`: build a `ctx` the same way `researchTickerForAgentUnlocked`
  does (agent config, circuit breaker, boundary token, budget, holdings/lots read
  for context, research ledger) but source candidates from a fixed ticker list
  (`config/proto/universe.json`, placeholder until Sam+partner pick names) instead of
  `buildSlate`/candidate-slate, set `ctx.dryRun = true`, and loop
  `reviewCandidateForAgent` per ticker. Persist every result to `proto:*` via
  `lib/proto-store.js` -- full evidence dump, not a summary, per Sam's explicit ask.
- Needs real per-metric timestamp provenance threaded through so the Q-002/Q-003
  freshness fix actually resolves `"fresh"` instead of staying `"policy_unresolved"`
  (`lib/proto-freshness-provenance.js`, not started).
- Own cadence (multiple runs/day), own cron registration -- NOT in production's
  `scheduler.js`.

### 5. Grading + feedback loop -- NOT STARTED
- Dashboard write path: Sam and partner each grade a proposal.
- `lib/proto-feedback.js`: same shape as production's `weekly-scorecard.js`, scoped
  to `proto:weekly-review` keys, with the frozen-baseline-window flag described above.

### 6. Dashboard -- NOT STARTED
Minimum fields per proposal: ticker, action, stated confidence, full raw evidence
with per-metric freshness/coverage, the model's own stated gaps, evaluator verdict,
both graders' scores/comments, and a trend view (volume, evaluator approval rate,
grade distribution over time).

### 7. Claude visibility -- NOT STARTED
`scripts/proto-export.js`: read-only markdown/JSON snapshot of recent proposals,
grades, and trend stats, same pattern as the ops "measure agent coverage" script.

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
