import assert from "node:assert/strict";
import test from "node:test";
import { buildTechnicalStandTableFromWorkbook, parseTechnicalReportWorkbook } from "../domain/technicalReportExcelTable.ts";
import { detectLikelyTechnicalReportCategory } from "../domain/technicalReportParsers/index.ts";
import type { ParsedTechnicalReport } from "../domain/technicalRaster.ts";
import type { TechnicalWorkbookCell } from "../domain/technicalReportWorkbook.ts";
import { CLEANING_LAYOUT, ELECTRICITY_LAYOUT, INTERNET_LAYOUT, WATER_LAYOUT, layoutToSheet, type CellLayout } from "./technicalReportExcelFixtures.ts";

// =========================================================================================
// Technické rastry — Excel (.xlsx) import mapping on the real ABRA export structures (see
// tests/technicalReportExcelFixtures.ts). The expected service labels are EXACTLY the labels the
// PDF import produces for the same reports, so product matching and merge stay identical.
// =========================================================================================

function parse(category: string, layout: CellLayout, extraCells: Readonly<Record<string, TechnicalWorkbookCell>> = {}) {
  return parseTechnicalReportWorkbook(category, { sheets: [layoutToSheet(layout, {}, extraCells)] });
}

function servicesByStand(report: ParsedTechnicalReport): Record<string, string[]> {
  return Object.fromEntries(report.rows.map((row) => [row.standNumber, row.services.map((service) => `${service.externalLabel}=${service.quantity}`)]));
}

test("voda: headers I/J/L are paired with values H/J/K by order, front matter with „stánku“ is not a header", () => {
  const { report, check } = parse("water", WATER_LAYOUT);
  assert.deepEqual(servicesByStand(report), {
    "3A03": ["Voda, odpad=1"],
    "3A11": ["Bazén - přípojka=1", "Bazén - objem=1"],
    "3A45": ["Voda, odpad=1"],
  });
  assert.deepEqual(report.rows.map((row) => row.companyName), ["Firma Alfa s.r.o.", "Firma Beta s.r.o.", "Firma Gama s.r.o."]);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(check?.headerRowNumbers, [8, 9]);
  assert.deepEqual(check?.columns, [
    { label: "Voda, odpad", headerColumn: "I", valueColumn: "H" },
    { label: "Bazén - přípojka", headerColumn: "J", valueColumn: "J" },
    { label: "Bazén - objem", headerColumn: "L", valueColumn: "K" },
  ]);
  assert.deepEqual(check?.totals, { status: "match" });
  assert.equal(report.rows[0]!.services[0]!.rawRow, "řádek 11: 3A03 Firma Alfa s.r.o. 1 0 0");
});

test("internet: three stacked header rows give the PDF labels; the shifted „Celkem“ (O instead of N) still verifies", () => {
  const { report, check } = parse("internet", INTERNET_LAYOUT);
  assert.deepEqual(check?.columns.map((column) => column.label), [
    "Pevná IP", "Internet", "Další přípojka", "WIFI", "Další WIFI přípojka", "RJ 2 EEt", "WIFI 2 EEt", "Router zapůjčení",
  ]);
  assert.deepEqual(check?.headerRowNumbers, [8, 9, 10]);
  assert.deepEqual(servicesByStand(report), {
    "3A21": ["WIFI=1"],
    "3A45": ["Pevná IP=1", "Internet=1", "Router zapůjčení=1"],
    "4A19": ["Internet=1", "Další přípojka=1"],
  });
  assert.equal(report.rows[2]!.companyName, "Firma Gama s.r.o.", "double spaces collapsed like the PDF text");
  assert.deepEqual(check?.totals, { status: "match" });
  assert.deepEqual(report.warnings, []);
});

