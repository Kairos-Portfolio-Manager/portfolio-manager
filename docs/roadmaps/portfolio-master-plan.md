# Portfolio Manager — Master Plan and Source of Truth

**Authority:** canonical portfolio-wide sequence, gates, and current-status index

**Status date:** 2026-09-14 ET

**Current release:** Jetson backend `mandate-v3@399693e`; runtime health and the
scheduled research path were rechecked on 2026-09-14 ET.

This is the one document that answers: what happens next, in what order, whether
the work proves **TRUST** or **SKILL**, what evidence is required, and what causes
the system to stop or move backward. Detailed roadmaps, execution packets,
decision records, ADRs, and observation logs remain useful, but none may change
the sequence or promotion gates here.

## 1. Objective and labels

Build a small, supervised autonomous investment firm in which three specialist
agents research under written mandates, Agent 4 accepts or rejects their exact
proposals within a bounded portfolio policy, and deterministic software handles
signatures, execution, accounting, ownership, and reconciliation. Autonomy is
earned from current-version evidence and automatically lost when safety evidence
becomes stale, inconsistent, or invalid.

- **TRUST:** proves the system can be permitted to act safely, observably, and
  reversibly.
- **SKILL:** proves the research, selection, or portfolio decisions add measurable
  value after costs.
- **BOTH:** a dependency or gate that must satisfy both.

These labels are not priorities. TRUST is a prerequisite for authority; SKILL is
a prerequisite for claiming usefulness. Passing one never substitutes for the
other.

## 2. Document authority

When documents conflict, use this order:

1. **This master plan** — portfolio-wide phase order, current status, promotion,
   reset, demotion, and outside-capital gates.
2. **Accepted ADRs and invariants** — binding architecture and safety rules inside
   their scope. An ADR cannot silently promote a phase.
3. **Decision register and versioned agent mandates** — accepted investment-policy
   definitions. Open questions block only their named work.
4. **Narrow roadmaps** — [autonomy](AUTONOMY-ROADMAP.md) for TRUST detail and
   [research](ROADMAP-FORMIDABLE-FUND.md) for SKILL detail.
5. **Supporting research plans** — including the
   [Athena integration and agent-parity plan](ATHENA-INTEGRATION-AND-AGENT-PARITY-PLAN.md),
   which refines a research-roadmap direction but cannot change this plan's phase
   order, promotion gates, or authority model.
6. **Execution guide** — [bounded engineering packets](RESEARCH-ROADMAP-EXECUTION-GUIDE.md),
   acceptance tests, and model assignment.
7. **Evidence records** — [Phase 0 observation](PHASE-0-OBSERVATION.md), runtime
   logs, signed ledgers, Postgres, Sheets, Redis, broker receipts, and deployment
   records. Runtime evidence decides whether a stated status is true.
8. Supporting plans, handoffs, FIXLIST entries, and vault notes.

If this plan claims a deployment or gate that current runtime evidence contradicts,
the evidence wins and this plan must be corrected. If a subordinate document has
more detail but conflicts with this sequence, this plan wins until an explicit
review updates it.

## 3. Binding authority model

1. Agents 1–3 may research and propose; they never execute or approve themselves.
2. A BUY creates strategy-owned lots. Only the owning specialist may propose a
   SELL or reduction against those lots.
3. In the target architecture, Agent 4 may accept or reject the specialist's exact
   proposal. It cannot invent a trade, change side/ticker/size, or force a sale.
   **Current authority is shadow-only:** Agent 4 has no live approval authority.
4. Deterministic controls may block, shrink, expire, or demote. They may never
   upgrade HOLD to BUY, bypass ownership, or manufacture a replacement order.
5. Only a signed, immutable, current proposal may reach the deterministic
   executor. Fills are accounted only after exact broker matching.
6. Missing, stale, unsigned, ambiguous, or inconsistent state fails closed.
7. Sam retains live approval, promotion, emergency-stop, and policy authority
   until this plan's later promotion gates explicitly grant narrower authority.

## 4. Current verified status

The following is a conservative synthesis of repository and recorded production
evidence. “Verified locally” is not “deployed,” and “deployed” is not “gate passed.”

