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

/**
 * PRODUCTION BATCH ("BEZ elektriky" automatic red X, spec section 12/13) — a row's own columns ALL
 * evaluating to zero/blank IS this app's real, verified normalized meaning of an explicit "BEZ"
 * assignment (no literal "BEZ" text token was found in any real electricity fixture available this
 * batch — see the final report's own real-fixture-audit section; a real row for a stand with no
 * electricity ordered at all, e.g. "1A10 Super-Lock s.r.o. 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" in the
 * real Decor 26 electricity report, already parses to zero services today). Deliberately scoped to
 * `category === "electricity"` only (spec section 20/30: "primary service parsing except where
 * explicit BEZ normalization requires it") — every other category's row never sets this. Guarded by
 * `table.headerFound` and `row.columnValues.size > 0` so a report whose header wasn't detected at
 * all (every row would then trivially have zero columns/services) never floods every single stand
 * with a false "BEZ" flag — and by `cellWarnings.length === 0` so a row with a genuinely ambiguous
 * (never a confirmed zero) column is never mistaken for an explicit zero either.
 */
function isExplicitZeroElectricityRow(
  category: string,
  headerFound: boolean,
  row: ParsedStandTableRow,
  services: readonly ParsedTechnicalServiceRow["services"][number][],
  cellWarnings: readonly Omit<TechnicalRasterImportWarning, "id">[],
): boolean {
  return category === "electricity" && headerFound && row.columnValues.size > 0 && services.length === 0 && cellWarnings.length === 0;
}

/** The one implementation every category parser calls — turns a generic table parse into the standardized ParsedTechnicalReport (spec section 40), grouping rows by normalized stand number and attaching notes (spec section 13) to the matching row. */
export function buildParsedTechnicalReport(category: string, items: readonly PdfTextItem[]): ParsedTechnicalReport {
  const table = parseGenericStandTable(items);
  const warnings: Omit<TechnicalRasterImportWarning, "id">[] = table.warnings.map((warning) => ({ message: warning.message, page: warning.page, rawText: warning.rawText }));

  const rowsByStand = new Map<string, { companyName?: string; page: number; services: ParsedTechnicalServiceRow["services"][number][]; notes: { text: string; sourcePage: number; rawRow?: string }[]; explicitNoServiceAssignment: boolean }>();
  for (const row of table.rows) {
    const standNumber = normalizeStandNumber(row.standNumber);
    const { services, warnings: cellWarnings } = tableRowToServiceRow(category, row);
    warnings.push(...cellWarnings);
    const explicitZero = isExplicitZeroElectricityRow(category, table.headerFound, row, services, cellWarnings);
    const existing = rowsByStand.get(standNumber);
    if (existing) {
      existing.services.push(...services);
      existing.companyName = existing.companyName ?? row.companyName;
      // A real report normally has at most one row per stand; defensively, if it ever has more than
      // one, the combined row is only an explicit zero when EVERY contributing row was.
      existing.explicitNoServiceAssignment = existing.explicitNoServiceAssignment && explicitZero;
    } else {
      rowsByStand.set(standNumber, { companyName: row.companyName, page: row.page, services: [...services], notes: [], explicitNoServiceAssignment: explicitZero });
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
    explicitNoServiceAssignment: data.explicitNoServiceAssignment || undefined,
  }));

  return { category, rows, warnings };
}
