# Codex review prompt -- Research Testing Prototype (paste this in as-is)

Please review two commits on branch `claude/research-lab-2026-09-23` in
`~/All Claude Projects/pm-worktrees/research-lab` (or wherever you check it out),
based on `origin/mandate-v3@7c54922`. Full context if you want it:
`docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md` and the 2026-09-23 entries in
`~/Claude Memory/Projects/pm-codex-claude-conversation.md`.

Short version of what this is: Sam and his investing partner are building a
paper-only "Research Testing Prototype" that runs Agent 1's real research pipeline
against a small fixed ticker list, so they can grade research quality directly
instead of inferring it from the production evidence-completeness gate. It is
explicitly NOT the existing on-demand dashboard "Lab" feature
(`researchTickerForAgentUnlocked`/`lib/lab-research.js`), which writes real
proposals -- Sam asked for zero overlap with that, hence "prototype" naming and
`proto:*` Redis keys throughout, never `lab`.

**Two commits actually need your money-adjacent review. Please focus there; the rest
of the branch (proto-store, the scan job, the feedback loop, the dashboard) is new,
isolated code that doesn't touch anything you'd normally review, though a look is
welcome.**

## 1. `6605516` -- `thesisCritical` derivation + Q-002/Q-003 freshness resolver

Files: `lib/freshness-policy.js` (new), `lib/mandate-observation.js` (modified),
`tests/freshness-policy.test.js` (new), `tests/mandate-observation.test.js` (modified).

This is the fix for the bug the 2026-09-21 session found: `thesisCritical` was
hardcoded `true` at both call sites in `mandate-observation.js`, which let a
missing/non-fresh 13F metric veto actionability -- directly contradicting accepted
Q-004 ("13F... required for full coverage but never blocking"). Please check:

- `lib/freshness-policy.js: isThesisCritical` -- only `instOwnershipDir`/`thirteenF`
  are marked non-critical. Does this match your understanding of the accepted Q-004
  decision? I did not extend leniency to any other metric.
- `resolveConsensusFreshness` (Q-002: 30-day age limit + event invalidation at next
  session open) and `resolveQuoteFreshness` (Q-003: 5-minute regular-session age +
  event invalidation, never fresh outside regular hours at creation time) -- do
  these match the exact decided policy text in the 2026-09-21 board entries? I was
  not in the room for the original Q-002/Q-003 decision conversation with Sam's
  partner, so an independent read of the policy-vs-code match matters here.
- `metricObservation()` in `mandate-observation.js` -- the resolver is only invoked
  when a caller supplies `metricProvenance` for a given metric; absent provenance
  falls back to the unchanged `"policy_unresolved"`, not a false `"unavailable"`.
  I had this backwards on my first pass (it silently reclassified covered metrics
  as uncovered and broke the schema contract) -- caught by the existing test suite,
  fixed, but please double-check the current logic is actually right, not just
  that it passes.
- Confirm this is genuinely additive/backward-compatible: no existing caller passes
  `metricProvenance`, so no existing behavior should have changed. Full suite was
  1143/1143 before this commit, 1147/1147 after (the extra 4 are the new tests) --
  please re-run it yourself rather than trusting that count.
- Deliberately NOT touched: freshness for the four EDGAR-companyfacts metrics, or
  13F's own freshness (separate from its now-non-critical status). No policy exists
  for either yet.

## 2. `80def9f` -- `ctx.dryRun` on `reviewCandidateForAgent` + six newly-exported functions

File: `jobs/research-scan.js`.

`reviewCandidateForAgent` -- the real per-candidate pipeline the scheduled scan and
the on-demand Lab tool both call -- now accepts an additive `ctx.dryRun` flag
(default off/undefined, so existing behavior is unchanged for every current caller).
When true, it runs the identical logic through sizing, then instead of calling the
real `createProposal()` and `recordAgent4ShadowReview()`, it builds the same
proposal-draft shape and returns it as `createdProposal: { ...draft, id: null,
status: "DryRun", dryRun: true }` with `proposalDisposition: "would_create"`.

Please check specifically:

- The dry-run branch never reaches `createProposal` or `recordAgent4ShadowReview` --
  I structured it as a separate `if (ctx.dryRun) { ... } else { <original unchanged
  try/catch> }` rather than adding a conditional inside the original block, on
  purpose, so the real path's code is untouched. Please verify that's actually true
  reading it fresh, not just trusting my description.
- `tests/agent-parity-proof.test.js` pins the real branch's exact source text via
  `assert.match(scanSource, /createProposal\(\{\s*agentId: agent\.id/s)`. I
  deliberately built the dry-run branch's proposal draft as its OWN object literal
  rather than extracting a shared `proposalDraft` variable that the real
  `createProposal(...)` call would then reference -- my first attempt at the shared
  variable broke that pinned test, which is exactly the kind of drift the parity
  proof exists to catch. Please confirm the two branches' field lists still agree
  (I built them from the same source at the time, but they're two literals now, not
  one variable, so they can drift silently in a future edit).
- Six functions gained an `export` keyword with no other change: `loadAgentConfig`,
  `resolveCircuitBreaker`, `makeDateWindow`, `buildCandidate`,
  `buildAgentReviewContext`, `reviewCandidateForAgent`. Please confirm these are
  genuinely additive (a grep/diff check, not a full re-read) and don't change any
  existing caller's behavior.
- **The gap I'm flagging myself, not hiding:** there is no dedicated unit test for
  the dry-run branch. There's no existing test harness that constructs a full `ctx`
  for `reviewCandidateForAgent` at all -- it's normally only exercised end-to-end via
  the scheduled scan or the Lab tool, both of which need heavy mocking
  (`getAIRecommendation`, `evaluateProposal`, Sheets clients) that I did not build.
  I'm asking: do you think this needs a dedicated test before it's trusted, or is
  running `jobs/proto-research-scan.js` for real against live data (which I'm doing
  next) sufficient direct verification given it will exercise this exact path and
  log every `[dry run] would queue...` line? I lean toward "needs a test eventually,
  but a live run is reasonable interim verification" -- tell me if you disagree.
- Full suite 1147/1147 -> 1148/1148 across this commit (the extra 1 is my earlier
  proto-store isolation test, unrelated). Please re-run yourself.

## What I'm NOT asking you to review

`lib/proto-store.js`, `jobs/proto-research-scan.js`, `jobs/proto-feedback.js`,
`lib/proto-feedback.js`, `scripts/proto-export.js`, `proto-dashboard/` -- all new,
isolated to `proto:*` keys (runtime-guarded, tested), no path to a real proposal or
real production status write. `tests/proto-store-isolation.test.js` specifically
asserts no `proto-*` file imports a money-path write function from `lib/redis.js` --
worth a skim if you want to sanity-check the guard itself, but it's not the same
risk class as the two commits above.

## What would help most

A plain yes/no on: (1) is the Q-002/Q-003/Q-004 logic actually correct against the
decided policy, not just internally consistent; (2) is the dry-run branch genuinely
side-effect-free against real proposal/Kairos/broker paths; (3) does this branch
need a dedicated dry-run test before Sam runs it against live data, or is a live run
itself sufficient verification for now. Thank you.
