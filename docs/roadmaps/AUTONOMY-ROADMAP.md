# Portfolio Manager — Roadmap to Supervised Autonomy

> **Narrow authority: TRUST detail.** The canonical cross-portfolio sequence,
> current-status index, two-clock policy, and promotion/demotion gates live in
> [the master plan](portfolio-master-plan.md). If this roadmap conflicts with the
> master plan, the master plan wins. This file retains the detailed autonomy
> architecture and historical phase design.

**Goal:** build a professional, observable, and reversible autonomous investment operating system. The near-term destination is a system that can research, allocate, approve, and execute within tested mandates; it is **not** a roadmap to accepting capital or becoming a fund. The long-term fund ambition raises the standard for controls, recordkeeping, attribution, and clarity now.

The operating model is deliberately asymmetric:

- **Agents 1–3 are specialist strategies.** Each researches its versioned mandate and may only create proposals.
- **Agent 4 is the portfolio manager.** It evaluates those proposals in portfolio context, dynamically assigns each strategy a virtual risk/capital budget, accepts or rejects proposals, and authorizes accepted orders for the deterministic execution service.
- **The execution service is mechanical.** It submits only Agent 4-authorized, signed orders and reconciles them to the broker. It never interprets strategy or invents a trade.
- **Sam retains the promotion and emergency authority** until a later evidence-based autonomy level explicitly changes that policy.

## Binding control model

```text
Agent 1 / Agent 2 / Agent 3
  mandate + evidence -> BUY / SELL / HOLD proposal
                              |
                              v
                         Agent 4
  performance + holdings + macro + portfolio risk -> accept / reject
                              |
                              v
                 signed immutable OrderIntent
                              |
                              v
            deterministic executor -> broker -> ledger -> reconciliation
```

### Ownership and authority rules

1. A specialist never executes an order and cannot approve its own proposal.
2. Every BUY creates strategy-owned lot records. **Only the specialist that owns those lots may propose a SELL or reduction.**
3. Agent 4 cannot create a new trade, alter a proposed side/ticker/size, or force a sale. It can accept or reject the specialist's exact proposal within the active policy.
4. Agent 4 may dynamically allocate virtual strategy budgets using attributable performance, current holdings/exposures, mandate fit, and macro/regime evidence. The decision must be explainable, versioned, bounded by hard portfolio limits, and never become simple return chasing.
5. Global deterministic controls can block, shrink, expire, or demote an order; they cannot manufacture a substitute order or bypass strategy ownership.
6. Missing, stale, ambiguous, unsigned, or inconsistent state blocks action loudly. Ledger and broker reconciliation failures immediately return the system to human-supervised mode.

The existing safety invariants remain: downgrade-only risk controls, deterministic gates around model calls, fenced untrusted evidence, pure tested money math, append-only signed ledgers, and the `Executing -> order -> ledger -> fulfilled` sequence with an exact broker reference.

---

## Status snapshot — 2026-07-11 (MCP migration deployed and smoked)

Work is gate-sequenced, not strictly code-sequenced: production remains in Phase 0 stabilization while the Phase 1 ownership/contracts foundation and Phase 2 shadow infrastructure now run in production without canonical-read cutover.

- **Production:** backend `e4e173e` is live on the Jetson; dashboard companion `6dc8a3f` is live on the Mac. The MCP read-sync migration replaces the unsupported unattended `robin_stocks` login: Jetson queues bounded work and the authenticated Mac companion performs broker reads against the pinned Agentic account.
- **Ownership/contracts:** strict owner-scoped SELL accounting is live with `ENFORCE_OWNERSHIP=false` as the rollback switch; Agent 4 remains shadow-only with no approval key or order authority.
- **Postgres shadow:** migration `0003_shadow_precision.sql` is applied, all 14 proposals/5 capital entries/1 lot/1 position were backfilled, and production parity is `MATCH` across all four domains. `PG_DUAL_WRITE=true` is enabled persistently, while Sheets/Redis remain canonical.
- **Verified:** backend 371/371 tests; dashboard MCP policy tests pass; independent review returned **SHIP**. Production read-only smoke passed holdings and reconciliation with both durable requests consumed. Performance 40/40, Trade Ledger 1/1, Lots 1/1, Investors 5/5, and Audit 2,586 rows verify clean.
- **Runtime evidence:** the legacy Jetson login is stale because Robinhood device approvals/SMS/passkeys do not provide a usable unattended TOTP path. Athena/Yahoo degradation and Mac sysloop history remain operational leads; adjudicate them from fresh logs after the migration smoke.
- **Authority:** Sam still signs every live order. Agents 2/3 are supervised and
  static-watchlist-bound; they are not catalog-enabled. Agent 4 has no runtime authority.

### Autonomy foundation deployed — observation now active

