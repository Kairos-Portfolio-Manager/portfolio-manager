# Portfolio Manager — Research Strategy Roadmap

> **Narrow authority: SKILL detail.** The canonical cross-portfolio sequence,
> current-status index, two-clock policy, and promotion/demotion gates live in
> [the master plan](portfolio-master-plan.md). If this roadmap conflicts with the
> master plan, the master plan wins. This file retains the detailed research and
> edge-measurement design.

**Rev 2026-07-13 · detailed research-and-edge plan for Sam + investing partner**

> **North-star thesis: deterministic breadth, evidence-triggered AI depth.**
>
> Maintain a reproducible, point-in-time view of the eligible US equity market; use deterministic scoring to identify where genuinely new evidence changes an investment hypothesis; spend scarce AI attention on those changes; and measure, by strategy and regime, whether the resulting decisions create risk-adjusted excess return.

This is a roadmap for improving research quality and learning whether an edge exists. It is not evidence that the system beats the market, and it is not authority to accept outside capital or autonomously trade.

Implementation companion: `docs/roadmaps/RESEARCH-ROADMAP-EXECUTION-GUIDE.md` translates each phase into bounded executor packets, exact file surfaces, verification commands, stop conditions, and reviewer-owned decisions.

Analytical-depth companion:
`docs/ATHENA-INTEGRATION-AND-AGENT-PARITY-PLAN.md` records the plan to evaluate
Athena as the shared research substrate for all three specialists, replace the
current lossy conclusion-only adapter with a versioned point-in-time evidence
package, validate paid/free sources through a golden-set bakeoff, and preserve
Portfolio Manager's mandate, evaluator, proposal, approval, and execution
authority. It is a supporting plan only; it does not activate Athena, change the
phase order, or authorize an implementation packet.

Frozen implementation authorities:

- `docs/RESEARCH-DECISION-REGISTER.md` — accepted architecture/policy choices and the remaining investment-policy questions.
- `docs/adr/0003-point-in-time-research-record.md` — append-only research record, comparison semantics, and selection modes.
- `docs/adr/0004-strategy-proposal-lineage.md` — immutable strategy lineage and signature-v2 migration architecture.
- `docs/BACKTEST-METHODOLOGY-v1.md` — point-in-time historical validation and promotion methodology.

---

## What “formidable” means

A formidable Portfolio Manager must be strong on three separate axes. Progress on one does not imply progress on the others.

| Axis | Current honest state | Target of this roadmap | Proof required |
|---|---:|---:|---|
| **Operating process** | ~5 / 10 | **8 / 10** | Reliable coverage, explicit data quality, adversarial review, auditability, and a clean human-approval boundary. |
| **Research validity** | ~3 / 10 | **7–8 / 10** | Versioned point-in-time observations, stable scores, counterfactual selection tests, and reproducible backtests without look-ahead or survivorship bias. |
| **Demonstrated edge** | ~2 / 10 | **Unknown until measured** | Months of forward outcomes plus credible historical tests, net of realistic costs and benchmarked by strategy and regime. |

After the roadmap is complete, the honest claim should be:

> “This is a disciplined, whole-eligible-market research system that records exactly what it knew at the time, directs AI review toward material evidence changes, preserves strategy and approval lineage, and measures whether its hypotheses work.”

The system may call itself market-beating only after the evidence says so.

---

## Historical runtime snapshot — 2026-07-13 (superseded)

This section is preserved only as dated context for why the research roadmap was
written. Every branch, deployment, worktree, count, and feature-state assertion
below describes the 2026-07-13 snapshot and is **not current status**. It no longer
supersedes any other document; the master plan's current-status table and linked
evidence records are authoritative.

- At that snapshot, production was on remote `main` at `6e0aa24`; Jetson PM2
  was online and `/health` was green.
- The anti-fabrication fix and Agents 2/3 supervised-proposal promotion were
  already deployed and were not waiting on a branch merge.
- The latest stored scan had begun at `2026-07-13T17:38:54Z`, before the
  post-fix PM2 restart, and produced **36 HOLDs from 36 reviews**. At the time,
  the next clean post-fix scan was the first valid proof of whether the
  fabrication bug caused the streak.
- The live universe then contained **4,386 cataloged names**, of which **1,494
  were sector-enriched (34%)**. Agent 1 screened 305 names through its existing
  technology-subvertical funnel; this was not yet the sector-agnostic v3 universe.
- `PEER_METRICS_ENABLED` and `PEER_METRICS_EDGAR` were both off in production,
  so whole-market mandate scoring was not running live.
