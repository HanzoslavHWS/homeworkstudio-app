import ExcelJS from "exceljs";
import type { RawCellValue, RawSheetRow } from "../../domain/priceImport.ts";

/**
 * Safe .xlsm reader: exceljs parses the OOXML/zip structure and reads cell values only.
 * It never touches vbaProject.bin (the compiled macro binary) — macros are simply absent
 * from the object model this returns, so nothing here can execute VBA even though the
 * source file has some. This is the only place in the app allowed to touch the filesystem
 * for workbook data; everything downstream (domain/priceImport.ts, domain/importBatch.ts)
 * is pure and takes plain arrays.
 */
export async function readWorkbookSheets(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

function cellToRawValue(value: ExcelJS.CellValue): RawCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const richText = (value as { richText?: readonly { text: string }[] }).richText;
    if (richText) return richText.map((part) => part.text).join("");
    const formulaResult = (value as { result?: ExcelJS.CellValue }).result;
    if (formulaResult !== undefined) return cellToRawValue(formulaResult);
    const hyperlinkText = (value as { text?: string }).text;
    if (typeof hyperlinkText === "string") return hyperlinkText;
  }
  return null;
}

export function extractSheetGrid(workbook: ExcelJS.Workbook, sheetName: string): readonly RawSheetRow[] {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return [];
  const grid: RawSheetRow[] = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const values: RawCellValue[] = [];
    for (let colNumber = 1; colNumber <= sheet.columnCount; colNumber++) {
      values.push(cellToRawValue(row.getCell(colNumber).value));
    }
    grid.push(values);
  }
  return grid;
}
