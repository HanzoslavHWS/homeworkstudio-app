import ExcelJS from "exceljs";
import { readWorkbookFromBufferTolerant } from "./xlsxReader.server.ts";
import {
  cellAddress,
  type TechnicalWorkbook,
  type TechnicalWorkbookCell,
  type TechnicalWorkbookSheet,
  type TechnicalWorkbookSheetVisibility,
} from "../../domain/technicalReportWorkbook.ts";

/**
 * Technické rastry — exceljs adapter for an uploaded .xlsx technical report. Reuses the shared
 * read-only workbook loading (xlsxReader.server.ts: macros never run, legacy VML drawings
 * tolerated) and only replaces the cell extraction: extractSheetGrid collapses errors and
 * uncached formulas to null and repeats a merged cell's value in every cell of the range — fine
 * for the price/print-surface imports, but a technical report would read the first as "not
 * ordered" and count the second twice. See domain/technicalReportWorkbook.ts.
 */

export type TechnicalWorkbookReadLimits = Readonly<{ maxRowsPerSheet: number; maxColumnsPerSheet: number }>;

export const DEFAULT_TECHNICAL_WORKBOOK_READ_LIMITS: TechnicalWorkbookReadLimits = { maxRowsPerSheet: 5000, maxColumnsPerSheet: 200 };

export async function readTechnicalReportWorkbook(buffer: Buffer, limits = DEFAULT_TECHNICAL_WORKBOOK_READ_LIMITS): Promise<TechnicalWorkbook> {
  return extractTechnicalReportWorkbook(await readWorkbookFromBufferTolerant(buffer), limits);
}

export function extractTechnicalReportWorkbook(workbook: ExcelJS.Workbook, limits = DEFAULT_TECHNICAL_WORKBOOK_READ_LIMITS): TechnicalWorkbook {
  return { sheets: workbook.worksheets.map((worksheet, index) => extractSheet(worksheet, index + 1, limits)) };
}

function extractSheet(worksheet: ExcelJS.Worksheet, position: number, limits: TechnicalWorkbookReadLimits): TechnicalWorkbookSheet {
  const totalRows = worksheet.rowCount;
  const totalColumns = worksheet.columnCount;
  const rowCount = Math.min(totalRows, limits.maxRowsPerSheet);
  const columnCount = Math.min(totalColumns, limits.maxColumnsPerSheet);

  const rows: TechnicalWorkbookCell[][] = [];
  const hiddenRowNumbers: number[] = [];
  // master address -> bounding box of its merged range, rebuilt from the cells actually read
  // (exceljs only exposes the range list through the heavy, whole-sheet `model` getter).
  const merges = new Map<string, { top: number; left: number; bottom: number; right: number }>();

  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (row.hidden) hiddenRowNumbers.push(rowNumber);
    const cells: TechnicalWorkbookCell[] = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      const cell = row.getCell(columnNumber);
      if (cell.type === ExcelJS.ValueType.Merge) {
        const master = cell.master;
        const range = merges.get(master.address) ?? { top: Number(master.row), left: Number(master.col), bottom: Number(master.row), right: Number(master.col) };
        range.bottom = Math.max(range.bottom, rowNumber);
        range.right = Math.max(range.right, columnNumber);
        merges.set(master.address, range);
        cells.push({ kind: "mergedContinuation", masterAddress: master.address });
      } else {
        cells.push(toWorkbookCell(cell));
      }
    }
    rows.push(cells);
  }

  const hiddenColumnNumbers: number[] = [];
  for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
    if (worksheet.getColumn(columnNumber).hidden) hiddenColumnNumbers.push(columnNumber);
  }

  return {
    name: worksheet.name,
    position,
    visibility: toVisibility(worksheet.state),
    rows: trimTrailingEmpty(rows),
    hiddenRowNumbers,
    hiddenColumnNumbers,
    mergedRanges: [...merges.values()].map((range) => `${cellAddress(range.top, range.left)}:${cellAddress(range.bottom, range.right)}`),
    ...(totalRows > rowCount || totalColumns > columnCount ? { truncated: { rowCount: totalRows, columnCount: totalColumns } } : {}),
  };
}

function toVisibility(state: string | undefined): TechnicalWorkbookSheetVisibility {
  return state === "hidden" || state === "veryHidden" ? state : "visible";
}

function toWorkbookCell(cell: ExcelJS.Cell): TechnicalWorkbookCell {
  switch (cell.type) {
    case ExcelJS.ValueType.Null:
      return { kind: "empty" };
    case ExcelJS.ValueType.Formula: {
      const result = cell.result as unknown;
      if (result === undefined || result === null) return { kind: "formulaWithoutResult", formula: cell.formula ?? "" };
      return primitiveToWorkbookCell(result);
    }
    case ExcelJS.ValueType.RichText:
      return textCell((cell.value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join(""));
    case ExcelJS.ValueType.Hyperlink: {
      const text = (cell.value as ExcelJS.CellHyperlinkValue).text as unknown;
      if (typeof text === "string") return textCell(text);
      return primitiveToWorkbookCell(text);
    }
    default:
      return primitiveToWorkbookCell(cell.value);
  }
}

function textCell(value: string): TechnicalWorkbookCell {
  return value.trim() ? { kind: "text", value } : { kind: "empty" };
}

function primitiveToWorkbookCell(value: unknown): TechnicalWorkbookCell {
  if (value === null || value === undefined) return { kind: "empty" };
  if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", value } : { kind: "unsupported", description: String(value) };
  if (typeof value === "string") return textCell(value);
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { kind: "unsupported", description: "neplatné datum" } : { kind: "date", iso: value.toISOString() };
  if (typeof value === "object") {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string") return { kind: "error", code: error };
    const richText = (value as { richText?: readonly { text: string }[] }).richText;
    if (Array.isArray(richText)) return textCell(richText.map((part) => part.text).join(""));
  }
  return { kind: "unsupported", description: typeof value };
}

function trimTrailingEmpty(rows: TechnicalWorkbookCell[][]): TechnicalWorkbookCell[][] {
  const trimmedRows = rows.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1]!.kind === "empty") end -= 1;
    return row.slice(0, end);
  });
  let end = trimmedRows.length;
  while (end > 0 && trimmedRows[end - 1]!.length === 0) end -= 1;
  return trimmedRows.slice(0, end);
}
