/**
 * ABF warehouse code matching — READ-ONLY analysis, no writes anywhere.
 *
 *   node scripts/matchAbfCodes.ts
 *
 * Reads private-imports/Ultimátní kalkulace V6.6.xlsm (PRICELIST + CZK sheet for the 23
 * technical services) and private-imports/vyjezd abry sklad.xlsx (ABF warehouse export),
 * both via exceljs' read-only API. Neither source file is ever written back to. No
 * Supabase, no R2, no catalog/db writes of any kind — this is analysis only.
 *
 * Writes:
 *   private-imports/code-matching-report.json
 *   private-imports/code-matching-report.xlsx  (new file — the ORIGINAL xlsm/xlsx are untouched)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { readWorkbookSheets, extractSheetGrid } from "../lib/import/xlsxReader.server.ts";
import { normalizePricelistSheet, normalizeEventPricingSheet } from "../domain/priceImport.ts";
import { assessMatch, type AbfItem, type MatchAssessment } from "../domain/abfCodeMatching.ts";

const XLSM_PATH = path.resolve(process.cwd(), "private-imports", "Ultimátní kalkulace V6.6.xlsm");
const ABF_PATH = path.resolve(process.cwd(), "private-imports", "vyjezd abry sklad.xlsx");

async function readAbfCatalog(filePath: string): Promise<readonly AbfItem[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath); // read-only — never .writeFile() on this workbook
  const sheet = workbook.worksheets[0]!;
  const header = (sheet.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? "").trim());
  const colIndex = (label: string) => header.findIndex((h) => h === label);
  const cols = {
    code: colIndex("Kód"),
    name: colIndex("Název"),
    spec: colIndex("Specifikace"),
    unit: colIndex("Hlav. jedn."),
    shortName: colIndex("Zkr.název"),
    spec2: colIndex("Specifikace2"),
    foreign: colIndex("Cizí název"),
  };
  for (const [key, index] of Object.entries(cols)) if (index < 0) throw new Error(`ABF sklad: sloupec pro "${key}" nebyl nalezen v hlavičce.`);

  const items: AbfItem[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const cell = (index: number) => row.getCell(index + 1).value;
    const codeRaw = cell(cols.code);
    const code = codeRaw === null || codeRaw === undefined ? "" : String(codeRaw).trim();
    if (!code) continue;
    const text = (value: ExcelJS.CellValue) => (value === null || value === undefined ? null : String(value).trim() || null);
    items.push({
      code,
      name: text(cell(cols.name)) ?? "",
      spec: text(cell(cols.spec)),
      unit: text(cell(cols.unit)),
      shortName: text(cell(cols.shortName)),
      spec2: text(cell(cols.spec2)),
      foreignName: text(cell(cols.foreign)),
    });
  }
  return items;
}

type PricelistReportRow = Readonly<{
  sourceRow: number;
  category: string;
  nameCz: string;
  nameEn: string | null;
  currentInternalCode: string | null;
  unit: string | null;
  assessment: MatchAssessment;
}>;

type TechnicalServiceReportRow = Readonly<{
  sourceKey: string;
  nameCz: string;
  assessment: MatchAssessment;
}>;

function buildSourceKey(rawName: string): string {
  return rawName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "-");
}

async function main() {
  const abfCatalog = await readAbfCatalog(ABF_PATH);
  console.log("ABF warehouse items loaded:", abfCatalog.length);

  const xlsmWorkbook = await readWorkbookSheets(XLSM_PATH); // read-only — never written back
  const pricelistRows = normalizePricelistSheet(extractSheetGrid(xlsmWorkbook, "PRICELIST"));
  const czkRows = normalizeEventPricingSheet(extractSheetGrid(xlsmWorkbook, "CZK"));
  console.log("PRICELIST rows:", pricelistRows.length, "| technical-service source rows (CZK sheet):", czkRows.length);

  // Known Batch #1 canonical mappings (M57 confirmed, L02 confirmed, kettle rejected) —
  // reused for cross-reference only, never re-derived or changed here.
  const pricelistReport: PricelistReportRow[] = pricelistRows.map((row) => ({
    sourceRow: row.sourceRow,
    category: row.category,
    nameCz: row.rawNameCz,
    nameEn: row.rawNameEn,
    currentInternalCode: null, // PRICELIST never carries an internalCode column — always null pre-match
    unit: row.unit.unit,
    assessment: assessMatch({ nameCz: row.rawNameCz, nameEn: row.rawNameEn, unit: row.unit.unit }, abfCatalog),
  }));

  const technicalServiceReport: TechnicalServiceReportRow[] = czkRows.map((row) => ({
    sourceKey: buildSourceKey(row.rawName),
    nameCz: row.rawName,
    assessment: assessMatch({ nameCz: row.rawName }, abfCatalog),
  }));

  const counts = (rows: readonly { assessment: MatchAssessment }[]) => ({
    total: rows.length,
    EXACT_SAFE: rows.filter((r) => r.assessment.status === "EXACT_SAFE").length,
    REVIEW: rows.filter((r) => r.assessment.status === "REVIEW").length,
    NO_MATCH: rows.filter((r) => r.assessment.status === "NO_MATCH").length,
  });

  console.log("=== PRICELIST ===", JSON.stringify(counts(pricelistReport)));
  console.log("=== TECHNICAL SERVICES ===", JSON.stringify(counts(technicalServiceReport)));

  const autoAssign = pricelistReport
    .filter((r) => r.assessment.action === "AUTO_ASSIGN")
    .map((r) => ({ sourceRow: r.sourceRow, nameCz: r.nameCz, abfCode: r.assessment.proposedCode, abfName: r.assessment.proposedName, reasons: r.assessment.matchReasons }));
  const technicalServiceAutoAssign = technicalServiceReport
    .filter((r) => r.assessment.action === "AUTO_ASSIGN")
    .map((r) => ({ sourceKey: r.sourceKey, nameCz: r.nameCz, abfCode: r.assessment.proposedCode, abfName: r.assessment.proposedName, reasons: r.assessment.matchReasons }));

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    note: "READ-ONLY analysis. Neither source .xlsm/.xlsx was modified. DATABASE WRITES = 0, R2 WRITES = 0, Batch #2A APPLY = NO.",
    sources: { xlsm: XLSM_PATH, abf: ABF_PATH },
    counts: { pricelist: counts(pricelistReport), technicalServices: counts(technicalServiceReport) },
    pricelist: pricelistReport,
    technicalServices: technicalServiceReport,
    autoAssign: { pricelist: autoAssign, technicalServices: technicalServiceAutoAssign },
  };
  const jsonPath = path.resolve(process.cwd(), "private-imports", "code-matching-report.json");
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), "utf8");
  console.log("JSON report written:", jsonPath);

  // ============================= XLSX REPORT (brand-new file) =============================
  const outWorkbook = new ExcelJS.Workbook();
  const sheet = outWorkbook.addWorksheet("Code matching");
  sheet.columns = [
    { header: "PRICELIST row", key: "row", width: 12 },
    { header: "Category", key: "category", width: 14 },
    { header: "CZ name", key: "nameCz", width: 42 },
    { header: "EN name", key: "nameEn", width: 42 },
    { header: "Current internalCode", key: "currentCode", width: 16 },
    { header: "Proposed ABF code", key: "abfCode", width: 16 },
    { header: "ABF name", key: "abfName", width: 42 },
    { header: "ABF EN name", key: "abfNameEn", width: 42 },
    { header: "ABF unit", key: "abfUnit", width: 10 },
    { header: "Match status", key: "status", width: 12 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Match reasons", key: "matchReasons", width: 40 },
    { header: "Conflict reasons", key: "conflictReasons", width: 40 },
    { header: "Alternative candidates", key: "alternatives", width: 40 },
    { header: "Action", key: "action", width: 14 },
  ];
  for (const row of pricelistReport) {
    sheet.addRow({
      row: row.sourceRow,
      category: row.category,
      nameCz: row.nameCz,
      nameEn: row.nameEn ?? "",
      currentCode: row.currentInternalCode ?? "",
      abfCode: row.assessment.proposedCode ?? "",
      abfName: row.assessment.proposedName ?? "",
      abfNameEn: row.assessment.proposedForeignName ?? "",
      abfUnit: row.assessment.proposedUnit ?? "",
      status: row.assessment.status,
      confidence: Number(row.assessment.confidence.toFixed(2)),
      matchReasons: row.assessment.matchReasons.join(" | "),
      conflictReasons: row.assessment.conflictReasons.join(" | "),
      alternatives: row.assessment.alternatives.map((a) => `${a.abfCode} (${a.abfName})`).join(" | "),
      action: row.assessment.action,
    });
  }
  sheet.addRow({});
  sheet.addRow({ row: "TECHNICAL SERVICES (Batch #2A — 23 source rows)" });
  for (const row of technicalServiceReport) {
    sheet.addRow({
      row: row.sourceKey,
      category: "T. služby",
      nameCz: row.nameCz,
      nameEn: "",
      currentCode: "",
      abfCode: row.assessment.proposedCode ?? "",
      abfName: row.assessment.proposedName ?? "",
      abfNameEn: row.assessment.proposedForeignName ?? "",
      abfUnit: row.assessment.proposedUnit ?? "",
      status: row.assessment.status,
      confidence: Number(row.assessment.confidence.toFixed(2)),
      matchReasons: row.assessment.matchReasons.join(" | "),
      conflictReasons: row.assessment.conflictReasons.join(" | "),
      alternatives: row.assessment.alternatives.map((a) => `${a.abfCode} (${a.abfName})`).join(" | "),
      action: row.assessment.action,
    });
  }
  sheet.getRow(1).font = { bold: true };

  const xlsxPath = path.resolve(process.cwd(), "private-imports", "code-matching-report.xlsx");
  await outWorkbook.xlsx.writeFile(xlsxPath); // writes a NEW file only — XLSM_PATH/ABF_PATH are never touched
  console.log("XLSX report written:", xlsxPath);

  console.log();
  console.log("=== ZERO WRITES ASSERTION ===");
  console.log("Original XLSM modified: NO | Original ABF xlsx modified: NO | Supabase writes: 0 | R2 writes: 0 | Batch #2A apply: NO");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