- The unattributed-lot mismatch is resolved: named strategies consume only their own lots; unresolved legacy inventory routes to signed durable reconciliation. `ENFORCE_OWNERSHIP=false` remains the exact legacy rollback.
- Agent 4 now has shared shadow-only policy/allocation/risk/decision contracts, a pure deterministic bounds engine, immutable content-fingerprinted decision lineage, explicit freshness gates, Redis persistence, and a FundManager-only read surface in the dashboard. There is no HTTP decision-write endpoint, approval HMAC, order intent, scheduler, or live authority. Policy activation waits for the reviewed mandate.
- Postgres shadow plumbing covers proposal lifecycle updates, lots, signed capital entries, and atomic current positions. Parity uses key-aware digests, treats unreadable stores as divergence, exits nonzero, and is scheduled on the Jetson for 8 PM daily. Migration `0002` preserves legacy lot dates and adds fulfillment fields. Sheets/Redis remain canonical.
- Independent review initially found four blockers; all were fixed and the focused re-review returned **SHIP**. Verification: backend 363/363; dashboard 92/92 in the independent pass; TypeScript clean; production build clean; shared contracts byte-identical.
- The coordinated release is complete. Remaining work is observation: retain Postgres as shadow-only, review daily parity evidence, and do not promote Agent 4 or Postgres reads without a separate reviewed gate.

### Resolved pre-deploy ownership policy

`unattributed` legacy/manual lots are quarantined. A named strategy may consume only its own lots. Insufficient ownership records a signed durable reconciliation requirement and leaves fulfillment open; it never consumes another strategy's or unattributed inventory. Explicit manual/unattributed processing remains available only through the unattributed/manual path, and the environment kill switch restores the prior account-wide FIFO for emergency rollback.

---

## Phase 0 — Stabilize the live supervised system

**Status:** Current. Phase 0A, ownership/contracts, and MCP read-sync are deployed. The read-only smoke passed on 2026-07-11 ET; start the five-trading-day observation clock on the next clean trading day.

Finish the existing 0A/0B/0C work: fail-closed research and fill attribution, signed ledger reads, truthful degraded-run status, Jetson-owned monitoring/reconciliation, live companion health, budget governance, and a unified manager surface.

**Current release policy:** `main` is the release branch
([ADR-0006](adr/0006-main-is-the-release-branch.md), superseding
[ADR-0005](adr/0005-production-branch-policy.md)); the Jetson cutover from
`mandate-v3` is pending. Every deploy must prove
the exact branch and commit, and no branch policy changes execution authority.

**Exit gate:** five consecutive trading days after deployment with no missed critical job, ambiguous fill, manual ledger repair, hidden failure, or unsafe client exposure; at least three genuine actionable proposals and one evaluator approval; every holding monitored despite quote failures; health, dashboard, logs, and reconciliation agree. Five days establish supervised workflow readiness, not investment-performance proof or new trading authority.

---

## Phase 1 — Mandate onboarding and proposal ownership

**Goal:** make the incoming Agent 2, Agent 3, and Agent 4 personalities operationally precise before reactivating strategy proposals.

**Deployed progress:** shared proposal/signature/lot/pipeline/accounting contracts; generated dashboard mirrors and drift guards; approval state-version checks; ownership-scoped SELL accounting; signed durable reconciliation; crash-injection coverage; Agent 4 shadow `PortfolioDecision` and allocation contracts; and the manager control-room surface. Still incomplete: versioned Agent 2/3/4 mandates, proof that every proposal source uses one compiler, full lineage/budget/rationale explainability, and scoped backend service identity.

For each specialist mandate, capture and version: universe, horizon, edge hypothesis, benchmark, entry/exit/abstention rules, evidence requirements, liquidity/turnover constraints, position limits, expected regimes, invalidation conditions, and evaluation criteria.

For Agent 4, capture and version: portfolio objective, permitted accept/reject criteria, dynamic allocation inputs, allocation bounds, rebalance cadence, conflict treatment, macro/regime framework, escalation rules, and explanation requirements. Agent 4's mandate must explicitly prohibit forced sales and self-originated trades.

Build the contract required for the model:

- `StrategyProposal` contains mandate/version, thesis, evidence IDs, requested action, requested size, owned-lot references for SELLs, and expiry.
- `StrategyLot` records the originating agent, remaining shares, and realized attribution. A SELL fails closed unless it consumes that agent's owned lots.
- `PortfolioDecision` records Agent 4's accept/reject result, allocation snapshot, portfolio/risk snapshot, explanations, policy version, and signature.
- The dashboard shows proposal lineage, lot ownership, active strategy budgets, Agent 4 decisions, conflicts, and decision rationale as authoritative state—not separate agent chats.

**Exit gate:** all three incoming mandates have a written, testable version; every BUY/SELL proposal and fill can be traced to one strategy and mandate version; Agent 4 cannot authorize an unowned SELL, changed proposal, or self-originated trade; the dashboard can explain every accepted/rejected decision.

---

## Phase 2 — One contract, one pipeline, one financial truth

**Goal:** eliminate cross-runtime schema drift and mutable accounting before authority expands.

