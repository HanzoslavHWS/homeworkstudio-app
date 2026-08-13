import { readFileSync } from "node:fs";
import { componentCatalogItems } from "../data/components.ts";
import { boothTypes } from "../data/booths.ts";
import { buildImportPreview } from "../domain/importBatch.ts";
import { fingerprintBytes } from "../domain/importBatch.ts";
import { extractSheetGrid, readWorkbookSheets } from "../lib/import/xlsxReader.server.ts";

function detectSourceVersion(fileName: string): string {
  const match = /V(\d+\.\d+)/iu.exec(fileName);
  return match ? `V${match[1]}` : fileName;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/importDryRun.ts <path-to-xlsm>");
    process.exit(1);
  }

  const bytes = readFileSync(filePath);
  const fingerprint = fingerprintBytes(new Uint8Array(bytes));
  const fileName = filePath.split(/[\\/]/u).pop() ?? filePath;
  const sourceVersion = detectSourceVersion(fileName);

  const workbook = await readWorkbookSheets(filePath);
  const sheets = {
    pricelist: extractSheetGrid(workbook, "PRICELIST"),
    dataSheet: extractSheetGrid(workbook, "data sheet"),
    czk: extractSheetGrid(workbook, "CZK"),
    eur: extractSheetGrid(workbook, "EUR"),
    naklad: extractSheetGrid(workbook, "náklad"),
  };

  const preview = buildImportPreview(sheets, componentCatalogItems);

  console.log("=== IMPORT BATCH (dry run) ===");
  console.log("sourceFileName:", fileName);
  console.log("sourceFingerprint:", fingerprint);
  console.log("sourceVersion:", sourceVersion);
  console.log();
  console.log("=== COUNTS ===");
  console.log(JSON.stringify(preview.counts, null, 2));
  console.log();
  console.log("=== EVENTS ===");
  for (const event of preview.events) {
    console.log(`- ${event.sourceKey} | ${event.name} | ${event.startDate ?? "?"} .. ${event.endDate ?? "?"}${event.needsReview ? "  [NEEDS REVIEW]" : ""}`);
  }
  console.log();
  console.log("=== CANDIDATE MAPPINGS (catalog rows with >=1 candidate) ===");
  for (const row of preview.catalogRows) {
    if (row.candidates.length === 0) continue;
    console.log(`- "${row.rawNameCz}" (row ${row.sourceRow}, ${row.category}) ->`);
    for (const candidate of row.candidates) {
      console.log(`    candidate: ${candidate.internalCode ?? "(no code)"} ${candidate.displayName} score=${candidate.score.toFixed(2)} reasons=${candidate.reasons.join(",")}`);
    }
  }
  console.log();
  console.log("=== TECHNICAL SERVICE CANDIDATE MAPPINGS ===");
  for (const row of preview.technicalServiceRows) {
    if (row.candidates.length === 0) continue;
    console.log(`- "${row.rawName}" ->`);
    for (const candidate of row.candidates) {
      console.log(`    candidate: ${candidate.internalCode ?? "(no code)"} ${candidate.displayName} score=${candidate.score.toFixed(2)} reasons=${candidate.reasons.join(",")}`);
    }
  }
  console.log();
  console.log("=== ROWS NEEDING UNIT REVIEW (sample, first 15) ===");
  preview.catalogRows.filter((r) => r.unitNeedsReview).slice(0, 15).forEach((r) => console.log(`- ${r.rawNameCz}`));
  console.log();
  console.log("=== MISSING BASE PRICE ROWS (sample, first 15) ===");
  preview.catalogRows.filter((r) => r.saleCzk.status === "missing").slice(0, 15).forEach((r) => console.log(`- ${r.rawNameCz} (${r.category})`));
  console.log();
  console.log("=== P86 CHECK (expect zero candidates — booths aren't matched against PRICELIST rows) ===");
  const p86Booth = boothTypes.find((booth) => booth.internalCode === "P86" || booth.code === "P86");
  console.log("P86 exists in current booth catalog:", Boolean(p86Booth), p86Booth?.name);
  const p86Candidates = preview.catalogRows.filter((row) => row.candidates.some((c) => c.internalCode === "P86"));
  console.log("PRICELIST rows suggesting P86 as a candidate:", p86Candidates.length, "(booths are out of scope for domain/catalogMapping.ts, which only compares ComponentDefinition items)");
  console.log();
  console.log("=== NÁKLAD SHEET CHECK (expect 0 — sheet is currently empty, must not invent purchase costs) ===");
  console.log("technicalPurchasePricesCzkPresent:", preview.counts.technicalPurchasePricesCzkPresent);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
