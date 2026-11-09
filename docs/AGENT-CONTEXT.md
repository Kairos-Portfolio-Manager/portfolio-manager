# Portfolio Manager — Shared Agent Context

This is the safe, Git-tracked starting point for collaborators and coding agents. It describes the system and its working rules without exposing credentials, account values, investor records, broker sessions, raw cache contents, or private notes.

## System purpose and authority

Portfolio Manager is a supervised AI research and portfolio-operations system. Research agents can produce proposals; deterministic risk controls can downgrade or block them; **Sam is the sole order approver**. Kairos / Agent 4 is shadow-only. No agent may autonomously execute an order.

## Repositories and runtimes

| Component | Location / owner | Role |
| --- | --- | --- |
| Backend | This repository; Jetson PM2 service `portfolio-manager` | Research, risk, proposal lifecycle, operations API |
| Dashboard and companion | Sibling repository `../portfolio-dashboard`; Vercel + Mac companion | Clerk-gated review surface and signed-order executor |
| Broker read worker | Jetson PM2 service `portfolio-broker-reader` | Read-only broker synchronization; never executes |
| Ledgers | Google Sheets plus signed, append-only ledger logic | Human-visible accounting and reconciliation artifacts |
| Shared cache | Upstash Redis, Portfolio Manager only | Operational state; not a collaboration datastore |

Current database/cache configuration is an operational detail: verify it from runtime evidence and the runbook before making a claim or changing it. Never put connection strings, tokens, or raw records in this document or in Git.

To have full *code* context, a collaborator needs access to both GitHub repositories: this backend and `portfolio-dashboard`. That does not grant infrastructure access. Give Vercel, Neon, Jetson, broker, Sheets, or Upstash access only through individual accounts and only when the person has a concrete operational need. Do not share a common SSH account, Redis token, or broker credential.

## Read in this order

1. `CLAUDE.md` and this file.
2. `ONBOARDING.md` for the system model and vocabulary.
3. `INVARIANTS.md` before touching proposals, execution, ledgers, NAV, or investor views.
4. `ARCHITECTURE.md` and `CHANGE_MAP.md` before designing or editing a change.
5. `RISK_REGISTER.md`, `TEST_PLAN.md`, and `RUNBOOK.md` for known gaps, verification, and operations.
6. `portfolio-master-plan.md` for the active phase, gate, and release branch. `main` is the release branch ([ADR-0006](adr/0006-main-is-the-release-branch.md)). Until the master plan records the Jetson cutover, the Jetson still runs `mandate-v3`: state the branch and exact commit before any deploy and verify them after.
7. In the sibling repository, read `../portfolio-dashboard/CLAUDE.md` and `../portfolio-dashboard/docs/AGENT-CONTEXT.md` before dashboard or companion work.

## Non-negotiable execution boundary

The execution flow is deliberately one-way:

`signed approval → Executing marker → broker order with proposal ref_id → append ledger record → fulfill/reconcile`

Signature verification fails closed. The execution marker precedes the order, ledger recording precedes fulfillment, and ambiguous outcomes reconcile against the broker rather than re-executing. Ledgers are signed and append-only; corrections are new rows. These rules are explained and enforced in `INVARIANTS.md`.

## Where durable knowledge belongs

| Information | Canonical place |
| --- | --- |
| Collaboration boundary, repository topology, and shared orientation | This file |
| Proposal, execution, ledger, or cross-repo changes | `CHANGE_MAP.md` and, when safety rules change, `INVARIANTS.md` |
| Data ownership, runtime interactions, or integration design | `ARCHITECTURE.md` |
| Deployment, configuration shape, recovery, or live verification | `RUNBOOK.md` |
| Phase, trust level, release gate, and reset rule | `portfolio-master-plan.md` |
| Test coverage or required checks | `TEST_PLAN.md` |
| Known failure modes and mitigations | `RISK_REGISTER.md` |

Sam's local memory vault may contain additional private working notes for his own agents. It is never the only record of a decision that a collaborator needs to implement safely, and it must never be copied wholesale into this repository.

## Collaboration protocol

Before work, state the repository, branch, target runtime, and whether the change crosses the backend/dashboard contract. Read the relevant documents above. Make narrowly scoped changes, update canonical contracts in this repository first, run `npm run contracts:sync` when required, and verify the exact affected behavior. When a change creates durable operational knowledge, update the canonical document in the table above in the same pull request.

Last reviewed: 2026-08-01.
