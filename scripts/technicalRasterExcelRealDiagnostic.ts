/**
 * Technické rastry — real-file check of the Excel (.xlsx) import against the PDF import of the
 * SAME ABRA reports. For every "Přehled - …" report found in both <dir>/PDF and <dir>/EXCEL it
 * runs both parsers and compares them stand by stand (company, services + quantities, "BEZ"),
 * then prints the Excel control report (column mapping, "Celkem" check) and all warnings.
 *
 * Real exhibitor data — never committed (_IMPORT/ is git-ignored) and NEVER part of `npm test`.
 * SKIP-SAFE: exits 0 with a message when the directory is missing. Exits 1 when the formats
 * disagree, so it can be used as a local regression check after a parser change.
 *
 * Usage:
 *   npm run test:technical-raster-excel-real
 *   node --no-warnings scripts/technicalRasterExcelRealDiagnostic.ts [dir]
 * Default dir: _IMPORT/TEST_TECHNICKYCH_VYJEZDU/FOR_BEAUTY_2026
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readTechnicalReportWorkbook } from "../lib/import/technicalReportWorkbookReader.server.ts";
import { parseTechnicalReportWorkbook } from "../domain/technicalReportExcelTable.ts";
import { detectLikelyTechnicalReportCategory, getTechnicalReportParser } from "../domain/technicalReportParsers/index.ts";
import type { ParsedTechnicalReport } from "../domain/technicalRaster.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseDir = path.resolve(repoRoot, process.argv[2] ?? "_IMPORT/TEST_TECHNICKYCH_VYJEZDU/FOR_BEAUTY_2026");

/** "Přehled - úklid (2026_10_29 09-43).pdf" → "Přehled - úklid" — PDF and Excel of one report differ only in the export timestamp. */
function reportTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "").replace(/\s*\([^)]*\)\s*$/u, "").trim();
}

async function pdfItems(filePath: string): Promise<PdfTextItem[]> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await readFile(filePath)), verbosity: 0 });
  const doc = await loadingTask.promise;
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const content = await (await doc.getPage(pageNumber)).getTextContent();
    for (const it of content.items as { str: string; width: number; height: number; transform: number[] }[]) {
      if (!it.str.trim()) continue;
      items.push({ str: it.str, page: pageNumber, x: it.transform[4]!, y: it.transform[5]!, width: it.width, height: it.height || Math.abs(it.transform[3]!) });
    }
  }
  await loadingTask.destroy();
  return items;
}

function standSignature(report: ParsedTechnicalReport): Map<string, string> {
  return new Map(report.rows.map((row) => [
    row.standNumber,
    `${row.companyName ?? ""} | ${row.services.map((service) => `${service.externalLabel}=${service.quantity}`).sort().join("; ")}${row.explicitNoServiceAssignment ? " | BEZ" : ""}`,
  ]));
}

async function main(): Promise<number> {
  const pdfDir = path.join(baseDir, "PDF");
  const excelDir = path.join(baseDir, "EXCEL");
  if (!existsSync(pdfDir) || !existsSync(excelDir)) {
    console.log(`SKIP: ${baseDir} neobsahuje podsložky PDF a EXCEL — reálné výjezdy nejsou k dispozici (nejsou v Gitu).`);
    return 0;
  }

  const pdfByTitle = new Map(readdirSync(pdfDir).filter((name) => name.toLowerCase().endsWith(".pdf")).map((name) => [reportTitle(name), name]));
  let failures = 0;
  for (const excelName of readdirSync(excelDir).filter((name) => name.toLowerCase().endsWith(".xlsx")).sort()) {
    const title = reportTitle(excelName);
    const category = detectLikelyTechnicalReportCategory(title);
    console.log(`\n=== ${title} → ${category ?? "?"}`);
    if (!category || !getTechnicalReportParser(category)) {
      console.log("  ⚠ kategorie nerozpoznána z názvu souboru — přeskočeno");
      continue;
    }

    const workbook = await readTechnicalReportWorkbook(await readFile(path.join(excelDir, excelName)));
    const { report: excel, check } = parseTechnicalReportWorkbook(category, workbook);
    const serviceCount = (report: ParsedTechnicalReport) => report.rows.reduce((sum, row) => sum + row.services.length, 0);
    console.log(`  Excel: ${excel.rows.length} stánků, ${serviceCount(excel)} služeb, ${excel.rows.filter((row) => row.explicitNoServiceAssignment).length}× BEZ, ${excel.warnings.length} upozornění`);
    if (check) {
      console.log(`  list „${check.sheetName}“, hlavička ř. ${check.headerRowNumbers.join("+")}, součty: ${check.totals.status}`);
      console.log(`  sloupce: ${check.columns.map((column) => `${column.label} [${column.headerColumn}→${column.valueColumn}]`).join(", ")}`);
    }
    for (const warning of excel.warnings) console.log(`  ⚠ ${warning.message}${warning.rawText ? ` — „${warning.rawText}“` : ""}`);

    const pdfName = pdfByTitle.get(title);
    if (!pdfName) {
      console.log("  (PDF stejného přehledu nenalezeno — bez porovnání)");
      continue;
    }
    const pdf = getTechnicalReportParser(category)!.parse(await pdfItems(path.join(pdfDir, pdfName)));
    console.log(`  PDF:   ${pdf.rows.length} stánků, ${serviceCount(pdf)} služeb, ${pdf.rows.filter((row) => row.explicitNoServiceAssignment).length}× BEZ, ${pdf.warnings.length} upozornění, ${pdf.rows.reduce((sum, row) => sum + row.notes.length, 0)} poznámek`);

    const excelStands = standSignature(excel);
    const pdfStands = standSignature(pdf);
    const differences = [...new Set([...excelStands.keys(), ...pdfStands.keys()])].filter((stand) => excelStands.get(stand) !== pdfStands.get(stand));
    for (const stand of differences) console.log(`  ✖ ${stand}: Excel „${excelStands.get(stand) ?? "—"}“ × PDF „${pdfStands.get(stand) ?? "—"}“`);
    console.log(differences.length === 0 ? "  ✔ Excel a PDF se shodují (stánky, firmy, služby, množství, BEZ)" : `  ✖ ${differences.length} rozdílů`);
    failures += differences.length;
  }
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
