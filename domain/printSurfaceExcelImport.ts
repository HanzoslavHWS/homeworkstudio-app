/**
 * Tiskové plochy — pure import pipeline for the real "rozmery_tisk_1_0.xlsx" catalog (sheet
 * "verze_1.0"). Deliberately has no dependency on any Excel-reading library — like
 * domain/priceImport.ts, it takes a plain RawSheetRow[] grid; the real reader
 * (lib/import/xlsxReader.server.ts) just adapts exceljs output into this shape, and
 * app/api/print-surfaces/import/route.ts is the only place that combines the two.
 *
 * Confirmed real structure (see the task's Excel-inspection step): a TWO-row header — row 1 names
 * columns A–D ("interni id"/"nazev"/"typ"/"parent_id") plus a realizační-společnost name repeated
 * across a width/height column pair (e.g. "Creativ Expo" over both E and F); row 2 labels each pair
 * "š"/"v". Data starts row 3. Company names/columns are read from the header itself, never
 * hardcoded — this file makes no assumption about which/how many realizačky exist beyond what the
 * header actually lists.
 *
 * Pipeline: parsePrintSurfaceExcelSheet (parse) → resolveCompanyDimensionOutcome / isGroupRow /
 * mapExcelRowToPrintSurfaceType (normalize+map, per row) → importPrintSurfaceExcel (validate +
 * assemble). "apply" (persisting the result) is NOT here — that's the caller's job (writing the
 * returned arrays into the three catalog repositories' replaceAll()).
 */

import type { RawCellValue, RawSheetRow } from "./priceImport.ts";
import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";
import type { PrintSurfacePreset } from "./printSurfacePreset.ts";
import type { RealizationCompany } from "./realizationCompany.ts";
import { findDuplicateProductionDimensionKeys, type PrintSurfaceProductionDimension } from "./printSurfaceProductionDimension.ts";

export const PRINT_SURFACE_EXCEL_SHEET_NAME = "verze_1.0";

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export type PrintSurfaceExcelDimensionCell =
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "no" }>
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "invalid"; raw: string }>;

export type PrintSurfaceExcelCompanyCell = Readonly<{
  companyName: string;
  width: PrintSurfaceExcelDimensionCell;
  height: PrintSurfaceExcelDimensionCell;
}>;

export type PrintSurfaceExcelRow = Readonly<{
  sourceRow: number;
  internalId: string;
  name: string;
  typ: string;
  parentId?: string;
  companies: readonly PrintSurfaceExcelCompanyCell[];
}>;

export type PrintSurfaceExcelHeaderError = Readonly<{ code: "INVALID_HEADER"; message: string }>;

export type PrintSurfaceExcelParseResult =
  | Readonly<{ ok: true; companyNames: readonly string[]; rows: readonly PrintSurfaceExcelRow[] }>
  | Readonly<{ ok: false; error: PrintSurfaceExcelHeaderError }>;

function cellText(value: RawCellValue): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function classifyDimensionCell(value: RawCellValue): PrintSurfaceExcelDimensionCell {
  if (value === null || value === undefined) return { kind: "blank" };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { kind: "number", value } : { kind: "invalid", raw: String(value) };
  }
  const trimmed = String(value).trim();
  if (trimmed === "") return { kind: "blank" };
  if (trimmed.toLowerCase() === "no") return { kind: "no" };
  const numeric = Number(trimmed.replace(",", "."));
  return Number.isFinite(numeric) ? { kind: "number", value: numeric } : { kind: "invalid", raw: trimmed };
}

/**
 * Header: A/B/C/D = interni id/nazev/typ/parent_id, then repeating width/height column pairs from
 * column E onward, each pair's row-1 cell holding the realizačka's name (repeated over both
 * columns) and row-2 holding "š"/"v". Company columns are discovered here, not assumed fixed.
 */
