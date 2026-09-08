import assert from "node:assert/strict";
import test from "node:test";
import {
  assignRowToColumns,
  buildTableColumns,
  evaluateNumericCellValue,
  groupTextItemsIntoRows,
  isNonStandReportLine,
  looksLikeStandNumberToken,
  parseGenericStandTable,
  rowText,
  type PdfTextItem,
} from "../domain/technicalReportTableParsing.ts";

// =========================================================================================
// Technické rastry — table reconstruction from PDF-positioned text (spec section 9/10/37).
// Synthetic PdfTextItem fixtures modeled directly on the spec's own real-report examples —
// this repo has no way to load a real PDF binary in tests, so the ALGORITHM is proven against
// representative positioned text instead (the browser-side pdfjs-dist adapter, lib/pdf/
// pdfTextExtraction.ts, is a thin, separately-reviewed translation layer this doesn't re-test).
// =========================================================================================

function item(str: string, x: number, y: number, page = 1, width?: number, height = 9): PdfTextItem {
  return { str, page, x, y, width: width ?? str.length * 5, height };
}

test("looksLikeStandNumberToken: matches spec section 3/26 examples, rejects plain numbers/words", () => {
  assert.equal(looksLikeStandNumberToken("1A01"), true);
  assert.equal(looksLikeStandNumberToken("1A11b"), true);
  assert.equal(looksLikeStandNumberToken("1B02b"), true);
  assert.equal(looksLikeStandNumberToken("1C01"), true);
  assert.equal(looksLikeStandNumberToken("40"), false);
  assert.equal(looksLikeStandNumberToken("Celkem"), false);
  assert.equal(looksLikeStandNumberToken("ABF"), false);
});

test("isNonStandReportLine: HALA/SEKTOR/Mezisoučet/Celkem and report front-matter are recognized, a real line is not", () => {
  assert.equal(isNonStandReportLine("HALA 1"), true);
  assert.equal(isNonStandReportLine("SEKTOR 1A"), true);
  assert.equal(isNonStandReportLine("Mezisoučet"), true);
  assert.equal(isNonStandReportLine("Celkem"), true);
  assert.equal(isNonStandReportLine("Firma: ABF, a.s."), true);
  assert.equal(isNonStandReportLine("1A01 European Trading Subsidiary s.r.o."), false);
});

// Real ABF exports prefix several boilerplate lines with a "**" bullet marker, and use "Sekce:"
// (distinct from "Sektor") as another sub-grouping keyword — found only once real PDFs (FOR
// DECOR 2026) were fed through the parser; a leading "**" was silently defeating every one of
// the patterns above since they're all anchored to the start of the line.
test("isNonStandReportLine: tolerates a real report's own '**' bullet marker, and recognizes 'Sekce:'", () => {
  assert.equal(isNonStandReportLine("** SEKTOR 1A"), true);
  assert.equal(isNonStandReportLine("** Mezisoučet SEKTOR 0 0 1 0"), true);
  assert.equal(isNonStandReportLine("** Sekce: 1B"), true);
  assert.equal(isNonStandReportLine("** Hala: 1"), true);
  assert.equal(isNonStandReportLine("** SEKTOR"), true);
});

// =========================================================================================
// evaluateNumericCellValue — compound cell values (spec section 2/3/4). Found on the real
// electricity report: two adjacent columns ("Osvětlení"/"Non stop") fused into one PDF text
// run upstream of us, so both values land in the same cell (e.g. "0 0", "1 0"). We can never
// know deterministically which token belongs to which real column — a non-zero compound value
// must NEVER become a guessed TechnicalService, only a zero-only compound is safely ignorable.
// =========================================================================================
test("evaluateNumericCellValue: a plain single value behaves exactly as before (simple number, never a compound)", () => {
  assert.deepEqual(evaluateNumericCellValue("0"), { kind: "zero" });
  assert.deepEqual(evaluateNumericCellValue("-"), { kind: "zero" });
  assert.deepEqual(evaluateNumericCellValue(""), { kind: "zero" });
  assert.deepEqual(evaluateNumericCellValue("1"), { kind: "single", quantity: 1 });
  assert.deepEqual(evaluateNumericCellValue("40"), { kind: "single", quantity: 40 });
  assert.deepEqual(evaluateNumericCellValue("2"), { kind: "single", quantity: 2 });
});

