# ADR-0006 — `main` is the release branch

**Status:** Accepted by Sam Huffard 2026-10-28; pending Sam Cristinzio's approval on the PR. Supersedes the `mandate-v3` transition in [ADR-0005](0005-production-branch-policy.md).

## Decision

`main` is the single source of truth and the production release branch. Production deploys the exact reviewed `main` commit. `mandate-v3` is retired as a release line once the Jetson cutover below is complete.

## Why

- ADR-0005 already named this as the target steady state. Its blocker was that reviewed evidence-spine work was ahead of `main`. That no longer holds: as of 2026-10-27, `origin/main` contains every commit on `origin/mandate-v3` (0 behind, 4 ahead), so `main` fast-forwards cleanly.
- Two branches with different "meanings" caused the 2026-08-01 divergence (see `docs/BRANCH-DIVERGENCE-2026-08-01.md`) and, on 2026-10-27, a co-owner merging reviewed work to the default branch without knowing it was not the release line.
- A default branch that is not production is a trap for every new human and agent. Making them the same removes the need for an instruction that has to be remembered.

## What changes

Immediately (docs only, this PR): `CLAUDE.md`, `docs/AGENT-CONTEXT.md`, and the autonomy roadmap say that `main` is the release branch and that the cutover is pending. Nothing in this PR changes runtime behavior.

At cutover (a separate Tier 2 production action, not part of this PR):

1. Confirm the Jetson checkout is clean and record its current branch and commit.
2. Decide whether `main`'s unreleased commits ship at cutover. In particular, `db/migrations/0011_pitch_lab_mandate_review.sql` and the Pitch Lab Telegram routing in the Mandate Review feature need the two-owner review the co-owner agreement requires for migrations and alert routing. If they are not yet approved, deploy a reviewed `main` commit that excludes them, or hold the cutover until they are.
3. Check out `main` on the Jetson, install dependencies, apply only reviewed migrations, and run `npm run deploy:restart`. The helper records the branch in `SYSLOOP_DEPLOYED_BRANCH`.
4. Set `OBSERVATION_RELEASE_BRANCH=main` for the Phase 0 preflight, then change the `"mandate-v3"` default in `scripts/observation-preflight.js` and the matching test fixtures in a follow-up change.
5. Verify, per ADR-0005 item 4: branch, commit, `/health`, fresh logs with no startup crash, migration state, no authority flag changed, and the changed feature itself.
6. Update `docs/roadmaps/portfolio-master-plan.md`'s "Current release" line to the verified `main` commit.
7. Fast-forward `mandate-v3` to `main` and delete it, or leave it as a read-only alias for one release cycle. Do not let it receive commits.

During Phase 0 observation, step 3 onward is a production change and needs Sam Huffard's explicit release decision.

## Guardrails

- Enable branch protection on `main`: no direct pushes, one other-owner approval for Tier 2 and above, as `docs/CHANGE-GOVERNANCE.md` already requires of the release branch.
- A branch rename does not change execution authority. Sam Huffard remains the sole order approver; Kairos stays shadow-only.
- Rollback returns to a previously verified commit, never an unreviewed branch switch (ADR-0005 item 5).
