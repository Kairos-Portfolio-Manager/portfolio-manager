import test from "node:test";
import assert from "node:assert/strict";
import { deriveThirteenFEvidence, MAX_QUARTER_AGE_DAYS } from "../lib/thirteen-f.js";
import { parseTsv, resolveLatestSubmissions, aggregateSharesByCusip, toTickerQuarters } from "../lib/thirteen-f-dataset.js";
import { chunk } from "../lib/cusip-map.js";

const quarter = (periodEnd, publishedAt, institutionalShares) => ({ periodEnd, publishedAt, institutionalShares });
const shares = (rows) => rows.map(([end, val]) => ({ end, val }));

const accumulating = [
  quarter("2025-09-30", "2025-11-20", 100e6),
  quarter("2025-12-31", "2026-02-20", 106e6),
  quarter("2026-03-31", "2026-05-20", 113e6),
];
const flatShareCount = shares([["2025-09-30", 1000e6], ["2025-12-31", 1000e6], ["2026-03-31", 1000e6]]);

test("two-quarter accumulation binds both ownership metrics", () => {
  const out = deriveThirteenFEvidence({ quarters: accumulating, sharesOutstanding: flatShareCount, asOf: "2026-06-01" });
  assert.equal(out.usableQuarters, 2);
  assert.equal(out.thirteenF.latestQuarterChangePct.toFixed(2), "6.60");
  assert.equal(out.thirteenF.priorQuarterChangePct.toFixed(2), "6.00");
  assert.equal(out.thirteenF.cumulativeTwoQuarterChangePct.toFixed(2), "13.00");
  assert.equal(out.instOwnershipDir.clearMultiQuarterAccumulation, true);
  // 11.3% - 10.6% of shares outstanding = 0.7 percentage points.
  assert.equal(out.instOwnershipDir.ownershipChangePoints.toFixed(2), "0.70");
});

test("ownershipChangePoints is percentage points of shares outstanding, not percent change in shares held", () => {
  const out = deriveThirteenFEvidence({ quarters: accumulating, sharesOutstanding: flatShareCount, asOf: "2026-06-01" });
  // The two quantities must not be confused: 6.6% change in shares held is only 0.7pp of
  // shares outstanding. Reading one as the other would put a routine quarter in the
  // top band.
  assert.ok(out.instOwnershipDir.ownershipChangePoints < 1);
  assert.ok(out.thirteenF.latestQuarterChangePct > 6);
});

test("a buyback cannot masquerade as institutional accumulation", () => {
  // Institutions hold exactly the same share count; the company retired 20% of shares.
  const flatHoldings = [
    quarter("2025-09-30", "2025-11-20", 100e6),
    quarter("2025-12-31", "2026-02-20", 100e6),
    quarter("2026-03-31", "2026-05-20", 100e6),
  ];
  const shrinking = shares([["2025-09-30", 1000e6], ["2025-12-31", 900e6], ["2026-03-31", 800e6]]);
  const out = deriveThirteenFEvidence({ quarters: flatHoldings, sharesOutstanding: shrinking, asOf: "2026-06-01" });

  // The share-held change is correctly zero — institutions did not buy.
  assert.equal(out.thirteenF.latestQuarterChangePct, 0);
  assert.equal(out.instOwnershipDir.clearMultiQuarterAccumulation, false);
  // Ownership PERCENTAGE genuinely rose, and that is a real fact, not an artifact —
  // but it must come from date-matched share counts, which is what this asserts.
  assert.equal(out.instOwnershipDir.ownershipChangePoints.toFixed(2), "1.39");
});

test("a share count from the wrong date is never borrowed", () => {
  // Only the latest quarter has a matching share count; the prior quarter has none.
  const out = deriveThirteenFEvidence({
    quarters: accumulating,
    sharesOutstanding: shares([["2026-03-31", 1000e6]]),
    asOf: "2026-06-01",
  });
  assert.equal("ownershipChangePoints" in out.instOwnershipDir, false, "no ownership pp without both endpoints date-matched");
  // clearMultiQuarterAccumulation survives — it is derived from share-count changes and
  // needs no denominator, and the full-credit band accepts it on its own.
  assert.equal(out.instOwnershipDir.clearMultiQuarterAccumulation, true);
  // The share-held changes are likewise unaffected.
  assert.equal(out.thirteenF.usableQuarters, 2);
});

test("stale data reports missing, never zero", () => {
  const out = deriveThirteenFEvidence({ quarters: accumulating, sharesOutstanding: flatShareCount, asOf: "2027-06-01" });
  assert.equal(out.thirteenF, null);
  assert.equal(out.instOwnershipDir, null);
  assert.equal(out.usableQuarters, 0);
  assert.match(out.unavailableReason, /old/);
  // Zero is the "institutions sold" band. Stale evidence must not land there.
  assert.notEqual(out.thirteenF, 0);
});

