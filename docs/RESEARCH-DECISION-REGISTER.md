# Portfolio Manager — Research Decision Register

> **Narrow authority: investment-policy decisions.** Accepted answers here bind
> implementation inside their scope. The canonical phase order, current status,
> and promotion/reset gates live in [the master plan](roadmaps/portfolio-master-plan.md).

**Rev 2026-07-13 · primary-reviewer decisions and unresolved investment-policy inputs**

This register prevents executor models from inventing rules. Accepted decisions may be implemented. Open decisions block only the packets named under “Blocks”; unrelated packets may proceed.

## Accepted decisions

### D-001 — Canonical specialist mandates

- **Decision:** Agent 1/2/3 v3 files under `agent_mandates/` are canonical at version `3.0`.
- **Reason:** They explicitly define universe, peer fallback, data handling, output, and authority boundaries.
- **Implementation:** add explicit machine-readable mandate metadata; do not parse version from Markdown at runtime.
- **Blocks cleared:** E1.1, E1.4, E2.1, E3.1.

### D-002 — Agent 1 target universe versus current production restriction

- **Decision:** v3’s target is sector-agnostic across eligible NYSE/NASDAQ operating-company common equities. The current technology-subvertical screen remains a temporary production restriction until Phase 2 gates pass.
- **Reason:** This honors the canonical mandate without prematurely exposing unimplemented special-sector economics.
- **Implementation:** status/observations must record both `mandateUniverseVersion` and active `productionUniversePolicyVersion`.
- **Blocks cleared:** architecture and coverage work. Live screen removal remains gated.

### D-003 — Agents 2/3 authority during migration

- **Decision:** retain current `supervised` proposal eligibility for their existing static-watchlist research. Do not expand them to catalog sourcing until canonical proposal lineage, evidence adapters, and canary evidence pass.
- **Reason:** Human approval preserves the immediate boundary; returning to paper-only is not necessary for the current narrow source, but expansion without lineage would compound governance debt.
- **Blocks cleared:** Phase 1–4 data work. Phase 5 catalog activation remains gated.

### D-004 — Durable research store

- **Decision:** Postgres is the append-only research record; Redis is latest-view/status cache only.
- **Reason:** Research history must outlive TTLs and retain point-in-time provenance.
- **Blocks cleared:** E1.1–E1.6.

### D-005 — Partial-score use

- **Decision:** store partial scores; compare them only inside identical coverage/version cohorts; never make them proposal-actionable unless thesis-critical fields are present and at least 80 points are available.
- **Reason:** This matches v3 rescaling rules and avoids treating coverage arrival as edge.
- **Current effect:** the first Agent 1 EDGAR adapter is research-only because it exposes fewer than 80 available points.
- **Blocks cleared:** E1.1–E3.3.

### D-006 — Score-change eligibility

- **Decision:** only economic causes (`filing`, `market`, `estimate`, `ownership`) may compete for AI review. Coverage, peer-set, restatement, version, retry, and initial observations remain shadow telemetry.
- **Blocks cleared:** event collection and shadow selection in E3.1–E4.2. Q-005 still blocks positive-canary and live event eligibility.

### D-007 — Nightly sequencing

- **Decision:** one workflow lock/run ID chains refresh → enrichment → peers → scores → events → shadow selection. Separate cron times are removed once the workflow exists.
- **Blocks cleared:** E1.5/E1.6.
- **Implementation note:** the prerequisite-gated ordered workflow is verified in the local worktree. It is not deployed or activated, and this note is not runtime proof.

### D-008 — Proposal-lineage architecture

- **Decision:** keep immutable `StrategyProposal` records separate from live allocation proposals. Live proposals reference `strategyProposalId` and `strategyProposalFingerprint`. A versioned approval signature v2 binds the fingerprint to the authorized trade.
- **Compatibility:** legacy v1 proposals remain readable. After the cutover, new system and manual proposals must have canonical lineage and signature v2. Outstanding v1 approvals are allowed only through their existing expiry or are deliberately rejected before enforcement.
- **Reason:** separates research truth from mutable lifecycle bookkeeping while cryptographically binding the approved trade to its lineage.
- **Blocks cleared:** ADR/design for E5.1–E5.4 only. Implementation remains blocked until the exact signature-v2 signed payload is frozen and outstanding v1 approvals are inventoried with an explicit expire/reject/migrate disposition; implementation is then high-risk and separately reviewed.