test("elektřina: 17 services, value column O between headers N and P is „Do 5kW“, wrapped „Celkem“ verifies, all-zero row is BEZ", () => {
  const { report, check } = parse("electricity", ELECTRICITY_LAYOUT);
  assert.equal(check?.columns.length, 17);
  assert.deepEqual(check?.columns.map((column) => column.label), [
    "Rozvaděč 9-21kW", "EET 0.5KW", "Do 2kW 230V", "Do 3kW 230V", "Do 5kW 230V", "Do 6kW 230V", "Do 9kW 400V", "Do 15kW 400V",
    "Do 21kW 400V", "Do 40kW 400V", "+ kW", "Lednicový okruh", "Vrchní přívod", "Jistič C", "Jistič D", "Osvětlení", "Non stop",
  ]);
  assert.deepEqual(check?.columns.find((column) => column.valueColumn === "O"), { label: "Do 5kW 230V", headerColumn: "P", valueColumn: "O" });
  assert.deepEqual(servicesByStand(report), {
    "3A01": ["Do 6kW 230V=1", "Jistič C=1"],
    "3A02": [],
    "3A03": ["Do 5kW 230V=1"],
    "4C06": ["Rozvaděč 9-21kW=2", "Do 21kW 400V=2", "Do 40kW 400V=1", "Jistič D=1"],
  });
  assert.deepEqual(report.rows.map((row) => Boolean(row.explicitNoServiceAssignment)), [false, true, false, false]);
  assert.deepEqual(check?.totals, { status: "match" });
  assert.deepEqual(report.warnings, [], "hall/sector/subtotal rows and the unlabeled totals half are not warnings");
});

test("úklid: the row with a quantity but no stand number and its note are reported, never imported or attached elsewhere", () => {
  const { report, check } = parse("cleaning", CLEANING_LAYOUT);
  assert.deepEqual(servicesByStand(report), { "3A02": ["Denní úklid=8"], "3B01": ["Generální úklid=15"], "3C01": ["Denní úklid=24"] });
  assert.ok(report.rows.every((row) => row.notes.length === 0));
  assert.equal(check?.rowsWithoutStandCount, 1);
  assert.deepEqual(check?.totals, { status: "match" }, "the report's own total includes the row without a stand");
  assert.equal(report.warnings.length, 2);
  assert.ok(report.warnings.some((warning) => /řádek 10: řádek „Pořadatel - propagace“ má objednané služby \(Denní úklid 18\), ale nemá číslo stánku/u.test(warning.message)));
  assert.ok(report.warnings.some((warning) => /řádek 11: poznámka patří k řádku 10 bez čísla stánku/u.test(warning.message) && warning.rawText === "doobjednávka úklidu"));
});

test("the title row gives the same category hint as the PDF title", () => {
  const cases: [string, CellLayout][] = [["electricity", ELECTRICITY_LAYOUT], ["internet", INTERNET_LAYOUT], ["water", WATER_LAYOUT], ["cleaning", CLEANING_LAYOUT]];
  for (const [category, layout] of cases) {
    assert.equal(detectLikelyTechnicalReportCategory(parse(category, layout).titleText), category);
  }
});

test("a free-text row right after a stand row becomes that stand's note", () => {
  // the water layout without its subtotal/total/footer rows (14–16), then a note in row 14
  const stands: CellLayout = Object.fromEntries(Object.entries(WATER_LAYOUT).filter(([address]) => !/^[A-Z]+1[456]$/u.test(address)));
  const { report } = parse("water", { ...stands, E14: "dodat až ve čtvrtek", A15: "Celkem: ", H15: 2, J15: 1, K15: 1 });
  assert.deepEqual(report.rows.find((row) => row.standNumber === "3A45")?.notes.map((note) => [note.text, note.rawRow]), [["dodat až ve čtvrtek", "řádek 14: dodat až ve čtvrtek"]]);
  assert.deepEqual(report.warnings, []);
});

test("value columns that do not match the header count stop the import — no guessed columns", () => {
  const { report, check } = parse("water", { ...WATER_LAYOUT, M12: 1 });
  assert.equal(report.rows.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0]!.message, /počet sloupců s množstvím \(4: H, J, K, M\) neodpovídá počtu služeb v hlavičce \(3: /u);
  assert.match(report.warnings[0]!.message, /použijte PDF výjezd/u);
  assert.deepEqual(check?.columns, []);
});

