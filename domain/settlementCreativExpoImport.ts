/**
 * Kontrola vyúčtování — import of a Creativ Expo billing workbook ("Beauty podzim 2026 hala
 * 3.xlsx"). Pure: takes the sheet grids, returns stands/rows/warnings.
 *
 * Verified against the real files (hala 3 + hala 4):
 *  - "SOUHR vše" is a summary (label + amount per sheet). Read for a cross-check only.
 *  - Every other sheet is the SAME ~90-row price-list template: header row "Položka | Cena/kus/
 *    m2/bm | Kusy/m2/bm | Cena /položku", the title one row above ("3A17 <vystavovatel>"), then
 *    rows. Creativ fills the quantity ONLY on what it bills — typically 1-15 rows of 90. A blank
 *    or zero quantity is a template row: kept as original data, never a billed item.
 *  - Template rows are overwritten in place for one-off items ("služba", "grafika 3A29 ?").
 *  - Units exist only inside the item text ("Kč/1m2", "1 bm", "/m2"); the rest are pieces.
 *  - Sheets that are not one stand exist in every file: "ostatní", "4C1-2", and unused template
 *    copies named "13", "16"…"32". None is skipped: each becomes an unassigned sheet with a
 *    reason, and no stand number is ever invented for it.
 */
import type { RawCellValue, RawSheetRow } from "./priceImport.ts";
import {
  normalizeSettlementText,
  parseSettlementQuantity,
  settlementStandKey,
  type ParsedVendorBilling,
  type ParsedVendorRow,
  type ParsedVendorSheet,
  type SettlementImportWarning,
  type VendorRowKind,
} from "./settlementCheck.ts";

export type VendorSheetGrid = Readonly<{ name: string; rows: readonly RawSheetRow[] }>;

const HEADER_SEARCH_ROWS = 12;
/** "4C1-2", "4C1+2", "4C1, 2" — one sheet for several stands. */
const MULTI_STAND_PATTERN = /\d[a-z]\d+\s*[-+,&]\s*\d+/iu;

function text(value: RawCellValue): string {
  return value === null || value === undefined ? "" : String(value).replace(/\s+/gu, " ").trim();
}

function numberOrNull(value: RawCellValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = parseSettlementQuantity(value);
  return parsed.value;
}

/**
 * Unit of a Creativ item, read from its own text. "m" (per metre, "Kč/1m", "/1 m") is kept as its
 * own unit: the template does not say whether it means running or square metres, so it is never
 * auto-compared with ABF's "bm" or "m2" — the dictionary entry can state the real unit.
 */
export function inferCreativUnit(rawName: string): Readonly<{ unit: string; source: "name" | "default" }> {
  const name = normalizeSettlementText(rawName).replace(/²/gu, "2");
  if (/(?<![a-z])m2(?![a-z0-9])/u.test(name)) return { unit: "m2", source: "name" };
  if (/(?<![a-z])bm(?![a-z0-9])/u.test(name)) return { unit: "bm", source: "name" };
  if (/\/\s*den(?![a-z])/u.test(name)) return { unit: "ks/den", source: "name" };
  if (/\/\s*1?\s*m(?![a-z0-9])/u.test(name)) return { unit: "m", source: "name" };
  return { unit: "ks", source: "default" };
}

type HeaderColumns = Readonly<{ headerRow: number; nameCol: number; priceCol: number; quantityCol: number; totalCol: number }>;

function findHeader(rows: readonly RawSheetRow[]): HeaderColumns | undefined {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, HEADER_SEARCH_ROWS); rowIndex += 1) {
    const cells = (rows[rowIndex] ?? []).map((value) => normalizeSettlementText(text(value)));
    const nameCol = cells.findIndex((cell) => cell.startsWith("polozka"));
    if (nameCol < 0) continue;
    const quantityCol = cells.findIndex((cell) => cell.startsWith("kusy") || cell.startsWith("mnozstvi") || cell.startsWith("pocet"));
    if (quantityCol < 0) continue;
    const priceCol = cells.findIndex((cell, index) => index !== nameCol && cell.startsWith("cena") && cell.includes("kus"));
    const totalCol = cells.findIndex((cell, index) => index !== priceCol && cell.startsWith("cena") && cell.includes("polozk"));
    return { headerRow: rowIndex, nameCol, priceCol, quantityCol, totalCol };
  }
  return undefined;
}

function rowKindOf(normalizedName: string): VendorRowKind {
  if (normalizedName.startsWith("celkova cena") || normalizedName.startsWith("celkem")) return "total";
  if (normalizedName.startsWith("prirazka")) return "surcharge";
  return "item";
}

