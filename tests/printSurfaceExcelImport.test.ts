import test from "node:test";
import assert from "node:assert/strict";
import {
  importPrintSurfaceExcel,
  isGroupRow,
  mapExcelRowToPrintSurfaceType,
  parsePrintSurfaceExcelSheet,
  type PrintSurfaceExcelIssue,
} from "../domain/printSurfaceExcelImport.ts";
import type { RawSheetRow } from "../domain/priceImport.ts";

const HEADER_ROW_1: RawSheetRow = ["interni id", "nazev", "typ", "parent_id", "Firma A", "Firma A", "Firma B", "Firma B"];
const HEADER_ROW_2: RawSheetRow = ["", "", "", "", "š", "v", "š", "v"];

function sheet(...dataRows: readonly RawSheetRow[]): readonly RawSheetRow[] {
  return [HEADER_ROW_1, HEADER_ROW_2, ...dataRows];
}

function issuesOf(code: string, issues: readonly PrintSurfaceExcelIssue[]): readonly PrintSurfaceExcelIssue[] {
  return issues.filter((issue) => issue.code === code);
}

test("parsePrintSurfaceExcelSheet: parses the real two-row header (lead columns + company š/v pairs)", () => {
  const result = parsePrintSurfaceExcelSheet(sheet(["Panel_S_100", "Panel stěnový", "panel", "", 950, 2340, 972, 2395]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.companyNames, ["Firma A", "Firma B"]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.sourceRow, 3);
  assert.equal(row.internalId, "Panel_S_100");
  assert.equal(row.name, "Panel stěnový");
  assert.equal(row.typ, "panel");
  assert.equal(row.parentId, undefined);
  assert.equal(row.companies.length, 2);
  assert.deepEqual(row.companies[0], { companyName: "Firma A", width: { kind: "number", value: 950 }, height: { kind: "number", value: 2340 } });
  assert.deepEqual(row.companies[1], { companyName: "Firma B", width: { kind: "number", value: 972 }, height: { kind: "number", value: 2395 } });
});

test("parsePrintSurfaceExcelSheet: rejects a header that doesn't match the expected lead columns", () => {
  const badHeader: RawSheetRow = ["id", "nazev", "typ", "parent_id"];
  const result = parsePrintSurfaceExcelSheet([badHeader, HEADER_ROW_2]);
  assert.equal(result.ok, false);
});

test("isGroupRow / parent-child: a parent product row has no dimensions and is never its own preset", () => {
  const rows = sheet(
    ["Pult_100x50_v", "Pult 1 x 0,5 x 1,1 m", "counter", "", "", "", "", ""],
    ["Pult_100x50_v_Celo", "Čelo", "counter", "Pult_100x50_v", 950, 960, 972, 995],
    ["Pult_100x50_v_Bok", "Bok", "counter", "Pult_100x50_v", 455, 960, 472, 995],
  );
  const parsed = parsePrintSurfaceExcelSheet(rows);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(isGroupRow(parsed.rows[0]!), true);
  assert.equal(isGroupRow(parsed.rows[1]!), false);

  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.counts.parentRows, 1);
  assert.equal(outcome.result.presets.length, 2); // only the two children, never the parent
  const celo = outcome.result.presets.find((preset) => preset.id === "Pult_100x50_v_Celo");
  assert.equal(celo?.parentId, "Pult_100x50_v");
  assert.equal(celo?.parentName, "Pult 1 x 0,5 x 1,1 m");
  assert.equal(celo?.typeId, "counter_front");
  const bok = outcome.result.presets.find((preset) => preset.id === "Pult_100x50_v_Bok");
  assert.equal(bok?.typeId, "counter_side");
});

test("mapExcelRowToPrintSurfaceType: naddveřní panel -> panel_above_door, ostatní panely -> panel", () => {
  assert.deepEqual(mapExcelRowToPrintSurfaceType({ typ: "panel", name: "Panel naddveřní (nad shrnovačky)" }), { ok: true, typeId: "panel_above_door" });
  assert.deepEqual(mapExcelRowToPrintSurfaceType({ typ: "panel", name: "Panel stěnový 1 x 2,5 m" }), { ok: true, typeId: "panel" });
});

test("mapExcelRowToPrintSurfaceType: showcase vždy -> showcase", () => {
  assert.deepEqual(mapExcelRowToPrintSurfaceType({ typ: "showcase", name: "Čelo" }), { ok: true, typeId: "showcase" });
  assert.deepEqual(mapExcelRowToPrintSurfaceType({ typ: "showcase", name: "Bok" }), { ok: true, typeId: "showcase" });
});

