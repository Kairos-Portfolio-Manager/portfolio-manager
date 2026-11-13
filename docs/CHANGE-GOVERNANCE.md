# Portfolio Manager change governance

This is the operating framework for the two equal PM owners: **Sam Huffard** and **Sam Cristinzio**. It assigns a default lead based on the task, not permanent territory. Either partner can build in either domain; the point is to put the best first reviewer on the work and make ownership visible.

## Default roles

| Domain | Default lead | Default reviewer / acceptance lens |
| --- | --- | --- |
| Systems architecture, reliability, deployment, agent orchestration, runtime integration, and operational tooling | Sam Huffard | Sam Cristinzio checks technical soundness and product/finance impact |
| Research mandate, Pitch Lab methodology, entry/holding/benchmark policy, financial interpretation, and research-quality acceptance | Sam Cristinzio | Sam Huffard checks implementation feasibility, safety, observability, and operational fit |
| New product direction, source-of-truth changes, money authority, external commitments, or material recurring spend | Both owners | Both owners explicitly decide |

The task owner is accountable for moving the task to a reviewable state. The reviewer is accountable for independent scrutiny, not for silently taking over the task. The integrator is the person who combines approved work and is the only person who may release it.

## Change tiers

Classify the task before editing. If any part crosses a higher tier, use the higher tier. If unsure, escalate; an agent may not lower a tier on its own.

| Tier | Examples | Minimum approval before merge or release |
| --- | --- | --- |
| **0 — Solo maintenance** | Documentation, formatting, isolated test fixtures, reversible local tooling, or a non-behavioral refactor with no shared contract/config/runtime effect | Task owner self-review and relevant checks. One owner may merge; leave a short record for the other. No production release at this tier. |
| **1 — Reviewed implementation** | Paper-only feature behavior in one runtime, testable non-financial logic, or a non-destructive change that does not alter shared contracts, schedules, data ownership, notifications, or budgets | Task owner + an independent agent review of the finished diff + relevant tests. One owner may merge; notify the other owner. No production release at this tier. |
| **2 — Shared or live behavior** | Backend/dashboard contract, Postgres or Redis schema addition, recurring job/schedule, Telegram routing, Pitch Lab runtime wiring, agent prompt/policy, model budget, or a production behavior release without money authority | Builder evidence + independent agent review for each owner + explicit approval from the non-building owner. Integrator performs the release and records live verification. |
| **3 — Financial, authority, or irreversible change** | Broker/order/signing/approval flow, risk limits, ledger/investor accounting, credentials/RBAC, destructive or backfill data operation, source-of-truth migration, autonomous authority, or a change that can materially affect money, access, or evidence integrity | Both owners explicitly approve the plan and final diff. Each owner has an independent agent review; required tests, rollback/containment plan, and release evidence are attached. Only the named integrator releases. |

A production deployment is at least Tier 2 even if its source change looked smaller. Incident containment may be performed by one available owner only to stop harm (for example, disabling a job or reverting a known revision); record it immediately and complete Tier 2/3 review before restoring normal operation.

## Required task header

Every persistent task, PR, or agent handoff starts with this compact header:

```text
Owner:
Reviewer:
Integrator:
Tier: 0 / 1 / 2 / 3
Outcome:
Boundary / explicitly not changing:
Target: local / Jetson / dashboard / database / other
Done when:
```

For Tier 2 and 3, add: production rollout, rollback/containment, agent-review links or summaries, and both human approvals where required. A person or agent cannot be the independent reviewer of code it authored.

## Agent instructions

Every agent must:

1. Read `CLAUDE.md`, `AGENT-CONTEXT.md`, this document, and the applicable runbook/change map before meaningful work.
2. State the task header and classify the tier before changing files. If no owner, reviewer, or tier is supplied, ask or default upward; do not begin a state-changing implementation under ambiguity.
3. Work only inside the declared slice. Do not edit another active task's files, migration, shared contract, or operational document without a new agreed boundary.
4. Provide a handoff with the exact diff/revision, checks run, runtime evidence, remaining risk, and the next approval required.
5. Treat an agent review as advisory evidence, never as a substitute for the human approvals required by Tier 2 or 3.

## Mechanical enforcement

Documentation guides agents; GitHub rules protect the shared branch. Before relying on this framework for live work, configure branch protection for `mandate-v3` so direct pushes are blocked and Tier 2/3 PRs can receive the required owner approval. Use the task header as the PR description template and a `tier:0` through `tier:3` label. Do not configure an automatic merge/deploy rule that lets an AI-agent review satisfy a human owner approval.