test("evaluateNumericCellValue: an ALL-ZERO compound value is still just 'not ordered' — no service, no warning needed", () => {
  assert.deepEqual(evaluateNumericCellValue("0 0"), { kind: "zero" });
  assert.deepEqual(evaluateNumericCellValue("0 0 0"), { kind: "zero" });
});

test("evaluateNumericCellValue: any NON-ZERO compound value is ambiguous — never guessed as a specific quantity", () => {
  assert.deepEqual(evaluateNumericCellValue("1 0"), { kind: "ambiguousCompound", parts: ["1", "0"] });
  assert.deepEqual(evaluateNumericCellValue("0 1"), { kind: "ambiguousCompound", parts: ["0", "1"] });
  assert.deepEqual(evaluateNumericCellValue("1 1"), { kind: "ambiguousCompound", parts: ["1", "1"] });
  assert.deepEqual(evaluateNumericCellValue("2 0"), { kind: "ambiguousCompound", parts: ["2", "0"] });
});

test("evaluateNumericCellValue: unparsable text never silently becomes quantity=1 — treated as ambiguous, never a guess", () => {
  const result = evaluateNumericCellValue("abc");
  assert.equal(result.kind, "ambiguousCompound");
});

test("groupTextItemsIntoRows groups by Y regardless of input order, sorts items within a row by X", () => {
  const items = [item("B", 50, 100), item("A", 10, 100), item("C", 10, 50)];
  const rows = groupTextItemsIntoRows(items);
  assert.equal(rows.length, 2);
  assert.equal(rowText(rows[0]!), "A B");
  assert.equal(rowText(rows[1]!), "C");
});

test("buildTableColumns + assignRowToColumns: values are assigned by X-position proximity, never by getTextContent() item order (spec section 10)", () => {
  const headerRow = groupTextItemsIntoRows([item("Do 2 kW 230V", 200, 100), item("Jistič C", 320, 100)])[0]!;
  const columns = buildTableColumns(headerRow.items);
  // deliberately out-of-order items in the array — reconstruction must not depend on it.
  const dataRow = groupTextItemsIntoRows([item("0", 320, 50), item("1", 200, 50)])[0]!;
  const values = assignRowToColumns(dataRow, columns);
  assert.equal(values.get("Do 2 kW 230V"), "1");
  assert.equal(values.get("Jistič C"), "0");
});

// =========================================================================================
// C) ignored report rows (spec section 9/37C) — HALA/SEKTOR/Mezisoučet/Celkem must never
// become a stand row, even interspersed between real data rows.
// =========================================================================================
test("C) HALA/SEKTOR/Mezisoučet/Celkem rows never produce a stand row", () => {
  const items: PdfTextItem[] = [
    item("Přehled - elektrická energie", 20, 900),
    item("Firma:", 20, 880), item("ABF,", 60, 880), item("a.s.", 90, 880),
    item("Do", 200, 840), item("2", 220, 840), item("kW", 235, 840), item("230V", 255, 840),
    item("1A01", 20, 820), item("European", 60, 820), item("Trading", 110, 820), item("s.r.o.", 160, 820), item("1", 210, 820),
    item("HALA", 20, 800), item("1", 60, 800),
    item("SEKTOR", 20, 780), item("1A", 60, 780),
    item("1A03", 20, 760), item("BDK-GLASS,", 60, 760), item("spol.", 120, 760), item("s", 150, 760), item("r.o.", 160, 760), item("0", 210, 760),
    item("Mezisoučet", 20, 740),
    item("Celkem", 20, 720),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.standNumber), ["1A01", "1A03"]);
});