- Agents 2 and 3 sourced research from static watchlists, while all three
  specialists were marked `supervised` and could create human-approval proposals.
- Confidence-floor and research-budget-reserve changes were **uncommitted,
  undeployed, and policy-gated** in that worktree snapshot.
- The point-in-time observation spine, event/shadow-selection history, and
  edge-measurement primitives were **verified locally, uncommitted, undeployed,
  and inactive in production** at that time.
- Production might still have contained the Holdings-marker leak because the
  local E0.1 classifier had not yet been deployed. Backend and dashboard readers
  had verified mirrored classification semantics, with deployment proof still a
  separate gate.

---

## Non-negotiable design rules

1. **Point-in-time truth, not revised-history truth.** Every observation records what was available then, including filing/retrieval timestamps, source, universe membership, and data freshness.
2. **No score without provenance.** Every score identifies the mandate version, scoring/config version, code version, input snapshot, peer-set version, coverage mask, and calculation method.
3. **Missing data is visible.** Missing fields are never fabricated or silently treated as zero. A partial score must disclose its available-point denominator and cannot be compared as a “change” until the system separates new evidence from newly arrived coverage.
4. **Coverage changes are not fundamental changes.** Phase 2 may not send AI a name merely because a missing metric appeared, a peer group changed, or a vendor corrected stale data.
5. **Deterministic code narrows; AI investigates.** Code handles universe eligibility, calculations, peer resolution, freshness, and ranking. AI receives a small evidence-backed finalist set and may only propose within the active mandate.
6. **Research cannot manufacture authority.** Scores and AI outputs remain advisory. Risk controls may block, shrink, expire, or downgrade; they never upgrade a recommendation or force a purchase.
7. **One proposal lineage.** Every actionable proposal must trace to one research intent, evidence snapshot, strategy/mandate version, evaluator result, and—for SELLs—owned lots.
8. **Human approval remains binding.** Nothing in this roadmap weakens the signed approval, deterministic execution, ledger, or reconciliation boundaries in `docs/roadmaps/AUTONOMY-ROADMAP.md`.
9. **Cash is valid, but HOLD must be testable.** The system may hold cash indefinitely when no candidate qualifies; it must be able to explain that decision against the strongest available alternatives.
10. **Claims follow evidence.** Coverage, edge, process maturity, and deployment status are reported from runtime artifacts—not inferred from code existing in a branch.

---

## Relationship to the autonomy roadmap

The two roadmaps are orthogonal but share contracts and evidence.

- **Research roadmap:** improves what the system knows, which names receive attention, and whether its hypotheses work.
- **Autonomy roadmap:** governs who may propose, approve, authorize, execute, and reconcile actions.

They meet at four explicit gates:

1. **Operational proof:** no research expansion substitutes for the autonomy roadmap’s live stability window.
2. **Proposal lineage:** catalog research may expand before autonomy, but a research result may not become an actionable proposal unless the production proposal carries its mandate and evidence lineage.
3. **Coordinator evidence:** versioned outcomes by strategy, mandate, and regime become inputs to Agent 4 shadow evaluation and later promotion decisions.
4. **No authority leakage:** idle-cash challenges, scores, backtests, and Agent 4 opinions can recommend or reject; none may create a trade or bypass the current human signature.

### Current authority and lineage gate

Agents 2/3 are already `supervised` in production even though earlier roadmap language calls them non-actionable. Their runtime proposal objects still use the legacy Redis proposal shape rather than the canonical `StrategyProposal` lineage contract.

Decision D-003 preserves supervised proposals from their current static watchlists. Before Agents 2/3 expand beyond those watchlists, route them through the canonical compiler with mandate version, evidence snapshot, research intent, kill criteria, evaluator lineage, and owned-lot references. Any move back to paper-only or expansion of proposal authority is a new reviewed decision.

Human approval reduces immediate execution risk, but it does not replace traceability.

---

## Delivery plan

### Status vocabulary

- **Implemented locally:** code and focused tests exist in the current worktree, but final reviewer validation may still find changes.
- **Verified locally:** the final reviewer has completed the required focused and full verification passes.
- **Deployed/activated:** the reviewed code, migrations, configuration, and flags are present in the intended runtime and runtime health is proven.
- **Evidence gate passed:** the required observation window, policy decision, or empirical result exists. Local code or a green test suite cannot satisfy this state by itself.

Unless a phase explicitly says otherwise, the implementation described below is verified locally but is neither deployed nor evidence-gate complete.

### Phase 0 — Prove the system that is already deployed

