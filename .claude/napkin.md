# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-07-14] Capital events require unitized, daily NAV controls**
   Do instead: run money-math tests after contribution, withdrawal, NAV, unit, investor-ID, or ledger-signing changes; derive breaker high-water from the final signed row per date so a cash-before-unit transition cannot create a false drawdown.
2. **[2026-07-17] Scheduled Robinhood MCP reads belong to the always-on Jetson**
   Do instead: keep PM2 `portfolio-broker-reader` at `COMPANION_ROLE=read-worker` and Mac `portfolio-executor` at `COMPANION_ROLE=execution`; verify the separate reader heartbeat and both account-bound receipts, and never restore the legacy Python/TOTP path as an unattended workaround.
3. **[2026-07-12] Holdings status rows are not positions**
   Do instead: keep every Holdings reader/parity projection filtering `Last synced`, `Synced via Robinhood Agentic MCP`, cash, and sample-marker rows; regression-test any new marker format.
4. **[2026-07-13] Research outcomes require decision-time facts**
   Do instead: classify outcomes from structured scan facts and persist versioned aggregates; treat legacy Sheet/Redis rows as non-classifiable instead of parsing rationale text.
5. **[2026-07-13] Observation days need clean parity and sentinel state**
   Do instead: count a Phase 0 day only after the scheduled jobs complete with no active P1s and live Sheets/Postgres parity is `MATCH`; local commits and basic `/health` cannot substitute for that evidence.
6. **[2026-10-12] NAV refresh idempotency is relative to the latest same-date row**
   Do instead: compare a refreshed NAV snapshot only with the newest row for that snapshot date; an older identical row must not suppress re-appending a correction after an intervening value.
7. **[2026-07-13] API-key presence is not research availability**
   Do instead: reconcile attempted reviews to explicit successes, blocks, and failures and inspect current provider errors; never treat a green key-presence `/health` check or a completed job wrapper as proof the model calls worked.
8. **[2026-07-14] Position accounting parity excludes quote-derived market value**
   Do instead: digest ticker/name/shares/average cost/cost basis at schema precision; report valuation separately and compare it exactly only with the same versioned quote snapshot, source, and source timestamp.
9. **[2026-07-14] Scheduled diagnostics must propagate negative verdicts**
   Do instead: when a report-only job returns `false` for detected problems, make its scheduler adapter throw so `pm:job:<name>:last-run` records `ok:false` instead of a false green.
10. **[2026-08-02] Lot shares need eight decimal places in the Neon shadow**
    Do instead: preserve `shares_original` and `shares_open` as `NUMERIC(18,8)` and include sub-four-decimal residual lots in migration/restore tests; four-decimal storage silently turns valid fractional inventory into a parity divergence.

## Operational Safety
1. **[2026-07-26] PM2 diagnostics can leak process environments**
   Do instead: never run raw `pm2 jlist`, `pm2 describe`, or print PM2 process environments into a task transcript. Extract and emit only the status, cwd, role, uptime, and restart fields needed for verification; rotate any dedicated secret immediately if an accidental private-transcript disclosure occurs.
2. **[2026-08-01] Mac fulfillment can bypass the Neon shadow**
   Do instead: route every broker-confirmed lot/proposal mutation through the Jetson-owned financial write path, or persist a retryable outbox that the Jetson drains; do not rely on a Mac-local `PG_DUAL_WRITE` setting for financial parity.

## Domain Behavior Guardrails
1. **[2026-07-11] Unattributed lots are quarantined until explicitly resolved**
   Do instead: require a signed, auditable assignment or manual/reconciled exit policy before a strategy may consume a legacy `unattributed` lot; never silently use it as ownership top-up.
2. **[2026-07-11] Strategy ownership governs exits**
   Do instead: record the originating agent on every BUY lot; permit a SELL proposal only from that agent, while Agent 4 may accept/reject the exact proposal but cannot create or force an exit.
3. **[2026-07-11] Agent 4 is a bounded portfolio manager**
   Do instead: use versioned, explainable performance/holding/macro inputs with hard allocation limits; keep Agent 4 unable to originate or mutate trades until its shadow evidence earns promotion.
4. **[2026-06-18] Backend is read-only with Robinhood**
   Do instead: keep `robinhood-sync.py` limited to holdings/cash reads and search for `rh.order_` before Robinhood-related changes.
5. **[2026-06-18] Contributions record confirmed transfers only**
   Do instead: keep `record-contribution.js` as accounting for money already received/sent, never as a money-movement command.
6. **[2026-06-29] Pending proposals are competing alternatives**
   Do instead: let all agents create pending proposals against the shared cash pool; only accepted, unfilled BUY proposals reserve cash.
7. **[2026-06-29] Backend reads durable agent memories**
   Do instead: pull global `pm:agent-memory:<agentId>:global` memories into `research-scan.js` so proposal generation reflects Sam's durable feedback.
8. **[2026-07-15] Read formatted Sheet money cells as unformatted numbers**
   Do instead: set `valueRenderOption: "UNFORMATTED_VALUE"` for Holdings cash, market-value, price, cost, shares, and return readers; a currency string such as `$85.00` becomes `NaN` under `Number()` and can silently fail closed to zero.
9. **[2026-07-15] Athena is richer than its Portfolio Manager adapter**
   Do instead: treat Athena as a separate research platform and inspect its current full-case contract before integration changes; preserve Portfolio Manager's mandate/execution authority and do not infer Athena capability from the six-section, 500-character evidence adapter.

## User Directives
1. **[2026-10-12] Phones are for decisions, failures, and Pitch Lab learning**
   Do instead: send immediate human-readable approval requests plus daily/weekly Pitch Lab digests; retain routine Phase 0 and repeated database diagnostics internally unless action is required.
2. **[2026-10-12] Agents 2 and 3 stay research-frozen**
   Do instead: run and fund Agent 1 only while Pitch Lab is the focus; do not spend model budget on frozen agents unless Sam explicitly reactivates them.