function parseSheetRows(sheetName: string, rows: readonly RawSheetRow[], header: HeaderColumns, warnings: SettlementImportWarning[]): ParsedVendorRow[] {
  const parsed: ParsedVendorRow[] = [];
  const known = new Set([header.nameCol, header.priceCol, header.quantityCol, header.totalCol]);
  for (let rowIndex = header.headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const rawName = text(row[header.nameCol]);
    const quantity = parseSettlementQuantity(row[header.quantityCol]);
    const unitPrice = header.priceCol >= 0 ? numberOrNull(row[header.priceCol]) : null;
    const lineTotal = header.totalCol >= 0 ? numberOrNull(row[header.totalCol]) : null;
    const extras = row.map((value, column) => (known.has(column) ? "" : text(value))).filter(Boolean);
    if (!rawName && quantity.raw === "" && unitPrice === null && !lineTotal && extras.length === 0) continue;

    const rowKind = rowKindOf(normalizeSettlementText(rawName));
    const isBilled = rowKind !== "total" && quantity.value !== null && quantity.value !== 0;
    const unit = inferCreativUnit(rawName);
    const sourceRow = rowIndex + 1;

    if (rowKind !== "total" && quantity.issue) {
      warnings.push({ code: "vendor_quantity_unreadable", severity: "warning", sheet: sheetName, row: sourceRow, message: `Záložka ${sheetName}, řádek ${sourceRow} („${rawName || "bez názvu"}“): ${quantity.issue}` });
    }
    if (isBilled && !rawName) {
      warnings.push({ code: "vendor_billed_row_without_name", severity: "warning", sheet: sheetName, row: sourceRow, message: `Záložka ${sheetName}, řádek ${sourceRow}: účtované množství ${quantity.raw} bez názvu položky.` });
    }

    parsed.push({
      sourceRow,
      rawName: rawName || (isBilled || quantity.issue ? "(bez názvu)" : ""),
      unitPrice,
      quantity: quantity.value,
      quantityRaw: quantity.raw,
      quantityIssue: rowKind === "total" ? null : quantity.issue,
      lineTotal,
      unit: unit.unit,
      unitSource: unit.source,
      note: extras.length > 0 ? extras.join(" · ") : null,
      rowKind,
      isBilled,
      raw: row.map((value) => (value === undefined ? null : value)),
    });
  }
  return parsed;
}

/** Rows that reach the comparison: billed ones, plus rows whose quantity is present but unreadable. */
export function isComparableVendorRow(row: Pick<ParsedVendorRow, "isBilled" | "quantityIssue" | "rowKind">): boolean {
  return row.rowKind !== "total" && (row.isBilled || Boolean(row.quantityIssue));
}

function splitTitle(title: string): Readonly<{ standKey: string | null; standNumberRaw: string | null; rest: string }> {
  const [firstToken = "", ...restTokens] = title.split(" ");
  const standKey = settlementStandKey(firstToken);
  return standKey ? { standKey, standNumberRaw: firstToken, rest: restTokens.join(" ").trim() } : { standKey: null, standNumberRaw: null, rest: title };
}

function isSummarySheet(name: string): boolean {
  return normalizeSettlementText(name).startsWith("souhr");
}

function parseSummary(rows: readonly RawSheetRow[]): Readonly<{ label: string; amount: number | null }>[] {
  const entries: { label: string; amount: number | null }[] = [];
  for (const row of rows) {
    const label = text(row[0]);
    if (!label) continue;
    const normalized = normalizeSettlementText(label);
    if (normalized.startsWith("nazev akce") || normalized.startsWith("stanek c") || normalized.startsWith("celkova castka") || normalized.includes("celkem")) continue;
    const numbers = row.slice(1).filter((value): value is number => typeof value === "number");
    const strings = row.slice(1).map(text).filter(Boolean);
    if (numbers.length === 0 && strings.length > 0) continue; // the event-name row repeats its text across columns
    entries.push({ label, amount: numbers.length > 0 ? numbers[numbers.length - 1]! : null });
  }
  return entries;
}