### D-009 — Selection rollout

- **Decision:** shadow → bounded canary → live. Holdings and mandatory exits are never displaced. Rollback is a config change to shadow mode.
- **Blocks cleared:** E4.1 and the shadow-recording portion of E4.2. Positive canary and live selection remain gated on Q-005, observed shadow evidence, and explicit promotion review.

## Open decisions requiring Sam/investing-partner input

### Q-001 — Agent 1 balance-sheet definitions

- **Status: PROVISIONALLY ACCEPTED (Sam, 2026-08-01) — PENDING INVESTING-PARTNER REVIEW.**
  Implemented so downstream work could proceed; see `todo/TODO.md` for the review item
  and `docs/human-inputs/Q-001-balance-sheet-definitions-DRAFT.md` for full rationale.
- Accepted definitions, implemented in `lib/edgar-metrics.js` and bound in `lib/mandate-evidence.js`:
  - `isProfitable` = TTM `OperatingIncomeLoss` > 0 (operating, not net, income); `isPreProfit` is its complement.
  - `netCash` = (unrestricted cash + short-term investments) − total debt > 0. Restricted
    cash is excluded; operating leases are NOT counted as debt.
  - EBITDA = operating income + D&A, with a concept fallback chain; a missing D&A tag
    yields `null` rather than an approximation.
  - `netDebtEbitda` = (total debt − liquid assets) / EBITDA, and is **null** whenever
    EBITDA ≤ 0, so a negative denominator can never sort as excellent.
  - Financial companies (banks/insurers/REITs) remain out of scope and fail closed.
- Band thresholds were already transcribed in `config/scoring/absolute-thresholds.js`
  and were used unchanged; only the definitions above were added.
- **Effect:** Agent 1 and Agent 2 max available points move 53/51 → 63, and → 85 with
  consensus bound, clearing the 80-point actionability bar for the first time.
- **Reset:** this is a material scoring change and opens a new research cohort.

### Q-002 — Current-estimate freshness

- **Status: RESOLVED (Sam, 2026-09-21).** Transcribed 2026-09-23 by Claude from the
  verbatim decision recorded in `~/Claude Memory/Projects/pm-codex-claude-conversation.md`
  (2026-09-21 entry "DECISIONS (Sam → both agents): Q-002 settled..."). This is a
  transcription of an already-made decision, not a new policy call — flagging it as
  such per Codex's 2026-09-23 review finding that this register lagged the decision
  and implementation should not get ahead of it. **Sam/Codex: please confirm this
  transcription is accurate before treating it as fully settled here.**
- **Decision:** an estimate snapshot is `fresh` only when its provider timestamp is
  no more than **30 calendar days** old at observation time (Choice C, not the
  15-minute-bar-anchored Choice C reading originally drafted — see reasoning below).
  After reported earnings, new company guidance, or a material filing, the prior
  snapshot is `stale` at the **next regular-market session open** and remains so
  until a newer provider timestamp is observed (Choice A). A missing or stale
  required estimate writes `stale`/`unavailable`; the metric is not covered and the
  candidate cannot be actionable on it (Choice A).
- **Reasoning for Choice C over stricter bar-anchored alternatives (Claude, accepted
  by Sam 2026-09-21):** the system has no intraday bar ingestion (`lib/yahoo.js`
  fetches are all `interval: "1d"`), so a reproducible decision-time reference is
  delivered by the existing required implementation facts (quote source, timestamp,
  session label, reference price/time) rather than by bar anchoring. This is a build
  commitment for infrastructure that exists today, not the strictest theoretical
  option.
- **Blocks cleared:** estimate freshness/actionability for `revBeat`/`estimateRevisions`
  (source: `consensus_snapshot_store`). Implemented in `lib/freshness-policy.js:
  resolveConsensusFreshness`, wired through `lib/mandate-observation.js`'s optional
  `metricProvenance` parameter (additive; no existing caller passes it yet, so no
  behavior changed until one does).