test("usability keys off publication, not the statutory due date", () => {
  // asOf sits after every period end but before the newest quarter was published.
  const out = deriveThirteenFEvidence({ quarters: accumulating, sharesOutstanding: flatShareCount, asOf: "2026-04-15" });
  assert.equal(out.usableQuarters, 1, "the unpublished quarter is invisible");
  assert.equal(out.thirteenF.priorQuarterChangePct, undefined);
  // One usable change cannot reach the full band, which requires usableQuarters >= 2.
  assert.equal(out.thirteenF.usableQuarters, 1);
});

test("retention holds at two quarters of change even when more history exists", () => {
  const long = [quarter("2025-03-31", "2025-05-20", 80e6), quarter("2025-06-30", "2025-08-20", 90e6), ...accumulating];
  const out = deriveThirteenFEvidence({ quarters: long, sharesOutstanding: flatShareCount, asOf: "2026-06-01" });
  assert.equal(out.usableQuarters, 2);
  assert.equal(out.thirteenF.priorQuarterChangePct.toFixed(2), "6.00");
});

test("MAX_QUARTER_AGE_DAYS leaves room for the publication lag", () => {
  // Two quarters plus the lag: a quarter that is merely awaiting the next publication
  // must stay usable, or the metric would blink out between SEC data-set releases.
  assert.ok(MAX_QUARTER_AGE_DAYS > 182);
});

// --- dataset parsing ---

const SUBMISSION = [
  "ACCESSION_NUMBER\tCIK\tPERIODOFREPORT\tFILING_DATE",
  "0001-ORIG\t1000\t2026-03-31\t2026-05-10",
  "0001-AMND\t1000\t2026-03-31\t2026-05-28",
  "0002\t2000\t2026-03-31\t2026-05-12",
].join("\n");

const INFOTABLE = [
  "ACCESSION_NUMBER\tNAMEOFISSUER\tCUSIP\tVALUE\tSSHPRNAMT\tSSHPRNAMTTYPE\tPUTCALL",
  "0001-ORIG\tAcme\t037833100\t1000\t500000\tSH\t",
  "0001-AMND\tAcme\t037833100\t1000\t400000\tSH\t",
  "0002\tAcme\t037833100\t1000\t250000\tSH\t",
  "0002\tAcme\t037833100\t1000\t999999\tSH\tCall",
  "0002\tAcme\t037833100\t1000\t888888\tPRN\t",
].join("\n");

test("an amended filing supersedes the original instead of double counting", () => {
  const { byCusip, skipped } = aggregateSharesByCusip(INFOTABLE, SUBMISSION);
  // 400k (amended, not 500k+400k) + 250k = 650k.
  assert.equal(byCusip.get("037833100").shares, 650000);
  assert.equal(byCusip.get("037833100").holders, 2);
  assert.equal(skipped.unmatchedAccession, 1);
});

test("options and principal amounts are not share ownership", () => {
  const { skipped } = aggregateSharesByCusip(INFOTABLE, SUBMISSION);
  assert.equal(skipped.options, 1);
  assert.equal(skipped.nonShare, 1);
});

test("the CUSIP filter restricts aggregation to our universe", () => {
  const { byCusip } = aggregateSharesByCusip(INFOTABLE, SUBMISSION, ["999999999"]);
  assert.equal(byCusip.size, 0);
});

test("resolveLatestSubmissions keeps the newest filing per manager and period", () => {
  const kept = resolveLatestSubmissions(SUBMISSION);
  assert.equal(kept.has("0001-AMND"), true);
  assert.equal(kept.has("0001-ORIG"), false);
  assert.equal(kept.has("0002"), true);
});

test("an unexpected header fails closed rather than reading by position", () => {
  assert.throws(() => parseTsv("A\tB\n1\t2", ["CUSIP"]), /missing required column/);
  assert.throws(() => parseTsv("", ["CUSIP"]), /empty file/);
});

test("toTickerQuarters skips unmapped tickers instead of guessing", () => {
  const quarters = [
    { periodOfReport: "2025-12-31", publishedAt: "2026-02-20", byCusip: new Map([["037833100", { shares: 10, holders: 1 }]]) },
    { periodOfReport: "2026-03-31", publishedAt: "2026-05-20", byCusip: new Map([["037833100", { shares: 12, holders: 1 }]]) },
  ];
  const out = toTickerQuarters(quarters, { AAPL: "037833100", MYSTERY: null });
  assert.equal(out.AAPL.length, 2);
  assert.equal(out.AAPL[0].periodEnd, "2025-12-31");
  assert.equal("MYSTERY" in out, false);
});

// --- CUSIP mapping ---

// The ticker → CUSIP direction was removed: OpenFIGI does not return CUSIPs. The reversed
// CUSIP → ticker mapping is tested in tests/thirteen-f-stream.test.js.

test("chunk respects the OpenFIGI 100-job ceiling", () => {
  assert.equal(chunk(new Array(250).fill("X")).length, 3);
});