export function parseCreativExpoWorkbook(sheets: readonly VendorSheetGrid[]): ParsedVendorBilling {
  const warnings: SettlementImportWarning[] = [];
  const parsedSheets: ParsedVendorSheet[] = [];
  let summaryEntries: Readonly<{ label: string; amount: number | null }>[] = [];
  let eventLabel: string | null = null;

  for (const sheet of sheets) {
    if (isSummarySheet(sheet.name)) {
      summaryEntries = parseSummary(sheet.rows);
      parsedSheets.push({ sheetName: sheet.name, kind: "summary", unassignedReason: null, title: null, standNumberRaw: null, standKey: null, exhibitorName: null, rows: [], billedCount: 0 });
      continue;
    }

    const header = findHeader(sheet.rows);
    if (!header) {
      const hasContent = sheet.rows.some((row) => row.some((value) => text(value) !== ""));
      warnings.push({
        code: "vendor_sheet_unrecognized",
        severity: "warning",
        sheet: sheet.name,
        message: hasContent
          ? `Záložka „${sheet.name}“ nemá očekávanou hlavičku (Položka / Kusy) — nebyla zpracována, je mezi nepřiřazenými k ruční kontrole.`
          : `Záložka „${sheet.name}“ je prázdná.`,
      });
      parsedSheets.push({ sheetName: sheet.name, kind: "unassigned", unassignedReason: hasContent ? "Neznámá struktura záložky" : "Prázdná záložka", title: null, standNumberRaw: null, standKey: null, exhibitorName: null, rows: [], billedCount: 0 });
      continue;
    }

    const title = header.headerRow > 0 ? text(sheet.rows[header.headerRow - 1]?.[header.nameCol]) : "";
    if (!eventLabel && header.headerRow > 1) eventLabel = text(sheet.rows[header.headerRow - 2]?.[header.nameCol]) || null;
    const rows = parseSheetRows(sheet.name, sheet.rows, header, warnings);
    const billedCount = rows.filter((row) => row.isBilled).length;
    const comparableCount = rows.filter(isComparableVendorRow).length;

    const sheetKey = settlementStandKey(sheet.name);
    const fromTitle = splitTitle(title);
    let standKey: string | null = sheetKey;
    let standNumberRaw: string | null = sheetKey ? sheet.name.trim() : null;
    let unassignedReason: string | null = null;

    if (sheetKey && fromTitle.standKey && fromTitle.standKey !== sheetKey) {
      warnings.push({ code: "vendor_sheet_title_mismatch", severity: "warning", sheet: sheet.name, message: `Záložka „${sheet.name}“ má v nadpisu jiný stánek („${title}“). Použito číslo ze záložky.` });
    }
    // "4C1-2" / title "4C1 - 2 soutěž" covers several stands: never reduced to its first one.
    const coversSeveralStands = MULTI_STAND_PATTERN.test(sheet.name) || /^[-+,&]\s*\d/u.test(fromTitle.rest);
    if (!sheetKey && fromTitle.standKey && comparableCount > 0 && !coversSeveralStands) {
      standKey = fromTitle.standKey;
      standNumberRaw = fromTitle.standNumberRaw;
      warnings.push({ code: "vendor_stand_from_title", severity: "info", sheet: sheet.name, message: `Záložka „${sheet.name}“ není číslo stánku — stánek ${fromTitle.standNumberRaw} převzat z nadpisu „${title}“.` });
    }

    if (!standKey) {
      const normalizedName = normalizeSettlementText(sheet.name);
      if (comparableCount === 0) {
        unassignedReason = "Nevyplněná šablona (žádná účtovaná položka)";
      } else if (normalizedName.startsWith("ostatni")) {
        unassignedReason = "Záložka „ostatní“ — položky mimo konkrétní stánek";
      } else if (coversSeveralStands) {
        unassignedReason = "Záložka pokrývá více stánků najednou";
      } else {
        unassignedReason = "Název záložky není číslo stánku";
      }
      if (comparableCount > 0) {
        warnings.push({ code: "vendor_sheet_unassigned", severity: "warning", sheet: sheet.name, message: `Záložka „${sheet.name}“${title ? ` („${title}“)` : ""} má ${comparableCount} účtovaných položek, ale nelze ji přiřadit ke stánku: ${unassignedReason}.` });
      }
    }

    parsedSheets.push({
      sheetName: sheet.name,
      kind: standKey ? "stand" : "unassigned",
      unassignedReason,
      title: title || null,
      standNumberRaw,
      standKey,
      exhibitorName: standKey ? (fromTitle.standKey ? fromTitle.rest : title) || null : null,
      rows,
      billedCount,
    });
  }

  const emptyTemplates = parsedSheets.filter((sheet) => sheet.kind === "unassigned" && sheet.rows.every((row) => !isComparableVendorRow(row)) && sheet.unassignedReason?.startsWith("Nevyplněná"));
  if (emptyTemplates.length > 0) {
    warnings.push({ code: "vendor_empty_template_sheets", severity: "info", message: `${emptyTemplates.length} záložek je nevyplněná šablona bez účtovaných položek (${emptyTemplates.map((sheet) => sheet.sheetName).join(", ")}).` });
  }

  const duplicateKeys = new Map<string, string[]>();
  for (const sheet of parsedSheets) if (sheet.standKey) duplicateKeys.set(sheet.standKey, [...(duplicateKeys.get(sheet.standKey) ?? []), sheet.sheetName]);
  for (const [key, names] of duplicateKeys) {
    if (names.length > 1) warnings.push({ code: "vendor_stand_multiple_sheets", severity: "warning", message: `Stánek ${key} je na více záložkách (${names.join(", ")}) — položky se sčítají.` });
  }

  // Cross-check: every summary line with an amount should have a sheet with the same title.
  const titles = new Set(parsedSheets.map((sheet) => normalizeSettlementText(sheet.title ?? "")));
  for (const entry of summaryEntries) {
    if (entry.amount && !titles.has(normalizeSettlementText(entry.label))) {
      warnings.push({ code: "vendor_summary_without_sheet", severity: "warning", message: `Souhrn uvádí „${entry.label}“ (${entry.amount} Kč), ale žádná záložka nemá tento nadpis.` });
    }
  }
  if (parsedSheets.every((sheet) => sheet.kind !== "stand")) {
    warnings.push({ code: "vendor_no_stands", severity: "warning", message: "V souboru nebyla nalezena žádná záložka stánku." });
  }

  return { parser: "creativ_expo_v1", eventLabel, sheets: parsedSheets, summaryEntries, warnings };
}