test("an unknown cell value (Excel error, formula without result, merged continuation) is a warning with its address, never a zero", () => {
  const { report } = parse("water", WATER_LAYOUT, {
    H12: { kind: "error", code: "#REF!" },
    J13: { kind: "formulaWithoutResult", formula: "SUM(J1:J2)" },
    K13: { kind: "mergedContinuation", masterAddress: "J13" },
  });
  const messages = report.warnings.map((warning) => warning.message);
  assert.ok(messages.some((message) => /stánek 3A11, služba „Voda, odpad“ \(buňka H12\): buňka obsahuje chybu Excelu #REF!/u.test(message)));
  assert.ok(messages.some((message) => /stánek 3A45, služba „Bazén - přípojka“ \(buňka J13\): vzorec/u.test(message)));
  assert.ok(messages.some((message) => /stánek 3A45, služba „Bazén - objem“ \(buňka K13\): buňka je součástí sloučené oblasti/u.test(message)));
  // 3A45's unknown cells are NOT zeros: its known value still imports
  assert.deepEqual(servicesByStand(report)["3A45"], ["Voda, odpad=1"]);
});

test("text, negative and fractional quantities are flagged; only the fractional one is imported", () => {
  const { report } = parse("water", WATER_LAYOUT, {
    H11: { kind: "text", value: "1 ks" },
    J12: { kind: "number", value: -1 },
    K12: { kind: "number", value: 1.5 },
  });
  const messages = report.warnings.map((warning) => warning.message);
  assert.ok(messages.some((message) => /buňka H11\): místo čísla obsahuje „1 ks“ — hodnota nebyla importována/u.test(message)));
  assert.ok(messages.some((message) => /buňka J12\): záporné množství -1/u.test(message)));
  assert.ok(messages.some((message) => /buňka K12\): neceločíselné množství 1\.5/u.test(message)));
  assert.deepEqual(servicesByStand(report)["3A03"], []);
  assert.deepEqual(servicesByStand(report)["3A11"], ["Bazén - objem=1.5"]);
});

test("a „Celkem“ row that disagrees with the imported rows is a warning naming the service", () => {
  const { report, check } = parse("water", { ...WATER_LAYOUT, H15: 3 });
  assert.deepEqual(check?.totals, { status: "mismatch", differences: [{ label: "Voda, odpad", expected: 3, actual: 2 }] });
  assert.ok(report.warnings.some((warning) => /nesouhlasí s řádkem „Celkem“ — Voda, odpad: načteno 2, v souboru 3/u.test(warning.message)));
});

test("a stand listed twice is reported (its services are summed by the shared builder)", () => {
  const { report } = parse("water", { ...WATER_LAYOUT, C13: "3A03", H15: 2 });
  assert.ok(report.warnings.some((warning) => /řádek 13: stánek 3A03 je v souboru vícekrát \(také řádek 11\)/u.test(warning.message)));
  assert.deepEqual(servicesByStand(report)["3A03"], ["Voda, odpad=1", "Voda, odpad=1"]);
});

test("multi-sheet: the first visible sheet with a stand header is imported, other sheets with data are reported", () => {
  const result = buildTechnicalStandTableFromWorkbook({
    sheets: [
      layoutToSheet({ A1: "Poznámky k výjezdu" }, { name: "Poznámky", position: 1 }),
      layoutToSheet(WATER_LAYOUT, { name: "Hidden", position: 2, visibility: "hidden" }),
      layoutToSheet(WATER_LAYOUT, { name: "Výjezd", position: 3 }),
    ],
  });
  assert.equal(result.check?.sheetName, "Výjezd");
  assert.equal(result.table.rows.length, 3);
  assert.deepEqual(result.table.warnings.map((warning) => warning.message), [
    "List „Poznámky“ obsahuje data, ale nebyl importován — import čte jen list „Výjezd“.",
    "List „Hidden“ obsahuje data, ale nebyl importován — import čte jen list „Výjezd“.",
  ]);
});

test("a workbook without the stand header is rejected loudly", () => {
  const result = buildTechnicalStandTableFromWorkbook({ sheets: [layoutToSheet({ A1: "Ceník", A2: "1A01", B2: 3 })] });
  assert.equal(result.table.headerFound, false);
  assert.equal(result.table.rows.length, 0);
  assert.match(result.table.warnings[0]!.message, /nebyla nalezena hlavička výjezdu/u);
  assert.equal(result.check, undefined);
});

test("a hidden data row and a merged range inside the data are reported; header merges are not", () => {
  const sheet = layoutToSheet(WATER_LAYOUT, { hiddenRowNumbers: [12], mergedRanges: ["I8:K8", "E13:G13"] });
  const { table } = buildTechnicalStandTableFromWorkbook({ sheets: [sheet] });
  const messages = table.warnings.map((warning) => warning.message);
  assert.ok(messages.includes("List „List1“: skrytý řádek 12 obsahuje data."));
  assert.ok(messages.some((message) => message.includes("E13:G13")));
  assert.ok(!messages.some((message) => message.includes("I8:K8")));
  assert.equal(table.rows.length, 3, "a hidden row is still imported — it is data, only flagged");
});
