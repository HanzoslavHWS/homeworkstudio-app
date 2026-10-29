/**
 * Technické rastry — the source-format model of an Excel (.xlsx) technical report, BEFORE any
 * column mapping. Pure and library-free (like domain/priceImport.ts's RawSheetRow): the exceljs
 * adapter lives in lib/import/technicalReportWorkbookReader.server.ts, and tests build workbooks
 * by hand.
 *
 * Deliberately richer than RawSheetRow: a technical report's blank cell means "not ordered"
 * (evaluateNumericCellValue → zero), so every cell whose real value is UNKNOWN — an Excel error,
 * a formula saved without a cached result, the hidden continuation of a merged cell — keeps its
 * own kind here instead of collapsing to null. technicalWorkbookCellRawText refuses to turn any of
 * those into text, so they can never silently become "0 = not ordered" downstream.
 *
 * Which sheets/rows/columns hold stand data is NOT decided here — that mapping lives in
 * domain/technicalReportExcelTable.ts. Every sheet is kept (multi-sheet reports), in workbook order.
 */

export type TechnicalWorkbookCell =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "date"; iso: string }>
  | Readonly<{ kind: "error"; code: string }>
  | Readonly<{ kind: "formulaWithoutResult"; formula: string }>
  /** A non-top-left cell of a merged range — its displayed value belongs to `masterAddress` only, never repeated here. */
  | Readonly<{ kind: "mergedContinuation"; masterAddress: string }>
  | Readonly<{ kind: "unsupported"; description: string }>;

export type TechnicalWorkbookSheetVisibility = "visible" | "hidden" | "veryHidden";

export type TechnicalWorkbookSheet = Readonly<{
  name: string;
  /** 1-based position in the workbook's own sheet order. */
  position: number;
  visibility: TechnicalWorkbookSheetVisibility;
  /** rows[0] is Excel row 1, cells[0] is column A. Trailing empty rows/columns are trimmed. */
  rows: readonly (readonly TechnicalWorkbookCell[])[];
  hiddenRowNumbers: readonly number[];
  hiddenColumnNumbers: readonly number[];
  /** Merged ranges as Excel range strings, e.g. "B2:D2". */
  mergedRanges: readonly string[];
  /** Set when the sheet exceeded the reader's row/column limit — the rest was never read. */
  truncated?: Readonly<{ rowCount: number; columnCount: number }>;
}>;

export type TechnicalWorkbook = Readonly<{
  sheets: readonly TechnicalWorkbookSheet[];
}>;

/** 1-based column number → Excel column letters (1 → "A", 27 → "AA"). */
export function columnLetters(columnNumber: number): string {
  let remaining = columnNumber;
  let letters = "";
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + offset) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

export function cellAddress(rowNumber: number, columnNumber: number): string {
  return `${columnLetters(columnNumber)}${rowNumber}`;
}

export type TechnicalWorkbookCellText =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * The ONE way a workbook cell becomes the raw text a stand table carries (and later
 * evaluateNumericCellValue reads). Known values become text; an empty cell becomes "" (= a real
 * blank). Every cell whose value is unknown is refused with a Czech reason instead — the caller
 * must surface it as a warning, never treat it as blank.
 */
export function technicalWorkbookCellRawText(cell: TechnicalWorkbookCell): TechnicalWorkbookCellText {
  switch (cell.kind) {
    case "empty":
      return { ok: true, text: "" };
    case "number":
      return { ok: true, text: String(cell.value) };
    case "text":
      return { ok: true, text: cell.value.trim() };
    case "boolean":
      return { ok: true, text: cell.value ? "PRAVDA" : "NEPRAVDA" };
    case "date":
      return { ok: true, text: cell.iso };
    case "error":
      return { ok: false, reason: `buňka obsahuje chybu Excelu ${cell.code}` };
    case "formulaWithoutResult":
      return { ok: false, reason: `vzorec „=${cell.formula}“ nemá uloženou vypočtenou hodnotu (soubor uložte v Excelu znovu)` };
    case "mergedContinuation":
      return { ok: false, reason: `buňka je součástí sloučené oblasti, hodnota patří buňce ${cell.masterAddress}` };
    case "unsupported":
      return { ok: false, reason: `nepodporovaný obsah buňky (${cell.description})` };
  }
}

function cellHasContent(cell: TechnicalWorkbookCell | undefined): boolean {
  return cell !== undefined && cell.kind !== "empty" && cell.kind !== "mergedContinuation";
}

export type TechnicalWorkbookSheetSummary = Readonly<{
  name: string;
  position: number;
  visibility: TechnicalWorkbookSheetVisibility;
  rowCount: number;
  columnCount: number;
  filledCellCount: number;
}>;

