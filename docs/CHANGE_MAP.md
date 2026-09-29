# Portfolio Manager — Change Map

Where to change things, with exact files and the gotchas that have actually bitten. Repos: `portfolio-manager` (backend, this repo) and `../portfolio-dashboard` (dashboard + Mac companion).

## Adding or changing a Google Sheet tab

Files:
- `lib/sheets.js` — add to `TABS` (line ~8), write header constants + reader/writer functions here.
- `../portfolio-dashboard/lib/sheets.ts` — if the dashboard reads it, mirror the schema there (independent hand-written copy).
- Consumers: jobs that read/write the tab.

Gotchas (all real bugs):
- **`ensureTabs` is skipped on Redis cache hits** in some paths — after adding a tab, call `ensureTabs` explicitly in every job that touches it (see `performance-review.js`, `holdings-sync.js` precedents), or run any job once manually to create it.
- Never delete the last sheet in a batch — bundle deletes with adds in one `batchUpdate` (the "can't remove all sheets" provisioning bug).
- Column-order changes are a **cross-repo breaking change**: `sheets.ts` destructures by position (e.g. `REC_DATA_START_ROW = 13` magic numbers exist in both files).
- Extending headers on an existing tab: use `ensureHeadersExtendable` (migrates in place), and remember it writes by row index captured at read time.
- Holdings parsing relies on sentinel strings (`"Cash"`, `"Last synced"`, `"⚠️"`) — don't reformat those rows.

## Changing Postgres shadow parity

Files: `lib/pg/inventory.js` (canonical inventory fields/precision),
`lib/pg/parity.js` (comparison classifications/report),
`lib/pg/parity-runner.js` (store reads), `tests/pg-inventory.test.js`, and
`tests/pg-parity*.test.js`.

Gotchas:
- Position transactional parity is exact over ticker, name, shares (8 decimals), average cost (4), and cost basis (2). `marketValue` is quote-derived and must not enter that digest.
- Compare valuation exactly only when both sides carry the same non-empty versioned quote snapshot, quote source, and source timestamp. A Sheet read time or Postgres `updated_at` is storage freshness, not quote provenance.
- The Holdings marker also carries a digest bound to ticker, shares, provider current price, and rounded market value. Validate that digest against rows from the same Sheets read before copying provenance to Postgres; a stale/manual/interleaved edit must degrade to `NON_COMPARABLE`, never false `EXACT_MATCH`.
- `jobs/holdings-sync.js` builds one canonical cent-rounded monetary projection before either the Sheet or Postgres write. Do not independently round the two destinations; half-cent boundaries otherwise create false parity failures.
- Missing provenance is `NON_COMPARABLE`; different source/version is `PROVENANCE_MISMATCH`; different source timestamp is `FRESHNESS_MISMATCH`. Keep these visible without calling them accounting divergence.
- Unreadable stores and transactional digest/count differences remain fail-closed. A valuation inventory mismatch from the same identified quote snapshot is a real shadow-projection divergence.

## Changing recommendation / research logic

Files: `jobs/research-scan.js` (orchestration), `lib/quant-scorer.js` (scoring), `lib/ai-overlay.js` (prompt + JSON parse), `lib/risk-engine.js` + `config/agents/<id>/risk-limits.json` (deterministic checks), `lib/screener.js`, `lib/data-gates.js`, `lib/conviction.js`, `lib/evaluator.js` (independent proposal evaluator), `lib/evidence.js` (untrusted-text fencing/redaction), `lib/circuit-breaker.js` (drawdown tiers), `config/agents/<id>/weights.json`, `lib/athena.js` (optional Athena dossier evidence, env-gated). Design rationale: `docs/LOOP-DESIGN.md`.

## Changing universe discovery / candidate selection