**Status:** Active. The earlier anti-fabrication deployment is complete; post-fix runtime proof is not. E0.1/E0.2 are verified locally, while E0.3 remains evidence/policy-gated.

**Objective:** establish a truthful baseline before changing selection logic.

Work:

- Observe the next clean post-fix research run and inspect all 36 action reasons, not only aggregate counts.
- Confirm unsupported analyst/insider figures are blocked and no plausible evidence is falsely rejected.
- Separate genuine investment HOLDs from infrastructure, budget, stale-data, evaluator, or parsing HOLDs.
- Centralize Holdings marker-row filtering and prove every Holdings reader uses it.
- Verify research-budget behavior from fresh usage records before deploying the lower reserve defaults or Agent 3 confidence change.
- Record the baseline: candidates reviewed, data-gate failures, generator actions, evaluator verdicts, proposals, costs, latency, and missing-data causes by agent.

**Exit gate:** one clean post-fix run with 36/36 attempts accounted for; zero fabricated unsupported figures; zero status rows treated as securities; no silently dropped output; budget and action counts agree across logs, Redis status, Sheets, and the dashboard.

---

### Phase 1 — Build the point-in-time scoring record

**Status:** E1.1–E1.6 are verified locally. The migrations have not been applied, the advisory workflow is not activated in production, and no runtime or research-promotion gate has passed.

**Objective:** make every score reproducible and scientifically comparable before collecting a “factor track record.”

Work:

- Define a versioned `MandateScoreObservation` contract containing:
  - ticker, eligible-universe membership, agent, mandate version;
  - scoring/config version and source-code revision;
  - score, raw points, available points, completeness, coverage mask, and actionability;
  - per-metric values, units, provenance, filing/as-of/retrieval timestamps, and freshness;
  - peer-set identity, membership/version, peer count, fallback method, and sector substitution;
  - explicit reason codes for missing, deferred, stale, restated, or unsupported data.
- Store observations durably and append-only in Postgres. Redis may remain the latest-view cache, but a 120-day TTL is not the research record.
- Preserve same-day reruns as separately identified observations rather than overwriting history.
- Version the eligible universe so delisted names and historical membership remain reconstructable.
- Chain `universe refresh → metric enrichment → scoring` under a workflow lock or explicit completion handoff. Clock spacing alone is not sequencing.
- Add health/status for scoring-job success, coverage, freshness distribution, unsupported sectors, and failed source calls.

**Exit gate:** any displayed score can be recomputed exactly from stored inputs; reruns are idempotent; no missing Redis/Postgres write can be reported as job success; historical observations survive beyond four months; schema/config changes create a new version rather than silently changing old meaning.

---

### Phase 2 — Converge coverage without confusing breadth with quality

**Status:** Coverage accounting and a fail-closed Agent 1 standard-sector evidence adapter are verified locally. Special-sector classification, Agent 1 balance-sheet completion, and Agent 2/3 evidence adapters remain policy/data-gated. No whole-market scoring rollout is active.

**Objective:** expand from today’s partial Agent 1/standard-sector adapter to useful coverage of the eligible market.

Work:

- Enable peer metrics and EDGAR enrichment behind an observed rollout.
- Track nightly cohort size, successfully scored names, complete vs. partial scores, metric-level coverage, age distribution, and unsupported classifications.
- Finish the Agent 1 balance-sheet binding from mandate-author-approved definitions.
- Implement and test special-sector classification and approved bank/insurer/REIT substitutions; never pass raw Yahoo sectors as mandate substitution keys.
- Build Agent 2 persistence and Agent 3 multi-year evidence adapters only from their approved v3 mandates.
- Add consensus-snapshot and 13F pipelines only when their point-in-time storage and freshness semantics are defined.
- Reconcile the sector-agnostic v3 mandates with the live Agent 1 technology-only screener and Agents 2/3 static watchlists. Treat this as a deliberate product decision, not an implicit config drift.
- Quarantine stale or structurally incomplete names from delta ranking while retaining them for coverage reporting.

**Exit gate:** at least 95% of the eligible catalog is classified; at least 90% has a fresh score or an explicit stable reason it cannot be scored; no special-sector candidate is evaluated with standard-sector economics; coverage and freshness meet target for 10 consecutive trading days.

---

### Phase 3 — Validate score meaning before using score changes

**Status:** Delta-cause classification, append-only event/selection history, the shadow comparator, and a synthetic point-in-time backtest scaffold are verified locally. Historical/forward evidence has not validated score meaning, Q-005 still blocks live materiality, and Q-007 still blocks final net results.

**Objective:** prove that scores and score changes are stable, interpretable, and plausibly useful.

Work:

