# TODO

Personal follow-up list for Sam. Not a system-loop artifact (see `ops/FIXLIST.md`
for those) — just things to come back to.


- [ ] **AGENT 2 CANNOT PRODUCE AN ACTIONABLE CANDIDATE (Q-009).** The local EDGAR
      adapter now derives only contiguous revenue-YoY history, while consensus beats,
      adjusted-EPS persistence, and mandate materiality stay null rather than being
      guessed from incompatible sources. Agent 2 therefore still caps at **59** available points,
      below the 80-point bar. Worse, `evaluateCondition` short-circuits `all` on `false`
      but returns `null` on a missing input, so this bites the *strongest* names: a
      company growing >20% reaches the top band, hits the null and scores missing, while
      a mediocre one scores fine. Pinned by `tests/mandate-coverage-ceiling.test.js`.
      Remaining fix is an approved point-in-time consensus/adjusted-EPS history source
      plus explicit persistence/materiality semantics; do not substitute GAAP EPS.

- [ ] **VERIFY THE TWO EXTERNAL HOSTS FROM THE JETSON.** Neither could be reached from
      the sandbox this work was written in, so both paths are unexercised:
      `curl -sS -o /dev/null -w '%{http_code}\n' -A 'portfolio-manager <email>' \
        https://www.sec.gov/files/dera/data/form-13f-data-sets/2025q1_form13f.zip`
      (expect 200 — sec.gov is already reached by `lib/edgar.js`, so this should pass)
      `curl -sS -X POST https://api.openfigi.com/v3/mapping -H 'Content-Type: application/json' \
        -d '[{"idType":"TICKER","idValue":"AAPL","exchCode":"US"}]'`
      (expect JSON containing AAPL's CUSIP — this host has NEVER been called by this
      repo, so egress may not be permitted). If OpenFIGI is blocked, the fallback is
      deriving a partial ticker→CUSIP map from SEC filings that carry both.

- [ ] **A CATALOG REFRESH MUST LAND BEFORE AGENT 3 SCREENS ANYTHING.** The 3-years-public
      gate reads the new `ftd` field written by `applyQuotes`; it fails closed when
      absent, so until a quote pass repopulates the catalog, Agent 3's screen returns
      empty with `public_history_unavailable` on every name. Expected, but it looks
      exactly like a breakage if you are not expecting it.

- [ ] **REVIEW THE Q-001 BALANCE-SHEET DEFINITIONS THAT ARE NOW LIVE IN SCORING.**
      Sam signed off provisionally on 2026-08-01 so the work could proceed; the
      investing partner has NOT reviewed them. They are implemented in
      `lib/edgar-metrics.js` (`deriveFundamentalMetrics`) and bound in
      `lib/mandate-evidence.js`. Draft + rationale:
      `docs/human-inputs/Q-001-balance-sheet-definitions-DRAFT.md`.
      The four judgement calls to confirm or overrule:
      1. **Profitability** is TTM *operating* income > 0, not net income — so a
         one-time tax/litigation/impairment item cannot flip a structurally
         profitable company into the pre-profit track.
      2. **netCash** excludes restricted cash, and **operating leases are NOT
         treated as debt** (post-ASC-842 they sit on the balance sheet;
         including them would make asset-light retail/restaurant names look far
         more levered than the market treats them). This is the most debatable call.
      3. **EBITDA fallback order** is operating income + D&A, with several
         concept fallbacks; a missing D&A tag yields null rather than an
         approximation from operating income alone.
      4. **Negative or zero EBITDA ⇒ `netDebtEbitda` is null**, never a number.
         Scored naively a negative denominator sorts as "excellent" — this is the
         single most dangerous failure mode in the metric.
      Note: the mandate's own band thresholds were already transcribed in
      `config/scoring/absolute-thresholds.js`, so the bands proposed in the draft
      document were redundant and were NOT used. Only the definitions above are new.
      This changed scoring, so per the master plan's reset rules it opens a new
      research cohort.