export function parsePrintSurfaceExcelSheet(rows: readonly RawSheetRow[]): PrintSurfaceExcelParseResult {
  const headerRow1 = rows[0] ?? [];
  const headerRow2 = rows[1] ?? [];

  const expectedLeadColumns = ["interni id", "nazev", "typ", "parent_id"];
  for (let col = 0; col < expectedLeadColumns.length; col++) {
    if (cellText(headerRow1[col]).toLowerCase() !== expectedLeadColumns[col]) {
      return {
        ok: false,
        error: {
          code: "INVALID_HEADER",
          message: `Neočekávaná hlavička — sloupec ${String.fromCharCode(65 + col)} má být "${expectedLeadColumns[col]}".`,
        },
      };
    }
  }

  const companyColumns: Readonly<{ name: string; widthCol: number; heightCol: number }>[] = [];
  for (let col = 4; col < Math.max(headerRow1.length, headerRow2.length); col += 2) {
    const name = cellText(headerRow1[col]);
    if (!name) continue;
    const widthLabel = cellText(headerRow2[col]).toLowerCase();
    const heightLabel = cellText(headerRow2[col + 1]).toLowerCase();
    if (widthLabel !== "š" || heightLabel !== "v") {
      return {
        ok: false,
        error: {
          code: "INVALID_HEADER",
          message: `Neočekávaná dvouřádková hlavička u realizačky "${name}" (očekáváno š/v).`,
        },
      };
    }
    companyColumns.push({ name, widthCol: col, heightCol: col + 1 });
  }
  if (companyColumns.length === 0) {
    return { ok: false, error: { code: "INVALID_HEADER", message: "V hlavičce nebyla nalezena žádná realizační společnost." } };
  }

  const parsedRows: PrintSurfaceExcelRow[] = [];
  for (let rowIndex = 2; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] ?? [];
    const internalId = cellText(row[0]);
    const name = cellText(row[1]);
    if (!internalId && !name) continue; // fully blank trailing row
    parsedRows.push({
      sourceRow: rowIndex + 1,
      internalId,
      name,
      typ: cellText(row[2]),
      parentId: cellText(row[3]) || undefined,
      companies: companyColumns.map((company) => ({
        companyName: company.name,
        width: classifyDimensionCell(row[company.widthCol]),
        height: classifyDimensionCell(row[company.heightCol]),
      })),
    });
  }

  return { ok: true, companyNames: companyColumns.map((company) => company.name), rows: parsedRows };
}

// ---------------------------------------------------------------------------
// normalize + map (per row / per company cell)
// ---------------------------------------------------------------------------

/** A "parent"/product-group row (e.g. "Pult 1 x 0,5 x 1,1 m") has NO dimension data anywhere — it only exists to name/group its Čelo/Bok children, never a print surface of its own. */
export function isGroupRow(row: PrintSurfaceExcelRow): boolean {
  return row.companies.every((cell) => cell.width.kind === "blank" && cell.height.kind === "blank");
}

export type PrintSurfaceExcelIssueCode =
  | "DUPLICATE_INTERNAL_ID"
  | "UNKNOWN_PARENT_ID"
  | "UNKNOWN_TYPE"
  | "EMPTY_NAME"
  | "INVALID_DIMENSION"
  | "INCOMPLETE_DIMENSION"
  | "INVALID_NO_VALUE"
  | "DUPLICATE_COMPANY_PRESET";

export type PrintSurfaceExcelIssue = Readonly<{
  code: PrintSurfaceExcelIssueCode;
  severity: "error" | "warning";
  message: string;
  sourceRow?: number;
  internalId?: string;
  companyName?: string;
  field?: "width" | "height";
}>;

/**
 * PANELY: "Panel_S_Dvere" (naddveřní panel) → panel_above_door, every other stěnový panel → panel.
 * SHOWCASE: always → showcase (no front/side split — this app's catalog doesn't distinguish those
 * for vitríny). COUNTER: split by the CHILD row's own name — "Čelo" → counter_front, "Bok" →
 * counter_side; anything else under typ=counter can't be mapped unambiguously. The single place
 * this mapping happens — never re-implemented inline in a component.
 */
export function mapExcelRowToPrintSurfaceType(
  row: Readonly<{ typ: string; name: string }>,
): Readonly<{ ok: true; typeId: PrintSurfaceTypeId }> | Readonly<{ ok: false; issue: Pick<PrintSurfaceExcelIssue, "code" | "severity" | "message"> }> {
  const typ = row.typ.trim().toLowerCase();
  const name = row.name.trim();

  if (typ === "panel") {
    return name.toLowerCase().includes("naddveřní")
      ? { ok: true, typeId: "panel_above_door" }
      : { ok: true, typeId: "panel" };
  }
  if (typ === "showcase") {
    return { ok: true, typeId: "showcase" };
  }
  if (typ === "counter") {
    if (name === "Čelo") return { ok: true, typeId: "counter_front" };
    if (name === "Bok") return { ok: true, typeId: "counter_side" };
    return {
      ok: false,
      issue: {
        code: "UNKNOWN_TYPE",
        severity: "error",
        message: `Nelze jednoznačně namapovat counter podle názvu "${row.name}" (očekáváno "Čelo" nebo "Bok").`,
      },
    };
  }
  return { ok: false, issue: { code: "UNKNOWN_TYPE", severity: "error", message: `Neznámý typ "${row.typ}".` } };
}