- **Known coupling, flagged not solved (Claude, 2026-09-21):** the 30-day limit
  against a 250-names/night enrichment cadence over a ~4,500-name catalog gives
  roughly a 5-day margin before missed nights start failing names closed for a
  scheduling reason rather than an investment one. Not a reason to loosen the limit;
  a reason enrichment cadence needs its own monitoring (Codex's lane).

### Q-003 — Entry quote and relative-volume freshness

- **Status: RESOLVED (Sam, 2026-09-21), transcribed 2026-09-23 by Claude —
  same provenance/confirmation caveat as Q-002 above.**
- **Decision:** during the regular US session, a proposal needs a quote timestamp no
  more than **5 minutes old** (Choice A). Outside regular hours, a last-regular-close
  quote may support `research_only` use but **never** an execution-ready read at
  proposal-creation time (Choice A) — confirmed safe because execution readiness is
  evaluated at Sam's approval, not at scan-creation time (docs commit `ae957b2`), so
  this does not silently mark every scheduled-scan proposal (17:15 ET, always outside
  regular hours) permanently research-only. Fresh review required at 3%+ move from
  the research snapshot's reference price (Choice A now; revisit
  `max(3%, 0.5 × 20-day ATR%)` once ATR coverage is proven — Choice C later).
  Issuer events (reported earnings, new guidance, material filing) make the proposal
  research-only until refreshed (Choice A now; Sam noted a maintained issuer+regime
  list, Choice B, is expected eventually — deferred, not rejected).
- **Blocks cleared:** exact entry actionability for `peerValuation`
  (source: `yahoo_quote_summary`). Implemented in `lib/freshness-policy.js:
  resolveQuoteFreshness`, wired the same additive way as Q-002 above.
- **Not yet implemented:** the 3%-move re-review trigger and issuer-event
  invalidation are decided but not wired into any code yet — only the base
  regular-session/outside-hours age rule is.

### Q-004 — Consensus and 13F completeness policy

- **Status: RESOLVED (Sam, 2026-08-02).** Supersedes the prior "temporarily optional,
  not thesis-critical" reading.
- **Decision:** 13F/institutional ownership is **required for full coverage but never
  blocking**. Absence degrades the score (metric reports missing, rescaled out) rather
  than vetoing the candidate — a dataset published ~45–75 days after quarter end must
  not hold a veto over a trade.
- **Sourcing:** SEC quarterly [Form 13F Data Sets](https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets)
  — one structured ZIP per quarter covering all ~3–4k filers. Ingest is per-QUARTER, not
  per-ticker: ownership is a sum across every holder, so there is no per-name filing to
  read, but the data only changes 4x a year.
- **Filer universe:** all 13F filers. A curated "smart money" subset was rejected — it is
  an unbacktested thesis requiring ongoing maintenance, and would change what
  `clearMultiQuarterAccumulation` means relative to the mandate text.
- **`ownershipChangePoints` = percentage points of shares outstanding.** The band table
  (≥5 full, ≥2 strong, −2..2 neutral) only coheres under this reading. The `thirteenF`
  table's `*ChangePct` fields are a *different* quantity — percent change in aggregate
  shares held. Do not collapse them.
- **Denominator:** `us-gaap:CommonStockSharesOutstanding` at period end.
  `dei:EntityCommonStockSharesOutstanding` was rejected: it is a cover-page figure
  measured at *filing* date, and that skew makes a buyback read as accumulation.
- **Retention:** two quarters of change plus the publication lag; usability keys off
  actual dataset publication, not the statutory due date.
- **CUSIP join:** 13F identifies holdings by CUSIP and the CUSIP master file is licensed.
  Resolved by inverting the direction — map our own candidate universe ticker→CUSIP once
  via OpenFIGI (`lib/cusip-map.js`) and use it to filter the quarterly file. Unmapped
  tickers contribute no rows and rescale out.
- **Effect:** Agents 1 and 3 reach the full 100-point ceiling. Agent 2 does not — see
  Q-009.
- **Reset:** material scoring change; opens a new research cohort.

### Q-008 — Agent 3 long-horizon definitions

- **Status: ACCEPTED (Sam, 2026-08-02).** Implemented in `lib/agent3-history.js`.
- **Period basis:** rolling TTM from quarterly facts, in **non-overlapping 4-quarter
  windows**. Overlapping windows share three of four quarters, so one bad quarter
  contaminates four comparisons and any consistency test reads smoother than reality.
  Note this is *stricter* than the 3-years-public rule: three year-over-year comparisons
  need 4 windows ≈ 16 clean quarters ≈ 4 years of filings. TTM is the binding constraint.
