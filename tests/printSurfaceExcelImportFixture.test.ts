import test from "node:test";
import assert from "node:assert/strict";
import { readWorkbookSheets, extractSheetGrid } from "../lib/import/xlsxReader.server.ts";
import { importPrintSurfaceExcel, PRINT_SURFACE_EXCEL_SHEET_NAME } from "../domain/printSurfaceExcelImport.ts";
import { resolvePrintSurfaceProductionDimension } from "../domain/printSurfaceProductionDimension.ts";

/**
 * Integration test against the REAL source file (_IMPORT/rozmery_tisk_1_0.xlsx, sheet
 * "verze_1.0"). Every expected value below was read directly off the actual workbook (see the
 * task's Excel-inspection dump — rows 3 and 38 specifically), never invented to match the
 * parser's output. If this file ever legitimately changes, these assertions must be re-verified
 * against the new real data, not just updated to whatever the parser currently returns.
 */
async function loadRealFixtureRows() {
  const workbook = await readWorkbookSheets("_IMPORT/rozmery_tisk_1_0.xlsx");
  return extractSheetGrid(workbook, PRINT_SURFACE_EXCEL_SHEET_NAME);
}

test("real fixture: sheet name and header parse cleanly, exactly 3 realizačky (Creativ Expo, Gendai, Macík)", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.counts.realizationCompanies, 3);
  assert.deepEqual(
    outcome.result.companies.map((c) => c.name),
    ["Creativ Expo", "Gendai", "Macík"],
  );
});

test("real fixture: 13 parent/group rows, 30 real presets, 0 errors, 2 warnings (Panel_S_25 incomplete)", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.counts.parentRows, 13);
  assert.equal(outcome.result.counts.presets, 30);
  assert.equal(outcome.result.counts.errors, 0);
  assert.equal(outcome.result.counts.warnings, 2);
  assert.equal(outcome.result.counts.unavailable, 4);
  assert.equal(outcome.result.counts.available, 30 * 3 - 2 - 4);
});

test("real fixture: Panel_S_100 has the exact per-company dimensions from row 3", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const creativExpo = outcome.result.companies.find((c) => c.name === "Creativ Expo")!;
  const gendai = outcome.result.companies.find((c) => c.name === "Gendai")!;
  const macik = outcome.result.companies.find((c) => c.name === "Macík")!;

  const forCreativExpo = resolvePrintSurfaceProductionDimension({ realizationCompanyId: creativExpo.id, presetId: "Panel_S_100" }, outcome.result.productionDimensions);
  const forGendai = resolvePrintSurfaceProductionDimension({ realizationCompanyId: gendai.id, presetId: "Panel_S_100" }, outcome.result.productionDimensions);
  const forMacik = resolvePrintSurfaceProductionDimension({ realizationCompanyId: macik.id, presetId: "Panel_S_100" }, outcome.result.productionDimensions);

  assert.equal(forCreativExpo.status, "available");
  assert.equal(forCreativExpo.status === "available" && forCreativExpo.widthMm, 950);
  assert.equal(forCreativExpo.status === "available" && forCreativExpo.heightMm, 2340);

  assert.equal(forGendai.status, "available");
  assert.equal(forGendai.status === "available" && forGendai.widthMm, 972);
  assert.equal(forGendai.status === "available" && forGendai.heightMm, 2395);

  assert.equal(forMacik.status, "available");
  assert.equal(forMacik.status === "available" && forMacik.widthMm, 950);
  assert.equal(forMacik.status === "available" && forMacik.heightMm, 2255);
});