| Area | Label | Status supported on 2026-09-14 | Evidence / unresolved fact |
| --- | --- | --- | --- |
| Live authority | TRUST | Human-supervised. Sam remains the sole live order approver; Agents 1–3 may research and propose, and Agent 4/Kairos is shadow-only. | No proposal, evaluator, signature, broker, ledger, or execution safeguard was broadened by the current research canary. |
| Live release | BOTH | Backend `mandate-v3@399693e` is loaded by PM2 and `/health` is healthy. The catalog contains 4,493 names; live slates use catalog discovery for all three research agents, not static Agent 2/3 watchlists. | This supersedes the July release/static-watchlist snapshot. The July evidence remains historical evidence, not a claim about today's loaded revision. |
| Phase 0 safety window | TRUST | The latest retained counted observations ending 2026-09-11 show two consecutive safety-pass days (Sep 10–11); earlier Sep 9 failed. The Sep 14 research-policy release must have its R1/S1 classification and clock effect recorded before any count is carried forward. | Do not claim a 5-day exit or a continuous post-canary safety count until the observer record and release classification support it. |
| Historical production artifacts and restart controls | TRUST | Previously resolved evidence remains append-only. No new safety, signature, ledger, broker, or reconciliation failure was established by the Sep 14 read-only verification. | Continue daily observer, parity, and reconciliation checks; historical resolution is not a permanent exemption. |
| Research throughput | SKILL | The latest nine retained scheduled scan receipts contain 97 attempted research decisions: all were `investment_hold`, with zero proposal attempts, evaluator rejects, data-gate blocks, errors, or budget blocks recorded. | This is valid abstention evidence, not a sign that the system is ready to trade. The dominant observed constraint is upstream candidate/data/selection readiness, not a downstream evaluator or broker veto. |
| Research actionability canary | SKILL | `PEER_FUNDAMENTAL_PROPOSAL_CANARY_SLOTS=1` permits at most one peer-screened research candidate per agent scheduled scan to enter the normal proposal-research path. The first observed run still held all eight candidates. | The canary does not bypass human approval or any downstream safeguard. Its relationship to D-005's partial-score policy needs an explicit decision-register clarification before expansion. |
| Research readiness and data | SKILL | Latest health evidence reports 324 scored names but zero fully complete mandate records. Local code derives only contiguous Agent 2 EDGAR revenue-YoY continuity; its consensus/adjusted-EPS/materiality inputs stay fail-closed, so the demonstrated partial bundle still maxes at 59 available points. | Data completeness, point-in-time consensus/estimate history, and the remaining Agent 2 persistence semantics are the near-term blockers to a well-evidenced positive proposal. |
| Local reviewed hardening | BOTH | Aggregate research-funnel reporting, peer-slate persistence, prompt-history fencing, bounded Agent 2 source evidence, macro sizing, and contribution-NAV provenance are implemented locally. Two independent review passes found and resolved P1 gaps; the full backend suite passes 1,050/1,050. Nothing is committed or deployed. | See [research solidification plan](../RESEARCH-SOLIDIFICATION-PLAN.md). This does not create runtime evidence or change authority: release verification needs the normal record, a scheduled request-bound 16:30 snapshot, and clean new funnel receipts. |
| Research evidence spine | SKILL | Evidence-pack and packet work remains useful only to the extent runtime evidence confirms it; historical local-verification entries do not grant authority. | [Execution ledger](RESEARCH-ROADMAP-EXECUTION-GUIDE.md#31-verified-local-implementation-ledger). |
| Athena research integration | SKILL | Production consumption remains disabled. Source review of `Cubanso24/stock-llm@483a68b` shows Athena is a broad research and accountability platform, while Portfolio Manager's existing adapter consumes only a small conclusion-first partner dossier and truncates it further for the generator prompt. | [Athena integration and agent-parity plan](ATHENA-INTEGRATION-AND-AGENT-PARITY-PLAN.md). This is a future planning direction, not runtime proof or activation authority. |
| Financial Postgres | TRUST | Neon is accepted and shadow/dual-write plumbing exists. Sheets/Redis remain canonical for money reads; no cutover gate has passed. | [ADR 0001](adr/0001-postgres-canonical-store.md) and autonomy Phase 2. |
| Outside capital | TRUST | Software support for investor accounting does **not** establish legal permission to pool or manage outside money. Sam has explicitly chosen to accept interim manual legal risk while continuing to seek counsel; that choice is not a compliance finding. | The legal/tax warning and autonomy restrictions in section 8 remain active. |

Do not promote a status merely because a code path, migration, test, or dashboard
exists. Promotion requires the phase's listed runtime evidence.

### 4.1 Current sequence and evidence boundary

Historical phase descriptions below remain the intended architecture; this section
is the current operational index. The next work is deliberately narrow:

1. Decide whether to commit the independently reviewed local hardening set as one
   reviewable release; do not deploy it from an unrelated dirty worktree.
2. If released, record the safety/research classification, then verify one scheduled
   request-bound 16:30 holdings snapshot and the aggregate funnel report on fresh logs.
3. Record the current one-slot canary's release class and resolve the D-005/D-009
   policy wording so partial peer-screened research is never mistaken for a weaker
   evidence standard.
4. Collect five stable scheduled receipts under that declared policy, then diagnose
   the funnel from aggregate evidence rather than from individual anecdotes.
5. Repair the first measured upstream constraint—expected to be mandate-complete
   data or Agent 2's multi-quarter persistence input—without changing approval,
   execution, ledger, or evaluator controls.
6. Prove one naturally occurring end-to-end positive path: evidence-backed
   specialist proposal, evaluator decision, Kairos shadow record, and Sam's signed
   disposition. A HOLD remains correct when no candidate clears the evidence bar.

## 5. Two independent evidence clocks

The project uses two clocks so research iteration does not erase valid money-path
safety evidence, while material safety changes cannot hide inside “research work.”

### Safety clock — TRUST

- Measures consecutive clean trading days under one materially stable safety and
  operations release.
- Phase 0 requires **five consecutive clean trading days** for supervised workflow readiness. This does not establish investment performance or expand trading authority.
- Starts on the first trading day after the gate-closing release is deployed,
  independently reviewed, and all Day 0 blockers have signed resolutions.
- A day counts only after scheduled work finishes and the daily observer records a
  pass with the deployed commit and policy versions.
- A safety reset returns the consecutive count to zero. The next eligible trading
  day is Day 1; repairs never make an earlier day clean retroactively.

### Research clock — SKILL

- Measures samples and outcomes under explicit mandate, scoring, evaluator,
  selection, benchmark, and cost-policy versions.
- It is sample-based unless a phase also specifies a consecutive-day observation
  period.
- A material research-policy change opens a new cohort. Old evidence remains
  historical but cannot be pooled into a current-version promotion sample unless
  a predeclared comparability rule permits it.
- Research changes do not reset the safety clock unless they alter money-path,
  holding-monitoring, health, resource-reservation, or fail-closed behavior.

### Change and reset taxonomy

| Change class | Examples | Safety clock | Research clock | Release rule |
| --- | --- | --- | --- | --- |
| **S1 — money/control** | signatures, approvals, execution, order states, broker identity, ownership, lots, NAV, ledger, reconciliation, canonical money reads, auth/service identity | Reset | Reset only if proposal/outcome semantics change | Independent review, rollback, deploy proof, fresh Day 1. |
| **S2 — safety observability** | critical-job schedule, sentinel, daily observer, parity meaning, holding-monitoring, failure classification, provider capacity reservation | Reset when pass/fail meaning or critical coverage changes | Reset affected cohort if outcome classification changes | Reviewed gate-closing or emergency release. |
| **R1 — research policy** | mandate, scoring weights, thresholds, freshness, evaluator prompt/policy, candidate selection, evidence adapters, benchmark, cost assumptions | No reset if purely advisory and safety coverage is unchanged | New cohort/reset affected sample | May be built locally during freeze; deploy only through a declared research release. |
| **R2 — inert research plumbing** | append-only advisory storage, read-only report, shadow UI, tests with all promotion flags off | No reset after proof it is inert | No reset if semantics and collected fields are unchanged; otherwise new cohort | Independent review if production-facing. |
| **D — docs/local tooling** | documentation, tests, local backtest scaffold, dashboard copy that cannot mutate authority | No reset | No reset | Must not touch production authority or scheduled behavior. |
| **E — emergency repair** | security issue, reconciliation failure, corrupt state, critical outage | Stop counting immediately; reset after repair | Quarantine affected samples | Safety outranks schedule; deploy, verify, document, restart clocks explicitly. |

The primary reviewer classifies a change before work begins. When uncertain, use
the more conservative class. A backend deploy is not automatically a reset; its
behavioral class is. Undocumented production drift invalidates the affected day.

### Declared 2026-07-20 specialist-parity release

- **Phase / label / class:** Phase 0 supervised baseline; BOTH; R1 + S2.
- **Purpose:** make Agents 1–3 use one live catalog, one rotation/slate mechanism,
  fair per-run model capacity, verified owner-attributed holdings, the same
  downgrade/evaluator/human-approval/signature/ledger boundaries, and the same
  observable holding-monitor contract. Mandate screens, horizons, evidence
  requirements, and exit rules remain intentionally different.
- **Authority:** unchanged. No agent gains approval, signature, broker, execution,
  or ledger authority. Every proposed BUY or SELL still requires Sam's review and
  signed approval. Every new SELL also carries the proposing strategy's verified
  owner-share ceiling; approval recomputes and signs that ceiling, and execution
  and accounting reject an absent or exceeded ceiling.
- **Revision / production proof:** record the exact reviewed commit and Jetson
  loaded identity in the Phase 0 observation ledger after deployment; do not treat
  a local commit or synthetic test as organic runtime proof.
- **Clock effect:** deployment day never counts. Candidate selection and mandate
  behavior open a new R1 research cohort. The ownership-aware holding-monitor
  coverage change is S2, so the consecutive TRUST window begins again on the
  first clean trading day after the release.
- **Rollback:** the three `AGENT_*_CATALOG_ROLLBACK` switches independently return
  discovery to seed watchlists while retaining attributed holdings and emitting
  degraded status. A full code rollback must use the prior reviewed release and a
  signed restart; it may not bypass ownership, approval, or ledger controls.
- **Required evidence:** full tests and secret scan; exact branch/SHA; signed PM2
  restart; health and fresh logs; fresh broad catalog; owner-correct monitor
  coverage; aggregate per-agent slate/funnel evidence; sentinel, ledger
  verification, transactional parity, execution-companion proof, and the next
  scheduled signed observer. An all-degraded holding-monitor run cannot count as
  a TRUST pass.

### Declared 2026-07-20: Evidence-bound proposal quality release

**Phase label: SKILL · Change class: R1 · Status: released for supervised observation**

This release addresses concrete proposal-quality failures observed in retained
research: unsupported numeric claims, rank scores described as raw financial
metrics, promotional material treated as thesis evidence, and a stale business
classification that described a financial company as a technology company.

- Every actionable thesis sentence must cite a typed, supplied fact. Normalized
  ranks are explicitly distinct from raw facts; missing or invented citations
  downgrade the recommendation to HOLD.
- Promotional, sponsored, social, and opinion material remains visible as
  context but cannot support an actionable thesis. Technical claims now carry
  a timestamped price/SMA/52-week fact packet or are explicitly unavailable.
- A deterministic sector/industry business-family check blocks a non-HOLD call
  whose claimed business is inconsistent with observed classification. It does
  not shrink any mandate's discovery universe.
- The evaluator cannot approve an actionable recommendation unless the evidence
  support and numeric spot checks pass.

This is an R1 research-and-evaluator quality change. It does not alter approval,
signature, execution, position limits, ledger authority, or the observer's
TRUST semantics. It starts a fresh SKILL evidence cohort; because the already
planned July 20 release day cannot count, July 21 remains the earliest possible
Phase 0 Day 1.

### Declared 2026-11-08: Pitch Lab scoring + Mandate Review release

**Phase label: SKILL · Change class: R1 + R2 (Pitch Lab only) · Status: approved by Sam, awaiting Jetson deploy**

- **Scope:** paper-only Pitch Lab. Mandate Review (monthly memo, migration `0011`,
  append-only), a code-computed Mandate Score /10 on each pitch (the model never
  sees it), conviction moved from 1–5 to 1–10 (pitch v3, prompt v4), report v3,
  website snapshot v2 and review-history keys.
- **Authority:** unchanged. Nothing gains proposal, approval, signature, broker,
  ledger or execution reach; Pitch Lab modules stay outside the execution path.
- **Clock effect:** TRUST window unaffected (no S-class change; ops-watch coverage
  unchanged). The 1–10 conviction scale opens a **new Pitch Lab research cohort**
  starting with the first pitch recorded after deploy; earlier 1–5 pitches are kept,
  never rescaled, and analysed separately. Agent proposal cohorts are unaffected.
- **Release revision:** the `mandate-v3` head after the release PR merges. Record the
  loaded SHA and restart edge here after deploy, then update **Current release** above.
- **Deploy and rollback:** `docs/releases/2026-11-08-pitch-lab-scoring.md`
  (dashboard first, migration `0011`, signed restart, `pitch-lab` restart, stop check
  if the Jetson is behind `mandate-v3`).
- **Required evidence:** full tests, exact SHA, signed restart, health, fresh logs,
  `db:migrate` output, and the first post-deploy daily run storing v3 pitches with
  a Mandate Score.

## 6. Immediate gate-closing release — Phase G0

**Phase label: BOTH · Status: complete · Owner: systems owner + independent reviewer**

This was the only planned safety-affecting release before the five-day freeze. If
execution evidence shows an item is already complete, attach that evidence and
close it; do not repeat or merely assert it.

| Step | Label | Owner | Required evidence | Completion / reset rule |
| --- | --- | --- | --- | --- |
| G0.1 Resolve production artifacts — **verified complete** | TRUST | Sam authorizes disposition; builder implements auditable path | Signed, append-only resolutions exist for both `reason=smoke` reconciliation records; historic unsigned NVDA proposal is rejected/closed; live Redis has zero open reconciliations and zero unsigned approved proposals | Completed from current live evidence. Preserve the historical rows and their resolutions. Any new unresolved/invalid signature blocks Day 1. |
| G0.2 Split parity semantics — **verified complete** | TRUST | builder + money-path reviewer | Exact transactional comparison for ticker, shares, cost basis/average cost, cash, units, ownership/lots; valuation report contains quote value, source, and timestamp and only exact-compares shared snapshots | Backend 713/713 tests plus the 2026-07-14 production `MATCH` across accounting snapshot, capital entries, lots, positions, and proposals. Valuation correctly reported `NON_COMPARABLE` because the retained Sheet data predates content-bound quote provenance; it did not manufacture an accounting mismatch or an exact valuation claim. |
| G0.3 Automate daily observation — **verified deployed with first scheduled record** | BOTH | builder + ops reviewer | Immutable/read-only daily result with commit, policy versions, critical jobs, MCP receipts, ledgers, transactional parity, valuation freshness, holding monitoring, research attempts/outcomes, proposals, approvals, fills, and exact reasons; concise notification | The HMAC-signed 2026-07-14 `phase0-observation-v2` record was created once and returned `FAIL_BOTH`, `countsTowardSafetyWindow=false`, and `countsTowardResearchCohort=true`; missing evidence did not pass. Changing pass semantics later is S2. |
| G0.4 Prove research-run accounting — **verified complete for the current classifier** | SKILL | research builder + reviewer | The 2026-07-14 scheduled run reconciled all 36 attempts under `research-outcomes-v1`: 35 investment HOLD, 1 stale-data block, and zero budget/provider/evaluator/queue failures; no outcome was unclassified | This proves conserved outcome accounting, not proposal throughput or investment edge. A classifier change opens a new research cohort. |
| G0.5 Install cost/capacity governance — **verified complete for current policy** | BOTH | Sam sets budget; builder enforces/observes | The atomic monthly/per-run/call controls, pricing, classifications, and privacy-safe report are deployed. Production enforces Sam's `$40` UTC-month ceiling, default 80% warning, and `$10` protected holding/evaluator pool inside that ceiling; telemetry is complete. Sam accepts the current shared credential for now. | Current report: `$3.6878` spent, `$0` active leases, `$36.3122` remaining. Capacity exhaustion cannot silently become an investment HOLD. A policy change affecting throughput opens a new research cohort. |
| G0.6 Explain infrastructure restarts — **verified complete and automated** | TRUST | ops investigator | All 42 observed restarts are accounted for. The first 40 retain manual release/config evidence; restarts 41 and 42 use dedicated-key signed, exact deploy edges. PM2 reports online, `unstable_restarts=0`, and `exit_code=0`; `--time` and the process list are persisted. | The sentinel trusted and atomically consumed markers `40→41` and `41→42`, recorded no PM2 anomaly, and advanced the baseline after each edge. Any future unmarked or unsafe restart invalidates the day. |
| G0.7 Backup/restore drill — **verified complete at the application layer** | TRUST | ops owner + reviewer | Type-preserving encrypted logical v2 restored all 20 declared tables after all seven live migrations into a clean PGlite target; exact counts/digests, signature bytes, foreign keys, and sequences verified. | [2026-07-14 v2 proof](../ops/restore-drills/2026-07-14-postgres-shadow-v2.md). The first production attempt exposed and then regression-tested a Neon-GMT/PGlite-host-timezone display mismatch; `df9b9ef` canonicalized both digest sessions to UTC and the rerun passed. Provider-native Neon PITR remains a separate pre-canonical-cutover gate. |
| G0.8 Gate-closing release verification — **verified complete** | BOTH | primary + independent reviewer | Backend `mandate-v3@e746bd5` is loaded with secret scan, 722/722 tests, migration 0007, signed controlled restart, health 200, timestamped logs, transactional parity `MATCH`, scheduled observer evidence, application restore, unchanged shadow authority, and observer identity pinned to the code actually loaded by PM2. Dashboard `bbb5a5c` passed 109/109, TypeScript, and build; local `portfolio-executor` restart 10 is online with fresh heartbeat. | Sam approved the later documentation/release-evidence alignment and the identical final status commit is present on both `mandate-v3` and `main`. This branch-hygiene completion does not retroactively create Day 1. |

## 7. Unified phase sequence

Phases are dependency-ordered. Work may be prepared early when the “allowed during
freeze” rules permit it, but no phase is promoted out of order.

| Unified phase | TRUST roadmap crosswalk | SKILL roadmap / packet crosswalk |
| --- | --- | --- |
| G0 — Gate-closing release | Autonomy Phase 0 repairs | Research Phase 0 / E0.1–E0.3 |
| 0 — Supervised baseline | Autonomy Phase 0 | Research Phase 0 runtime proof |
| 1 — Mandates/contracts | Autonomy Phase 1 | D/Q policy gates; lineage prerequisites |
| 2 — Durable truth | Autonomy Phase 2 shadow/financial foundation | Research Phase 1 / E1.1–E1.6 |
| 3 — Coverage/score meaning | No authority expansion | Research Phases 2–3 / E2–E3 |
| 4 — Attention/Agent 4 shadow | Autonomy Phase 3 shadow work | Research Phase 4 / E4 |
| 5 — Compiler/financial truth | Autonomy Phases 1–2 completion | Research Phase 5 / E5 |
| 6 — Bounded autonomy proof | Autonomy Phase 3 exit and Phase 4 steps 1–2 | Research/Agent 4 current-version sample gates |
| 7 — Cash/edge | No authority expansion by itself | Research Phases 6–7 / E6–E7 |
| 8 — Exit/full mandate autonomy | Autonomy Phase 4 steps 3–4 | Ongoing current-version skill evidence |

### Athena analytical-depth crosswalk

The [Athena integration and agent-parity plan](ATHENA-INTEGRATION-AND-AGENT-PARITY-PLAN.md)
does not create a new master phase. It refines existing SKILL work as follows:

| Master phase | Athena/depth-plan role |
| --- | --- |
| **0 — Supervised baseline** | Source/runtime review, permission discussion, and contract design only. Keep Portfolio Manager consumption disabled; no live research-policy change. |
| **1 — Mandates/contracts** | Freeze a read-only versioned Athena evidence contract and define equal workflow/evidence access across Agents 1–3 while preserving mandate-specific judgment. |
| **2 — Durable truth** | Store full Athena evidence packages point-in-time in shadow with fingerprints, provenance, freshness, conflicts, completeness, and restore proof. |
| **3 — Coverage/score meaning** | Validate Athena's sources and analytical outputs across a golden company set; add paid data only for measured gaps; prove equal catalog/evidence coverage for all specialists. |
| **4 — Attention/Agent 4 shadow** | Compare current, compact-Athena, and full-package research in shadow/canary; use one shared candidate bus with mandate-specific ranking. |
| **5 — Compiler/financial truth** | Bind the accepted Athena package fingerprint into the canonical proposal lineage and broaden catalog attention only through a separately reviewed canary. |
| **6–8 — Skill/autonomy evidence** | Grade each mandate separately at its correct horizon while holding all three to the same process, evidence, evaluator, lineage, and authority standards. |

Athena remains a read-only research dependency. Portfolio Manager retains mandate,
portfolio, risk, evaluator, approval, execution, accounting, and reconciliation
authority. Athena source sophistication never substitutes for runtime evidence,
agent-specific skill samples, or the master plan's promotion gates.

### Phase 0 — Prove the supervised baseline

**Label: BOTH · Status: active; G0 historical gates complete, but the current
post-canary safety-clock treatment must be recorded before a consecutive count is
claimed.**

1. **[TRUST]** Freeze S1/S2 behavior after the gate-closing release.
2. **[TRUST]** Run the daily checklist for five consecutive trading days.
3. **[TRUST]** Maintain 100% holding monitoring even when Athena/Yahoo/FRED or other evidence
   sources degrade; degraded inputs must visibly block or downgrade action.
4. **[SKILL]** Accumulate at least three genuine actionable specialist proposals and at least
   one evaluator approval under current versions. Do not lower thresholds or force
   trades to obtain them.
5. **[SKILL]** Prove every attempted research review has one explicit outcome.
6. **[TRUST]** Keep live authority human-supervised and Postgres money reads shadow-only.

**Evidence:** daily observer rows, valid MCP receipts, signed-ledger verification,
transactional parity, valuation freshness, timestamped logs, proposal/evaluator
lineage, deployment/policy versions.

**Exit gate [BOTH]:** safety clock 5/5; zero unresolved critical incidents or manual
ledger repairs; research baseline and proposal throughput proven; health, logs,
dashboard, ledgers, broker receipts, and parity agree.

**Reset/demotion [BOTH]:** any S1/S2 anomaly resets the safety clock. A material R1 change
starts a new research cohort but does not erase already-clean safety days. If
throughput is still zero, remain in Phase 0, diagnose locally, make one declared
research release, and restart only the research cohort unless safety behavior also
changed.

### Phase 1 — Freeze mandates, ownership, and decision contracts

**Label: BOTH · Owner: Sam/investing partner for policy; primary reviewer for contracts**

1. **[SKILL]** Finalize Q-001–Q-003 and Q-009 (Q-004 is resolved), then turn Agent
   1/2/3 v3 mandates into exact,
   machine-readable policies without inventing missing investing rules.
2. **[BOTH]** Complete and version Agent 4's objective, accept/reject boundaries, virtual
   strategy-budget bounds, conflict treatment, regime inputs, explanations, and
   prohibition on self-originated trades or forced sales.
3. **[TRUST]** Inventory every proposal source and every outstanding v1 approval.
4. **[TRUST]** Freeze the exact signature-v2 payload and explicit expire/reject disposition of
   outstanding v1 approvals before lineage implementation.
5. **[TRUST]** Prove BUY/SELL ownership lineage and quarantine unattributed legacy inventory.
6. **[TRUST]** Complete scoped service-identity design and compatibility-removal evidence.

**Evidence:** accepted decision-register entries, versioned mandates, approved
contracts/ADRs, source inventory, ownership tests, dashboard explanations.

**Exit gate [BOTH]:** all four mandates are written and testable; no policy ambiguity is
silently encoded; every proposed action has an owner and version; Agent 4 cannot
alter or originate a proposal.

**Reset/demotion [BOTH]:** a mandate or contract change starts a new research cohort. A
signature, ownership, or identity change is S1 and returns live authority to the
last proven human-supervised level.

### Phase 2 — Establish durable, point-in-time truth

**Label: BOTH · Owner: data/contract builders + independent reviewer**

1. **[SKILL]** Activate the append-only point-in-time research record only after reviewed
   migration and rollback proof: universe, evidence, score observation, event,
   selection run, outcome, and job-run provenance.
2. **[SKILL]** Chain refresh → enrichment → peers → scores → events → shadow selection under
   one lock/run ID; downstream success is impossible after upstream failure.
3. **[SKILL]** Preserve version identities, same-day reruns, historical membership, source
   chronology, missing-data reasons, and complete/partial/actionable distinctions.
4. **[TRUST]** Continue financial dual-write/shadow-read; fix all unexplained parity failures.
5. **[TRUST]** Complete atomic money-path constraints, idempotency, backup automation, and
   repeatable restore testing.

**Evidence:** reproducible score from stored inputs; idempotent rerun; durable
write-failure tests; migration/restore proof; daily financial parity.

**Exit gate [BOTH]:** research records are reproducible and durable; no job can report
success after a required write failure; money remains shadow-read until 30 days of
zero unexplained broker/Postgres/Sheet differences and a clean restore/crash drill.

**Reset/demotion [BOTH]:** research schema/version changes create new cohorts. Any money
parity, duplicate-order, partial-book, or restore failure blocks canonical-read
cutover and returns financial state to the last proven source.

### Phase 3 — Converge coverage and validate score meaning

**Label: SKILL · Owner: research/data team; policy inputs from the decision register**

1. **[SKILL]** Classify at least 95% of the eligible catalog and give at least 90% a fresh
   score or a stable explicit reason it cannot be scored.
2. **[SKILL]** Implement special-sector economics and Agent 1/2/3 evidence adapters only from
   accepted Q-001–Q-004 and Q-009 definitions.
3. **[SKILL]** Separate true economic changes from coverage, peer-set, restatement, retry, and
   version changes.
4. **[SKILL]** Resolve Q-005 before positive-canary materiality is enabled.
5. **[SKILL]** Run leakage-resistant point-in-time validation with historical membership,
   filing availability, delistings, actions, benchmarks, and Q-007 cost policy.
6. **[SKILL]** Observe coverage/freshness for 10 consecutive trading days.

**Evidence:** coverage/freshness distributions, delta-cause ledger, comparable
cohorts, predeclared methodology, backtest diagnostics, out-of-sample results.

**Exit gate [SKILL]:** special sectors are not scored with ordinary-company economics;
false events stay below the accepted threshold; score changes are reproducible;
historical tests pass leakage, survivorship, and cost checks. This proves research
measurement quality, not alpha.

**Reset/demotion [SKILL]:** material scoring, source, universe, mandate, benchmark, or cost
changes open new cohorts and require renewed comparability evidence.

### Phase 4 — Promote evidence-driven attention and shadow Agent 4

**Label: BOTH · Owner: research lead + portfolio-policy owner**

1. **[BOTH]** Keep holdings and mandatory exit/re-underwrite work budget-exempt and protected.
2. **[SKILL]** Run the evidence slate in shadow, recording selected and displaced candidates.
3. **[SKILL]** After Q-005 and shadow evidence, canary only a bounded number of non-holding
   slots; preserve immediate rollback to shadow.
4. **[BOTH]** Run Agent 4 shadow accept/reject and virtual-allocation decisions beside Sam's
   decisions; expose conflict, concentration, cash pressure, ownership, and rationale.
5. **[BOTH]** Prevent return chasing with versioned windows, minimum samples, capped allocation
   changes, regime/drawdown controls, and diversification limits.

**Evidence:** at least 20 clean shadow/canary trading days; selection reasons;
displaced-candidate counterfactuals; costs; holding coverage; Agent 4 decision
lineage and paired human comparison.

**Exit gate [BOTH]:** attention improves predeclared research-quality or mature outcome
metrics without losing holding coverage, exceeding budget, or creating authority
leakage; Agent 4 remains shadow-only until later trust and sample gates pass.

**Reset/demotion [BOTH]:** coverage, freshness, concentration, budget, job health, or
proposal-quality regression returns selection to shadow. Policy changes start a
new research cohort.

### Phase 5 — One compiler, one lineage, one financial truth

**Label: BOTH · Owner: senior builder + security/money-path reviewer**

1. **[BOTH]** Implement ADR 0004 only after signature-v2 and v1-disposition gates close.
2. **[BOTH]** Route scheduled discovery, Lab, alerts, exits, and manual requests through
   `ResearchIntent → EvidenceSnapshot → immutable StrategyProposal → AllocationProposal`.
3. **[BOTH]** Require mandate/version, evidence, intent, sizing, kill criteria, evaluator,
   expiry, and owned SELL-lot references for every actionable proposal.
4. **[TRUST]** Mirror canonical contracts mechanically to dashboard and companion; prove drift
   guards and reject every bypass path.
5. **[BOTH]** Broaden catalog attention only through a separately reviewed canary;
   the current one-slot peer-screened canary is evidence, not authority to expand.
6. **[TRUST]** Cut canonical money reads to Postgres only after Phase 2's 30-day parity and
   restore/crash gates; Sheets becomes reporting-only after cutover proof.

**Evidence:** cross-runtime contract/signature tests, compiler-source inventory,
immutable fingerprint verification, v1 disposition ledger, 30-day parity record,
clean restore and rollback drill.

**Exit gate [BOTH]:** no executable proposal bypasses the compiler; every proposal and
fill traces to one current strategy and point-in-time evidence snapshot; Postgres
is promoted only with zero unexplained differences.

**Reset/demotion [TRUST]:** any lineage, signature, ownership, money parity, or schema-drift
anomaly stops new execution and restores human-supervised/last-canonical behavior.

### Phase 6 — Prove decision quality and bounded autonomy

**Label: BOTH · Owner: Sam as promotion authority**

1. **[SKILL]** Accumulate a meaningful current-version sample: at least 30 evaluator-graded
   actionable proposals plus mature outcomes appropriate to each mandate.
2. **[TRUST]** Accumulate at least 10 genuine live fills for execution/accounting evidence.
   Never trade merely to hit the number; the gate may take time.
3. **[SKILL]** Compare Agent 4 shadow decisions with Sam's supervised decisions across market
   regimes, specialist, allocation state, and portfolio risk.
4. **[TRUST]** Run live rollback/demotion drills and predeclare daily, per-strategy, portfolio,
   and loss/risk caps.
5. **[TRUST]** Promote first to bounded acceptance of eligible specialist BUYs. Keep SELLs
   human-supervised initially.

**Evidence:** current-version sample ledger, live fills and reconciliations,
decision comparisons, incident-free accounting, signed promotion policy, cap and
rollback tests.

**Exit gate [BOTH]:** 8–12 weeks plus the minimum samples; no ownership/accounting or
unresolved reconciliation incidents; Agent 4 decisions are explainable and aligned
with portfolio limits; independent promotion review passes.

**Reset/demotion [BOTH]:** any reconciliation, ledger, heartbeat, signature, contract,
stale-state, risk, mandate, or cap anomaly immediately returns authority to Sam.
Poor Agent 4 alignment returns it to shadow even if infrastructure remains healthy.

### Phase 7 — Cash challenger and durable edge program

**Label: SKILL · Owner: research lead; Q-006/Q-007 from the decision register**

1. **[SKILL]** After Q-006, challenge prolonged cash with evidence-backed alternatives and
   explicit rejection reasons; never force a BUY.
2. **[SKILL]** Mature and report outcomes for candidate scores, attention policies, AI review,
   evaluator decisions, specialist strategies, Agent 4, accepted/rejected
   proposals, cash, sizing, turnover, and costs.
3. **[SKILL]** Distinguish historical backtest, shadow counterfactual, paper result, and live
   realized return.
4. **[SKILL]** Use predeclared hypotheses, walk-forward/out-of-sample tests, confidence
   intervals, regime breakdowns, and Q-007 base/stressed costs.

**Evidence:** reproducible report, mature sample inventory, sensitivity analysis,
counterfactuals, benchmark/cost versions, explicit unavailable fields where data
does not exist.

**Exit gate [SKILL]:** any claimed edge survives realistic costs and out-of-sample testing
with adequate sample size; otherwise the feature remains measurement/shadow-only.

**Reset/demotion [SKILL]:** material methodology or policy changes open new cohorts. A
failed skill gate removes performance claims and can reduce capital/attention, but
does not by itself rewrite historical records.

### Phase 8 — Bounded specialist exits, then full mandate autonomy

**Label: BOTH · Owner: Sam + independent trust/skill reviewers**

1. **[BOTH]** Permit Agent 4 to accept an owner-specialist SELL only after all lot, risk,
   freshness, reconciliation, and Phase 6 promotion gates pass.
2. **[TRUST]** Expand caps gradually through written policy versions and observation windows.
3. **[BOTH]** Consider full mandate autonomy only after repeated clean windows and durable
   current-version skill evidence. Sam supervises health, allocations, performance,
   and policy versions rather than each trade.

**Evidence:** clean prior autonomy levels, live incident record, current skill
report, signed cap versions, rollback drills, independent review.

**Exit gate [BOTH]:** the system operates inside its exact mandates and caps with no
authority leakage and retains immediate deterministic demotion.

**Reset/demotion [BOTH]:** the Phase 6 anomaly list always applies. Trust failure demotes
authority immediately; skill decay reduces capital/attention or returns affected
strategies to shadow pending new evidence.

## 8. Human decisions and outside-capital gates

The durable questionnaires are [RESEARCH-POLICY-QUESTIONNAIRE.md](human-inputs/RESEARCH-POLICY-QUESTIONNAIRE.md)
and [SAM-SYSTEM-OWNER-QUESTIONNAIRE.md](human-inputs/SAM-SYSTEM-OWNER-QUESTIONNAIRE.md).
Accepted answers belong in the [decision register](RESEARCH-DECISION-REGISTER.md),
not only in chat. A task identifier is not a source of truth for whether a
decision remains open.

| ID | Label | Human owner | Decision | Blocks |
| --- | --- | --- | --- | --- |
| [Q-001](RESEARCH-DECISION-REGISTER.md) | SKILL | Sam + investing partner | Agent 1 balance-sheet definitions and fallbacks | Provisionally accepted; partner review remains needed before final mandate freeze. |
| [Q-002](RESEARCH-DECISION-REGISTER.md) | SKILL | Sam + investing partner | Current-estimate maximum age | Estimate actionability |
| [Q-003](RESEARCH-DECISION-REGISTER.md) | BOTH | Sam + investing partner | Entry quote/relative-volume age and session policy | Exact entry actionability |
| [Q-004](RESEARCH-DECISION-REGISTER.md) | SKILL | Resolved 2026-08-02 | Optional vs thesis-critical consensus/13F evidence | Resolved: 13F/ownership contributes to full coverage but is not a hard veto. |
| [Q-005](RESEARCH-DECISION-REGISTER.md) | SKILL | Sam + investing partner after shadow calibration | Per-agent score/rank/metric materiality | Positive canary selection |
| [Q-009](RESEARCH-DECISION-REGISTER.md) | SKILL | Sam + investing partner | Agent 2 multi-quarter persistence derivation and fallback | Agent 2 cannot reach its normal actionability threshold without it. |
| [Q-006](RESEARCH-DECISION-REGISTER.md) | SKILL | Sam + investing partner | Cash measure, duration, regimes, cooldown, horizon | Cash challenger |
| [Q-007](RESEARCH-DECISION-REGISTER.md) | SKILL | Sam + investing partner/accounting input | Base/stressed spread, slippage, tax scope | Net historical results and edge claims |

During Phase 0, Sam owns scheduling one focused session with the investing partner
for Q-001–Q-003, Q-005, Q-009, and mandate ambiguities. The accepted answers must
be recorded in the decision register before the affected Phase 1 work can exit; no
meeting or no recorded answer means the affected capability remains blocked rather
than receiving an inferred default.

### Legal/tax/outside-capital warning and autonomy gate — active now

Sam explicitly chose on 2026-07-14 to accept the interim legal risk of manual
outside-capital activity while still wanting continued pressure to obtain counsel.
The roadmap records that owner decision; it does **not** validate the arrangement
or convert software controls into legal advice. Sam should promptly obtain advice
from a qualified securities lawyer and accountant on investment-club/fund/adviser
classification, registration or exemptions, custody, disclosures, agreements,
tax reporting, valuation/NAV, fees, recordkeeping, and investor access.

Until written professional guidance is recorded, the system must not claim legal
compliance, market performance, solicit investors, charge or automate fees, or
autonomously manage outside capital. Existing software and ledger rows are not
evidence that the arrangement is compliant. Manual capital decisions remain Sam's
explicitly accepted risk; no roadmap phase may silently convert that decision into
system autonomy.

Professional advice may require work stricter than this plan. That requirement wins.

## 9. Cost and capacity policy

Cost is a BOTH control because exhausted capacity can corrupt research evidence and
holding monitoring.

1. Portfolio Manager usage remains separately attributable in its own signed
   telemetry. Sam explicitly accepts the existing shared provider credential for
   now; credential/project isolation is recommended again before broader autonomy.
2. Sam approved a `$40` UTC-month ceiling with a `$10` protected
   holding/evaluator pool inside—not on top of—that ceiling; production enforces
   both with an 80% warning threshold.
3. Every run has a bounded deep-review allowance and a protected evaluator/holding
   reserve. Holdings cannot lose required monitoring to broad discovery.
4. Each attempted call records model/policy version, usage/cost, success, rate
   limit, budget block, or provider failure without private rationale leakage.
5. Budget exhaustion and provider throttling are operational outcomes, never
   investment HOLDs.
6. Raising/lowering a limit is R1 unless it changes critical safety coverage, in
   which case it is S2.

## 10. Sample policy: shadow, paper, and live

- **Shadow/paper decisions count for SKILL** when they are point-in-time,
  versioned, evaluator-graded, benchmarked, and allowed to mature without hindsight
  edits. They can satisfy research, attention, and Agent 4 comparison sample gates.
- **Shadow/paper decisions do not prove TRUST execution.** Only genuine live fills,
  broker receipts, accounting, ownership, and reconciliation count toward the
  live-fill and money-path gates.
- **A live fill is not automatically skill evidence.** It becomes comparable only
  with complete decision-time lineage and a matured horizon.
- Do not create trades to satisfy a quota. If the account or opportunity set cannot
  naturally produce 10 fills, the autonomy gate remains open while shadow/paper
  skill evidence continues to accumulate.
- Do not claim alpha from a tiny or immature sample. Report uncertainty and keep
  autonomy promotion separate from investment-performance claims.

## 11. Freeze rules: what may proceed

During the Phase 0 safety freeze, the following may proceed without resetting the
safety clock only while it remains behaviorally isolated from the live backend:

- Q-001–Q-007 meetings, mandate drafting, legal/tax consultation, and policy review;
- Athena source/runtime review, owner/licensing discussion, evidence-contract
  design, and offline vendor comparison with no live adapter activation;
- local-only research packets, data adapters, backtest scaffold, tests, docs, and
  dashboard work with no authority or scheduled-job effect;
- read-only evidence review, restore rehearsal in non-production, and cost analysis;
- shadow analysis from already collected immutable data;
- preparation and independent review of a later release.

Do not during the freeze:

- deploy S1/S2 behavior except an emergency repair;
- change signatures, execution, accounting, canonical reads, broker access,
  reconciliation, critical schedules, observer pass semantics, or authority flags;
- tune live mandate/prompts/thresholds without declaring an R1 release and opening a
  new research cohort;
- broaden the current one-slot peer-screened research canary, grant Agent 4
  authority, or activate outside-capital work.

## 12. Standing demotion and release protocol

1. Every release states its phase, label, change class, owner, exact revision,
   flags, expected clock effect, rollback, and evidence to collect.
2. Money-, authority-, identity-, or cross-runtime-contract changes require an
   independent review and coordinated verification.
3. Production verification includes branch/commit, env presence without values,
   migrations, tests, restart, health, fresh logs, observer, parity, and authority
   flags.
4. Any reconciliation, ledger, signature, ownership, heartbeat, contract,
   stale-state, critical-job, unsafe-client, or cap failure immediately blocks new
   autonomous actions and demotes to the last proven human-supervised level.
5. Evidence is append-only. Resolve, supersede, or annotate bad records; never erase
   inconvenient history.
6. Update this plan's status and the appropriate evidence ledger in the same
   reviewed documentation change after a gate actually passes.

## 13. Narrow supporting documents

| Document | Narrow authority |
| --- | --- |
| [AUTONOMY-ROADMAP.md](AUTONOMY-ROADMAP.md) | TRUST architecture and detailed autonomy controls. |
| [ROADMAP-FORMIDABLE-FUND.md](ROADMAP-FORMIDABLE-FUND.md) | SKILL research/edge design and detailed metrics. |
| [ATHENA-INTEGRATION-AND-AGENT-PARITY-PLAN.md](ATHENA-INTEGRATION-AND-AGENT-PARITY-PLAN.md) | Supporting SKILL plan for using Athena as the shared research substrate, equalizing Agents 1–3, and improving evidence depth; no implementation or activation authority. |
| [PROPOSAL-QUALITY-FINDINGS.md](PROPOSAL-QUALITY-FINDINGS.md) | Current proposal-path strengths, confidence limits, and evidence-gated improvement candidates; no implementation authority. |
| [RESEARCH-ROADMAP-EXECUTION-GUIDE.md](RESEARCH-ROADMAP-EXECUTION-GUIDE.md) | Bounded implementation packets and verification detail. |
| [RESEARCH-DECISION-REGISTER.md](RESEARCH-DECISION-REGISTER.md) | Accepted/open investment-policy decisions. |
| [PHASE-0-OBSERVATION.md](PHASE-0-OBSERVATION.md) | Append-only Phase 0 daily evidence and consecutive count. |
| [PHASE-0-OBSERVER.md](PHASE-0-OBSERVER.md) | Automated observer behavior and fail-closed evidence eligibility. |
| [ANTHROPIC-COST-GOVERNANCE.md](ANTHROPIC-COST-GOVERNANCE.md) | Versioned pricing, usage telemetry, ceiling enforcement, and human configuration gate. |
| [POSTGRES-BACKUP-RESTORE.md](POSTGRES-BACKUP-RESTORE.md) | Application restore runbook and provider-native limitation. |
| [BACKTEST-METHODOLOGY-v1.md](BACKTEST-METHODOLOGY-v1.md) | Frozen historical-test method inside its accepted scope. |
| [ADRs](adr/) | Accepted architecture decisions; no phase promotion authority. |
| [INVARIANTS.md](INVARIANTS.md) | Non-negotiable implementation safety rules. |
| [CHANGE_MAP.md](CHANGE_MAP.md) | Code ownership/copy map, not roadmap status. |

The next action is Sam's local commit decision for the independently reviewed
hardening set. Only after a normal release record may the team verify the
request-bound 16:30 snapshot and collect stable funnel receipts under the declared
one-slot canary policy. The next promotion remains Phase 0 exit; later phase code
may exist or be prepared, but it does not change that ordering.
