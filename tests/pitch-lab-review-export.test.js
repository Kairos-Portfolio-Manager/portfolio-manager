import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { AGENT_SCORING } from "../config/scoring/mandate-v2.js";
import { runPitchLabReviewExport } from "../jobs/pitch-lab-daily.js";
import { analyzePitchLab } from "../lib/pitch-lab/analysis.js";
import { FEATURE_CATALOG } from "../lib/pitch-lab/features.js";
import { generateMandateReview } from "../lib/pitch-lab/mandate-review.js";
import { buildReviewExport } from "../lib/pitch-lab/review-export.js";
import { seededRandom } from "../lib/pitch-lab/stats.js";
import { buildXlsx, sheetNames, toCsv } from "../lib/pitch-lab/xlsx-writer.js";

/** Read a zip back the slow, independent way: walk the central directory and inflate each entry. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "zip end-of-central-directory record present");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const packedSize = buffer.readUInt32LE(at + 20);
    const rawSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(localAt), 0x04034b50);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const raw = inflateRawSync(buffer.subarray(dataAt, dataAt + packedSize));
    assert.equal(raw.length, rawSize, `${name} inflates to its recorded size`);
    files[name] = raw.toString("utf8");
    at += 46 + nameLength;
  }
  return files;
}

test("buildXlsx writes a workbook a spreadsheet app can open: every part present, numbers as numbers, text escaped", () => {
  const files = unzip(buildXlsx([
    { name: "Adjustments", rows: [["Metric", "Change (bps)"], ["P/E <lower> & \"cheaper\"", -50], ["Blank next", null, 0.1234, true]] },
    { name: "Matrix 10d", rows: [["only"]] },
  ]));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  assert.match(files["xl/workbook.xml"], /<sheet name="Adjustments" sheetId="1" r:id="rId1"\/><sheet name="Matrix 10d" sheetId="2" r:id="rId2"\/>/);
  const sheet = files["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">Metric<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B2"><v>-50<\/v><\/c>/, "a number is a numeric cell, not text");
  assert.match(sheet, /P\/E &lt;lower&gt; &amp; &quot;cheaper&quot;/);
  assert.doesNotMatch(sheet, /r="B3"/, "null is an empty cell");
  assert.match(sheet, /<c r="C3"><v>0\.1234<\/v><\/c><c r="D3" t="b"><v>1<\/v><\/c>/);
  assert.match(files["[Content_Types].xml"], /sheet2\.xml/);
  // Same input, same bytes.
  assert.deepEqual(buildXlsx([{ name: "A", rows: [[1]] }]), buildXlsx([{ name: "A", rows: [[1]] }]));
  assert.throws(() => buildXlsx([]), /at least one sheet/);
});

test("tab names are made legal and unique; CSV quotes what needs quoting", () => {
  assert.deepEqual(sheetNames(["Matrix 10d", "a/b:c", "x".repeat(40), "", "matrix 10d"]), ["Matrix 10d", "a b c", "x".repeat(31), "Sheet4", "matrix 10d 2"]);
  assert.equal(toCsv([["Metric", "Why"], ["P/E, forward", "said \"cheap\""], [null, 0.5]]), "Metric,Why\r\n\"P/E, forward\",\"said \"\"cheap\"\"\"\r\n,0.5\r\n");
});

// A small graded history with one planted effect (revenue growth).
const DAY_MS = 86_400_000;
const addDays = (dateStr, days) => new Date(Date.parse(`${dateStr}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const NO_FEATURES = Object.fromEntries(FEATURE_CATALOG.map((feature) => [feature.id, { value: null, missing: true }]));
function history({ weeks = 9, perWeek = 14 } = {}) {
  const random = seededRandom(11);
  const pitches = [];
  const outcomes = [];
  for (let w = 0; w < weeks; w += 1) {
    for (let i = 0; i < perWeek; i += 1) {
      const id = `p-${w}-${i}`;
      const entryDate = addDays("2026-01-05", w * 7 + (i % 5));
      const ranks = Object.fromEntries(["revBeat", "revGrowth", "epsTrajectory", "marginTrend", "peerValuation", "balanceSheet"].map((metricId) => [metricId, { status: "ranked", percentile: random(), peerCount: 12 }]));
      pitches.push({ id, ticker: `T${w}${i}`, pitchedAt: `${addDays(entryDate, -1)}T23:40:00Z`, conviction: 6, convictionScale: 10, features: NO_FEATURES, peers: { ranks } });
      for (const horizonDays of [5, 10]) {
        const excessReturn = 0.08 * (ranks.revGrowth.percentile - 0.5) + (random() - 0.5) * 0.03;
        outcomes.push({ pitchId: id, horizonDays, status: "matured", entryDate, excessReturn, netReturn: excessReturn + 0.01, benchmarkReturn: 0.01, benchmark: "SPY", costPerSide: 0.001 });
      }
    }
  }
  return { pitches, outcomes };
}
const NOW = new Date("2026-03-13T23:40:00Z"); // a Friday, 19:40 ET
const data = history();
const report = analyzePitchLab({ pitches: data.pitches, outcomes: data.outcomes, now: NOW, options: { bootstrapIterations: 200, matrix: { relativeIterations: 100 } } });
const review = generateMandateReview(report, AGENT_SCORING["agent-1"], { now: NOW });
const sheetOf = (sheets, name) => sheets.find((sheet) => sheet.name === name);

test("the export has a tab for the summary, the adjustments, each holding period's matrix and spread, and the pitches", () => {
  const sheets = buildReviewExport({ review, report, ...data });
  // The review's own holding period (10 days) comes first.
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["Summary", "Adjustments", "Change request", "Metric ideas", "Matrix 10d", "Matrix 5d", "Spread 10d", "Spread 5d", "Pitches"]);
  const summary = sheetOf(sheets, "Summary").rows;
  assert.deepEqual(summary.find((row) => row[0] === "Review period"), ["Review period", "2026-03-13"]);
  assert.ok(summary.some((row) => row[0] === "Mandate weights used" && /A\.revBeat=10/.test(row[1])));
  assert.match(sheetOf(sheets, "Change request").rows[0][0], /^Mandate weight change request — from the Pitch Lab Mandate Review of 2026-03-13/);
  assert.match(sheetOf(sheets, "Metric ideas").rows[0][0], /soft suggestions/);
  assert.ok(summary.some((row) => /no mandate change has been made/.test(row[0] ?? "")));
  assert.ok(summary.some((row) => row[0] === "Caveats"));
  assert.doesNotThrow(() => buildXlsx(sheets));
});

test("the adjustments tab lists all nine metrics with bps that net to zero", () => {
  const [header, ...rows] = sheetOf(buildReviewExport({ review, report, ...data }), "Adjustments").rows;
  assert.deepEqual(header.slice(0, 7), ["Metric", "Category", "Current weight (bps)", "Suggested change (bps)", "Suggested weight (bps)", "Suggestion", "Confidence"]);
  const metricRows = rows.slice(0, 9);
  assert.deepEqual(metricRows.map((row) => row[0]), review.adjustments.rows.map((row) => row.label));
  assert.deepEqual(metricRows.map((row) => row[3]), review.adjustments.rows.map((row) => row.changeBps));
  assert.equal(metricRows.reduce((sum, row) => sum + row[3], 0), 0);
  assert.deepEqual(rows.at(-1), ["Net change (bps)", null, 10_000, 0, 10_000]);
  const growth = metricRows.find((row) => row[0] === "Revenue growth (YoY)");
  assert.equal(growth[5], review.adjustments.rows.find((row) => row.metricId === "revGrowth").sized === "not_sized" ? "more weight (not sized: nothing in its category to pair it with)" : "more weight");
  assert.equal(growth[7], "aggregate went with better results");
});

test("the matrix and spread tabs carry the report's numbers unchanged, one column per week", () => {
  const sheets = buildReviewExport({ review, report, ...data });
  const horizon = report.weeklyMatrix.horizons.find((h) => h.horizonDays === 10);
  const matrix = sheetOf(sheets, "Matrix 10d").rows;
  assert.deepEqual(matrix[1].slice(0, 4), ["Metric", "2026-01-05", "2026-01-12", "2026-01-19"]);
  assert.equal(matrix[1].length, 1 + horizon.weeks.length + 8);
  const source = horizon.metrics.find((m) => m.id === "revGrowth");
  const row = matrix.find((r) => r[0] === "Revenue growth (YoY)");
  assert.deepEqual(row.slice(1, 1 + horizon.weeks.length), source.cells.map((cell) => cell.rho));
  assert.deepEqual(row.slice(1 + horizon.weeks.length), [source.aggregate.rho, source.aggregate.verdict, source.aggregate.excessReturnPerSd.qValue, source.weeksPositive, source.weeksNegative, source.weeksUsed, source.consistency.score, "rank among industry peers"]);
  assert.deepEqual(matrix.find((r) => r[0] === "Pitches graded").slice(1), [...horizon.weeks.map((w) => w.graded), horizon.graded]);
  const spread = sheetOf(sheets, "Spread 10d").rows.find((r) => r[0] === "Revenue growth (YoY)");
  assert.deepEqual(spread.slice(1), [...source.cells.map((cell) => cell.spread), source.spread.overall, source.spread.meanWeekly, source.spread.sdWeekly, source.spread.weeksUsed]);
});

test("the pitches tab has one row per pitch with the inputs every other tab was computed from", () => {
  const [header, ...rows] = sheetOf(buildReviewExport({ review, report, ...data }), "Pitches").rows;
  assert.equal(rows.length, data.pitches.length);
  assert.deepEqual(header.slice(0, 6), ["Pitch id", "Ticker", "Pitched at (UTC)", "Entry date", "Entry week", "Week start (Monday)"]);
  assert.ok(header.includes("Revenue growth (YoY) — peer percentile") && header.includes("Excess return 10d") && header.includes("Benchmark return 5d"));
  const pitch = data.pitches[0];
  const row = rows.find((r) => r[0] === pitch.id);
  assert.deepEqual(row.slice(3, 6), ["2026-01-05", "2026-W02", "2026-01-05"]);
  assert.equal(row[header.indexOf("Revenue growth (YoY) — peer percentile")], pitch.peers.ranks.revGrowth.percentile);
  assert.equal(row[header.indexOf("Latest 13F accumulation — peer percentile")], null, "an unranked metric is blank, never zero");
  assert.equal(row[header.indexOf("Excess return 10d")], data.outcomes.find((o) => o.pitchId === pitch.id && o.horizonDays === 10).excessReturn);
});

test("an insufficient-data review still exports, and says there is no table", () => {
  const few = history({ weeks: 2, perWeek: 5 });
  const thinReport = analyzePitchLab({ pitches: few.pitches, outcomes: few.outcomes, now: NOW, options: { bootstrapIterations: 50 } });
  const thinReview = generateMandateReview(thinReport, AGENT_SCORING["agent-1"], { now: NOW });
  assert.equal(thinReview.status, "insufficient_data");
  const sheets = buildReviewExport({ review: thinReview, report: thinReport, ...few });
  assert.deepEqual(sheetOf(sheets, "Adjustments").rows[0], ["No sized suggestions in this review."]);
  assert.ok(sheetOf(sheets, "Summary").rows.some((row) => row[0] === "More weeks needed"));
  assert.ok(sheetOf(sheets, "Matrix 10d"));
  assert.throws(() => buildReviewExport({}), /review is required/);
});

test("the export job writes one workbook and one CSV per tab, read-only, and only when Pitch Lab is enabled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pitch-lab-export-"));
  try {
    const store = {
      listPitches: async () => data.pitches,
      listOutcomes: async () => data.outcomes,
      appendMandateReview: async () => { throw new Error("the export must not store a review"); },
    };
    assert.deepEqual(await runPitchLabReviewExport({ env: {}, store, outDir: dir }), { status: "disabled" });
    assert.deepEqual(readdirSync(dir), []);
    const result = await runPitchLabReviewExport({ env: { PITCH_LAB_ENABLED: "1" }, store, outDir: dir, now: () => NOW });
    assert.equal(result.status, "ok");
    assert.equal(result.pitches, data.pitches.length);
    assert.equal(path.basename(result.xlsxPath), "mandate-review-2026-03-13.xlsx");
    const written = readdirSync(dir).sort();
    assert.equal(written.filter((name) => name.endsWith(".csv")).length, result.sheets.length);
    assert.ok(written.includes("mandate-review-2026-03-13-adjustments.csv"));
    assert.match(readFileSync(result.changeRequestPath, "utf8"), /^Mandate weight change request/);
    assert.equal(written.filter((name) => name.endsWith(".txt")).length, 1);
    assert.ok(Object.keys(unzip(readFileSync(result.xlsxPath))).includes("xl/worksheets/sheet1.xml"));
    assert.match(readFileSync(path.join(dir, "mandate-review-2026-03-13-matrix-10d.csv"), "utf8"), /^"Correlation with 10-day excess return, by entry week"\r\nMetric,2026-01-05,/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the export's content modules stay pure", () => {
  for (const file of ["review-export.js", "xlsx-writer.js"]) {
    const src = readFileSync(new URL(`../lib/pitch-lab/${file}`, import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]);
    for (const spec of imports) assert.ok(!/node:fs|redis|\/pg\/|config\/|proposal|ledger|broker|order/.test(spec), `${file} must not import "${spec}"`);
  }
});
