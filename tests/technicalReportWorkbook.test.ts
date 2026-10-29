import assert from "node:assert/strict";
import test from "node:test";
import {
  auditTechnicalWorkbook,
  cellAddress,
  columnLetters,
  summarizeTechnicalWorkbook,
  technicalWorkbookCellRawText,
  type TechnicalWorkbookCell,
  type TechnicalWorkbookSheet,
} from "../domain/technicalReportWorkbook.ts";
import { evaluateNumericCellValue } from "../domain/technicalReportTableParsing.ts";

// =========================================================================================
// Technické rastry — Excel import, pure workbook model (no exceljs). Mapping-independent: these
// tests only cover multi-sheet structure and the "unknown value is never zero" contract.
// =========================================================================================

function sheet(name: string, rows: TechnicalWorkbookCell[][], overrides: Partial<TechnicalWorkbookSheet> = {}): TechnicalWorkbookSheet {
  return { name, position: 1, visibility: "visible", rows, hiddenRowNumbers: [], hiddenColumnNumbers: [], mergedRanges: [], ...overrides };
}
const num = (value: number): TechnicalWorkbookCell => ({ kind: "number", value });
const text = (value: string): TechnicalWorkbookCell => ({ kind: "text", value });
const empty: TechnicalWorkbookCell = { kind: "empty" };

test("columnLetters / cellAddress follow Excel's own A..Z, AA.. naming", () => {
  assert.deepEqual([1, 26, 27, 52, 53, 702, 703].map(columnLetters), ["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  assert.equal(cellAddress(7, 2), "B7");
});

test("known cells become raw text; an empty cell is a real blank", () => {
  assert.deepEqual(technicalWorkbookCellRawText(num(2)), { ok: true, text: "2" });
  assert.deepEqual(technicalWorkbookCellRawText(num(0.5)), { ok: true, text: "0.5" });
  assert.deepEqual(technicalWorkbookCellRawText(text("  Do 2 kW ")), { ok: true, text: "Do 2 kW" });
  assert.deepEqual(technicalWorkbookCellRawText(empty), { ok: true, text: "" });
});

test("UNKNOWN cells are refused with a reason — never handed on as text that would evaluate to zero", () => {
  const unknown: TechnicalWorkbookCell[] = [
    { kind: "error", code: "#N/A" },
    { kind: "formulaWithoutResult", formula: "SUM(B2:B9)" },
    { kind: "mergedContinuation", masterAddress: "C4" },
    { kind: "unsupported", description: "object" },
  ];
  for (const cell of unknown) {
    const result = technicalWorkbookCellRawText(cell);
    assert.equal(result.ok, false, cell.kind);
    if (!result.ok) assert.ok(result.reason.length > 0);
  }
  // The trap these refusals close: a blank string is "zero / not ordered" for the shared evaluator.
  assert.deepEqual(evaluateNumericCellValue(""), { kind: "zero" });
});

test("summary covers every sheet, hidden included, counting only cells that hold a value", () => {
  const summary = summarizeTechnicalWorkbook({
    sheets: [
      sheet("Hala 1", [[text("1A01"), num(2), empty], [{ kind: "mergedContinuation", masterAddress: "A1" }]]),
      sheet("Skrytý", [[num(1)]], { position: 2, visibility: "hidden" }),
      sheet("Prázdný", [], { position: 3 }),
    ],
  });
  assert.deepEqual(summary, [
    { name: "Hala 1", position: 1, visibility: "visible", rowCount: 2, columnCount: 3, filledCellCount: 2 },
    { name: "Skrytý", position: 2, visibility: "hidden", rowCount: 1, columnCount: 1, filledCellCount: 1 },
    { name: "Prázdný", position: 3, visibility: "visible", rowCount: 0, columnCount: 0, filledCellCount: 0 },
  ]);
});

test("audit: no sheets / no data at all", () => {
  assert.deepEqual(auditTechnicalWorkbook({ sheets: [] }).map((issue) => issue.code), ["NO_SHEETS"]);
  assert.deepEqual(auditTechnicalWorkbook({ sheets: [sheet("A", []), sheet("B", [[empty]])] }).map((issue) => issue.code), ["NO_DATA", "EMPTY_SHEET", "EMPTY_SHEET"]);
});

test("audit: every unknown cell is reported with sheet + address, as severity unknownValue", () => {
  const issues = auditTechnicalWorkbook({
    sheets: [
      sheet("Hala 1", [[text("1A01"), { kind: "error", code: "#REF!" }]]),
      sheet("Hala 2", [[empty], [empty, empty, { kind: "formulaWithoutResult", formula: "A1+1" }]], { position: 2 }),
    ],
  });
  assert.deepEqual(issues.map((issue) => [issue.code, issue.severity, issue.sheetName, issue.address]), [
    ["ERROR_CELL", "unknownValue", "Hala 1", "B1"],
    ["FORMULA_WITHOUT_RESULT", "unknownValue", "Hala 2", "C2"],
  ]);
  assert.match(issues[0]!.message, /#REF!/u);
});

test("audit: hidden sheet / row / column only flagged when it actually contains data; merged ranges always listed", () => {
  const issues = auditTechnicalWorkbook({
    sheets: [
      sheet("Data", [[text("a"), empty], [empty, empty], [num(1), num(2)]], { hiddenRowNumbers: [2, 3], hiddenColumnNumbers: [2], mergedRanges: ["A1:B1"] }),
      sheet("Skrytý s daty", [[num(1)]], { position: 2, visibility: "hidden" }),
      sheet("Skrytý prázdný", [], { position: 3, visibility: "veryHidden" }),
    ],
  });
  assert.deepEqual(issues.map((issue) => [issue.code, issue.sheetName, issue.address]), [
    ["HIDDEN_ROW_WITH_DATA", "Data", "3"],
    ["HIDDEN_COLUMN_WITH_DATA", "Data", "B"],
    ["MERGED_RANGE", "Data", "A1:B1"],
    ["HIDDEN_SHEET_WITH_DATA", "Skrytý s daty", undefined],
    ["EMPTY_SHEET", "Skrytý prázdný", undefined],
  ]);
  assert.ok(issues.every((issue) => issue.severity === "warning"));
});
