#!/usr/bin/env node
/**
 * Pitch Lab peer-coverage dry run for one ticker. Read-only by default.
 *
 *   node scripts/pitch-lab-peer-check.js NET
 *   node scripts/pitch-lab-peer-check.js NET --file-request   also queue a coverage request
 *                                                            for any metric that cannot be ranked
 *
 * Fetches what the research scan fetches (Yahoo, EDGAR, daily bars), reads the
 * peer table (needs the Redis env — run it on the Jetson), and prints, per metric,
 * the value and whether it could be ranked against industry peers. Records no
 * pitch and writes nothing, except the optional coverage request.
 */
import "dotenv/config";
import { PEER_RANK_METRIC_IDS } from "../lib/pitch-lab/peer-rank.js";
import { peerCheck } from "../lib/pitch-lab-peer-bridge.js";

const args = process.argv.slice(2);
const ticker = args.find((a) => !a.startsWith("--"));
if (!ticker) {
  console.error("usage: node scripts/pitch-lab-peer-check.js <TICKER> [--file-request]");
  process.exit(1);
}

try {
  const result = await peerCheck({ ticker, requestsEnabled: args.includes("--file-request") });
  const { peers, features } = result;
  console.log(`\nPitch Lab peer check — ${result.ticker} at ${result.asOf}`);
  console.log(`  industry: ${peers.industry ?? "—"}   sector: ${peers.sector ?? "—"}`);
  console.log(`  peer set: level=${peers.level} key=${peers.key ?? "—"} peers=${peers.peerCount} mode=${peers.mode}${peers.reason ? ` (${peers.reason})` : ""}`);
  console.log(`  peer data as of: ${peers.peerDataAsOf ?? "—"}   rows ignored (no/late timestamp): ${peers.excludedPeers}\n`);
  for (const id of PEER_RANK_METRIC_IDS) {
    const rank = peers.ranks[id];
    const value = features[id].value;
    const shown = value == null ? `missing (${features[id].missingReason})` : Number(value.toFixed(4));
    const detail = rank.status === "ranked" ? `${Math.round(rank.percentile * 100)}th percentile of ${rank.peerCount}` : rank.status;
    console.log(`  ${id.padEnd(18)} ${String(shown).padEnd(34)} ${detail}`);
  }
  console.log(`\n  coverage request: ${result.request.filed ? "filed" : `not filed${result.request.reason ? ` (${result.request.reason})` : " (nothing to request)"}`}`);
} catch (error) {
  console.error(`[pitch-lab-peer-check] ${error?.message ?? error}`);
  process.exitCode = 1;
}