test("real fixture: Pult_Vit_100x50_Celo — Creativ Expo/Gendai available, Macík explicitly unavailable (NO/NO, row 38)", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const creativExpo = outcome.result.companies.find((c) => c.name === "Creativ Expo")!;
  const gendai = outcome.result.companies.find((c) => c.name === "Gendai")!;
  const macik = outcome.result.companies.find((c) => c.name === "Macík")!;

  const forCreativExpo = resolvePrintSurfaceProductionDimension({ realizationCompanyId: creativExpo.id, presetId: "Pult_Vit_100x50_Celo" }, outcome.result.productionDimensions);
  const forGendai = resolvePrintSurfaceProductionDimension({ realizationCompanyId: gendai.id, presetId: "Pult_Vit_100x50_Celo" }, outcome.result.productionDimensions);
  const forMacik = resolvePrintSurfaceProductionDimension({ realizationCompanyId: macik.id, presetId: "Pult_Vit_100x50_Celo" }, outcome.result.productionDimensions);

  assert.equal(forCreativExpo.status, "available");
  assert.equal(forCreativExpo.status === "available" && forCreativExpo.widthMm, 950);
  assert.equal(forCreativExpo.status === "available" && forCreativExpo.heightMm, 398);

  assert.equal(forGendai.status, "available");
  assert.equal(forGendai.status === "available" && forGendai.widthMm, 972);
  assert.equal(forGendai.status === "available" && forGendai.heightMm, 590);

  assert.equal(forMacik.status, "unavailable");
});

test("real fixture: all 4 known Macík NO/NO presets resolve to unavailable, no others do", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const macik = outcome.result.companies.find((c) => c.name === "Macík")!;
  const macikUnavailablePresetIds = outcome.result.productionDimensions
    .filter((d) => d.realizationCompanyId === macik.id && d.status === "unavailable")
    .map((d) => d.presetId)
    .sort();

  assert.deepEqual(macikUnavailablePresetIds, [
    "Pult_Vit_100x50_Bok",
    "Pult_Vit_100x50_Celo",
    "Pult_Vit_50x50_Bok",
    "Pult_Vit_50x50_Celo",
  ]);
});

test("real fixture: Panel_S_25's incomplete Creativ Expo / Macík dimensions resolve to not_defined, not 0 and not unavailable", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const creativExpo = outcome.result.companies.find((c) => c.name === "Creativ Expo")!;
  const gendai = outcome.result.companies.find((c) => c.name === "Gendai")!;
  const macik = outcome.result.companies.find((c) => c.name === "Macík")!;

  const forCreativExpo = resolvePrintSurfaceProductionDimension({ realizationCompanyId: creativExpo.id, presetId: "Panel_S_25" }, outcome.result.productionDimensions);
  const forMacik = resolvePrintSurfaceProductionDimension({ realizationCompanyId: macik.id, presetId: "Panel_S_25" }, outcome.result.productionDimensions);
  const forGendai = resolvePrintSurfaceProductionDimension({ realizationCompanyId: gendai.id, presetId: "Panel_S_25" }, outcome.result.productionDimensions);

  assert.equal(forCreativExpo.status, "not_defined");
  assert.equal(forMacik.status, "not_defined");
  assert.equal(forGendai.status, "available");
  assert.equal(forGendai.status === "available" && forGendai.widthMm, 222);
  assert.equal(forGendai.status === "available" && forGendai.heightMm, 2395);

  const incompleteWarnings = outcome.result.issues.filter((issue) => issue.code === "INCOMPLETE_DIMENSION" && issue.internalId === "Panel_S_25");
  assert.equal(incompleteWarnings.length, 2);
  assert.deepEqual(incompleteWarnings.map((issue) => issue.companyName).sort(), ["Creativ Expo", "Macík"]);
});

test("real fixture: Panel_S_Dvere maps to panel_above_door, other panels map to panel", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.presets.find((p) => p.id === "Panel_S_Dvere")?.typeId, "panel_above_door");
  assert.equal(outcome.result.presets.find((p) => p.id === "Panel_S_100")?.typeId, "panel");
});

test("real fixture: counter children map to counter_front/counter_side by name, and inherit their parent's display name", async () => {
  const rows = await loadRealFixtureRows();
  const outcome = importPrintSurfaceExcel(rows);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const celo = outcome.result.presets.find((p) => p.id === "Pult_100x50_v_Celo");
  const bok = outcome.result.presets.find((p) => p.id === "Pult_100x50_v_Bok");
  assert.equal(celo?.typeId, "counter_front");
  assert.equal(bok?.typeId, "counter_side");
  assert.equal(celo?.parentId, "Pult_100x50_v");
  assert.equal(celo?.parentName, "Pult 1 x 0,5 x 1,1 m");
});