test("mapExcelRowToPrintSurfaceType: counter Čelo -> counter_front, Bok -> counter_side", () => {
  assert.deepEqual(mapExcelRowToPrintSurfaceType({ typ: "counter", name: "Čelo" }), { ok: true, typeId: "counter_front" });
  assert.deepEqual(mapExcelRowToPrintSurfaceType({ typ: "counter", name: "Bok" }), { ok: true, typeId: "counter_side" });
});

test("mapExcelRowToPrintSurfaceType: nejednoznačný counter název vrátí UNKNOWN_TYPE, nikdy nehádaný typeId", () => {
  const result = mapExcelRowToPrintSurfaceType({ typ: "counter", name: "Roh" });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.issue.code, "UNKNOWN_TYPE");
});

test("NO/NO (case-insensitive, trimmed) -> unavailable, nikdy width=0/height=0", () => {
  const rows = sheet(["Pult_Vit_100x50_Celo", "Čelo", "counter", "", 950, 398, " No ", "NO"]);
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.counts.errors, 0);
  const dimension = outcome.result.productionDimensions.find((d) => d.presetId === "Pult_Vit_100x50_Celo" && d.realizationCompanyId === "firma-b");
  assert.equal(dimension?.status, "unavailable");
  assert.equal("widthMm" in (dimension ?? {}), false);
});

test("blank/blank -> not_defined, žádný production dimension záznam a žádné issue", () => {
  const rows = sheet(["Panel_X", "Panel X", "panel", "", "", "", 950, 2340]);
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const dimensionA = outcome.result.productionDimensions.find((d) => d.presetId === "Panel_X" && d.realizationCompanyId === "firma-a");
  assert.equal(dimensionA, undefined);
  assert.equal(issuesOf("INCOMPLETE_DIMENSION", outcome.result.issues).length, 0);
  assert.equal(outcome.result.counts.notDefinedOrIncomplete >= 1, true);
});

test("blank + číslo -> INCOMPLETE_DIMENSION warning, resolver-relevant výsledek zůstává not_defined (žádný záznam)", () => {
  const rows = sheet(["Panel_S_25", "Panel stěnový 0,25 x 2,5 m", "panel", "", "", 2340, 222, 2395]);
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const warnings = issuesOf("INCOMPLETE_DIMENSION", outcome.result.issues);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.severity, "warning");
  assert.equal(warnings[0]?.companyName, "Firma A");
  const dimensionA = outcome.result.productionDimensions.find((d) => d.presetId === "Panel_S_25" && d.realizationCompanyId === "firma-a");
  assert.equal(dimensionA, undefined);
  assert.equal(outcome.result.counts.errors, 0); // warning only, does not block apply
});

test("NO + číslo -> INVALID_NO_VALUE validation error (nikdy unavailable)", () => {
  const rows = sheet(["Panel_Y", "Panel Y", "panel", "", "no", 2340, 950, 2340]);
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const errors = issuesOf("INVALID_NO_VALUE", outcome.result.issues);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.severity, "error");
  assert.equal(outcome.result.counts.errors, 1);
  const dimensionA = outcome.result.productionDimensions.find((d) => d.presetId === "Panel_Y" && d.realizationCompanyId === "firma-a");
  assert.equal(dimensionA, undefined);
});

test("neznámý parent_id -> UNKNOWN_PARENT_ID error", () => {
  const rows = sheet(["Child_1", "Čelo", "counter", "Neexistujici_Parent", 950, 960, 972, 995]);
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(issuesOf("UNKNOWN_PARENT_ID", outcome.result.issues).length, 1);
  assert.equal(outcome.result.counts.errors, 1);
});

test("duplicitní interni id -> DUPLICATE_INTERNAL_ID error, druhý výskyt se ignoruje", () => {
  const rows = sheet(
    ["Panel_Dup", "Panel Dup 1", "panel", "", 950, 2340, 972, 2395],
    ["Panel_Dup", "Panel Dup 2", "panel", "", 111, 111, 111, 111],
  );
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(issuesOf("DUPLICATE_INTERNAL_ID", outcome.result.issues).length, 1);
  const preset = outcome.result.presets.find((p) => p.id === "Panel_Dup");
  assert.equal(preset?.name, "Panel Dup 1"); // first occurrence wins
});

test("prázdný název -> EMPTY_NAME error, žádný preset vytvořen pro tento řádek", () => {
  const rows = sheet(["Panel_NoName", "", "panel", "", 950, 2340, 972, 2395]);
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(issuesOf("EMPTY_NAME", outcome.result.issues).length, 1);
  assert.equal(outcome.result.presets.some((p) => p.id === "Panel_NoName"), false);
});
