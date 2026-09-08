/**
 * Technické rastry — the parser adapter pattern (spec section 40): every technical-report PDF
 * category implements this SAME small interface. Adding a new report type later (spec section 8:
 * "další typy později bez refactoru") means writing one new file here and adding it to the
 * registry below — never touching domain/technicalRaster.ts's merge logic, which only ever
 * consumes the standardized ParsedTechnicalReport output.
 */
import {
  evaluateNumericCellValue,
  parseGenericStandTable,
  type PdfTextItem,
  type ParsedStandTableRow,
} from "../technicalReportTableParsing.ts";
import type { ParsedTechnicalReport, ParsedTechnicalServiceRow, TechnicalRasterImportWarning } from "../technicalRaster.ts";
import { normalizeStandNumber } from "../technicalStandNumber.ts";

export interface TechnicalReportParser {
  readonly category: string;
  /** Best-effort strings this report's title/header text usually contains — used ONLY for an "autodetected as: X" UI hint (spec section 8: "nesmí být jediný způsob"), never to silently pick the category instead of the user's own explicit choice. */
  readonly detectionHints: readonly string[];
  parse(items: readonly PdfTextItem[]): ParsedTechnicalReport;
}

/**
 * Shared row->service conversion every category parser below uses: one TechnicalService per
 * genuinely-ordered column value in a stand's row (spec section 11-14 — quantity is ALWAYS the
 * real parsed number, rawValue is ALWAYS kept verbatim, never coerced to a boolean). A column
 * value evaluating to "zero" (spec section 15: legitimately not ordered) is skipped — no noise
 * TechnicalService. A column value evaluating to "ambiguousCompound" (spec section 2/3: two real
 * report columns fused into one PDF text run, e.g. "0 1") NEVER becomes a guessed TechnicalService
 * either — it becomes a warning instead, with the raw label/value/row kept for traceability.
 * internalProductId/Code/status are deliberately NOT set here — domain/technicalRaster.ts's
 * mergeTechnicalRasterImport resolves those via the injected resolveProduct callback at merge
 * time (domain/technicalServiceProductMapping.ts), so a parser never needs catalog access.
 */
function tableRowToServiceRow(
  category: string,
  row: ParsedStandTableRow,
): Readonly<{ services: readonly ParsedTechnicalServiceRow["services"][number][]; warnings: readonly Omit<TechnicalRasterImportWarning, "id">[] }> {
  const services: ParsedTechnicalServiceRow["services"][number][] = [];
  const warnings: Omit<TechnicalRasterImportWarning, "id">[] = [];
  for (const [externalLabel, rawValue] of row.columnValues) {
    const evaluation = evaluateNumericCellValue(rawValue);
    if (evaluation.kind === "zero") continue;
    if (evaluation.kind === "ambiguousCompound") {
      warnings.push({
        message: `Nejednoznačná složená hodnota "${rawValue}" u stánku ${row.standNumber} (sloupec "${externalLabel}") — zdrojové PDF sloučilo více sloupců do jednoho textového pole, hodnota nebyla automaticky přiřazena ke konkrétní službě.`,
        page: row.page,
        rawText: row.rawRow,
      });
      continue;
    }
    services.push({ category, externalLabel, quantity: evaluation.quantity, rawValue, sourcePage: row.page, rawRow: row.rawRow });
  }
  return { services, warnings };
}

/** The one implementation every category parser calls — turns a generic table parse into the standardized ParsedTechnicalReport (spec section 40), grouping rows by normalized stand number and attaching notes (spec section 13) to the matching row. */
export function buildParsedTechnicalReport(category: string, items: readonly PdfTextItem[]): ParsedTechnicalReport {
  const table = parseGenericStandTable(items);
  const warnings: Omit<TechnicalRasterImportWarning, "id">[] = table.warnings.map((warning) => ({ message: warning.message, page: warning.page, rawText: warning.rawText }));

  const rowsByStand = new Map<string, { companyName?: string; page: number; services: ParsedTechnicalServiceRow["services"][number][]; notes: { text: string; sourcePage: number; rawRow?: string }[] }>();
  for (const row of table.rows) {
    const standNumber = normalizeStandNumber(row.standNumber);
    const { services, warnings: cellWarnings } = tableRowToServiceRow(category, row);
    warnings.push(...cellWarnings);
    const existing = rowsByStand.get(standNumber);
    if (existing) {
      existing.services.push(...services);
      existing.companyName = existing.companyName ?? row.companyName;
    } else {
      rowsByStand.set(standNumber, { companyName: row.companyName, page: row.page, services: [...services], notes: [] });
    }
  }
  for (const note of table.notes) {
    const standNumber = normalizeStandNumber(note.afterStandNumber);
    const target = rowsByStand.get(standNumber);
    if (target) {
      target.notes.push({ text: note.text, sourcePage: note.page, rawRow: note.rawRow });
    } else {
      warnings.push({ message: `Poznámka nalezena, ale nepodařilo se ji přiřadit ke stánku "${note.afterStandNumber}".`, page: note.page, rawText: note.text });
    }
  }

  const rows: ParsedTechnicalServiceRow[] = [...rowsByStand.entries()].map(([standNumber, data]) => ({
    standNumber,
    companyName: data.companyName,
    services: data.services,
    notes: data.notes,
  }));

  return { category, rows, warnings };
}
