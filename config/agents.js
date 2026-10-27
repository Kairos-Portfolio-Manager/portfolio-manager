/**
 * Registry of independent research agents. Each agent has its own watchlist,
 * quant weights, risk limits, personality (empty until named), and internal
 * tab (Agent-1/Agent-2/Agent-3 in lib/sheets.js) for its own recommendation
 * history, strategy notes, and track record.
 *
 * All three agents propose trades against the SAME shared portfolio (one real
 * Robinhood account, one spreadsheet — see lib/redis.js getCachedSharedSpreadsheetId).
 * Risk limits are checked against that real shared portfolio's actual position/
 * sector sizes, so agents can downgrade/block each other's proposals.
 *
 * researchStatus: "active" | "frozen". A frozen agent is skipped by the
 * scheduled research scan and refused by on-demand research (Lab, price
 * alerts), so it spends no model budget and queues no new research-driven
 * proposals. Everything it already owns is untouched: lots, ledgers,
 * recommendation history, memories, and mandate config. Ownership-based
 * exit monitoring on its existing lots keeps running so held positions are
 * never left unprotected. Unfreeze by setting it back to "active".
 */
export const AGENTS = [
  { id: "agent-1", name: "Short-Term High-Velocity", executionEligibility: "supervised", researchStatus: "active" },
  { id: "agent-2", name: "Medium-Term Momentum", executionEligibility: "supervised", researchStatus: "frozen" },
  { id: "agent-3", name: "Long-Term Compounder", executionEligibility: "supervised", researchStatus: "frozen" },
];
