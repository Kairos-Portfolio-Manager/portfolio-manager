// Dual-write shadow layer (ADR 0001, migration step 2). While Sheets/Redis stay
// authoritative, these mirror money objects into Postgres so we can compare the
// two for 30 days before cutting canonical reads over.
//
// Two hard invariants:
//   1. OFF by default. Nothing writes to Postgres unless PG_DUAL_WRITE=true AND
//      DATABASE_URL is set. A machine without the flag behaves exactly as today.
//   2. A shadow write must NEVER throw into the money path. The authoritative
//      Sheets/Redis write is the source of truth; a Postgres hiccup logs and is
//      swallowed. (Parity checking, not the write, is what surfaces divergence.)
//
// Each object is validated against its shared contract before insert, so a
// malformed shadow row fails here (logged) instead of silently diverging. Inserts
// are idempotent (ON CONFLICT DO NOTHING) so a replay never double-writes.

import { getPool, pgConfigured } from "./client.js";
import { ProposalSchema } from "../../contracts/proposal.js";
import { StrategyLotSchema } from "../../contracts/lot.js";
import { InvestorLedgerEntrySchema, NavSnapshotSchema, PositionSchema } from "../../contracts/accounting.js";

export function dualWriteEnabled() {
  return pgConfigured() && process.env.PG_DUAL_WRITE?.trim() === "true";
}