**Shadow mode active, not a phase promotion:** Neon is the accepted provider; migrations, full financial backfill, and daily fail-closed parity are live. Sheets/Redis remain authoritative and Postgres reads are not used for money decisions. Keep `PG_DUAL_WRITE=true` only while parity remains clean; any divergence disables promotion and triggers investigation.

- Create shared contracts for mandates, proposals, ownership lots, portfolio decisions, signatures, risk snapshots, broker events, and financial precision.
- Route scheduled research, Lab requests, price alerts, exit signals, and manual requests through the same compiler.
- Use typed state/version checks; invalidation follows material quote, portfolio, mandate, or allocation-policy changes.
- Move canonical accounting to Postgres through an audited dual-write/shadow-read migration; retain Sheets as a read-only reporting projection.
- Use append-only double-entry events, exact broker IDs, idempotency, locks/fencing, backups, restore tests, and broker/order/position reconciliation.

**Exit gate:** no executable proposal bypasses the compiler; schema copies are removed or generated; 30 days of zero unexplained broker/Postgres/Sheet differences; crash-injection and clean restore prove no duplicate order or partial book.

---

## Phase 3 — Portfolio-manager shadow coordination

**Goal:** prove that Agent 4 makes better-coordinated decisions without gaining execution autonomy yet.

- Run all specialists with their mandates; keep their proposals individually attributable.
- Have Agent 4 produce shadow accept/reject decisions and virtual strategy allocations alongside Sam's supervised decisions.
- Measure proposal quality and outcomes by specialist, mandate version, allocation state, market regime, and Agent 4 decision.
- Require Agent 4 to surface—not silently net—duplicate theses, conflicts, concentration, cash pressure, and unowned sell attempts.
- Prevent performance chasing: allocations use a documented rolling evidence window, minimum sample rules, capped change size, drawdown/regime controls, and diversification limits.

**Exit gate:** at least 8–12 weeks plus a meaningful current-version sample (minimum 30 evaluator-graded actionable proposals and 10 filled trades); no ownership violations, accounting incidents, or unresolved reconciliation; Agent 4's shadow decisions are explainable and demonstrably aligned with portfolio limits.

---

## Phase 4 — Bounded Agent 4 autonomy

**Goal:** transition only the approval/authorization role from Sam to Agent 4, in reversible increments.

1. **Shadow manager:** Agent 4 records decisions and allocations; Sam approves every order.
2. **Bounded accepts:** Agent 4 may accept eligible specialist BUYs within strict daily, per-strategy, and portfolio caps; specialist SELL proposals remain human-supervised initially.
3. **Bounded specialist exits:** Agent 4 may accept a SELL only when proposed by the owner strategy and all lot, risk, and reconciliation gates pass.
4. **Full mandate autonomy:** Agent 4 authorizes eligible specialist proposals; Sam supervises health, allocations, performance, and policy versions rather than each trade.

Every promotion requires a written policy version, capital/risk caps, observation window, live rollback drill, and clean evidence at the prior level. A reconciliation, ledger, heartbeat, signature, contract, stale-state, risk, or mandate anomaly immediately demotes to human-supervised mode.

---

## Immediate next milestone — deploy foundations, prove stability, ingest mandates

Execute in this order:

1. Start the five-trading-day observation window on the next clean trading day; inspect fresh Jetson/companion logs and the scheduled parity report each day.
2. Keep the MCP account-binding and exact read-only allowlists under regression watch; any failed receipt or ledger mismatch returns the system to human-supervised mode.
3. Convert the Agent 2, Agent 3, and Agent 4 inputs into versioned mandate templates. Record ambiguities for Sam/his friend; do not invent investment rules. Keep Agents 2/3 supervised and static-watchlist-bound, and Agent 4 shadow-only.
4. Finish Phase 1's `PortfolioDecision`/allocation contract, unified-compiler proof, ownership lineage, and manager UI before adding Agent 4 runtime behavior.
5. Keep Postgres shadow plumbing and daily parity evidence healthy without changing canonical reads. A read cutover remains a later, separately reviewed milestone.
6. Rebuild the FIXLIST from fresh runtime evidence after the release, closing false positives only when logs/job state prove they are stale.

The detailed multi-model execution guide lives in repo-root `handoff.md`. Do not implement autonomous execution, forced portfolio-wide sells, new outside-capital features, or fund structure work while Phase 0/1 gates remain open.

## Standing session protocol

Before meaningful Portfolio Manager work: read `docs/roadmaps/portfolio-master-plan.md`
first, then use this roadmap only for narrower TRUST detail alongside `CLAUDE.md`,
`docs/INVARIANTS.md`, `docs/CHANGE_MAP.md`, and `ops/FIXLIST.md`; protect existing
WIP; verify runtime evidence; state the master-plan phase and exit criterion
advanced; add money-math and failure-path tests; obtain independent review before
financial/autonomous-write deployment; and update the master plan plus the durable
vault project note when reality changes.
