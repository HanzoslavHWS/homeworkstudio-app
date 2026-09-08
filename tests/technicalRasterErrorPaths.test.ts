import assert from "node:assert/strict";
import test from "node:test";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseGenericStandTable, type PdfTextItem } from "../domain/technicalReportTableParsing.ts";
import { detectRasterStandLabels } from "../lib/pdf/rasterStandLabelDetection.ts";
import type { PdfPageSize } from "../lib/pdf/pdfTextExtraction.ts";

// =========================================================================================
// Technické rastry — error boundaries / "fail loudly, not silently" (spec batch 2.5 section 22).
// None of these may crash the module, fabricate data, or report a failed operation as a success.
// =========================================================================================

test("invalid PDF bytes: pdfjs-dist's own getDocument() rejects with a catchable error — the app's loadPdfDocument()/handleRasterFileSelected() try/catch chain relies on exactly this", async () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await assert.rejects(async () => {
    await pdfjsLib.getDocument({ data: garbage }).promise;
  });
});

test("empty PDF bytes: also rejects cleanly, never hangs or throws synchronously outside a catchable promise", async () => {
  await assert.rejects(async () => {
    await pdfjsLib.getDocument({ data: new Uint8Array(0) }).promise;
  });
});

test("PDF with no text layer at all (empty items[]): detectRasterStandLabels returns an empty array, never crashes", () => {
  const pageSizes = new Map<number, PdfPageSize>([[1, { widthPt: 100, heightPt: 100, transform: [1, 0, 0, -1, 0, 100] }]]);
  assert.deepEqual(detectRasterStandLabels([], pageSizes), []);
});

test("PDF with no text layer at all: parseGenericStandTable on an empty item list reports a warning, never a crash, never a fabricated row", () => {
  const result = parseGenericStandTable([]);
  assert.deepEqual(result.rows, []);
  assert.ok(result.warnings.length > 0);
  assert.equal(result.headerFound, false);
});

test("a report with real stand rows but NO discoverable header row: rows are still returned (never silently dropped), with an explicit warning that the header wasn't found — never a crash, never fabricated column data", () => {
  function item(str: string, x: number, y: number): PdfTextItem {
    return { str, page: 1, x, y, width: str.length * 5, height: 9 };
  }
  // every candidate row before the data start is a single-item row (front-matter), so no row
  // ever qualifies as a >=2-item header candidate.
  const items: PdfTextItem[] = [
    item("Přehled - neznámý report", 20, 900),
    item("Firma: ABF, a.s.", 20, 880),
    item("1A01", 20, 80), item("Testovací", 60, 80), item("firma", 110, 80), item("s.r.o.", 150, 80), item("1", 210, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.headerFound, false);
  assert.equal(result.rows.length, 1, "the stand row itself must still be reported, never dropped just because the header couldn't be identified");
  assert.equal(result.rows[0]?.standNumber, "1A01");
  assert.equal(result.rows[0]?.columnValues.size, 0, "without a discoverable header, values can't be assigned to a specific column — but nothing is guessed either");
  assert.ok(result.warnings.some((w) => w.message.includes("Hlavička sloupců nebyla rozpoznána")));
});

test("a report with zero stand-shaped rows anywhere (e.g. every row is boilerplate) never fabricates a fake stand — empty rows, explicit warning", () => {
  function item(str: string, x: number, y: number): PdfTextItem {
    return { str, page: 1, x, y, width: str.length * 5, height: 9 };
  }
  const items: PdfTextItem[] = [item("Přehled - elektrická energie", 20, 900), item("Firma: ABF, a.s.", 20, 880), item("Celkem", 20, 100), item("0", 60, 100)];
  const result = parseGenericStandTable(items);
  assert.deepEqual(result.rows, []);
  assert.ok(result.warnings.length > 0, "must fail loudly (a warning), never silently report success with zero stands");
});
