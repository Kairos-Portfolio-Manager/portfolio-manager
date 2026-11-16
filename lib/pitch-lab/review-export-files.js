/**
 * Writes a Mandate Review export to disk: one .xlsx workbook plus one .csv per tab.
 * The only file-writing part of the export; the content is built by review-export.js.
 * Local files only — nothing is published, sent, or written to production state.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildReviewExport } from "./review-export.js";
import { buildXlsx, sheetNames, toCsv } from "./xlsx-writer.js";

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * @returns {{ xlsxPath: string, csvPaths: string[], sheets: string[] }}
 */
export function writeReviewExport({ review, report, pitches, outcomes, outDir }) {
  const sheets = buildReviewExport({ review, report, pitches, outcomes });
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const base = `mandate-review-${review.period ?? "latest"}`;
  mkdirSync(outDir, { recursive: true });
  const xlsxPath = path.join(outDir, `${base}.xlsx`);
  writeFileSync(xlsxPath, buildXlsx(sheets));
  const csvPaths = sheets.map((sheet, index) => {
    const csvPath = path.join(outDir, `${base}-${slug(names[index])}.csv`);
    writeFileSync(csvPath, toCsv(sheet.rows));
    return csvPath;
  });
  return { xlsxPath, csvPaths, sheets: names };
}