// Wraps a shadow write: no-op when disabled, never throws, logs on failure.
export async function runShadowOperation(label, fn, options = {}) {
  const enabled = options.enabled ?? dualWriteEnabled();
  if (!enabled) return { ok: false, skipped: true };
  try {
    const pool = options.pool ?? getPool();
    if (!pool) throw new Error("Postgres pool is unavailable.");
    await fn(pool);
    return { ok: true };
  } catch (err) {
    console.error(`[pg dual-write] ${label} shadow write failed (authoritative write unaffected): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Bridge legacy Redis proposal rows to the canonical shape for the shadow copy.
// Old rows (created before these fields existed) carry `fulfilledTradeId` and
// lack `fulfilledOrderId`/`fulfilledShares`/`decisionHmac` — the exact
// cross-repo drift the contracts package exists to end. We normalize at the
// migration boundary (map tradeId->orderId, absent nullable fields -> null) so
// the canonical ProposalSchema stays strict rather than loosened to fit history.
function normalizeLegacyProposal(p) {
  return {
    ...p,
    fulfilledOrderId: p.fulfilledOrderId ?? p.fulfilledTradeId ?? null,
    fulfilledShares: p.fulfilledShares ?? null,
    decisionHmac: p.decisionHmac ?? null,
    decidedAt: p.decidedAt ?? null,
    decidedByUserId: p.decidedByUserId ?? null,
    decisionNote: p.decisionNote ?? null,
    createdByEmail: p.createdByEmail ?? null,
    fulfilledAt: p.fulfilledAt ?? null,
    // Legacy terminal (Rejected/Expired) rows predate expiresAt; it's meaningless
    // for a decided proposal, and the column is NOT NULL, so fall back to its last
    // timestamp for the shadow copy.
    expiresAt: p.expiresAt ?? p.updatedAt ?? p.createdAt,
  };
}

export async function shadowWriteProposal(proposal) {
  return runShadowOperation("proposal", async (pool) => {
    const p = ProposalSchema.parse(normalizeLegacyProposal(proposal));
    await pool.query(
      `INSERT INTO proposals
         (id, agent_id, ticker, side, amount_dollars, max_price, rationale, risk_summary,
          status, thesis, kill_criteria, horizon_days, created_by_user_id, created_by_email,
          decided_at, decided_by_user_id, decision_note, decision_hmac,
          fulfilled_at, fulfilled_order_id, fulfilled_shares, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         ticker = EXCLUDED.ticker,
         side = EXCLUDED.side,
         amount_dollars = EXCLUDED.amount_dollars,
         max_price = EXCLUDED.max_price,
         rationale = EXCLUDED.rationale,
         risk_summary = EXCLUDED.risk_summary,
         status = EXCLUDED.status,
         decided_at = EXCLUDED.decided_at,
         decided_by_user_id = EXCLUDED.decided_by_user_id,
         decision_note = EXCLUDED.decision_note,
         decision_hmac = EXCLUDED.decision_hmac,
         fulfilled_at = EXCLUDED.fulfilled_at,
         fulfilled_order_id = EXCLUDED.fulfilled_order_id,
         fulfilled_shares = EXCLUDED.fulfilled_shares,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at`,
      [
        p.id, p.agentId, p.ticker, p.side, p.amountDollars, p.maxPrice, p.rationale, p.riskSummary,
        p.status, null, null, null, p.createdByUserId, p.createdByEmail,
        p.decidedAt, p.decidedByUserId, p.decisionNote, p.decisionHmac,
        p.fulfilledAt, p.fulfilledOrderId, p.fulfilledShares, p.createdAt, p.updatedAt, p.expiresAt,
      ]
    );
  });
}

export async function shadowWriteLot(lot) {
  return runShadowOperation("lot", async (pool) => {
    const l = StrategyLotSchema.parse(lot);
    const owner = l.agentId === "unattributed" ? null : l.agentId;
    await pool.query(
      `INSERT INTO lots
         (lot_id, ticker, owner_agent_id, open_date, cost_per_share, shares_original, shares_open, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (lot_id) DO UPDATE SET
         shares_open = EXCLUDED.shares_open,
         status = EXCLUDED.status`,
      [l.lotId, l.ticker, owner, l.openDate, l.costPerShare, l.sharesOriginal, l.sharesOpen, l.status]
    );
  });
}

export async function shadowWriteCapitalEntry(entry) {
  return runShadowOperation("capital_entry", async (pool) => {
    // Sheets has a legacy zero-dollar "Correction" row type. It is not a new
    // money event, but the shadow schema intentionally keeps the smaller
    // contribution/withdrawal contract; represent that historical no-op as a
    // zero contribution so it remains visible and parity-safe.
    const legacyType = String(entry?.type ?? "").trim().toLowerCase();
    const normalized = legacyType
      ? { ...entry, type: legacyType === "correction" ? "contribution" : legacyType }
      : entry;
    const e = InvestorLedgerEntrySchema.parse(normalized);
    // Investor must exist first (shadow only; FK is nullable-safe via upsert).
    await pool.query(
      `INSERT INTO investors (investor_id, email, name) VALUES ($1,$2,$3)
       ON CONFLICT (investor_id) DO NOTHING`,
      [e.investorId, e.email, e.name]
    );
    await pool.query(
      `INSERT INTO capital_entries
         (entry_id, investor_id, entry_date, type, amount, nav_per_unit, units, row_hmac)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (entry_id) DO NOTHING`,
      [e.entryId, e.investorId, e.date, e.type, e.amount, e.navPerUnit, e.units, e.rowHmac]
    );
  });
}

/** Mirror a point-in-time NAV/cash/units snapshot after the signed Sheet append. */
export async function shadowWriteNavSnapshot(snapshot, options) {
  return runShadowOperation("nav_snapshot", async (pool) => {
    const value = NavSnapshotSchema.parse(snapshot);
    await pool.query(
      `WITH locked AS (
         SELECT pg_advisory_xact_lock(hashtextextended(($1::date)::text, 0))
       )
       INSERT INTO nav_snapshots
         (snapshot_date, total_value, cash, units_outstanding, nav_per_unit)
       SELECT $1::date,$2,$3,$4,$5 FROM locked
       WHERE NOT EXISTS (
         SELECT 1
           FROM (
             SELECT total_value, cash, units_outstanding, nav_per_unit
               FROM nav_snapshots
              WHERE snapshot_date = $1::date
              ORDER BY id DESC
              LIMIT 1
           ) AS latest
          WHERE latest.total_value = $2
            AND latest.cash = $3
            AND latest.units_outstanding = $4
            AND latest.nav_per_unit IS NOT DISTINCT FROM $5
       )`,
      [value.date, value.totalValue, value.cash, value.unitsOutstanding, value.navPerUnit],
    );
  }, options);
}

/** Mirror the current Holdings projection. This is replaceable state, not a ledger. */
export async function shadowWritePosition(position) {
  return runShadowOperation("position", async (pool) => {
    const p = PositionSchema.parse(position);
    await pool.query(
      `INSERT INTO positions
         (ticker, name, shares, avg_cost, cost_basis, market_value,
          quote_snapshot_version, quote_source, quote_timestamp, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,now())
       ON CONFLICT (ticker) DO UPDATE SET
         name = EXCLUDED.name,
         shares = EXCLUDED.shares,
         avg_cost = EXCLUDED.avg_cost,
         cost_basis = EXCLUDED.cost_basis,
         market_value = EXCLUDED.market_value,
         quote_snapshot_version = NULL,
         quote_source = NULL,
         quote_timestamp = NULL,
         updated_at = now()`,
      [p.ticker, p.name ?? null, p.shares, p.avgCost, p.costBasis, p.marketValue]
    );
  });
}

/**
 * Replace the complete current-position projection in one shadow transaction.
 * A failed transaction is swallowed by runShadowOperation, so Sheets remains
 * authoritative and Postgres never exposes a half-refreshed inventory.
 */
export async function shadowReplacePositions(positions, options = {}) {
  const { valuation = null, ...operationOptions } = options ?? {};
  return runShadowOperation("positions", async (pool) => {
    const parsed = positions.map((position) => PositionSchema.parse(position));
    const quoteSnapshot = valuation == null ? null : {
      quoteSnapshotVersion: String(valuation.quoteSnapshotVersion ?? "").trim(),
      quoteSource: String(valuation.quoteSource ?? "").trim(),
      quoteTimestamp: new Date(valuation.quoteTimestamp),
    };
    if (quoteSnapshot && (
      !quoteSnapshot.quoteSnapshotVersion
      || !quoteSnapshot.quoteSource
      || !Number.isFinite(quoteSnapshot.quoteTimestamp.getTime())
    )) throw new Error("position valuation provenance is incomplete");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tickers = [];
      for (const p of parsed) {
        tickers.push(p.ticker);
        await client.query(
          `INSERT INTO positions
             (ticker, name, shares, avg_cost, cost_basis, market_value,
              quote_snapshot_version, quote_source, quote_timestamp, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (ticker) DO UPDATE SET
             name = EXCLUDED.name, shares = EXCLUDED.shares, avg_cost = EXCLUDED.avg_cost,
             cost_basis = EXCLUDED.cost_basis, market_value = EXCLUDED.market_value,
             quote_snapshot_version = EXCLUDED.quote_snapshot_version,
             quote_source = EXCLUDED.quote_source,
             quote_timestamp = EXCLUDED.quote_timestamp,
             updated_at = now()`,
          [
            p.ticker, p.name ?? null, p.shares, p.avgCost, p.costBasis, p.marketValue,
            quoteSnapshot?.quoteSnapshotVersion ?? null,
            quoteSnapshot?.quoteSource ?? null,
            quoteSnapshot?.quoteTimestamp ?? null,
          ]
        );
      }
      if (tickers.length) await client.query("DELETE FROM positions WHERE NOT (ticker = ANY($1::text[]))", [tickers]);
      else await client.query("DELETE FROM positions");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }, operationOptions);
}