- Decompose every score delta into:
  - new fundamental filing;
  - price/valuation movement;
  - estimate or ownership update;
  - peer-set/universe change;
  - newly available coverage;
  - restatement/vendor correction;
  - scoring-version change.
- Suppress “research events” caused only by coverage arrival, peer churn, retries, or a version migration.
- Run the proposed event slate in shadow beside the current slate. Record which names each method would select and why.
- Measure selection stability, turnover, sector/cap concentration, novelty, evidence freshness, and eventual forward returns.
- Build a point-in-time historical test using filing availability dates, historical universe membership, delistings, corporate actions, benchmark returns, and realistic slippage. Never backfill today’s revised facts into yesterday’s decision.
- Establish benchmark and evaluation windows appropriate to each agent’s horizon.

**Exit gate:** score changes are reproducible and reason-coded; false events from coverage/version changes are below an agreed threshold; the shadow event slate demonstrates better evidence freshness or outcome signal than rotation without unacceptable concentration; the backtest passes leakage, survivorship, and transaction-cost checks.

---

### Phase 4 — Promote the evidence-driven AI review slate

**Status:** The pure selector and shadow-recording portion of E4.2 are verified locally. The local configuration remains shadow with zero canary slots; positive canary and live selection fail closed pending Q-005, deployment, and the Phase 3/4 evidence gates.

**Objective:** allocate the same AI budget to the names where current evidence most warrants expensive review.

Slate priority:

1. Current holdings and mandatory exit/re-underwrite triggers.
2. Material new filings, credibility events, or thesis-breaking evidence.
3. Validated score changes with a known economic cause.
4. Top stable scores not recently researched.
5. A bounded exploration allocation to preserve discovery and measure selection bias.

Work:

- Run shadow first, then canary a small portion of non-holding slots.
- Preserve holdings as budget-exempt and keep evaluator/risk gates downgrade-only.
- Log the displaced candidate for every selected candidate so the system can measure the opportunity cost of its attention policy.
- Add rollback to the current slate if coverage, freshness, concentration, job health, or proposal quality degrades.

**Exit gate:** at least 20 clean trading days in shadow/canary; no holding loses required monitoring; selection reasons are visible in the dashboard; cost stays within budget; the event-driven slate outperforms rotation on predeclared research-quality metrics or remains shadow-only.

---

### Phase 5 — Expand all specialist strategies through one compiler

**Status:** ADR/design is frozen, but no E5 implementation is accepted. Agents 2/3 remain intentionally supervised and watchlist-bound in production; catalog expansion is blocked on the exact signature-v2 payload, outstanding-v1 approval disposition, canonical compiler implementation, and the lineage evidence gate.

**Objective:** let each specialist search the eligible catalog according to its own testable mandate without creating parallel proposal paths.

Work:

- Preserve the accepted supervised/watchlist-bound production policy until catalog-wide evidence coverage and the Phase 5 lineage gate are complete; treat any authority expansion as a new reviewed decision.
- Complete their deterministic universe screens and evidence adapters.
- Route scheduled discovery, Lab, alerts, exits, and manual requests through one `ResearchIntent → EvidenceSnapshot → StrategyProposal` compiler.
- Require every production proposal to include mandate/version, evidence snapshot, intent, requested sizing, kill criteria, evaluator result, expiry, and owned-lot references for SELLs.
- Keep each agent’s scores and outcomes separate even when they research the same ticker.
- Record proposal and outcome metrics by mandate version and regime so later comparisons are fair.

**Exit gate:** no actionable proposal bypasses the compiler; every proposal and fill is traceable to one strategy version and point-in-time evidence snapshot; Agents 2/3 catalog coverage produces no cross-strategy ownership violations; the dashboard can explain the full lineage.

---

### Phase 6 — Add an idle-cash challenger, never a forced-buy rule

**Status:** Not implemented. Q-006 and trustworthy scoring/lineage evidence block E6.1/E6.2.

**Objective:** make prolonged cash positions intellectually accountable without weakening abstention discipline.

Work:

- Define cash-pressure thresholds using portfolio state, opportunity set quality, regime, and time—not cash percentage alone.
- When triggered, compare every HOLD with the strongest eligible alternatives and require explicit rejection reasons.
- Separate “no qualifying opportunity” from data failure, budget exhaustion, stale inputs, evaluator failure, position caps, and operational degradation.
- Alert Sam with the best rejected alternatives, their evidence, and the binding reason they did not become proposals.
- Store the counterfactual and later measure whether holding cash or buying the challenger would have been better.