type CompanyDimensionOutcome =
  | Readonly<{ kind: "available"; widthMm: number; heightMm: number }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "not_defined" }>;

/**
 * Classifies one company's width/height cell PAIR. "NO" must be case-insensitive/trimmed and
 * present in BOTH cells to mean unavailable (spec) — one NO + one number/blank is a validation
 * error (INVALID_NO_VALUE), never treated as unavailable. Blank+blank is a normal not-yet-defined
 * state (no issue); blank+number is a real data problem (INCOMPLETE_DIMENSION warning) but still
 * resolves to not_defined, never a guessed size.
 */
function resolveCompanyDimensionOutcome(
  cell: PrintSurfaceExcelCompanyCell,
  context: Readonly<{ sourceRow: number; internalId: string }>,
): Readonly<{ outcome: CompanyDimensionOutcome; issue?: PrintSurfaceExcelIssue }> {
  const { width, height } = cell;
  const base = { sourceRow: context.sourceRow, internalId: context.internalId, companyName: cell.companyName };

  if (width.kind === "invalid" || height.kind === "invalid") {
    return {
      outcome: { kind: "not_defined" },
      issue: {
        ...base,
        code: "INVALID_DIMENSION",
        severity: "error",
        message: `Neplatná hodnota rozměru u "${context.internalId}" (${cell.companyName}).`,
        field: width.kind === "invalid" ? "width" : "height",
      },
    };
  }
  if (width.kind === "no" && height.kind === "no") {
    return { outcome: { kind: "unavailable" } };
  }
  if (width.kind === "no" || height.kind === "no") {
    return {
      outcome: { kind: "not_defined" },
      issue: {
        ...base,
        code: "INVALID_NO_VALUE",
        severity: "error",
        message: `"NO" musí být v obou buňkách (šířka i výška) — "${context.internalId}" (${cell.companyName}) má NO jen v jedné z nich.`,
      },
    };
  }
  if (width.kind === "blank" && height.kind === "blank") {
    return { outcome: { kind: "not_defined" } };
  }
  if (width.kind === "blank" || height.kind === "blank") {
    return {
      outcome: { kind: "not_defined" },
      issue: {
        ...base,
        code: "INCOMPLETE_DIMENSION",
        severity: "warning",
        message: `Neúplný rozměr u "${context.internalId}" (${cell.companyName}) — chybí ${width.kind === "blank" ? "šířka" : "výška"}.`,
        field: width.kind === "blank" ? "width" : "height",
      },
    };
  }
  if (width.kind === "number" && height.kind === "number") {
    return { outcome: { kind: "available", widthMm: width.value, heightMm: height.value } };
  }
  return { outcome: { kind: "not_defined" } };
}

function slugifyCompanyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "-");
}

// ---------------------------------------------------------------------------
// validate + assemble
// ---------------------------------------------------------------------------

export type PrintSurfaceExcelImportCounts = Readonly<{
  realizationCompanies: number;
  presets: number;
  parentRows: number;
  available: number;
  unavailable: number;
  notDefinedOrIncomplete: number;
  warnings: number;
  errors: number;
}>;

export type PrintSurfaceExcelImportResult = Readonly<{
  companies: readonly RealizationCompany[];
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  issues: readonly PrintSurfaceExcelIssue[];
  counts: PrintSurfaceExcelImportCounts;
}>;

export type PrintSurfaceExcelImportOutcome =
  | Readonly<{ ok: true; result: PrintSurfaceExcelImportResult }>
  | Readonly<{ ok: false; error: PrintSurfaceExcelHeaderError }>;

/**
 * Full parse → normalize → validate → map pipeline over one already-extracted sheet grid. Never
 * touches a repository — the caller decides whether/when to persist result.{companies,presets,
 * productionDimensions} (typically only once result.counts.errors === 0).
 */
