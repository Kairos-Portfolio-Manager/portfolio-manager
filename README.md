# Portfolio Manager

An AI research desk for a real brokerage account. Three agents scan the market every trading day, build a thesis on individual names, and queue a proposal — buy, sell, or hold, with sizing, a written rationale, and a kill criterion. A human approves or rejects every proposal before anything reaches the broker. The system can read the account at any time; it can never place an order on its own.

Companion repo: [portfolio-dashboard](https://github.com/Kairos-Portfolio-Manager/portfolio-dashboard) — the approval UI and execution worker.

## Why it's built this way

Most "AI trading bot" projects skip the hard part: making the AI's mistakes cheap. This one is designed around the assumption that the model will sometimes be wrong, and that the cost of being wrong should be bounded by process, not by hoping the model is right.

- **No autonomous execution.** The Python broker client is read-only by contract — `grep rh.order_` is required to return nothing, and a test enforces it. Every trade is a human click.
- **Signed approvals.** Accepting a proposal produces an HMAC signature over the trade's exact fields. The execution worker refuses to act on anything unsigned or altered.
- **Execution is crash-safe.** An `Executing` marker is written before the order goes out, the ledger entry is written before the order is confirmed filled, and a restart mid-trade reconciles against the broker's own order history instead of blindly retrying — so a crash can't double-fill or silently drop a trade.
- **Append-only audit trail.** Every ledger row is signed and the table structurally forbids `UPDATE`/`DELETE` — corrections are new rows, not edits.
- **Deterministic risk engine runs after the model, not instead of it.** The AI proposes; a separate, non-AI risk engine can only downgrade a proposal toward HOLD — never upgrade it — based on hard checks (stale data, confidence floor, position caps, sector exposure).

## What the research loop actually does

Each weekday, three agents independently:

1. Pull a daily candidate slate — current holdings, market movers, and a rotating slice of the broader market — screened against each agent's investment philosophy.
2. Gather fundamentals, SEC filings, macro data, and news for each candidate.
3. Score everything on a 9-metric quantitative model, then hand it to a Claude-based analyst for a qualitative read: thesis, risks, target position size, and the specific condition that would prove the thesis wrong.
4. Run the result through the deterministic risk engine.
5. Size the position against actual idle cash and existing exposure, then queue it.

A human reviews the queue in the dashboard, with the full reasoning trail attached, and approves or rejects.

## Architecture

```
Backend (Node, Jetson/PM2)             Dashboard (Next.js, Vercel)
  scheduler.js — cron jobs               /approvals — human review queue
  jobs/research-scan.js — the loop       /holdings, /history, /research
  lib/ai-overlay.js — Claude analyst     Clerk auth
  lib/risk-engine.js — deterministic          │
  lib/quant-scorer.js — factor model          ▼
       │                              Execution worker (Mac, PM2)
       ▼                                — polls approved proposals
  Google Sheets (system of record)      — places the order via Robinhood
  Upstash Redis (proposal queue,        — writes the signed ledger entry
                 audit log, agent memory)
```

## Stack

Node.js (ESM), Anthropic Claude, Google Sheets API, Upstash Redis, Yahoo Finance / SEC EDGAR / FRED / Tavily for research data, Robinhood (read-only market data + human-approved order placement).