**Hard rule:** this phase may challenge a HOLD, request a re-review, or alert. It may never upgrade HOLD to BUY, weaken a hard gate, manufacture a proposal, or force portfolio-wide selling.

**Exit gate:** every prolonged-cash alert is evidence-backed and non-duplicative; operational failures cannot masquerade as investment abstention; counterfactual outcomes are recorded; no forced-buy or authority bypass exists in code or prompt behavior.

---

### Phase 7 — Build the durable edge-measurement program

**Status:** Outcome math, additive persistence/readers, attention-policy counterfactuals, and an aggregate-safe report generator are verified locally. Outcome-maturation cadence, mature samples, accepted Q-007 costs, deployment, and any edge or promotion claim remain outstanding.

**Objective:** determine what works, for whom, in which regime, and after costs.

Measurement layers:

- **Candidate score:** forward excess return and drawdown by score band, completeness, and score-change cause.
- **Attention policy:** event-driven slate vs. rotation vs. top-score vs. exploration counterfactuals.
- **AI contribution:** deterministic finalist outcome vs. AI-reviewed recommendation and evaluator decision.
- **Strategy contribution:** Agent 1/2/3 results by active mandate version, horizon, benchmark, and regime.
- **Portfolio contribution:** accepted vs. rejected proposals, sizing effects, cash drag, concentration, turnover, slippage, and Agent 4 shadow decisions.

Required safeguards:

- Point-in-time inputs and universe membership.
- Delistings, splits, dividends, corporate actions, and realistic fills/costs.
- Predeclared hypotheses and evaluation windows.
- Out-of-sample or walk-forward validation.
- Sample-size and confidence intervals; no promotion based on a handful of trades.
- Clear distinction between historical backtest, shadow counterfactual, paper result, and realized live return.

**Exit gate:** a reproducible research report can show where return came from, what would have happened under the alternatives, how sensitive results are to assumptions, and whether any claimed edge survives costs and out-of-sample testing. Autonomy promotion remains governed separately by `docs/roadmaps/AUTONOMY-ROADMAP.md`.

---

## Success metrics

### Operating health

- Critical-job completion and duration.
- Catalog, classification, metric, and score coverage.
- Input freshness and source-failure rates.
- Research cost per reviewed name and per actionable proposal.
- Silent-output-loss count: target zero.
- Holding-monitoring coverage: target 100%.

### Research quality

- Percentage of AI reviews triggered by genuinely new economic evidence.
- Percentage triggered incorrectly by coverage/version/peer churn.
- Evaluator APPROVE/REVISE/REJECT mix and subsequent outcomes.
- Thesis, bear-case, kill-criteria, and evidence-lineage completeness.
- Duplicate research and slate turnover.
- Counterfactual opportunity cost of selected vs. displaced candidates.

### Edge evidence

- Forward alpha and drawdown by score band and strategy horizon.
- Calibration: stated confidence vs. realized outcomes.
- Accepted vs. rejected proposal outcomes.
- Event slate vs. rotation/top-score/exploration outcomes.
- Performance by mandate version and market regime.
- Net results after turnover, spread, slippage, and taxes where applicable.

No single metric is a promotion gate. Sample size, data quality, risk, and operational integrity are considered together.

---

## Immediate next actions

1. Complete Phase 0 runtime proof on the next post-fix scan.
2. Commit only the adversarially reviewed roadmap scope; keep unrelated and policy-gated worktree edits out of those commits.
3. Treat Postgres migration, runtime configuration, feature activation, and deployment as a separate reviewed rollout with health and rollback proof.
4. Enable enrichment and durable observation collection only as an observed advisory rollout—not as immediate input to proposals or the live AI slate.
5. Resolve Q-001–Q-005 before completing actionable evidence adapters or positive-canary selection, Q-006 before a cash challenger, and Q-007 before publishing net historical results.
6. Add and review the outcome-maturation cadence, then accumulate point-in-time observations and matured forward outcomes; history that was never captured cannot be reconstructed later without bias.
7. Keep the current candidate slate live until the shadow evidence-driven slate clears the Phase 3 and Phase 4 gates.

---

## The decision standard

When choosing what to build next, prefer the work that improves one of these:

1. **Truth:** better point-in-time data, provenance, or reproducibility.
2. **Attention:** better allocation of scarce research effort.
3. **Learning:** clearer measurement of what worked and why.
4. **Control:** stronger lineage, safety, auditability, or rollback.

Features that do not improve truth, attention, learning, or control are not roadmap priorities.

---

*Internal strategy document. Runtime figures are point-in-time as of 2026-07-13 and must be refreshed from production evidence when status changes.*