/** Per-sheet overview for a multi-sheet workbook (lets the user/mapping see every sheet, hidden ones included). */
export function summarizeTechnicalWorkbook(workbook: TechnicalWorkbook): readonly TechnicalWorkbookSheetSummary[] {
  return workbook.sheets.map((sheet) => ({
    name: sheet.name,
    position: sheet.position,
    visibility: sheet.visibility,
    rowCount: sheet.rows.length,
    columnCount: Math.max(0, ...sheet.rows.map((row) => row.length)),
    filledCellCount: sheet.rows.reduce((sum, row) => sum + row.filter(cellHasContent).length, 0),
  }));
}

export type TechnicalWorkbookIssueCode =
  | "NO_SHEETS"
  | "NO_DATA"
  | "EMPTY_SHEET"
  | "HIDDEN_SHEET_WITH_DATA"
  | "HIDDEN_ROW_WITH_DATA"
  | "HIDDEN_COLUMN_WITH_DATA"
  | "MERGED_RANGE"
  | "ERROR_CELL"
  | "FORMULA_WITHOUT_RESULT"
  | "UNSUPPORTED_CELL"
  | "SHEET_TRUNCATED";

export type TechnicalWorkbookIssue = Readonly<{
  code: TechnicalWorkbookIssueCode;
  /** "unknownValue" = a cell whose real value cannot be known; it must never be read as blank/zero. */
  severity: "unknownValue" | "warning";
  sheetName?: string;
  address?: string;
  message: string;
}>;

/**
 * Mapping-independent ambiguity check over the WHOLE workbook (every sheet, hidden ones included):
 * reports every cell whose value is unknown plus every structure that commonly hides or duplicates
 * data (hidden sheets/rows/columns that still contain values, merged ranges, truncated sheets).
 * Nothing is dropped or "fixed" here — the later mapping decides which of these touch stand data.
 */
export function auditTechnicalWorkbook(workbook: TechnicalWorkbook): readonly TechnicalWorkbookIssue[] {
  const issues: TechnicalWorkbookIssue[] = [];
  if (workbook.sheets.length === 0) {
    return [{ code: "NO_SHEETS", severity: "warning", message: "Soubor neobsahuje žádný list." }];
  }

  for (const sheet of workbook.sheets) {
    const sheetName = sheet.name;
    const filled = sheet.rows.some((row) => row.some(cellHasContent));

    if (!filled) {
      issues.push({ code: "EMPTY_SHEET", severity: "warning", sheetName, message: `List „${sheetName}“ je prázdný.` });
    } else if (sheet.visibility !== "visible") {
      issues.push({ code: "HIDDEN_SHEET_WITH_DATA", severity: "warning", sheetName, message: `List „${sheetName}“ je skrytý, ale obsahuje data.` });
    }

    if (sheet.truncated) {
      issues.push({
        code: "SHEET_TRUNCATED",
        severity: "warning",
        sheetName,
        message: `List „${sheetName}“ má ${sheet.truncated.rowCount} řádků × ${sheet.truncated.columnCount} sloupců, načetla se jen část — zbytek nebyl zkontrolován.`,
      });
    }

    for (const rowNumber of sheet.hiddenRowNumbers) {
      if ((sheet.rows[rowNumber - 1] ?? []).some(cellHasContent)) {
        issues.push({ code: "HIDDEN_ROW_WITH_DATA", severity: "warning", sheetName, address: String(rowNumber), message: `List „${sheetName}“: skrytý řádek ${rowNumber} obsahuje data.` });
      }
    }
    for (const columnNumber of sheet.hiddenColumnNumbers) {
      if (sheet.rows.some((row) => cellHasContent(row[columnNumber - 1]))) {
        const letters = columnLetters(columnNumber);
        issues.push({ code: "HIDDEN_COLUMN_WITH_DATA", severity: "warning", sheetName, address: letters, message: `List „${sheetName}“: skrytý sloupec ${letters} obsahuje data.` });
      }
    }
    for (const range of sheet.mergedRanges) {
      issues.push({ code: "MERGED_RANGE", severity: "warning", sheetName, address: range, message: `List „${sheetName}“: sloučené buňky ${range} — hodnota se počítá jen jednou, v levé horní buňce.` });
    }

    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        const code: TechnicalWorkbookIssueCode | undefined =
          cell.kind === "error" ? "ERROR_CELL" : cell.kind === "formulaWithoutResult" ? "FORMULA_WITHOUT_RESULT" : cell.kind === "unsupported" ? "UNSUPPORTED_CELL" : undefined;
        if (!code) return;
        const address = cellAddress(rowIndex + 1, columnIndex + 1);
        const text = technicalWorkbookCellRawText(cell);
        const reason = "reason" in text ? text.reason : "neznámá hodnota";
        issues.push({ code, severity: "unknownValue", sheetName, address, message: `List „${sheetName}“, buňka ${address}: ${reason}.` });
      });
    });
  }

  if (workbook.sheets.every((sheet) => !sheet.rows.some((row) => row.some(cellHasContent)))) {
    issues.unshift({ code: "NO_DATA", severity: "warning", message: "Žádný list v souboru neobsahuje data." });
  }
  return issues;
}
