/**
 * Technické rastry — corrective batch (post real-file acceptance test) section 7-10: real-file
 * diagnostic for the supplemental catalog parser (domain/technicalRasterCatalogImport.ts) against
 * the actual customer export `_IMPORT/realizacky.pdf` ("5. Stavby - tisk vše katalog"), plus a full
 * reconciliation run against the real primary electricity report for the SAME FOR DECOR project.
 *
 * Entirely SKIP-SAFE, same discipline as scripts/technicalRasterRealDiagnostic.ts: `_IMPORT/` is a
 * local-only, gitignored fixture workspace, never assumed present, never required for `npm test`.
 *
 * Usage:
 *   node --no-warnings scripts/technicalRasterCatalogRealDiagnostic.ts
 *   npm run test:technical-raster-catalog-real
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSupplementalCatalogPdf, extractTechnicalMentionsFromCatalogStand } from "../domain/technicalRasterCatalogImport.ts";
import { electricityReportParser } from "../domain/technicalReportParsers/electricityReportParser.ts";
import { cleaningReportParser } from "../domain/technicalReportParsers/cleaningReportParser.ts";
import { reconcileTechnicalReportAndCatalog, type TechnicalReconciliationMention } from "../domain/technicalRasterReconciliation.ts";
import { resolveTechnicalRealizationGroup, resolveRealizationDisplayState } from "../domain/technicalRasterRealization.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const importDir = path.join(repoRoot, "_IMPORT");
const CATALOG_FILE = "realizacky.pdf";
const ELECTRICITY_FILE = "Decor 26 - elektrická energie.pdf";
const CLEANING_FILE = "Decor 26 - úklid.pdf";

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

async function extractItems(filePath: string): Promise<PdfTextItem[]> {
  const bytes = await readFile(filePath);
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const it of content.items as { str: string; width: number; height: number; transform: number[] }[]) {
      if (!it.str.trim()) continue;
      items.push({ str: it.str, page: pageNumber, x: it.transform[4]!, y: it.transform[5]!, width: it.width, height: it.height || Math.abs(it.transform[3]!) });
    }
  }
  return items;
}

async function main(): Promise<void> {
  if (!existsSync(path.join(importDir, CATALOG_FILE))) {
    console.log(`_IMPORT/${CATALOG_FILE} not found — skipping (this is expected in a fresh checkout; the file is a real customer document and is gitignored).`);
    process.exitCode = 0;
    return;
  }

  section("PARSE — 5. Stavby - tisk vše katalog");
  const catalogItems = await extractItems(path.join(importDir, CATALOG_FILE));
  const catalog = parseSupplementalCatalogPdf(catalogItems);
  console.log(`Stands found: ${catalog.stands.length}`);
  console.log(`Warnings: ${catalog.warnings.length}`);
  for (const warning of catalog.warnings) console.log(`  - ${warning.message}`);

  const standsWithNumber = catalog.stands.filter((stand) => stand.standNumber);
  const standsWithoutNumber = catalog.stands.filter((stand) => !stand.standNumber);
  console.log(`\nStands WITH a stand number: ${standsWithNumber.length}`);
  console.log(`Stands WITHOUT a stand number (captured, never fabricated, cannot reconcile): ${standsWithoutNumber.length}`);

  section("REALIZACE — R: extraction + canonical grouping");
  const groupCounts = new Map<string, number>();
  for (const stand of catalog.stands) {
    const group = resolveTechnicalRealizationGroup(stand.realizationCompanyRaw);
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
    console.log(`  ${stand.standNumber ?? "(no number)"}: R="${stand.realizationCompanyRaw ?? "(none)"}" -> ${group}`);
  }
  console.log("\nBy canonical group:", Object.fromEntries(groupCounts));

  const catalogMentions: TechnicalReconciliationMention[] = catalog.stands.flatMap((stand) => extractTechnicalMentionsFromCatalogStand(stand));
  section("TECHNICAL MENTIONS extracted from catalog");
  console.log(`Total: ${catalogMentions.length}`);
  const byCategory = new Map<string, number>();
  for (const mention of catalogMentions) byCategory.set(mention.category, (byCategory.get(mention.category) ?? 0) + 1);
  console.log("By category:", Object.fromEntries(byCategory));

  // CORRECTIVE BATCH (3rd) section 21 — 1B06 is the real, confirmed case: a catalog build record
  // with NO entry in ANY primary technical-service report. `hasCatalogBuildRecord`/
  // `resolveRealizationDisplayState` are domain-only (no raster stand-label detection is run by
  // this text-only diagnostic), so this reports what the CATALOG ITSELF says about 1B06's own
  // realization — the full end-to-end raster-matching behavior is covered by the unit tests in
  // tests/technicalRaster.test.ts's own "Realization domain Case 1 (real 1B06)" test.
  section("1B06 — real catalog-only build record check");
  const stand1B06 = catalog.stands.find((stand) => stand.standNumber === "1B06");
  if (stand1B06) {
    const display = resolveRealizationDisplayState(true, stand1B06.realizationCompanyRaw);
    console.log(`1B06 catalog record found: R="${stand1B06.realizationCompanyRaw ?? "(none)"}" -> ${display.shouldShow ? display.group : "(hidden)"}`);
  } else {
    console.log("1B06 not found in this run's catalog fixture (real document contents may differ from when this was last verified).");
  }

  if (!existsSync(path.join(importDir, ELECTRICITY_FILE))) {
    console.log(`\n_IMPORT/${ELECTRICITY_FILE} not found — skipping the cross-report reconciliation run.`);
    return;
  }

  section("RECONCILIATION — primary electricity report vs. supplemental catalog");
  const electricityItems = await extractItems(path.join(importDir, ELECTRICITY_FILE));
  const electricityReport = electricityReportParser.parse(electricityItems);
  const reportMentions: TechnicalReconciliationMention[] = electricityReport.rows.flatMap((row) =>
    row.services.map((service) => ({ standNumber: row.standNumber, category: service.category, externalLabel: service.externalLabel, quantity: service.quantity })),
  );
  console.log(`Report mentions (electricity): ${reportMentions.length}`);
  console.log(`Catalog mentions (electricity only): ${catalogMentions.filter((m) => m.category === "electricity").length}`);
  console.log(`1B06 mentioned in the primary electricity report: ${reportMentions.some((m) => m.standNumber === "1B06")}`);

  const electricityOutcomes = reconcileTechnicalReportAndCatalog(reportMentions, catalogMentions.filter((mention) => mention.category === "electricity"));
  const byStatus = new Map<string, number>();
  for (const outcome of electricityOutcomes) byStatus.set(outcome.status, (byStatus.get(outcome.status) ?? 0) + 1);
  console.log("\nOutcomes by status:", Object.fromEntries(byStatus));
  for (const outcome of electricityOutcomes) {
    if (outcome.status === "conflict" || outcome.status === "quantity_mismatch") console.log("  ⚠", JSON.stringify(outcome));
  }
  const outcome1B05 = electricityOutcomes.find((outcome) => outcome.standNumber === "1B05");
  console.log(`\n1B05 refrigerated/NOČNÍ PROUD outcome (must be SHODA after the section 14 alias fix): ${outcome1B05 ? JSON.stringify(outcome1B05) : "(no 1B05 electricity outcome found in this real run)"}`);

  if (!existsSync(path.join(importDir, CLEANING_FILE))) {
    console.log(`\n_IMPORT/${CLEANING_FILE} not found — skipping the cleaning reconciliation run.`);
    return;
  }

  section("RECONCILIATION — primary cleaning report vs. supplemental catalog");
  const cleaningItems = await extractItems(path.join(importDir, CLEANING_FILE));
  const cleaningReport = cleaningReportParser.parse(cleaningItems);
  const cleaningReportMentions: TechnicalReconciliationMention[] = cleaningReport.rows.flatMap((row) =>
    row.services.map((service) => ({ standNumber: row.standNumber, category: service.category, externalLabel: service.externalLabel, quantity: service.quantity })),
  );
  const cleaningOutcomes = reconcileTechnicalReportAndCatalog(cleaningReportMentions, catalogMentions.filter((mention) => mention.category === "cleaning"));
  const cleaningByStatus = new Map<string, number>();
  for (const outcome of cleaningOutcomes) cleaningByStatus.set(outcome.status, (cleaningByStatus.get(outcome.status) ?? 0) + 1);
  console.log("Outcomes by status:", Object.fromEntries(cleaningByStatus));
  const outcome1C01 = cleaningOutcomes.find((outcome) => outcome.standNumber === "1C01");
  console.log(`\n1C01 'denni uklid'/'uklid denni' outcome (must be SHODA after the section 13 alias fix): ${outcome1C01 ? JSON.stringify(outcome1C01) : "(no 1C01 cleaning outcome found in this real run)"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
