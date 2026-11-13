# Portfolio Manager co-owner working agreement

This repository is jointly operated by Sam Huffard and Sam Cristinzio. Both partners may inspect, change, and operate PM code and production infrastructure through individual accounts. That operational authority does **not** alter the order-approval boundary: Sam Huffard remains the sole human order approver and broker-signing authority until a separately reviewed, attributable two-approver design is implemented.

## Work records

- **Implementation:** branch, focused commit(s), and PR. State the goal, affected runtime(s), risk, checks, and any cross-repo follow-up.
- **Production change:** record the exact revision, deployment target, health result, and verification of the changed behavior. A green health endpoint alone is not a completed deploy.
- **Access or authority change:** record the provider, authority, date, and verification result in the private co-owner checklist. Never commit credentials, contact details, keys, or raw configuration.
- **Decision:** record material choices in an issue, PR, or the relevant repository document so the decision is discoverable without private chat history.

The private vault may keep concise partner/access context, but it is never the only implementation record a collaborator needs. The typed agent-handoff conversation is for AI-agent work only; it does not replace human review or a production record.

## Working method

1. State the goal, branch, target runtime, and whether a backend/dashboard/data contract changes.
2. Keep changes narrow. The builder supplies evidence; the other partner reviews when practical.
3. Before a production release, compare the reviewed revision with the production branch, follow `RUNBOOK.md`, and verify the exact affected behavior.
4. Leave a short handoff: changed, verified, remaining, and owner/next decision.

## Shared agent protocol

Agents serve the partner who assigned them; they do not become an independent third decision-maker. Before meaningful work, an agent must read `CLAUDE.md`, `AGENT-CONTEXT.md`, this agreement, the relevant change map/runbook, and the current task's branch/working-tree state.

1. **Claim a slice before editing.** The human or agent records one owner, the concrete outcome, repository/branch, likely files or subsystem, target runtime, and what is explicitly out of scope. Use a GitHub issue when work will persist; a draft PR or the task handoff is enough for a short investigation.
2. **One builder per logical slice.** Two agents must not edit the same feature, migration, contract, or operational document concurrently. Parallel work is good only when the boundaries are explicit—for example, one investigates runtime evidence while another reviews a finished diff. Use separate branches/worktrees for separate implementation slices.
3. **Return evidence, not just conclusions.** A handoff names the revision/diff, tests or commands run, runtime evidence if applicable, remaining risk, and the precise next decision. “Done” means the requested behavior was verified at the relevant layer.
4. **Resolve disagreement in a durable place.** Compare code, tests, logs, and product intent; then record the decision in the issue/PR or canonical document. Do not let an ambiguous chat thread silently become policy.
5. **Escalate rather than guessing.** An agent stops for a partner decision if scope, authority, data ownership, money impact, or production effect is unclear. It may investigate read-only evidence while waiting.

For a task with parallel agents, designate one **integrator**. Only the integrator combines reviewed changes, runs the final checks, and proposes or performs the release. The other agent(s) leave their work in reviewable commits or written findings.

## Two-person review required

Review together before merge or deploy when work affects broker execution, approval/signing, financial ledgers/risk limits, credentials or RBAC, database migrations/destructive data work, source-of-truth changes, autonomous-agent authority, Pitch Lab scheduling/wiring, Telegram alert routing, material model spend, recurring jobs, or Phase 0 safety/measurement.

Pitch Lab remains paper-only. It cannot create a live order path or broaden Agent 4's shadow-only authority. Its current goal is Agent One paper-pitch generation, durable Postgres-backed records, and useful operator notifications; do not claim the Postgres migration or live runtime wiring is complete without runtime proof.

## Role-aware review

Use `CHANGE-GOVERNANCE.md` for the required tier and approvals. Sam Huffard is the default systems/agentic-engineering lead; Sam Cristinzio is the default research-and-finance lead. This is not permanent turf: either partner may build anywhere, but the other partner supplies the complementary review lens. New product direction, source-of-truth changes, money authority, external commitments, and material recurring spend are joint decisions.
