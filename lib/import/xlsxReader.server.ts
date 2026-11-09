import ExcelJS from "exceljs";
import JSZip from "jszip";
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

/** Same safety guarantees as readWorkbookSheets, for an in-memory upload (e.g. a browser file posted to an API route) rather than a server filesystem path. */
export async function readWorkbookFromBuffer(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's bundled .d.ts resolves a Buffer shape that disagrees with this project's own
  // @types/node (a versions-skew over ArrayBuffer's resizable/maxByteLength members) — both are
  // the same Node Buffer at runtime; `any` is needed here because even `unknown as Buffer` still
  // gets structurally checked against exceljs's own (mismatched) Buffer declaration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);
  return workbook;
}

/**
 * Strips legacy VML drawings (form-control checkboxes/buttons in macro workbooks like
 * _IMPORT/KODY.xlsm) that exceljs mis-parses as cell comments and then rejects with
 * "unexpected close tag". Only drawing/markup parts are removed — every worksheet's cell data,
 * shared strings and styles are kept byte-for-byte, so the extracted values are identical.
 */
async function stripLegacyVmlDrawings(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/drawings\/vmlDrawing\d+\.vml$/u.test(name)) {
      zip.remove(name);
    } else if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/u.test(name)) {
      const xml = await zip.file(name)!.async("string");
      zip.file(name, xml.replace(/<Relationship [^>]*Target="[^"]*\.vml"[^>]*\/>/gu, ""));
    } else if (/^xl\/worksheets\/sheet\d+\.xml$/u.test(name)) {
      const xml = await zip.file(name)!.async("string");
      zip.file(name, xml.replace(/<legacyDrawing [^>]*\/>/gu, ""));
    }
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * readWorkbookFromBuffer, retried once without legacy VML drawings if exceljs can't parse them.
 * Same read-only guarantees: nothing is written back to the source file, macros never run.
 */
export async function readWorkbookFromBufferTolerant(buffer: Buffer): Promise<ExcelJS.Workbook> {
  try {
    return await readWorkbookFromBuffer(buffer);
  } catch {
    return readWorkbookFromBuffer(await stripLegacyVmlDrawings(buffer));
  }
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

/**
 * Catalog import cell: like RawCellValue, but nothing is silently dropped — an Excel boolean stays a
 * boolean and an error value (#N/A, #REF!, … also as a formula result) or a formula without a stored
 * value becomes an ExcelErrorCell, so
 * the importer can accept or refuse it explicitly instead of reading "empty".
 */
export type ExcelErrorCell = Readonly<{ excelError: string }>;
export type StrictCellValue = string | number | boolean | ExcelErrorCell | null;

export function cellToStrictValue(value: ExcelJS.CellValue): StrictCellValue {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string") return { excelError: error };
    const formulaResult = (value as { result?: ExcelJS.CellValue }).result;
    if (formulaResult !== undefined && (typeof formulaResult === "boolean" || (formulaResult && typeof formulaResult === "object"))) return cellToStrictValue(formulaResult);
    // A formula whose value was never calculated/stored would otherwise read as empty.
    if (formulaResult === undefined && ("formula" in value || "sharedFormula" in value)) return { excelError: "vzorec bez uložené hodnoty" };
  }
  return cellToRawValue(value);
}

/** extractSheetGrid for the catalog import — booleans and Excel errors kept (see StrictCellValue). */
export function extractStrictSheetGrid(workbook: ExcelJS.Workbook, sheetName: string): readonly (readonly StrictCellValue[])[] {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return [];
  // Same rectangle as before, but only cells that hold something are visited: the template has
  // ~1000 formatted (validated) empty rows per sheet, and getRow()/getCell() on each of them made
  // reading a real workbook take ~30 s instead of well under a second.
  const width = sheet.columnCount;
  const grid: StrictCellValue[][] = Array.from({ length: sheet.rowCount }, () => new Array<StrictCellValue>(width).fill(null));
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (rowNumber <= grid.length && colNumber <= width) grid[rowNumber - 1]![colNumber - 1] = cellToStrictValue(cell.value);
    });
  });
  return grid;
}