export function importPrintSurfaceExcel(rows: readonly RawSheetRow[]): PrintSurfaceExcelImportOutcome {
  const parsed = parsePrintSurfaceExcelSheet(rows);
  if (parsed.ok === false) {
    return { ok: false, error: parsed.error };
  }

  const issues: PrintSurfaceExcelIssue[] = [];

  const rowsByInternalId = new Map<string, PrintSurfaceExcelRow>();
  for (const row of parsed.rows) {
    if (rowsByInternalId.has(row.internalId)) {
      issues.push({
        code: "DUPLICATE_INTERNAL_ID",
        severity: "error",
        message: `Duplicitní interní ID "${row.internalId}".`,
        sourceRow: row.sourceRow,
        internalId: row.internalId,
      });
      continue; // first occurrence wins, matching this app's existing dedup convention elsewhere
    }
    rowsByInternalId.set(row.internalId, row);
  }

  const parentNameById = new Map<string, string>();
  let parentRowCount = 0;
  for (const row of rowsByInternalId.values()) {
    if (isGroupRow(row)) {
      parentNameById.set(row.internalId, row.name);
      parentRowCount++;
    }
  }

  const companies: RealizationCompany[] = parsed.companyNames.map((name) => ({
    id: slugifyCompanyName(name),
    name,
    isActive: true,
  }));
  const companyIdByName = new Map(companies.map((company) => [company.name, company.id] as const));

  const presets: PrintSurfacePreset[] = [];
  const productionDimensions: PrintSurfaceProductionDimension[] = [];
  let availableCount = 0;
  let unavailableCount = 0;
  let notDefinedCount = 0;

  for (const row of rowsByInternalId.values()) {
    if (isGroupRow(row)) continue; // metadata only — never its own preset/production dimension

    if (!row.name) {
      issues.push({ code: "EMPTY_NAME", severity: "error", message: `Prázdný název u "${row.internalId}".`, sourceRow: row.sourceRow, internalId: row.internalId });
      continue;
    }

    if (row.parentId && !parentNameById.has(row.parentId)) {
      issues.push({
        code: "UNKNOWN_PARENT_ID",
        severity: "error",
        message: `Neznámý parent_id "${row.parentId}" u "${row.internalId}".`,
        sourceRow: row.sourceRow,
        internalId: row.internalId,
      });
    }

    const typeMapping = mapExcelRowToPrintSurfaceType(row);
    if (typeMapping.ok === false) {
      const { issue } = typeMapping;
      issues.push({ ...issue, sourceRow: row.sourceRow, internalId: row.internalId });
      continue; // never invent a typeId — no preset created for this row
    }

    presets.push({
      id: row.internalId,
      typeId: typeMapping.typeId,
      name: row.name,
      isActive: true,
      parentId: row.parentId,
      parentName: row.parentId ? parentNameById.get(row.parentId) : undefined,
    });

    for (const companyCell of row.companies) {
      const companyId = companyIdByName.get(companyCell.companyName);
      if (!companyId) continue; // structurally unreachable — companies are derived from the same header
      const { outcome, issue } = resolveCompanyDimensionOutcome(companyCell, { sourceRow: row.sourceRow, internalId: row.internalId });
      if (issue) issues.push(issue);
      if (outcome.kind === "available") {
        productionDimensions.push({ realizationCompanyId: companyId, presetId: row.internalId, status: "available", widthMm: outcome.widthMm, heightMm: outcome.heightMm });
        availableCount++;
      } else if (outcome.kind === "unavailable") {
        productionDimensions.push({ realizationCompanyId: companyId, presetId: row.internalId, status: "unavailable" });
        unavailableCount++;
      } else {
        notDefinedCount++;
      }
    }
  }

  for (const duplicate of findDuplicateProductionDimensionKeys(productionDimensions)) {
    issues.push({
      code: "DUPLICATE_COMPANY_PRESET",
      severity: "error",
      message: `Duplicitní kombinace realizačka + tisková plocha ("${duplicate.realizationCompanyId}" / "${duplicate.presetId}").`,
      internalId: duplicate.presetId,
      companyName: duplicate.realizationCompanyId,
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;

  return {
    ok: true,
    result: {
      companies,
      presets,
      productionDimensions,
      issues,
      counts: {
        realizationCompanies: companies.length,
        presets: presets.length,
        parentRows: parentRowCount,
        available: availableCount,
        unavailable: unavailableCount,
        notDefinedOrIncomplete: notDefinedCount,
        warnings,
        errors,
      },
    },
  };
}