// =========================================================================================
// D) quantity (spec section 12/14/37D) — real numbers, never coerced to boolean.
// =========================================================================================
test("D) quantity value 2 stays 2 (never becomes true/1)", () => {
  const items: PdfTextItem[] = [
    item("Internet", 200, 100), item("Další WIFI přípojka", 300, 100),
    item("1A05", 20, 80), item("MARK", 60, 80), item("&", 100, 80), item("MORE", 110, 80), item("1", 210, 80), item("2", 310, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows[0]?.columnValues.get("Další WIFI přípojka"), "2");
});

test("D) quantity value 40 stays 40 (never becomes true/1) — spec's own 'Denní úklid: 40' example", () => {
  const items: PdfTextItem[] = [
    item("Denní úklid", 200, 100), item("Generální úklid", 300, 100),
    item("1C01", 20, 80), item("Škoda", 60, 80), item("Auto", 100, 80), item("a.s.", 140, 80), item("40", 210, 80), item("0", 310, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows[0]?.columnValues.get("Denní úklid"), "40");
  assert.equal(result.rows[0]?.columnValues.get("Generální úklid"), "0");
});

// =========================================================================================
// E) notes attached to the preceding stand (spec section 13/37E) — the waste-report example.
// =========================================================================================
test("E) a free-text line between two stand rows is attached as a note to the PRECEDING stand, never dropped", () => {
  const items: PdfTextItem[] = [
    item("Kontejner 1100 l", 200, 100),
    item("1B04", 20, 80), item("KLIA", 60, 80), item("PRAHA", 100, 80), item("s.r.o.", 140, 80), item("1", 210, 80),
    item("doobjednáno", 20, 60), item("telefonicky", 90, 60), item("dne", 150, 60), item("5.9.", 175, 60),
    item("1B05", 20, 40), item("Jiná", 60, 40), item("firma", 100, 40), item("s.r.o.", 140, 40), item("0", 210, 40),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows.length, 2);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0]?.afterStandNumber, "1B04");
  assert.match(result.notes[0]?.text ?? "", /doobjednáno telefonicky dne 5\.9\./u);
});

