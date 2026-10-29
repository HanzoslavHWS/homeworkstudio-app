/**
 * Technické rastry — HOTFIX-02 real-file check: the approved technical marker Excel
 * (`_IMPORT/TECHNICKE_ZNACKY/Generator_ABF_Revize_technickych_znacek.xlsx`, git-ignored, never
 * committed) against domain/technicalMarkerApprovedTable.ts AND the live presentation
 * (domain/technicalRasterServicePresentation.ts). For every approved row it compares the ABRA name
 * (B), the raster label (K), the PDF text (L), the color (N) and the point rule (P).
 *
 * SKIP-SAFE: exits 0 with a message when the Excel is missing. Exits 1 on any difference — run it
 * after the Excel is revised, before changing the table by hand.
 *
 * Usage:
 *   npm run test:technical-markers-excel
 *   node --no-warnings scripts/technicalMarkersExcelCheck.ts [path.xlsx]
 */
import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APPROVED_MARKER_CATEGORY_IDS, APPROVED_TECHNICAL_MARKER_ROWS } from "../domain/technicalMarkerApprovedTable.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const excelPath = path.resolve(repoRoot, process.argv[2] ?? "_IMPORT/TECHNICKE_ZNACKY/Generator_ABF_Revize_technickych_znacek.xlsx");
const SAMPLE_QUANTITY = 3;

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in value) return value.richText.map((part) => part.text).join("").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  return String(value).trim();
}

async function main(): Promise<number> {
  if (!existsSync(excelPath)) {
    console.log(`SKIP: ${excelPath} nenalezen — schválený Excel technických značek není k dispozici (není v Gitu).`);
    return 0;
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet("Technické značky");
  if (!sheet) {
    console.log("✖ list „Technické značky“ v Excelu chybí");
    return 1;
  }

  const problems: string[] = [];
  const excelRows: { category: string; abraName: string; label: string; pdfText: string; color: string; rule: string; approval: string }[] = [];
  sheet.eachRow((excelRow, rowNumber) => {
    if (rowNumber === 1) return;
    const text = (column: string) => cellText(excelRow.getCell(column).value);
    const categoryName = text("A");
    if (!categoryName) return;
    excelRows.push({ category: APPROVED_MARKER_CATEGORY_IDS[categoryName] ?? `?${categoryName}`, abraName: text("B"), label: text("K"), pdfText: text("L"), color: text("N").toLowerCase(), rule: text("P"), approval: text("Q") });
  });

  if (excelRows.length !== APPROVED_TECHNICAL_MARKER_ROWS.length) problems.push(`počet řádků: Excel ${excelRows.length} × tabulka ${APPROVED_TECHNICAL_MARKER_ROWS.length}`);
  excelRows.forEach((excel, index) => {
    const approved = APPROVED_TECHNICAL_MARKER_ROWS[index];
    const where = `ř. ${index + 2} „${excel.abraName}“`;
    if (excel.approval !== "Schváleno") problems.push(`${where}: stav „${excel.approval}“, ne „Schváleno“`);
    if (excel.label !== excel.pdfText) problems.push(`${where}: popisek v rastru „${excel.label}“ ≠ text v PDF „${excel.pdfText}“`);
    if (!approved || approved.abraName !== excel.abraName || approved.category !== excel.category || approved.label !== excel.label || approved.color !== excel.color || approved.rule !== excel.rule) {
      problems.push(`${where}: tabulka v kódu se liší (${JSON.stringify(approved)} × ${JSON.stringify(excel)})`);
    }
    const presentation = resolveTechnicalServicePresentation(excel.category, excel.abraName, SAMPLE_QUANTITY);
    const expectedLabel = excel.label.replace("{mnozstvi}", String(SAMPLE_QUANTITY));
    const expectedCardinality = excel.rule === "Vždy 1 bod" ? "onePerRecord" : "perQuantity";
    if (presentation.displayLabel !== expectedLabel) problems.push(`${where}: generátor zobrazí „${presentation.displayLabel}“, schváleno „${expectedLabel}“`);
    if (presentation.color !== excel.color) problems.push(`${where}: barva ${presentation.color}, schváleno ${excel.color}`);
    if (presentation.placementCardinality !== expectedCardinality) problems.push(`${where}: počet bodů ${presentation.placementCardinality}, schváleno „${excel.rule}“`);
  });

  for (const problem of problems) console.log(`✖ ${problem}`);
  console.log(problems.length === 0 ? `✔ ${excelRows.length} schválených technických značek odpovídá generátoru (popisek, PDF text, barva, počet bodů)` : `✖ ${problems.length} rozdílů`);
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = await main();