Files: `lib/universe.js` (NYSE/NASDAQ listing parse + Redis catalog shapes), `jobs/universe-refresh.js` (nightly listing/quotes/sector-enrichment crawler, 7:30 PM ET cron), `lib/candidate-slate.js` (pure daily slate: holdings → movers → ranked → exploration), `lib/research-ledger.js` (per-agent memory of researched names; drives rotation + the overlay's prior-research line), `config/agents/<id>/universe.json` (`source: "catalog" | "watchlist"`, `slateSize`, `aiReviewBudget`, `researchCooldownDays`, `explorationSlots`), Redis helpers in `lib/redis.js` (`pm:universe:*` chunked catalog, `pm:research-ledger:<agentId>`).

Gotchas:
- `aiReviewBudget` is the cost guardrail on Anthropic spend — holdings are exempt (a held name is always reviewed), everything else competes for the budget. Don't add an unbudgeted path to `toReview`.
- Catalog entries use short field names (`t/n/x/s/i/v/mc/advd/p/c52/qa/ea`) because the catalog is chunk-stored under Upstash request-size limits — keep new fields short and update `toScreenerCandidates`.
- `advd` is average daily DOLLAR volume (price × 3-month share volume), matching what `screenUniverse` expects — don't store raw share volume.
- The catalog/ledger are advisory discovery data: money paths must never read them, and their absence must degrade to the seed watchlist LOUDLY (console.error), never silently.
- A data-gate NO_TRADE is still recorded in the research ledger — otherwise a permanently-gated name occupies an exploration slot forever.

Gotchas:
- Preserve the pipeline shape: cheap gates → AI → deterministic downgrades → **evaluator (downgrade-only, fail-closed, one revision max)** → sizing → human queue. Neither the risk engine nor the evaluator may ever upgrade an action or confidence.
- The circuit breaker is resolved ONCE per scan run (system-wide) before any agent; it restricts (halves/blocks), never authorizes. UNKNOWN tier (no valuation data) blocks BUYs on purpose.
- News/scan text must pass through `sanitizeEvidenceItems` + `fenceUntrusted` before reaching any prompt; the cache stores ORIGINAL text and sanitization runs on every use.
- Anything volatile (cash figures, per-run values) goes in the **user message**, never the cached `system` block — it kills the prompt cache for the rest of the run.
- Anthropic prompt-cache proof lives in Redis `pm:anthropic-usage:<YYYY-MM-DD>` via `lib/anthropic-usage.js`; check `cacheReadInputTokens` and `cacheCreationInputTokens` before claiming caching is working or changing prompt structure.
- Model JSON: check `stop_reason === "max_tokens"`; missing fields must FAIL the checks that read them (see the confidence-floor bug).
- New config keys: grep that code actually consumes them — `risk-limits.json` has historically accumulated dead keys.
- Per-ticker code runs inside a try/catch that writes `scan_error` rows — keep new steps inside it.

## Changing proposal approval / execution logic

> **Shared contract (Phase 1):** single-source in `contracts/` (canonical here), mirrored to `../portfolio-dashboard/lib/contracts/` by `npm run contracts:sync`; `tests/contracts-drift.test.ts` (dashboard) enforces byte-equality. Edit in `contracts/` only, then sync. Now shared: proposal enums/limits/ticker-rule/`validateProposalInput` (`contracts/proposal.js`); the **decision-signature payload + HMAC** (`contracts/signature.js` — all three sites below now delegate to it, so the payload composition is no longer hand-copied); strategy-lot ownership (`contracts/lot.js`). The full `AllocationProposal` **shape** is still declared as a TS interface in `proposals.ts` + built by hand in `redis.js` `createProposal`, but drift is now caught by `tests/proposal-shape.test.ts` (field-set parity vs `ProposalSchema`) — if you add/rename a field, update both and that test keeps them honest. The list below still applies to shape/status-flow logic.

Files (ALL THREE, always):
- `../portfolio-dashboard/lib/proposals.ts` — canonical schema, validation, decisions, `computeDecisionSignature`.
- `lib/redis.js` (this repo) — backend mirror (`createProposal`, `markProposalFulfilled`, expiry).
- `../portfolio-dashboard/scripts/mac-companion.mjs` — executor's raw JSON handling + mirrored signature function.
- Also: `lib/proposal-signature.js` (backend verify), `lib/mcp-accounting.js` (fill validation), `lib/proposal-sizing.js` (auto-queue sizing/dedupe), `EXECUTION-GUIDE.md` (manual path).

Gotchas:
- **Any field in the signature payload (id/status/agentId/ticker/side/amountDollars/maxPrice/decidedAt/decidedByUserId) is frozen at approval** — changing the payload composition invalidates every outstanding approved proposal and must update all three signature copies at once.
- Status flow: `Pending → ApprovedForBrokerReview | Rejected | Expired`, `executionState: "Executing"` in-flight, `fulfilledAt` terminal. Keep decisions one-way; keep ledger-write-before-fulfill; keep Executing-before-order.
- The companion does blind read-modify-write on the proposal JSON — don't add concurrent writers to the same fields.
- Write BOTH `fulfilledTradeId` and `fulfilledOrderId` (schema-drift bridge).

## Adding a dashboard page

Files: `../portfolio-dashboard/app/<page>/page.tsx`, nav in `components/Sidebar.tsx`, and if Clients may see it: `lib/client-access.ts` (fail-closed allowlist — a page not listed is manager-only by default).
Gotchas: dark "Portfolio OS" terminal theme (`app/globals.css`, `terminal-panel` classes, Sora + JetBrains Mono); handle the backend-offline state (styled error, not a crash); `npm run lint` runs `tsc --noEmit`.

## Adding or modifying dashboard API routes

Files: `../portfolio-dashboard/app/api/<route>/route.ts`.
Every handler starts with `requireApiPermission({ permission, action, request })` — no exceptions (the one route that skipped it became a finding). New audit actions must be added to the `AuditAction` union in `lib/audit.ts`. Rate-limit sensitive mutations via the existing action names in `lib/rate-limit.ts`. Routes proxying to the Jetson (`/api/scan`, `/api/alerts*`) must forward `Authorization: Bearer ${PORTFOLIO_WEBHOOK_SECRET}` — the backend fails closed. `tests/proxy-routes.test.ts` asserts proxy routes keep RBAC — extend it for new proxies.

## Changing RBAC permissions

Files: `../portfolio-dashboard/lib/rbac.ts` (Permission union + `ROLE_PERMISSIONS`), `lib/client-access.ts` (page-level), `tests/rbac.test.ts` + `tests/client-access.test.ts`.
Gotchas: FundManager = Clerk `publicMetadata.role` AND `FUND_MANAGER_EMAILS` (Vercel env) — both, always. Client additions are the dangerous direction; anything touching pooled data stays manager-only (INVARIANTS #4).

## Changing investor ledger / NAV behavior

Files: `lib/investor-ledger.js`, `scripts/record-contribution.js`, `scripts/process-withdrawal.js`, `jobs/holdings-sync.js` (NAV/unit computation), `../portfolio-dashboard/lib/investors.ts` + `lib/withdrawal-preview.ts` (read side).
Gotchas: append-only, HMAC-signed (INVARIANTS #5/#6); the seed-owner guard and stale-NAV rejection are load-bearing — never bypass them "temporarily". A post-ledger contribution uses the latest *prior-date* signed 4:30 PM ET snapshot, never a same-day/intraday fallback. `sourceInvocationId` and request ID are forwarded from the companion and must match the durable scheduler request before they are HMAC-bound beside the Performance row; scripts run manually AFTER money moves, never before.

## Changing Robinhood sync behavior

Files: `lib/robinhood-sync.py` (read-only positions/cash/fills), `lib/robinhood-scan.py`, `jobs/holdings-sync.js` (legacy full sync + `processFills`), `scripts/sync-holdings-from-mcp.js` + `lib/portfolio-snapshot.js` (MCP-driven sync), `lib/market-scan-sync.js` (direct robin_stocks scan pull).
Gotchas:
- Python stays read-only forever — no `rh.order_*`. The write path is MCP-only.
- `ROBINHOOD_ACCOUNT_NUMBER` pins the account; robin_stocks silently defaults to `is_default=true` otherwise (was a real wrong-account bug).
- Login volume is rationed deliberately (5 scheduled logins/day) — don't add sync frequency without reading the comment in `scheduler.js`.
- `processFills` must dedupe against Trade Ledger orderIds — both sync paths write the same ledger.
- 150s subprocess timeout exists for the device-approval flow — don't shorten it.

## Changing scheduler cadence

File: `scheduler.js`. Gotchas: research scan runs AFTER the exit monitor on purpose (SELLs queue first); weekly review (Fri 6:30 PM) runs AFTER ledger verify so the week's books are checked before being summarized; update the startup console summary string when times change. Market-dependent jobs pass `MARKET_DAY_ONLY` to `wrapJob` and skip full-day NYSE holidays via `lib/market-calendar.js` (computed, not a static list) — new market jobs must pass it too; verify-ledgers/weekly-review/system-sentinel deliberately run on holidays. The dashboard companion's `isMarketOpen()` still has NO holiday awareness (see RISK_REGISTER #2).

## Changing the weekly review / agent lessons

Files: `jobs/weekly-review.js` (orchestration + the one LLM call), `lib/weekly-scorecard.js` (pure scorecard math + lesson parsing), `lib/agent-memory.js` (`mergeWeeklyLessons`/`applyWeeklyLessons`), `lib/sheets.js` (`readAgentRecommendationOutcomes`).
Gotchas: lessons are `source: "weekly_review"` memories — they may only evict each other (cap 6), never Sam's chat/manual memories; the dashboard's `AgentMemorySource` union in `../portfolio-dashboard/lib/agentMemory.ts` must include any new source value; malformed lesson JSON yields ZERO lessons (fail closed), never partial garbage.

## Changing the system sentinel / sysloop

Files: `lib/sysloop/*` (pure checks — unit-test with fixtures in `tests/sysloop.test.js`), `jobs/system-sentinel.js` (Jetson Tier 0), `scripts/sysloop-{mac,triage,weekly,shared}.mjs` (Mac tiers). Design doc: `docs/SYSTEM-LOOP-PLAN.md`. Gotchas: sysloop Redis writes MUST stay inside `pm:sysloop:*` (enforced by `redisGuardSet` — don't bypass it); new checks go in `checks.js` as pure functions taking injected inputs, gathering goes in `snapshot.js`; the `claude -p` invocations in `sysloop-shared.mjs` must keep `--strict-mcp-config` and the read-only `--allowedTools` list; new expected Sheet headers come from `SYSLOOP_EXPECTED_HEADERS` in `sheets.js` (references the writer constants — never copy header strings). Deploy: backend to Jetson as usual, plus `pm2 restart portfolio-sysloop` on the Mac (runs from this repo's working tree).

## Adding tests

Backend: `tests/*.test.js`, node:test, `npm test`. Dashboard: `tests/*.test.ts`, `npm test` (tsx), plus `npm run lint` (= `tsc --noEmit`) and `npm run build`.
Pattern that works here: money math lives in pure functions (`lib/tax-lots.js`, `proposal-sizing.js`, `mcp-accounting.js`, `risk-engine.js`, `investor-ledger.js`) — put new logic in a pure lib, test it, then wire it into jobs. The mcp-accounting test fixture signs proposals with a test secret (`computeDecisionSignature`) — copy that pattern for anything touching approvals. See `docs/TEST_PLAN.md` for the missing-test priority list.

## Changing the Pitch Lab (paper conviction/metric attribution — inert, not scheduled)

Files: `lib/pitch-lab/` (`features.js` metric catalog, `pitch.js` record + validation, `pitch-prompt.js` model contract, `grading.js`, `analysis.js`, `stats.js`, `store.js`, `render-html.js`, `demo-data.js`), `scripts/pitch-lab.js` (`npm run pitch-lab`), `tests/pitch-lab.test.js`. Design + report contract: `docs/PITCH-LAB.md`.
Gotchas: never change a feature's definition in place (new id instead) and never edit stored pitches/outcomes (append-only); a change to entry/exit/cost rules bumps `GRADING_VERSION`, a report shape change bumps `REPORT_SCHEMA_VERSION` (the website reads it). Paper only — must never import `lib/redis.js`, `createProposal`, or anything under the execution path.

## Changing peer-relative scoring (Mandate v2 — Phase A, inert)

The v2 mandates score every metric by percentile rank within the candidate's industry
peer set (not the daily slate — that's `lib/quant-scorer.js`). Full plan +
status: `docs/MANDATE-V2-INGESTION.md`.

Files: `lib/peer-scoring.js` (pure peer/absolute primitives), `lib/peer-resolve.js`
(peer-set widening + 8/6 tier selection), `lib/absolute-rules.js` (fail-closed
declarative rule evaluator), `lib/mandate-score.js` (inert aggregate result),
`config/scoring/mandate-v2.js` (per-agent category/point maps + id map),
`config/scoring/absolute-thresholds.js` (executable Agent 1/2/3 + special-sector §5 tables),
`lib/peer-source.js` (`PeerSource` interface + `YahooIndustryPeerSource`;
`buildIndustryDistributions`), `lib/mandate-metrics.js` (`extractMetricVector` — Yahoo
`raw` → metric vector), `jobs/peer-distributions.js` (`npm run peer:dist`), the
`PEER_METRICS_ENABLED` hook in `jobs/universe-refresh.js`, Redis `pm:peer-metrics:*` /
`pm:peer-dist:*` helpers in `lib/redis.js`. Tests: `tests/peer-scoring.test.js`,
`tests/peer-resolve.test.js`, `tests/absolute-rules.test.js`,
`tests/mandate-score.test.js`, `tests/mandate-metrics.test.js`.

Gotchas:
- Two off-by-default flags gate this end to end: `PEER_METRICS_ENABLED` (accumulate
  per-name vectors nightly) then a future `PEER_SCORING` (make the engine live). Nothing
  on the scan/money path imports these modules yet — keep it that way until Phase A is
  verified on real distributions.
- Deterministic code computes the percentiles; the analyst LLM must never rank peers
  (invariant #4). It consumes sub-scores and may only downgrade.
- Missing metric ⇒ vendor-lag rescale (excluded from numerator AND denominator), never
  scored zero. Thin peer set (<~7 comps) ⇒ reported for absolute fallback, not guessed.
- `extractMetricVector` only reads Yahoo fields already fetched by
  `FUNDAMENTALS_MODULES`; 5 metrics are deliberately `null` pending new modules — add
  them by verifying yahoo-finance2 v3 field shapes first, never by guessing names.
- Peer distributions are advisory discovery data (like the universe catalog): money
  paths never read them, and `pm:peer-*` keys stay out of any signed/ledger path.

## Making the mandate score drive proposal sizing (flag-gated, default off)

The wire between the deterministic conviction score and the proposal pipeline. Files:
`lib/mandate-proposal-clamp.js` (`applyMandateScoreClamp`, `mandateGateSummary`), built
on the already-complete `lib/mandate-policy.js` (`evaluateMandateSizing` → tier
resolution, macro tier cap, position/sector/cash ceilings) over the canonical tables in
`config/agents/mandate-policy.js`. Tests: `tests/mandate-proposal-clamp.test.js`.
Flag: `MANDATE_SCORE_GATES_PROPOSALS=1` (default off).

Gotchas:
- DOWNGRADE-ONLY. `jobs/research-scan.js` requires that nothing in the proposal pipeline
  ever upgrades an action. A tier is a CEILING: a 3% request under tier 1 (10–15%) stays
  3%. Never "fill the band" — that would be an upgrade.
- NEVER GATE A SELL. Entry tiers are entry economics. If thin score coverage could block
  an exit, degraded data would make positions unsellable — strictly more dangerous than
  declining to size an entry. Mirrors the Agent 4 asymmetry rule. Only BUY is gated.
- FAIL CLOSED once enabled: missing/invalid/stale/identity-mismatched score ⇒ HOLD. A BUY
  must never proceed because the score could not be read.
- The Redis latest-view cache row (`cacheView` in `jobs/mandate-scoring.js`) is NOT a
  valid `scoreObservation` — it omits the identity fields (`mandateId`, `mandateVersion`,
  `observedAt`) that `evaluateMandateScore` validates. Read the durable Postgres
  observation instead.
- Per-agent floors differ: agent-1/2 `minimumEntryScore` 45, agent-3 65 with no
  speculative tier. Do not assume one threshold across agents.

## Changing consensus-estimate ingestion (Mandate v3 Category A/B — LIVE)

Supplies the two metrics the `maxAvailable >= 80` actionability bar in
`lib/mandate-score.js` cannot be reached without: `revBeat` (Category A) and
`estimateRevisions` (Category B) — 22 points for Agent 1, 22 for Agent 2. Files:
`lib/consensus-snapshot.js` (pure extraction, derivations, and the point-in-time
`selectRevenueBeatPair`), `fetchConsensusTrend()` (`lib/yahoo.js`),
`lib/pg/consensus-snapshots.js` (durable store), `db/migrations/0009_consensus_snapshots.sql`,
collection in `jobs/universe-refresh.js` (broad nightly batch) + `jobs/peer-coverage-refresh.js` (requested cohorts), consumption in `jobs/mandate-scoring.js`
(`buildConsensusBundles` → `scoreCohortForAgent`). Tests:
`tests/consensus-snapshot.test.js`, `tests/consensus-beat-pairing.test.js`,
`tests/consensus-snapshot-store.test.js`, `tests/consensus-wiring.test.js`.

Gotchas:
- **Collection is the whole game.** `estimateRevisions` is a change between instants this
  system observed, so it does not exist until history has accumulated: every collection
  pass that is skipped is a permanently missing data point that cannot be backfilled.
  `revBeat` binds on the first pass; `estimateRevisions` needs ≥3 snapshots spanning ≥30
  days, so expect it to stay `missing` for roughly a month after first deploy. That is
  correct behavior, not a bug.
- Snapshots live in **Postgres, not Redis**. Redis peer metrics are a TTL cache, and an
  expiry there would silently reset the revision window and read as "no signal" —
  indistinguishable from a genuinely flat consensus. New research tables must also be
  added to `RESTORE_TABLES` in `lib/pg/restore-drill.js` or the backup-coverage drill
  fails closed (it does this on purpose — do not weaken the check to make it pass).
- The store's identity hash covers ticker + period + retrieval instant and deliberately
  **excludes the estimate values**. Hashing values would let a re-run of the same pass
  insert a second row whenever an estimate happened to tick, inflating the snapshot count
  that gates activation.
- Pairing an actual to a pre-report consensus is `selectRevenueBeatPair`, not caller
  discretion. It requires `retrievedAt < filed` and takes the LATEST qualifying snapshot.
  This needs each quarter's FILING date, which is why `_revenueQuarterSeries` (end/val/filed)
  is carried in the EDGAR derived bundle — the scalar `_asOf` cannot express it.
- Collection rides BOTH enrichment jobs, and it has to. `peer-coverage-refresh` only walks
  requested cohorts; `universe-refresh` handles the broad nightly batch. Wiring only one
  leaves most of the scored universe holding peer metrics with no consensus behind them.
  If you add a third place that writes `peerMetricsRow`, it needs consensus collection too.
- In both jobs it is a SEPARATE try/catch from the peer-metrics fetch: a consensus outage
  must never cost a ticker its peer row, which the whole peer-relative substrate needs.
- `earningsTrend` is fetched by a DEDICATED `fetchConsensusTrend()`, deliberately NOT
  folded into `FUNDAMENTALS_MODULES`. Yahoo would accept it in the same request for free,
  and that is precisely the trap: this client keeps provider schema validation failing
  closed, and validation throws for the WHOLE call. One schema drift in `earningsTrend`
  on the shared list would take out price, fundamentals and technicals for every ticker.
  Losing consensus must degrade `revBeat`/`estimateRevisions` to `missing` (rescaled out),
  never break the scan. Do not "optimize" it back into the shared module list.
- Field shapes are verified against the installed yahoo-finance2 v3 `EarningsTrendTrend`
  interface. Verify against the package's own `.d.ts` before adding fields — do not guess
  v3 shapes from v2 memory.
- Two DIFFERENT revision histories exist and must not be merged: Yahoo's vendor-asserted
  trailing fields (`epsTrend.30daysAgo`, `epsRevisions.upLast30days`) are available from a
  single snapshot; locally-observed history requires ≥3 stored snapshots spanning ≥30 days.
  ADR 0003 prefers locally-observed. Which may SCORE is open (Q-002/Q-004) — the extractor
  keeps both so that decision stays reversible without re-collecting data.
- `revBeat` compares an EDGAR actual against a consensus snapshot that **pre-dates the
  filing**. Differencing against a post-report snapshot is leakage.
- Derived percentages are rounded (6dp) at the derivation boundary so float dust cannot
  surface later as a phantom score change in `lib/score-delta.js`.
- A row with neither an EPS nor a revenue estimate returns null rather than storing an
  empty row that would inflate apparent coverage.

## Changing 13F / institutional-ownership ingestion (Mandate v3 Category D)

- Pure derivation of the named rule inputs: `lib/thirteen-f.js`.
- Quarterly SEC data-set parse + aggregate: `lib/thirteen-f-dataset.js` (pure, text in).
- ticker→CUSIP resolution: `lib/cusip-map.js` (OpenFIGI, cached indefinitely).
- Share-count denominator concept: `CONCEPTS.sharesOutstanding` in `lib/edgar-facts.js`.
- Binding: `assembleMandateInputs({ thirteenF })` in `lib/mandate-evidence.js`.
- Decisions + rationale: `docs/RESEARCH-DECISION-REGISTER.md` Q-004 (resolved 2026-08-02).

**GOTCHAS**

- **This is a per-QUARTER ingest of one file, not a per-ticker fetch.** Institutional
  ownership is a sum across every holder, so no per-name filing answers it. Do not
  "optimize" it into a per-ticker call — that shape does not exist.
- **`ownershipChangePoints` and the `thirteenF` `*ChangePct` fields are different
  quantities** (percentage points of shares outstanding vs percent change in shares
  held). Collapsing them puts routine quarters in the top band.
- **The share count must be date-matched to the holdings period end.** Borrowing a
  neighbouring quarter's count makes a buyback read as institutional accumulation.
  `sharesOutstandingAt` enforces a ±10-day tolerance and yields null otherwise.
- **Usability keys off dataset publication, not the 45-day due date.** The SEC runs
  these after the Feb/May/Aug/Nov month-ends, so a quarter is routinely past due before
  it is readable.
- Amended filings (13F-HR/A) must supersede the original or positions double-count;
  `resolveLatestSubmissions` handles this. Options rows (`PUTCALL`) and principal
  amounts (`SSHPRNAMTTYPE != "SH"`) are not share ownership.
- **`lib/thirteen-f-dataset.js` has never been run against a real download** — sec.gov
  is unreachable from the sandbox it was written in. The header parse fails closed on an
  unexpected shape; verify against a real quarterly ZIP before trusting it.

## Changing Agent 3 long-horizon evidence (Mandate v3, Agent Three)

- Derivation: `lib/agent3-history.js`. TTM window primitives: `ttmWindows`,
  `ttmWindowMeans`, `alignWindows`, `windowGrowthSeries` in `lib/edgar-metrics.js`.
- Binding: `assembleMandateInputs({ agentId: "agent-3", companyfacts | history })`.
- Eligibility gate (3+ years public): `screenAgentThree` in `lib/mandate-catalog-screen.js`,
  reading the catalog's `ftd` field populated by `applyQuotes` in `lib/universe.js`.
- Decisions + rationale: `docs/RESEARCH-DECISION-REGISTER.md` Q-008.

**GOTCHAS**

- **Windows are NON-OVERLAPPING at 4-quarter strides.** Do not switch to 1-quarter
  strides for "more data": adjacent windows would share three of four quarters, so one
  bad quarter contaminates four comparisons and `maxAnnualGrowthSpreadPoints` reads far
  smoother than reality.
- **`cagrFromSeries` is not reusable for windows.** It searches for a point at-or-before
  `end - years`, and four windows span almost exactly three years, so the oldest lands a
  fraction of a day past the target and the result is null on nearly every company. Use
  `windowCagr`.
- Agent 1/2's short-window scalars are **never** substituted for Agent 3's multi-year
  inputs. Fewer than 4 windows means the metric reports missing and rescales out.
- The 3-years-public gate is looser than the data requirement (~4 years of filings), so
  a name can pass the screen and still score partial. That is intended.
- Adding a required candidate fact to a screen breaks every fixture that predates it —
  `firstTradeDate` was one, and an absent value fails closed, so a catalog refresh must
  land before Agent 3 will screen anything.

## Changing EDGAR/XBRL fundamentals ingestion (Mandate v2.1, inert)

The mandated primary fundamentals source (free). Files: `lib/edgar.js` (I/O — CIK
lookup + `fetchCompanyFacts`, SEC User-Agent, `EDGAR_RATE_MS` pacing), `lib/edgar-facts.js`
(pure XBRL parser — concept fallback chains in `CONCEPTS`, quarterly/annual/instant
series, duration-based quarter isolation, dedup-by-period), `lib/edgar-metrics.js` (pure
derivations → `deriveFundamentalMetrics` / `edgarMetricSubset`), consumed by
`lib/mandate-metrics.js` `extractMetricVector(fundamentals, companyfacts?)`. Enabled by
`PEER_METRICS_EDGAR` in `jobs/universe-refresh.js`. Tests: `tests/edgar.test.js`.

Gotchas:
- A 10-Q reports BOTH the 3-month quarter and the 6-/9-month year-to-date for the same
  concept; `quarterlySeries` keeps only ~90-day-duration facts. Don't remove that filter.
- Revenue/cost/equity concepts vary by filer — extend the `CONCEPTS` chains, don't
  hardcode one tag. Instant (balance-sheet) facts have no `start`.
- Missing concepts/periods return null/empty and flow to the engine's vendor-lag rescale
  — never fabricate. Keep SEC calls paced (`EDGAR_RATE_MS`) and the User-Agent descriptive.
- `edgarMetricSubset` uses first-cut YoY defaults shared across agents; the per-agent
  definitions (accel / YoY / multi-year) are in `_derived` and bind via config later.

## Onboarding a specialist mandate (agent-2 / agent-3)

Turning an incoming friend-authored personality into a live specialist. **Order matters — do not skip to activation.**

Agent 1 has since moved off the flat `personality.md` described below onto a split `master.md` + `buy-playbook.md` layout — see `config/agents/MANDATE-SPLIT-PILOT.md` for why and exactly how, and to repeat it for agent-2/agent-3 later. This section still describes the flat pattern agent-2/agent-3 use today.

Files: `config/agents/agent-N/personality.md` (the compact mandate the runtime loads every scan — `jobs/research-scan.js` reads it, `lib/ai-overlay.js` puts it in the cached system block, `lib/evaluator.js` grades "mandate fit" against it), `config/agents/agent-N/AGENT-<NAME>-PLAN.md` (full versioned spec — copy `config/agents/_TEMPLATE-STRATEGY-SPEC.md`), `config/agents/agent-N/universe.json` (`source`, `slateSize`, `aiReviewBudget`, `researchCooldownDays`, `explorationSlots`), `config/agents/agent-N/weights.json` (quant weights, must sum to 1.0), `config/agents/agent-N/risk-limits.json`, `config/agents.js` (registry: `name`, `executionEligibility`).

Steps:
1. Fill `AGENT-<NAME>-PLAN.md` from the template, then write the compact `personality.md` to match it. The compact file is what the model sees — if the two disagree, the model follows the compact one.
2. Tune `weights.json` (sum to 1.0) and `risk-limits.json` to the mandate. Grep that any new risk-limit key is actually consumed by `lib/risk-engine.js` — this file accretes dead keys.
3. Set the agent's `name` in `config/agents.js`. **Leave `executionEligibility: "paper"`** — 2/3 stay propose-only until their mandate + ownership tests pass (roadmap Phase 1 gate).
4. Universe: keep `source: "watchlist"` unless you also add a mandate-specific catalog screen. Catalog mode is driven by `lib/candidate-slate.js` + a philosophy screen; agent-1's is `screenUniverse` in `lib/universe.js`/`jobs/research-scan.js`. Without an equivalent, `source: "catalog"` screens nothing coherent. Flipping to catalog is its own change — see "Changing universe discovery".
5. Add mandate tests before activation: the evaluator must reject an out-of-universe or missing-kill-criteria proposal for this agent (pattern in existing `tests/`), and ownership must hold (`tests/ownership-enforcement.test.js`, `tests/owned-lots.test.js`).

Gotchas:
- Agents share ONE real portfolio; risk limits check the shared position/sector sizes, so a new agent can block/downgrade another's proposals. Set `maxSectorPct`/`maxPositionPct` with that overlap in mind.
- Empty `personality.md` = the model runs against "general prudence" (evaluator says so explicitly). An empty file is a silent no-mandate, not a safe default — don't half-activate.
- `aiReviewBudget` is the Anthropic spend guardrail (holdings exempt). Adding a live agent adds cost; confirm the per-day budget across all agents is acceptable.

## Onboarding / changing the Kairos (Agent 4) allocation policy (portfolio manager)

Kairos (machine ID `agent-4`) is the shadow portfolio manager, NOT a specialist — no `config/agents/agent-4/` dir, not in `AGENTS`. It reviews an immutable specialist `StrategyProposal` and may only ACCEPT/REJECT it; it can never originate a trade, mutate a proposal, or authorize an unowned SELL.

Files: `contracts/portfolio-decision.js` (canonical — `AllocationPolicySchema`, `StrategyBudgetSchema`, `AllocationSnapshotSchema`, `PortfolioRiskSnapshotSchema`, reason codes; mirrored to the dashboard via `npm run contracts:sync`), Redis keys `pm:allocation-policy:active` / `pm:allocation-policy:<version>` / `pm:allocation-snapshot:*` / `pm:portfolio-risk-snapshot:*` / `pm:portfolio-decision:*` (`PORTFOLIO_SHADOW_KEYS`), plus the dashboard's Kairos shadow control room. Tests: `tests/portfolio-manager-shadow.test.js`, `tests/ownership-enforcement.test.js`.

Steps:
1. Convert Kairos's personality into a versioned `AllocationPolicy` object: `mode: "SHADOW"` (do not change), `version`, and every hard bound (`maxSingleProposalDollars`, `maxStrategyAllocationPct`, `maxTickerExposurePct`, `minCashReservePct`, `maxGrossExposurePct`, `maxBudgetChangePct`, `evidenceWindowDays`, snapshot-age caps, `minEvaluatedProposals`, `minFilledTrades`). The schema validates numeric ranges only — it does not choose a policy; the numbers are the mandate.
2. Keep Kairos in **shadow mode with Sam as final approver**. No live approval authority until the policy passes shadow-mode evidence (roadmap Phase 2/3 gate). There is deliberately no order-authorization or approval-signature field in these contracts.
3. Any contract shape change: edit `contracts/portfolio-decision.js`, run `npm run contracts:sync`, commit both repos together (drift-tested).

Gotchas:
- `AllocationSnapshot.budgets` must contain exactly one `StrategyBudget` per specialist in `AGENT_IDS` (currently agent-1/2/3) — adding/removing a specialist changes this invariant and its test.
- Reason codes are an enum (`PORTFOLIO_DECISION_REASON_CODES`); a new rejection cause needs a new code in the canonical file + sync, not a free-text string.

## Cross-repo schema-change checklist (run every time)

1. `grep -rn "<field-or-key>" lib/ jobs/ scripts/` in BOTH repos + `scripts/mac-companion.mjs`.
2. Update `lib/proposals.ts` ↔ `lib/redis.js` ↔ `mac-companion.mjs` together (proposals), or `sheets.js` ↔ `sheets.ts` together (tabs).
3. Update the three signature copies together if the payload changed.
4. Run both test suites; run `npm run build` on the dashboard.
5. Deploy order for breaking Redis-schema changes: writer first only if readers tolerate the new field; otherwise readers first.

## Changing financial shadow parity

Exact transactional parity lives in `lib/pg/inventory.js` and
`lib/pg/parity-runner.js`. It covers proposal lifecycle, capital entries/units,
strategy-owned lots, position shares/cost, and the latest total-value/cash/units
accounting snapshot. `jobs/holdings-sync.js`, the MCP recovery writer
`lib/portfolio-snapshot.js`, and `scripts/refresh-shadow-positions.js` mirror
the accounting snapshot through `shadowWriteNavSnapshot`; the latter runs
before the nightly parity job. Quote-
derived market value is a separate classification in `lib/pg/parity.js` and may
only exact-match when both stores carry the same quote snapshot/source/time.

Gotchas:
- Never put `marketValue` back into `POSITION_TRANSACTIONAL_INVENTORY`.
- A missing Postgres accounting snapshot is a read failure, not an empty match.
- Keep Sheets authoritative until the full 30-day cutover gate passes; shadow
  write failures remain non-blocking on the write path and loud in parity.
