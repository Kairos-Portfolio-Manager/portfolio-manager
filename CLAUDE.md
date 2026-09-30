# portfolio-manager (backend)

AI portfolio research + execution backend. **Real money flows through this repo.** Node ESM (no TypeScript syntax in .js), runs on the Jetson under PM2 as `portfolio-manager` (`scheduler.js` → jobs + `server.js` on :3200).

> **On branch `claude/research-lab-2026-09-23`?** You're looking at the
> **Research Testing Prototype**, not production. Read
> `docs/roadmaps/RESEARCH-PROTOTYPE-PLAN-2026-09-23.md` first — it's a
> self-contained plan/status doc (what it is, why it's isolated from
> production, current build status, what's already been live-tested, what's
> still open). Everything below this note still applies (it's the same repo,
> same hard rules) — the prototype reuses production's pipeline as a library
> rather than replacing any of these rules. Quick orientation:
> - All prototype code/keys are named `proto-*` / `proto:*`, never `lab` (that
>   name is taken by an existing, different, real-money-adjacent feature —
>   see the plan doc's naming-collision section before assuming "Lab" means
>   this).
> - `lib/proto-store.js` is the only file allowed to touch Redis for
>   prototype code, and it refuses any non-`proto:` key at runtime.
>   `tests/proto-store-isolation.test.js` enforces this and a matching list of
>   forbidden real-money/production-status writes — read it before adding any
>   new external call to the prototype's job files.
> - The dashboard is a **separate repo**: `github.com/samuelhuffard/proto-dashboard`
>   (Vercel, deployed). Not a route in this repo or in `portfolio-dashboard`.
> - This branch has been through six rounds of independent (Codex) review —
>   see `~/Claude Memory/Projects/pm-codex-claude-conversation.md`'s
>   2026-09-23 entries if you have vault access, otherwise the commit messages
>   on this branch tell the same story in order. Read them before assuming an
>   isolation gap doesn't already have a fix — several non-obvious ones did
>   (a stale-cache freshness bug, a shared Anthropic budget leak, and the
>   prototype originally calling real production breaker/spreadsheet-ID
>   functions directly).
> - Real credentials were used for exactly one live run so far (2026-09-23,
>   confirmed safe). They are never committed — if you need to run the
>   prototype for real, get `.env`/`credentials.json` from Sam directly
>   (not via git/chat), and delete them from your worktree again afterward.

## Read first

- **Open system-loop findings → `ops/FIXLIST.md`** (auto-generated). At session start, skim "Needs attention" and judge whether anything there should be fixed as part of (or before) the current task — verify against live state first, findings are point-in-time. When you fix one, follow the status/regenerate steps in the file header.
- Collaborating with another human or coding agent → `docs/AGENT-CONTEXT.md` (the shared, redacted project context; do not rely on Sam's private local vault).
- New to the system → `docs/ONBOARDING.md` (mental models, proposal lifecycle, vocabulary).
- Planning significant work → `docs/roadmaps/portfolio-master-plan.md` is the single north star: find the current unified phase, TRUST/SKILL label, gate, and reset rule there. Use `docs/roadmaps/AUTONOMY-ROADMAP.md` only for narrower TRUST implementation detail; the master plan wins on conflict.
- Before ANY change → find your change type in `docs/CHANGE_MAP.md` (exact files + gotchas).
- Touching proposals/execution/ledgers/NAV → `docs/INVARIANTS.md` is non-negotiable.
- Ops (deploy, env, failure modes) → `docs/RUNBOOK.md`.

## Hard rules

- No autonomous trade execution. Python (`lib/robinhood-*.py`) stays read-only forever — `grep rh.order_` must return nothing (tested in `tests/read-only-broker.test.js`).
- Execution ordering is the safety mechanism: `Executing` marker before order → ledger write before fulfillment → `ref_id = proposal.id`. Never reorder.
- Security/signature checks fail CLOSED. Ledger tabs are append-only; corrections are new rows.
- Cross-repo contracts are single-source in `contracts/` (canonical here), mirrored to `../portfolio-dashboard/lib/contracts/` via `npm run contracts:sync` (drift-tested). The decision-signature payload, proposal enums/limits/validation, and lot ownership now live there — edit in `contracts/`, run sync, commit both. The full `AllocationProposal` shape is still hand-declared (`lib/redis.js`, dashboard `lib/proposals.ts`) but field-set drift is caught by the dashboard's `proposal-shape.test.ts`. See CHANGE_MAP "Changing proposal approval / execution logic".
- Money math goes in pure `lib/` functions with tests (`npm test`), then gets wired into `jobs/`.
- Failure is loud: pipeline outputs that get dropped must `console.error` + Telegram. Missing model-output fields FAIL the checks that read them.
- Never print secrets or full `.env`; `.trim()` every env read; check env presence per machine (local ≠ Jetson).

## Deploy

Deploy only the exact reviewed release branch/commit named in
`docs/roadmaps/portfolio-master-plan.md` (currently `mandate-v3`; do not assume `main`) →
`ssh sam@100.102.93.103`, fast-forward that branch, install dependencies/apply
reviewed migrations when required, then
`npm run deploy:restart`. That fail-closed helper observes exactly one PM2
restart edge, persists PM2, and writes a dedicated-key signed marker for the
sentinel; never replace it with an unmarked direct restart. Verify the exact
branch/commit, `curl localhost:3200/health`
(200 with all `deps` true), timestamped fresh logs, PM2 restart metadata, parity,
and the release-specific evidence. Deployment is not complete until those checks
are clean.

Companion repo: `../portfolio-dashboard` (dashboard on Vercel + Mac executor `scripts/mac-companion.mjs`, PM2 `portfolio-executor` — restart it after pulling executor changes).
