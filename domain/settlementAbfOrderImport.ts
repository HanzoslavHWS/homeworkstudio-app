/**
 * Kontrola vyúčtování — import of the ABF report "5. Stavby - tisk vše katalog" (orders per stand
 * for one realization company), from XLSX or from a PDF with a text layer. Pure: both sources are
 * first reduced to the same `AbfSourceLine[]`, then one state machine assembles stands and items,
 * so the two formats can never drift apart.
 *
 * Verified against the real export (FOR BEAUTY 2026 podzim, Creativ Expo): the report carries NO
 * ABF codes and NO prices — only item names (cut at ~40 characters), a quantity and a unit. A
 * stand block is: a stand line (stand number + document number), an exhibitor line, an optional
 * "Šířka:/Hloubka:" line, then item lines, each optionally followed by an indented note line.
 * In the PDF a block continues across pages (the column header repeats, a footer closes a page).
 *
 * Nothing is dropped silently: a line that fits no rule becomes a warning, an item without a
 * readable quantity is kept as an item with a quantity issue, a stand whose number cannot be
 * read as one stand is kept with standKey = null.
 */
import type { RawCellValue, RawSheetRow } from "./priceImport.ts";
import { groupTextItemsIntoRows, type PdfTextItem } from "./technicalReportTableParsing.ts";
import {
  normalizeSettlementText,
  parseSettlementQuantity,
  settlementStandKey,
  type ParsedAbfItem,
  type ParsedAbfOrders,
  type ParsedAbfStand,
  type SettlementImportWarning,
} from "./settlementCheck.ts";

export type AbfSourceLine = Readonly<{
  row: number | null;
  page: number | null;
  /** Text in the leftmost column (stand number, exhibitor, item name, prolog). */
  first: string;
  docNumber: string | null;
  quantity: unknown;
  hasQuantity: boolean;
  unit: string | null;
  /** Text of an indented line with nothing in the leftmost column. */
  note: string | null;
  /** Every other text on the line, left to right. */
  texts: readonly string[];
  raw: unknown;
}>;

/** "V253-31/2026"; the report cuts a longer one at 12 characters ("V253-206/202"), in XLSX and PDF alike. */
const DOCUMENT_NUMBER_PATTERN = /^[A-Z]{0,4}\d+-\d+\/\d+$/u;
const NUMERIC_TEXT_PATTERN = /^-?\d+(?:[.,]\d+)?$/u;
const ABF_CODE_PREFIX_PATTERN = /^([A-Z][0-9A-Z]{2})\s+-\s+\S/u;

function cellText(value: RawCellValue): string {
  return value === null || value === undefined ? "" : String(value).replace(/\s+/gu, " ").trim();
}

/** One worksheet grid (lib/import/xlsxReader.server.ts extractSheetGrid) -> source lines. Column positions are not hardcoded: the quantity is the last numeric cell, the unit the text right after it. */
export function abfLinesFromSheetGrid(rows: readonly RawSheetRow[]): readonly AbfSourceLine[] {
  const lines: AbfSourceLine[] = [];
  rows.forEach((row, index) => {
    const cells = row.map((value, column) => ({ column, value, text: cellText(value) })).filter((cell) => cell.text !== "");
    if (cells.length === 0) return;
    const first = cells[0]!.column === 0 ? cells[0]!.text : "";
    const rest = first ? cells.slice(1) : cells;

    let quantityIndex = -1;
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      const cell = rest[i]!;
      if (typeof cell.value === "number" || NUMERIC_TEXT_PATTERN.test(cell.text)) { quantityIndex = i; break; }
    }
    const quantityCell = quantityIndex >= 0 ? rest[quantityIndex]! : undefined;
    const unitCell = quantityCell ? rest.find((cell) => cell.column === quantityCell.column + 1 && typeof cell.value !== "number") : undefined;
    const others = rest.filter((cell) => cell !== quantityCell && cell !== unitCell);
    const docNumber = others.find((cell) => DOCUMENT_NUMBER_PATTERN.test(cell.text))?.text ?? null;
    const texts = others.filter((cell) => cell.text !== docNumber).map((cell) => cell.text);

    lines.push({
      row: index + 1,
      page: null,
      first,
      docNumber,
      quantity: quantityCell?.value,
      hasQuantity: Boolean(quantityCell),
      unit: unitCell?.text ?? null,
      note: !first && !quantityCell && texts.length > 0 ? texts.join(" ") : null,
      texts,
      raw: row.map((value) => (value === undefined ? null : value)),
    });
  });
  return lines;
}

