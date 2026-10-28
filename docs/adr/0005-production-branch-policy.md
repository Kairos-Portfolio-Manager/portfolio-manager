# ADR-0005 — Production branch and revision policy

**Status:** Superseded by [ADR-0006](0006-main-is-the-release-branch.md) (2026-10-28)

## Decision

`mandate-v3` is the current reviewed production line because it contains the
research evidence spine already deployed on the Jetson. The target steady state
is that reviewed work lands on `main` and production deploys the exact reviewed
`main` commit.

Until the controlled transition is complete:

1. A deployment may use `mandate-v3` only when its branch and exact commit are
   stated before and verified after restart.
2. No deployment may silently substitute the server's default branch.
3. Promote `mandate-v3` into `main` only from a clean worktree after a review,
   full test pass, dashboard parity check, and an explicit merge record.
4. Production verification records branch, commit, health result, migration
   state, and whether any authority flag changed.
5. A rollback returns to a previously verified commit; it is never an
   unreviewed branch switch.

## Why

The reviewed evidence-spine work is ahead of `main`, while unrelated local work
is currently in progress. Treating a branch name as an implementation detail
already caused one deployment to start from the old default branch. Pinning the
revision prevents that class of error without merging incomplete work.

## Consequences

This does not grant research, evaluator, broker, or money-read authority. It
only makes the software release path auditable and repeatable.