- [ ] **MANDATE REVIEW: LET CONVICTION PERFORMANCE VS SPY INFORM THE SUGGESTIONS.**
      Part of the planned monthly Mandate Review (Pitch Lab report -> suggested mandate
      changes; suggestions only, never auto-applied). Conviction is the 1-5 rating Agent 1
      gives each paper pitch; the review should test whether it earns its keep and feed
      that into what it recommends. Inputs already exist in `report.json`
      (`lib/pitch-lab/analysis.js`): per period x horizon (5/10/20 days) the conviction
      block has Spearman rho + CI, excess return per conviction point (SE, CI, p),
      and per-level `buckets` (n, mean/median excess return vs SPY, hit rate + CI).
      Excess return = net stock return (10 bps/side) minus SPY over the same sessions.
      Ideas to work out:
      1. **Is conviction informative?** Calibration check: do higher levels beat SPY by
         more? Require rho and the per-point regression CI (cluster-robust) to both
         exclude zero before saying "positive"; a negative result is a real finding
         (higher conviction did worse).
      2. **Monotonicity by level.** Read the 1-5 buckets side by side: a 5 that does
         worse than a 3 is a red flag even if the overall slope is positive. Flag
         non-monotone patterns and sparse levels (e.g. n < 10 -> "not enough to judge").
      3. **What it changes in the review (suggestions only).** If conviction is
         predictive: suggest the mandate size/act more on the top levels, and
         identify the lowest level that still beats SPY as a candidate minimum
         threshold for acting on a pitch. If it's flat or negative: recommend
         NOT using conviction for sizing/gating yet and say what it would take
         (more pitches/weeks) to conclude anything. Also surface whether the 9
         metrics already explain conviction (the multivariate "does conviction add
         anything beyond the metrics" step in docs/PITCH-LAB.md Next steps #4);
         if not tested, say that conviction's apparent edge may be just the metrics.
      4. **Guardrails, same as the rest of the review.** Use the existing minimums
         (>= 30 graded pitches, >= 8 independent weeks, else "insufficient_data");
         call a conviction level "recommended" only if the pattern holds across
         >= 2 periods or horizons, otherwise "watch"; no multiple-testing shortcut
         (levels x horizons is a lot of looks - report q-values or treat per-level
         results as descriptive); caveats: SPY-only benchmark (a sector rally can
         inflate a level), overlapping holding periods, paper evidence != TRUST
         execution evidence (master plan section 10).
      5. **Implementation.** A pure function in the planned mandate-review module with
         tests (fixtures: planted positive, flat, negative, non-monotone, and
         sparse-level reports); fail closed (`unavailable`) on missing/malformed
         conviction fields; show a conviction section on the website page (bucket table
         + verdict) and in the Telegram summary. Must not import or write the mandate
         config, proposals, ledgers or any order path.

- [ ] **Revisit holdings reassessment cadence.** Come back to how often each
      agent's held positions get reassessed (daily exit-monitor at 16:45 ET,
      plus intraday ATR checks for Agent 1) and whether that cadence is still
      right as the portfolio grows. See `jobs/monitor-positions.js`,
      `jobs/intraday-monitor.js`, `scheduler.js`.

- [ ] **Not urgent — revisit Agent 4 trust-distribution start timing.** Currently
      trust starts at a flat 50 for all analysts and stays process-only (zero
      return weight) for a fixed 60-trading-day cold start (`agent_mandates/Agent_Four_Mandate_v3.md`,
      Section 5/10). Explore a metric-driven alternative to that fixed window —
      likely something beta-based (each analyst's portfolio beta vs. its own
      benchmark), then adjust by a multiple to judge how good the returns
      actually are for the time period given, relative to that analyst's
      mandate goals — rather than switching from process-only to performance-
      weighted purely on a calendar trigger.

- [x] **Wire a real Tier-2 size cap for the single-red macro condition.** The
      scheduled research path now applies `applySingleRedMacroTierCap()` after
      risk/conviction handling and on evaluator revisions. It uses each
      agent's `config/agents/mandate-policy.js` Tier-2 upper bound: Agent 1
      10%, Agent 2 8%; Agent 3 remains macro-informational. Unknown macro data,
      dual-red conditions, HOLDs, and SELLs are unchanged. See
      `lib/macro-regime.js` for the pure downgrade-only implementation.
