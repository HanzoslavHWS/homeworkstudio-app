import assert from "node:assert/strict";
import test from "node:test";
import {
  TECHNICAL_REPORT_PARSERS,
  detectLikelyTechnicalReportCategory,
  getTechnicalReportParser,
} from "../domain/technicalReportParsers/index.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";

// =========================================================================================
// Technické rastry — the adapter/parser pattern (spec section 40): 5 thin category parsers,
// all delegating to the SAME shared table-parsing core. These tests prove the wiring, not the
// core algorithm again (already covered by technicalReportTableParsing.test.ts).
// =========================================================================================

function item(str: string, x: number, y: number, page = 1, width?: number, height = 9): PdfTextItem {
  return { str, page, x, y, width: width ?? str.length * 5, height };
}

test("all 5 required categories are registered (spec section 8: electricity/internet/waste/cleaning/water minimum)", () => {
  const categories = TECHNICAL_REPORT_PARSERS.map((parser) => parser.category).sort();
  assert.deepEqual(categories, ["cleaning", "electricity", "internet", "waste", "water"]);
});

test("getTechnicalReportParser resolves a known category and returns undefined for an unknown one", () => {
  assert.equal(getTechnicalReportParser("electricity")?.category, "electricity");
  assert.equal(getTechnicalReportParser("does-not-exist"), undefined);
});

test("each parser's parse() produces a standardized ParsedTechnicalReport tagged with its OWN category, regardless of input", () => {
  const items: PdfTextItem[] = [
    item("Do 2 kW 230V", 200, 100), item("Jistič C", 300, 100),
    item("1A21", 20, 80), item("Testovací", 60, 80), item("firma", 110, 80), item("s.r.o.", 150, 80), item("1", 210, 80), item("0", 310, 80),
  ];
  for (const parser of TECHNICAL_REPORT_PARSERS) {
    const report = parser.parse(items);
    assert.equal(report.category, parser.category);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0]?.standNumber, "1A21");
    assert.equal(report.rows[0]?.services[0]?.category, parser.category, "each service inherits ITS parser's category, not a hardcoded one");
  }
});

test("boilerplate rows (HALA/SEKTOR/Mezisoučet/Celkem) never produce a stand through any of the 5 parsers", () => {
  const items: PdfTextItem[] = [
    item("Do 2 kW 230V", 200, 100),
    item("HALA", 20, 80), item("1", 60, 80),
    item("Mezisoučet", 20, 60),
    item("Celkem", 20, 40),
  ];
  for (const parser of TECHNICAL_REPORT_PARSERS) {
    const report = parser.parse(items);
    assert.equal(report.rows.length, 0);
  }
});

test("detectLikelyTechnicalReportCategory: a hint, never the sole selection mechanism — matches the report title text", () => {
  assert.equal(detectLikelyTechnicalReportCategory("Přehled - elektrická energie"), "electricity");
  assert.equal(detectLikelyTechnicalReportCategory("Přehled - Internet a WiFi"), "internet");
  assert.equal(detectLikelyTechnicalReportCategory("Přehled - odpad, kontejnery"), "waste");
  assert.equal(detectLikelyTechnicalReportCategory("Přehled - denní a generální úklid"), "cleaning");
  assert.equal(detectLikelyTechnicalReportCategory("Přehled - vodovodní přípojka"), "water");
});

test("detectLikelyTechnicalReportCategory returns undefined when nothing matches — never forces a guess", () => {
  assert.equal(detectLikelyTechnicalReportCategory("Zcela neznámý typ dokumentu"), undefined);
});

// =========================================================================================
// Compound cell values through the FULL parser pipeline (spec section 2/3/5) — models the real
// electricity report's "Osvětlení"+"Non stop" fused-header defect: two columns collapse into one
// PDF text run, so the data row's cell for that column is a compound "0 0"/"1 0" string.
// =========================================================================================
test("a non-zero compound value (fused columns) never becomes a guessed TechnicalService — it becomes a warning instead, raw data preserved", () => {
  const items: PdfTextItem[] = [
    item("Do 2kW 230V", 200, 466), item("Osvětlení", 300, 466), item("Non stop", 340, 466),
    // "Osvětlení" and "Non stop" fuse into ONE pdf text item on the data row (exactly what pdf.js
    // reported for the real PDF) — so the resulting cell for that merged column is "1 0".
    item("1A01", 20, 448), item("European", 60, 448), item("Trading", 110, 448), item("s.r.o.", 160, 448),
    item("1", 210, 448), item("1 0", 320, 448),
  ];
  const parser = getTechnicalReportParser("electricity")!;
  const report = parser.parse(items);
  const stand = report.rows.find((row) => row.standNumber === "1A01");
  assert.ok(stand, "the stand row itself must still be parsed");
  assert.equal(stand?.services.some((service) => service.rawValue.includes(" ")), false, "no service may be created from a compound raw value");
  assert.equal(stand?.services.find((service) => service.externalLabel === "Do 2kW 230V")?.quantity, 1, "the unaffected, unambiguous column must still work normally");
  assert.ok(report.warnings.some((warning) => warning.message.includes("1 0") && warning.message.includes("1A01")), "a warning must be recorded, naming the stand and the raw compound value");
});

test("an all-zero compound value (fused columns, both genuinely unordered) creates neither a service nor a warning — it's simply not ordered", () => {
  const items: PdfTextItem[] = [
    item("Do 2kW 230V", 200, 466), item("Osvětlení", 300, 466), item("Non stop", 340, 466),
    item("1A03", 20, 448), item("BDK-GLASS", 60, 448), item("s.r.o.", 160, 448),
    item("0", 210, 448), item("0 0", 320, 448),
  ];
  const parser = getTechnicalReportParser("electricity")!;
  const report = parser.parse(items);
  const stand = report.rows.find((row) => row.standNumber === "1A03");
  assert.equal(stand?.services.length, 0, "an all-zero compound must never create a service");
  assert.equal(report.warnings.length, 0, "an all-zero compound is legitimately 'not ordered' — no warning noise");
});

test("a note between two stand rows is attached correctly through the full parser (not just the shared core in isolation)", () => {
  const items: PdfTextItem[] = [
    item("Kontejner 1100 l", 200, 100),
    item("1B04", 20, 80), item("KLIA", 60, 80), item("PRAHA", 100, 80), item("s.r.o.", 140, 80), item("1", 210, 80),
    item("doobjednáno", 20, 60), item("telefonicky", 90, 60),
    item("1B05", 20, 40), item("Jiná", 60, 40), item("firma", 100, 40), item("s.r.o.", 140, 40), item("0", 210, 40),
  ];
  const wasteParser = getTechnicalReportParser("waste")!;
  const report = wasteParser.parse(items);
  const standWithNote = report.rows.find((row) => row.standNumber === "1B04");
  assert.equal(standWithNote?.notes.length, 1);
  assert.match(standWithNote?.notes[0]?.text ?? "", /doobjednáno telefonicky/u);
});