test("header row is detected as the nearest preceding multi-item row — company name text is separated from numeric column values", () => {
  const items: PdfTextItem[] = [
    item("Do 2 kW 230V", 200, 100), item("Jistič C", 300, 100),
    item("1A01", 20, 80), item("European", 60, 80), item("Trading", 110, 80), item("Subsidiary", 160, 80), item("s.r.o.", 210, 80), item("1", 250, 80), item("0", 320, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.headerFound, true);
  assert.equal(result.rows[0]?.companyName, "European Trading Subsidiary s.r.o.");
  assert.equal(result.rows[0]?.columnValues.get("Do 2 kW 230V"), "1");
  assert.equal(result.rows[0]?.columnValues.get("Jistič C"), "0");
});

// =========================================================================================
// Real-PDF-driven regression tests (found only once the ACTUAL FOR DECOR 2026 reports were fed
// through the parser — synthetic fixtures alone didn't surface these). Two real defects:
//  1) a company/hall/grand-total SUBTOTAL row (label + a run of quantities, no boilerplate
//     keyword) was being mistaken for the column header, collapsing every real column into one.
//  2) real ABF reports often split ONE logical column header across two stacked PDF text lines
//     (e.g. "Rozvaděč" directly above "9-21kW") — using only the nearer line lost the category
//     word, and worse, two DIFFERENT columns sharing the same nearer-line word (e.g. "přípojka"
//     appearing under both "Další" and "Další WIFI") silently merged their values together.
// =========================================================================================
test("a numeric-majority subtotal row (e.g. the exporting company's own grand-total line) is never mistaken for the column header", () => {
  const items: PdfTextItem[] = [
    item("Rozvaděč", 247, 466), item("Do 2kW", 309, 466),
    item("9-21kW", 251, 458), item("230V", 315, 458),
    // "ABF, a.s." grand-total row: shaped exactly like a data row, but not a real stand — no
    // boilerplate keyword prefix at all, must still be rejected as a header candidate.
    item("ABF, a.s.", 82, 417), item("0", 261, 417), item("1", 320, 417),
    item("** SEKTOR 1A", 36, 360),
    item("1A01", 20, 349), item("European", 60, 349), item("Trading", 110, 349), item("s.r.o.", 160, 349), item("0", 261, 349), item("1", 320, 349),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows.length, 1);
  assert.equal(result.headerFound, true);
  // proves the header actually came from the two text-header rows, not the "ABF, a.s." subtotal —
  // a real, distinct column label, never "0" or "1" literally.
  assert.equal(result.rows[0]?.columnValues.get("Rozvaděč 9-21kW"), "0");
  assert.equal(result.rows[0]?.columnValues.get("Do 2kW 230V"), "1");
});

test("a two-line column header is joined by X position; two different columns sharing the same lower-line word never collapse into one", () => {
  const items: PdfTextItem[] = [
    item("Číslo stánku", 28, 713), item("Firma", 105, 713), item("Další", 357, 713), item("Další WIFI", 419, 713),
    item("Pevná IP", 286, 705), item("Internet", 326, 705), item("přípojka", 357, 705), item("WIFI", 400, 705), item("přípojka", 419, 705),
    item("1B04", 20, 677), item("KLIA", 60, 677), item("PRAHA", 100, 677), item("s.r.o.", 140, 677),
    // positioned at the resulting merged columns' own centers (306 / 346 / 373.25 / 410 / 441.5)
    // rather than the header items' left edges, so the assertion isn't at the mercy of this test
    // fixture's own crude str.length-based width estimate producing a near-tie between columns.
    item("1", 303, 677, 1, 6), item("1", 343, 677, 1, 6), item("0", 370, 677, 1, 6), item("2", 407, 677, 1, 6), item("0", 439, 677, 1, 6),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.headerFound, true);
  const values = result.rows[0]?.columnValues;
  // standalone lower-line-only columns (no upper-line counterpart) keep their own plain label.
  assert.equal(values?.get("Pevná IP"), "1");
  assert.equal(values?.get("Internet"), "1");
  assert.equal(values?.get("WIFI"), "2");
  // the two "přípojka" columns must stay DISTINCT (joined with their own upper-line word) —
  // never merged into one "přípojka" entry just because they share the lower-line text.
  assert.equal(values?.get("Další přípojka"), "0");
  assert.equal(values?.get("Další WIFI přípojka"), "0");
  assert.equal(values?.has("přípojka"), false);
});

// =========================================================================================
// L) Company name variants (spec batch 2.5 section 12L): s.r.o., a.s., Polish diacritics, and a
// comma embedded in the company name itself — company name is only ever informational (spec
// section 27), but it must still be extracted intact, never truncated at the comma/diacritic.
// =========================================================================================
test("L) company name with 's.r.o.' is captured intact", () => {
  const items: PdfTextItem[] = [
    item("Do 2kW", 200, 100),
    item("1A01", 20, 80), item("European", 60, 80), item("Trading", 110, 80), item("s.r.o.", 160, 80), item("1", 210, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows[0]?.companyName, "European Trading s.r.o.");
});

test("L) company name with 'a.s.' is captured intact", () => {
  const items: PdfTextItem[] = [
    item("Do 2kW", 200, 100),
    item("1C01", 20, 80), item("Škoda", 60, 80), item("Auto", 100, 80), item("a.s.", 140, 80), item("1", 210, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows[0]?.companyName, "Škoda Auto a.s.");
});

test("L) company name with a comma embedded in it is captured intact, never truncated at the comma", () => {
  const items: PdfTextItem[] = [
    item("Do 2kW", 200, 100),
    item("1A03", 20, 80), item("BDK-GLASS,", 60, 80), item("spol.", 120, 80), item("s", 150, 80), item("r.o.", 165, 80), item("0", 210, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows[0]?.companyName, "BDK-GLASS, spol. s r.o.");
});

test("L) company name with Polish diacritics is captured intact, not mangled or dropped", () => {
  const items: PdfTextItem[] = [
    item("Do 2kW", 200, 100),
    item("1A15", 20, 80), item("Świątkowski", 60, 80), item("Ślusarnia", 130, 80), item("sp.", 190, 80), item("z", 210, 80), item("o.o.", 225, 80), item("1", 250, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows[0]?.companyName, "Świątkowski Ślusarnia sp. z o.o.");
});

// =========================================================================================
// Notes traceability at the parser level (spec batch 2.5 section 19): a single logical line,
// even split across several PDF text items on the SAME row (same Y), becomes exactly ONE note.
// Two genuinely separate logical lines become TWO notes. Report front-matter (header) and the
// report generator's own footer must NEVER become a note.
// =========================================================================================
test("one logical note line split across THREE separate PDF text items on the same row -> exactly ONE note", () => {
  const items: PdfTextItem[] = [
    item("Kontejner 1100 l", 200, 100),
    item("1B04", 20, 80), item("KLIA", 60, 80), item("PRAHA", 100, 80), item("s.r.o.", 140, 80), item("1", 210, 80),
    item("doobjednáno", 20, 60), item("telefonicky", 90, 60), item("dne", 150, 60),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0]!.text, /doobjednáno telefonicky dne/u);
});

test("TWO genuinely separate logical note lines (different Y) after a stand row -> TWO notes, never merged into one", () => {
  const items: PdfTextItem[] = [
    item("Kontejner 1100 l", 200, 100),
    item("1B04", 20, 80), item("KLIA", 60, 80), item("PRAHA", 100, 80), item("s.r.o.", 140, 80), item("1", 210, 80),
    item("doobjednáno telefonicky", 20, 60),
    item("zašle emailem potvrzení", 20, 45),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.notes.length, 2);
  assert.match(result.notes[0]!.text, /doobjednáno telefonicky/u);
  assert.match(result.notes[1]!.text, /zašle emailem potvrzení/u);
});

test("report front-matter (header text before the table) never becomes a note, even though it technically precedes a stand row in the document", () => {
  const items: PdfTextItem[] = [
    item("Přehled - odpad", 20, 900),
    item("Firma: ABF, a.s.", 20, 880),
    item("Do 2kW", 200, 100),
    item("1B04", 20, 80), item("KLIA", 60, 80), item("s.r.o.", 120, 80), item("1", 210, 80),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.notes.length, 0);
  assert.equal(result.rows.length, 1);
});

test("the report generator's own print footer never becomes a note attached to the last stand", () => {
  const items: PdfTextItem[] = [
    item("Do 2kW", 200, 100),
    item("1B04", 20, 80), item("KLIA", 60, 80), item("s.r.o.", 120, 80), item("1", 210, 80),
    item("Výtisk", 20, 30), item("sestavil(a)", 60, 30), item("Jan", 120, 30), item("Polánek", 150, 30), item("dne", 190, 30), item("25.08.2026", 210, 30), item("strana", 270, 30), item("1", 310, 30),
  ];
  const result = parseGenericStandTable(items);
  assert.equal(result.notes.length, 0, "the print footer must never attach itself as a note to the preceding stand");
});

test("no stand-number-shaped row anywhere -> empty result with a warning, never a crash", () => {
  const items: PdfTextItem[] = [item("Celkem", 20, 100), item("0", 60, 100)];
  const result = parseGenericStandTable(items);
  assert.equal(result.rows.length, 0);
  assert.ok(result.warnings.length > 0);
});