- **Normalized EPS** = operating income per diluted share, consistent with Q-001's
  profitability decision. CAGR is endpoint-to-endpoint; a trimmed/regression trend was
  considered and **not** adopted, so a depressed base window can still flatter the
  result — the volatility fields are what surface that.
- **`marginChangeBps3y`** uses gross margin, matching Agents 1 and 2.
- **Q-001 extends unchanged to the 3-year medians**, applied per window *before* the
  median, so a negative-EBITDA year drops out instead of sorting as excellent.
- **"Material" booleans** (`materiallyErraticGrowth`, `volatileYears`,
  `materialDeterioration`, `materialMultiYearDeterioration`, `persistentDeterioration`)
  all derive from the mandate's one stated number — `maxAnnualGrowthSpreadPoints ≤ 15`.
  A year is volatile when its growth rate swings >15pp from the year before it; two
  consecutive bad years is "persistent". Deviation-from-median was rejected: a
  +60/−25/+60 path is plainly erratic yet only one of its years deviates from the median.
- **Eligibility:** Agent 3 cannot invest in a company public for under 3 years. Enforced
  upstream in `lib/mandate-catalog-screen.js`, not as a scoring outcome, so the rejection
  reason stays legible. Requires the catalog's new `ftd` (first trade date) field.
- **Effect:** Agent 3 max available points move 10 → 100.

### Q-009 — Agent 2 multi-quarter persistence inputs (OPEN — partially derived locally)

- Agent 2's rule tables read `beatsInLatestThree`, `minimumBeatPct`,
  `missesInLatestThree`, `positiveQuartersInLatestFour`,
  `positiveMultiQuarterPersistence`, `consecutiveMaterialDecelerations`,
  `consecutiveQualifyingQuarters`, `consecutiveDeterioratingQuarters`. The local EDGAR
  adapter now derives only contiguous, sourced revenue YoY observations
  (`positiveQuartersInLatestFour` and `nonDecelerating`). Consensus beats, materiality,
  adjusted-EPS persistence, and deterioration remain deliberately null rather than
  being inferred from GAAP or a single scalar.
- Because `evaluateCondition` short-circuits `all` on `false` but returns `null` on a
  missing input, this bites hardest on the *strongest* names: a company growing >20%
  reaches the top band, hits the null, and reports missing, while a mediocre one scores.
- **Effect:** Agent 2 caps at **59** available points — below the 80-point actionability
  bar — so it cannot produce an actionable candidate at all. Pinned by
  `tests/mandate-coverage-ceiling.test.js`.
- **Blocks:** Agent 2 actionability entirely. It still needs an approved point-in-time
  consensus/adjusted-EPS history source and explicit materiality semantics before its
  remaining persistence inputs can be derived.

### Q-005 — Score-event materiality thresholds

- Define per-agent absolute score delta, rank delta, or metric-specific event thresholds.
- Recommended method: calibrate in shadow from observed delta distributions before freezing thresholds.
- **Blocks:** E3.1 live materiality policy and E4 canary, not event collection.

### Q-006 — Cash-challenger policy

- Define deployable-cash measure, threshold, idle duration, regime exceptions, challenger count, alert cooldown, and evaluation horizon.
- **Blocks:** E6.1/E6.2 only.

### Q-007 — Backtest cost assumptions

- Confirm base and stressed spread/slippage assumptions by liquidity bucket and tax treatment scope.
- **Blocks:** populated net-return fields, final historical results, and any net-edge claim. It does not block pure outcome math, additive persistence, or aggregate-safe report structure when those surfaces keep costs explicitly unavailable.

## Decisions reserved for later evidence gates

- Shadow-to-canary promotion date and slot count.
- Canary-to-live selection promotion.
- Exact signature-v2 signed payload and the reviewed disposition of every outstanding v1 approval before E5 enforcement.
- Ownership and production cadence for E7 outcome maturation.
- Postgres money-read cutover.
- Agent 4 authority promotion.
- Any statement that a strategy or system demonstrates edge.