/** Leftmost-column tolerance and the minimum offset of the quantity column, in PDF points. */
const PDF_FIRST_COLUMN_TOLERANCE_PT = 10;
const PDF_QUANTITY_MIN_OFFSET_PT = 150;
/** A number and at most one short unit token ("12,0 m2", "2,0 ks/d") — never an exhibitor name that merely starts with a digit ("4 Beauty s.r.o."). */
const PDF_QUANTITY_PATTERN = /^(-?\d+(?:[.,]\d+)?)(?:\s+([\p{L}\d²/.]{1,8}))?$/u;

/**
 * PDF text items (lib/pdf/pdfTextExtraction.ts) -> source lines. Rows are rebuilt from Y/X only
 * (never from the PDF's own item order); the left margin is measured from the document itself.
 */
export function abfLinesFromPdfTextItems(items: readonly PdfTextItem[]): readonly AbfSourceLine[] {
  const visible = items.filter((item) => item.str.trim());
  if (visible.length === 0) return [];
  const leftX = Math.min(...visible.map((item) => item.x));
  const lines: AbfSourceLine[] = [];
  groupTextItemsIntoRows(visible).forEach((row, index) => {
    const parts = row.items.map((item) => ({ x: item.x, text: item.str.replace(/\s+/gu, " ").trim() })).filter((part) => part.text);
    if (parts.length === 0) return;
    const firstParts = parts.filter((part) => part.x < leftX + PDF_FIRST_COLUMN_TOLERANCE_PT);
    const first = firstParts.map((part) => part.text).join(" ");
    const rest = parts.filter((part) => !firstParts.includes(part));

    const right = rest.filter((part) => part.x >= leftX + PDF_QUANTITY_MIN_OFFSET_PT);
    const quantityMatch = first ? PDF_QUANTITY_PATTERN.exec(right.map((part) => part.text).join(" ")) : null;
    const others = quantityMatch ? rest.filter((part) => !right.includes(part)) : rest;
    const docNumber = others.find((part) => DOCUMENT_NUMBER_PATTERN.test(part.text))?.text ?? null;
    const texts = others.filter((part) => part.text !== docNumber).map((part) => part.text);

    lines.push({
      row: index + 1,
      page: row.page,
      first,
      docNumber,
      quantity: quantityMatch ? quantityMatch[1] : undefined,
      hasQuantity: Boolean(quantityMatch),
      unit: quantityMatch?.[2]?.trim() || null,
      note: !first && texts.length > 0 ? texts.join(" ") : null,
      texts,
      raw: parts,
    });
  });
  return lines;
}

function isColumnHeader(line: AbfSourceLine): boolean {
  return normalizeSettlementText(line.first) === "stanek" && line.texts.some((text) => normalizeSettlementText(text).startsWith("cislo dokladu"));
}

function isFooter(line: AbfSourceLine): boolean {
  return normalizeSettlementText(line.first).startsWith("vytisk sestavil");
}

type MutableStand = { -readonly [K in keyof ParsedAbfStand]: ParsedAbfStand[K] } & { items: ParsedAbfItem[] };

