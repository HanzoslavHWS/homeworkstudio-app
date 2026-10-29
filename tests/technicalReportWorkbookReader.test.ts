import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { readTechnicalReportWorkbook } from "../lib/import/technicalReportWorkbookReader.server.ts";
import { extractSheetGrid, readWorkbookFromBuffer } from "../lib/import/xlsxReader.server.ts";
import { auditTechnicalWorkbook } from "../domain/technicalReportWorkbook.ts";

// =========================================================================================
// Technické rastry — Excel import, exceljs adapter. Every workbook here is SYNTHETIC (built with
// the same exceljs the reader uses, written to a real .xlsx buffer and read back) and describes
// only generic workbook structure — the real ABRA report layouts are covered by
// tests/technicalReportExcelTable.test.ts and tests/technicalReportExcelImportRoute.test.ts.
// =========================================================================================

async function roundTrip(build: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("reads EVERY sheet in workbook order, hidden ones included, with their visibility", async () => {
  const buffer = await roundTrip((workbook) => {
    workbook.addWorksheet("Hala 1").getCell("A1").value = "1A01";
    workbook.addWorksheet("Pomocný", { state: "hidden" }).getCell("A1").value = "x";
    workbook.addWorksheet("Hala 2").getCell("A1").value = "2B03";
  });
  const result = await readTechnicalReportWorkbook(buffer);
  assert.deepEqual(result.sheets.map((sheet) => [sheet.name, sheet.position, sheet.visibility]), [
    ["Hala 1", 1, "visible"],
    ["Pomocný", 2, "hidden"],
    ["Hala 2", 3, "visible"],
  ]);
});

test("known values keep their type: number, text, rich text, boolean, date", async () => {
  const buffer = await roundTrip((workbook) => {
    const sheet = workbook.addWorksheet("S");
    sheet.getCell("A1").value = 2;
    sheet.getCell("B1").value = "Do 2 kW";
    sheet.getCell("C1").value = { richText: [{ text: "Pevná " }, { text: "IP" }] };
    sheet.getCell("D1").value = true;
    sheet.getCell("E1").value = new Date(Date.UTC(2026, 9, 29));
  });
  const [sheet] = (await readTechnicalReportWorkbook(buffer)).sheets;
  assert.deepEqual(sheet!.rows[0], [
    { kind: "number", value: 2 },
    { kind: "text", value: "Do 2 kW" },
    { kind: "text", value: "Pevná IP" },
    { kind: "boolean", value: true },
    { kind: "date", iso: "2026-10-29T00:00:00.000Z" },
  ]);
});

test("a formula yields its cached result; a formula saved WITHOUT a result stays unknown, never blank", async () => {
  const buffer = await roundTrip((workbook) => {
    const sheet = workbook.addWorksheet("S");
    sheet.getCell("A1").value = { formula: "1+1", result: 2 };
    sheet.getCell("B1").value = { formula: "A1*3" };
  });
  const [sheet] = (await readTechnicalReportWorkbook(buffer)).sheets;
  assert.deepEqual(sheet!.rows[0], [
    { kind: "number", value: 2 },
    { kind: "formulaWithoutResult", formula: "A1*3" },
  ]);
});

test("an Excel error cell (stored or as a formula result) stays an error, never blank", async () => {
  const buffer = await roundTrip((workbook) => {
    const sheet = workbook.addWorksheet("S");
    sheet.getCell("A1").value = { error: "#REF!" } as ExcelJS.CellErrorValue;
    sheet.getCell("B1").value = { formula: "1/0", result: { error: "#DIV/0!" } } as ExcelJS.CellFormulaValue;
  });
  const [sheet] = (await readTechnicalReportWorkbook(buffer)).sheets;
  assert.deepEqual(sheet!.rows[0], [
    { kind: "error", code: "#REF!" },
    { kind: "error", code: "#DIV/0!" },
  ]);
});

test("a merged range's value appears ONCE (top-left); the rest are continuations — unlike extractSheetGrid, which repeats it", async () => {
  const buffer = await roundTrip((workbook) => {
    const sheet = workbook.addWorksheet("S");
    sheet.getCell("A1").value = 3;
    sheet.mergeCells("A1:B2");
  });
  const [sheet] = (await readTechnicalReportWorkbook(buffer)).sheets;
  assert.deepEqual(sheet!.rows, [
    [{ kind: "number", value: 3 }, { kind: "mergedContinuation", masterAddress: "A1" }],
    [{ kind: "mergedContinuation", masterAddress: "A1" }, { kind: "mergedContinuation", masterAddress: "A1" }],
  ]);
  assert.deepEqual(sheet!.mergedRanges, ["A1:B2"]);

  // Why the technical import cannot reuse extractSheetGrid as-is: the shared grid repeats the
  // merged quantity in all four cells, which a stand table would count four times.
  const grid = extractSheetGrid(await readWorkbookFromBuffer(buffer), "S");
  assert.deepEqual(grid, [[3, 3], [3, 3]]);
});

test("hidden rows and columns are reported by number", async () => {
  const buffer = await roundTrip((workbook) => {
    const sheet = workbook.addWorksheet("S");
    for (let row = 1; row <= 3; row += 1) for (let column = 1; column <= 3; column += 1) sheet.getCell(row, column).value = row * 10 + column;
    sheet.getRow(2).hidden = true;
    sheet.getColumn(3).hidden = true;
  });
  const [sheet] = (await readTechnicalReportWorkbook(buffer)).sheets;
  assert.deepEqual(sheet!.hiddenRowNumbers, [2]);
  assert.deepEqual(sheet!.hiddenColumnNumbers, [3]);
  assert.deepEqual(
    auditTechnicalWorkbook({ sheets: [sheet!] }).map((issue) => [issue.code, issue.address]),
    [["HIDDEN_ROW_WITH_DATA", "2"], ["HIDDEN_COLUMN_WITH_DATA", "C"]],
  );
});

test("trailing empty rows/columns are trimmed; inner blanks are kept as empty cells", async () => {
  const buffer = await roundTrip((workbook) => {
    const sheet = workbook.addWorksheet("S");
    sheet.getCell("A1").value = "x";
    sheet.getCell("C3").value = 1;
    sheet.getCell("F9").style = { font: { bold: true } };
  });
  const [sheet] = (await readTechnicalReportWorkbook(buffer)).sheets;
  assert.equal(sheet!.rows.length, 3);
  assert.deepEqual(sheet!.rows[1], []);
  assert.deepEqual(sheet!.rows[2], [{ kind: "empty" }, { kind: "empty" }, { kind: "number", value: 1 }]);
});

test("a sheet over the row/column limit is cut off and marked truncated — never silently partial", async () => {
  const buffer = await roundTrip((workbook) => {
    const sheet = workbook.addWorksheet("S");
    for (let row = 1; row <= 6; row += 1) sheet.getCell(row, 1).value = row;
    sheet.getCell("E1").value = "x";
  });
  const [sheet] = (await readTechnicalReportWorkbook(buffer, { maxRowsPerSheet: 4, maxColumnsPerSheet: 2 })).sheets;
  assert.equal(sheet!.rows.length, 4);
  assert.ok(sheet!.rows.every((row) => row.length <= 2));
  assert.deepEqual(sheet!.truncated, { rowCount: 6, columnCount: 5 });
  assert.ok(auditTechnicalWorkbook({ sheets: [sheet!] }).some((issue) => issue.code === "SHEET_TRUNCATED"));
});

test("a buffer that is not an .xlsx file is rejected", async () => {
  await assert.rejects(readTechnicalReportWorkbook(Buffer.from("%PDF-1.7 not a workbook")));
});