/** The shared state machine. Input order = reading order. */
export function assembleAbfOrders(lines: readonly AbfSourceLine[]): ParsedAbfOrders {
  const stands: MutableStand[] = [];
  const warnings: SettlementImportWarning[] = [];
  let title: string | null = null;
  let orderLabel: string | null = null;
  let companyLabel: string | null = null;
  let started = false;
  let current: MutableStand | undefined;
  let expectExhibitor = false;

  const where = (line: AbfSourceLine) => ({ ...(line.row !== null && line.page === null ? { row: line.row } : {}), ...(line.page !== null ? { page: line.page } : {}) });

  for (const line of lines) {
    if (isFooter(line)) continue;
    if (isColumnHeader(line)) { started = true; continue; }

    const isStandLine = Boolean(line.first) && Boolean(line.docNumber) && !line.hasQuantity;
    if (!started && !isStandLine) {
      const all = [line.first, ...line.texts, line.note ?? ""].join(" ").trim();
      if (!title && line.first) title = line.first;
      if (/Zakázka:/u.test(all)) orderLabel = all.replace(/^.*Zakázka:\s*(?:\(\d+\):\s*)?/u, "").trim();
      if (/Realizační firma:/u.test(all)) companyLabel = all.replace(/^.*Realizační firma:\s*(?:\(\d+\):\s*)?/u, "").replace(/^'|'$/gu, "").trim();
      continue;
    }

    if (isStandLine) {
      started = true;
      const standKey = settlementStandKey(line.first);
      current = {
        standNumberRaw: line.first,
        standKey,
        documentNumber: line.docNumber,
        exhibitorName: null,
        exhibitorDisplayName: null,
        dimensionsText: null,
        sourceRow: line.row,
        sourcePage: line.page,
        items: [],
      };
      stands.push(current);
      expectExhibitor = true;
      if (!standKey) {
        warnings.push({ code: "abf_stand_number_unreadable", severity: "warning", message: `Označení „${line.first}“ (doklad ${line.docNumber}) není číslo jednoho stánku — objednávka je zařazena mezi nepřiřazené.`, ...where(line) });
      }
      continue;
    }

    if (!current) {
      warnings.push({ code: "abf_line_before_first_stand", severity: "warning", message: `Řádek „${line.first || line.note || line.texts.join(" ")}“ je před prvním stánkem a nebyl přiřazen.`, ...where(line) });
      continue;
    }

    if (line.first && normalizeSettlementText(line.first).startsWith("sirka")) {
      current.dimensionsText = [line.first, ...line.texts].join(" ");
      expectExhibitor = false;
      continue;
    }

    if (line.first && line.hasQuantity) {
      const quantity = parseSettlementQuantity(line.quantity);
      const code = ABF_CODE_PREFIX_PATTERN.exec(line.first)?.[1] ?? null;
      current.items.push({
        sourceRow: line.row,
        sourcePage: line.page,
        rawName: line.first,
        abfCode: code,
        quantity: quantity.value,
        quantityRaw: quantity.raw,
        quantityIssue: quantity.issue,
        unitRaw: line.unit,
        note: line.texts.length > 0 ? line.texts.join(" ") : null,
        raw: line.raw,
      });
      expectExhibitor = false;
      continue;
    }

    if (line.first && expectExhibitor) {
      // A long exhibitor name can run into the "R: <realizační firma>" column in the PDF.
      current.exhibitorName = line.first.replace(/\s+R:\s.*$/u, "");
      current.exhibitorDisplayName = line.texts.find((text) => !/^R:/u.test(text)) ?? null;
      expectExhibitor = false;
      continue;
    }

    if (!line.first && line.note) {
      const last = current.items[current.items.length - 1];
      if (last) {
        current.items[current.items.length - 1] = { ...last, note: last.note ? `${last.note} · ${line.note}` : line.note };
      } else {
        warnings.push({ code: "abf_note_without_item", severity: "info", message: `Poznámka „${line.note}“ u stánku ${current.standNumberRaw} nepatří k žádné položce.`, ...where(line) });
      }
      continue;
    }

    if (line.first) {
      // A named line with no quantity inside a stand block: kept as an item so it is never lost.
      current.items.push({
        sourceRow: line.row,
        sourcePage: line.page,
        rawName: line.first,
        abfCode: ABF_CODE_PREFIX_PATTERN.exec(line.first)?.[1] ?? null,
        quantity: null,
        quantityRaw: "",
        quantityIssue: "Řádek nemá množství.",
        unitRaw: null,
        note: line.texts.length > 0 ? line.texts.join(" ") : null,
        raw: line.raw,
      });
      warnings.push({ code: "abf_item_without_quantity", severity: "warning", message: `Položka „${line.first}“ u stánku ${current.standNumberRaw} nemá množství.`, ...where(line) });
      continue;
    }

    warnings.push({ code: "abf_line_unrecognized", severity: "warning", message: `Nerozpoznaný řádek u stánku ${current.standNumberRaw}: „${line.texts.join(" ")}“.`, ...where(line) });
  }

  for (const stand of stands) {
    if (stand.items.length === 0) {
      warnings.push({ code: "abf_stand_without_items", severity: "info", message: `Stánek ${stand.standNumberRaw} (doklad ${stand.documentNumber ?? "—"}) nemá žádnou položku.` });
    }
  }
  const seen = new Map<string, number>();
  for (const stand of stands) if (stand.standKey) seen.set(stand.standKey, (seen.get(stand.standKey) ?? 0) + 1);
  for (const [key, count] of seen) {
    if (count > 1) warnings.push({ code: "abf_stand_multiple_orders", severity: "info", message: `Stánek ${key} má ${count} objednávky/doklady — položky se sčítají, každý řádek si drží svůj doklad.` });
  }
  if (stands.length === 0) {
    warnings.push({ code: "abf_no_stands", severity: "warning", message: "V souboru nebyl nalezen žádný stánek (řádek s číslem stánku a číslem dokladu)." });
  }

  return { title, orderLabel, companyLabel, stands, warnings };
}

export function parseAbfOrdersFromSheetGrid(rows: readonly RawSheetRow[]): ParsedAbfOrders {
  return assembleAbfOrders(abfLinesFromSheetGrid(rows));
}

export function parseAbfOrdersFromPdfTextItems(items: readonly PdfTextItem[]): ParsedAbfOrders {
  if (items.filter((item) => item.str.trim()).length === 0) {
    return { title: null, orderLabel: null, companyLabel: null, stands: [], warnings: [{ code: "abf_pdf_no_text_layer", severity: "warning", message: "PDF neobsahuje textovou vrstvu — použijte export do XLSX." }] };
  }
  return assembleAbfOrders(abfLinesFromPdfTextItems(items));
}
