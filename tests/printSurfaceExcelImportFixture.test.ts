import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { readWorkbookSheets, extractSheetGrid } from "../lib/import/xlsxReader.server.ts";
import { importPrintSurfaceExcel, PRINT_SURFACE_EXCEL_SHEET_NAME } from "../domain/printSurfaceExcelImport.ts";
import { resolvePrintSurfaceProductionDimension } from "../domain/printSurfaceProductionDimension.ts";

/**
 * Self-contained SYNTHETIC fixture (no tracked binary .xlsx in git — see the checkpoint-batch
 * report for why). Reproduces, row-for-row, the exact structural shape and specific data points
 * every test below asserts against (row 3 = Panel_S_100, row 38 = Pult_Vit_100x50_Celo, the exact
 * 4 Macík NO/NO presets, Panel_S_25's 2 incomplete-dimension warnings, ...) that were originally
 * read off the real "_IMPORT/rozmery_tisk_1_0.xlsx" workbook (sheet "verze_1.0"). Built with the
 * SAME exceljs library production code uses (lib/import/xlsxReader.server.ts), written to a REAL
 * temp .xlsx file on disk and read back through the REAL readWorkbookSheets()/extractSheetGrid()
 * pipeline — this still exercises the actual xlsx file I/O + parsing code path end to end, not
 * hand-built RawSheetRow[] data bypassing it. The temp file is generated once (memoized) and
 * removed in an `after` hook once every test in this file has run.
 *
 * Row layout reference (domain/printSurfaceExcelImport.ts's own parsePrintSurfaceExcelSheet):
 * row 1 = A-D "interni id"/"nazev"/"typ"/"parent_id" + a company name repeated over a width/height
 * column pair; row 2 = "š"/"v" under each pair; data from row 3. Company columns here: E/F =
 * Creativ Expo š/v, G/H = Gendai š/v, I/J = Macík š/v — same 3 companies, same column order as the
 * real workbook.
 */

type FixtureDataRow = readonly [string, string, string, string, ...(number | string | undefined)[]];

function panelRow(internalId: string, name: string, dims: readonly [number, number, number, number, number, number]): FixtureDataRow {
  return [internalId, name, "panel", "", ...dims];
}
function counterRow(internalId: string, name: "Čelo" | "Bok", parentId: string | undefined, dims: readonly (number | string)[]): FixtureDataRow {
  return [internalId, name, "counter", parentId ?? "", ...dims];
}
function groupRow(internalId: string, name: string): FixtureDataRow {
  return [internalId, name, "", "", undefined, undefined, undefined, undefined, undefined, undefined];
}
function fillerPresetRow(index: number): FixtureDataRow {
  const v = 100 + index;
  return [`FillerPreset${String(index).padStart(2, "0")}`, `Filler preset ${index}`, "showcase", "", v, v, v, v, v, v];
}
function fillerGroupRow(index: number): FixtureDataRow {
  return groupRow(`FillerGroup${String(index).padStart(2, "0")}`, `Filler group ${index}`);
}

function buildFixtureDataRows(): readonly FixtureDataRow[] {
  // sourceRow 3 (the FIRST data row) — test: "Panel_S_100 has the exact per-company dimensions from row 3".
  const panel100 = panelRow("Panel_S_100", "Panel S 100", [950, 2340, 972, 2395, 950, 2255]);

  // test: "Panel_S_25's incomplete Creativ Expo / Macík dimensions resolve to not_defined" — exactly
  // ONE blank cell each (INCOMPLETE_DIMENSION warning), Gendai fully available at 222x2395 (the
  // one company/value the test also directly asserts).
  const panel25 = panelRow("Panel_S_25", "Panel S 25", [222, undefined as unknown as number, 222, 2395, undefined as unknown as number, 2000]);

  // test: "Panel_S_Dvere maps to panel_above_door" (name contains "naddveřní", case-insensitive).
  const panelDvere = panelRow("Panel_S_Dvere", "Panel S naddveřní", [100, 100, 100, 100, 100, 100]);

  // test: "all 4 known Macík NO/NO presets resolve to unavailable, no others do" — exactly these 4
  // internalIds, Macík NO/NO, Creativ Expo/Gendai available (never NO anywhere else in the sheet).
  const pultVit100x50Bok = counterRow("Pult_Vit_100x50_Bok", "Bok", undefined, [500, 300, 500, 300, "NO", "NO"]);
  // test: "Pult_Vit_100x50_Celo — Creativ Expo/Gendai available, Macík explicitly unavailable
  // (NO/NO, row 38)" — this exact row must land at sourceRow 38 (the 36th data row), placed below.
  const pultVit100x50Celo = counterRow("Pult_Vit_100x50_Celo", "Čelo", undefined, [950, 398, 972, 590, "NO", "NO"]);
  const pultVit50x50Bok = counterRow("Pult_Vit_50x50_Bok", "Bok", undefined, [300, 300, 300, 300, "NO", "NO"]);
  const pultVit50x50Celo = counterRow("Pult_Vit_50x50_Celo", "Čelo", undefined, [300, 300, 300, 300, "NO", "NO"]);

  // test: "counter children map to counter_front/counter_side by name, and inherit their parent's
  // display name" — a group row PLUS its two named children, parentName must read back exactly.
  const pult100x50vGroup = groupRow("Pult_100x50_v", "Pult 1 x 0,5 x 1,1 m");
  const pult100x50vCelo = counterRow("Pult_100x50_v_Celo", "Čelo", "Pult_100x50_v", [500, 300, 500, 300, 500, 300]);
  const pult100x50vBok = counterRow("Pult_100x50_v_Bok", "Bok", "Pult_100x50_v", [500, 300, 500, 300, 500, 300]);

  const otherSpecificPresets = [panel25, panelDvere, pultVit100x50Bok, pultVit50x50Bok, pultVit50x50Celo, pult100x50vCelo, pult100x50vBok];
  const fillerGroups = Array.from({ length: 12 }, (_, i) => fillerGroupRow(i + 1));
  const fillerPresetsBeforeRow38 = Array.from({ length: 14 }, (_, i) => fillerPresetRow(i + 1));
  const fillerPresetsAfterRow38 = Array.from({ length: 7 }, (_, i) => fillerPresetRow(i + 15));

  // Assemble so Panel_S_100 lands at sourceRow 3 (data row #1) and Pult_Vit_100x50_Celo at
  // sourceRow 38 (data row #36) exactly, matching what the tests below assert by name.
  const middleBlock = [...otherSpecificPresets, pult100x50vGroup, ...fillerGroups, ...fillerPresetsBeforeRow38]; // 7 + 1 + 12 + 14 = 34 rows
  const dataRows = [panel100, ...middleBlock, pultVit100x50Celo, ...fillerPresetsAfterRow38]; // 1 + 34 + 1 + 7 = 43 rows

  // Sanity on the fixture builder itself — counted here so a future edit that breaks the exact
  // row-38 placement or the 13/30 split fails LOUDLY at fixture-build time, not as a confusing
  // mismatch deep inside one of the real assertions below.
  if (dataRows.length !== 43) throw new Error(`fixture builder bug: expected 43 data rows, got ${dataRows.length}`);
  if (dataRows[35] !== pultVit100x50Celo) throw new Error("fixture builder bug: Pult_Vit_100x50_Celo must be data row #36 (sourceRow 38)");
  if (dataRows[0] !== panel100) throw new Error("fixture builder bug: Panel_S_100 must be data row #1 (sourceRow 3)");

  return dataRows;
}

function buildFixtureWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(PRINT_SURFACE_EXCEL_SHEET_NAME);
  sheet.addRow(["interni id", "nazev", "typ", "parent_id", "Creativ Expo", "Creativ Expo", "Gendai", "Gendai", "Macík", "Macík"]);
  sheet.addRow(["", "", "", "", "š", "v", "š", "v", "š", "v"]);
  for (const row of buildFixtureDataRows()) sheet.addRow([...row]);
  return workbook;
}

let fixtureFilePathPromise: Promise<string> | undefined;
let fixtureDir: string | undefined;

async function ensureFixtureFile(): Promise<string> {
  fixtureFilePathPromise ??= (async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "print-surface-fixture-"));
    const filePath = path.join(fixtureDir, "rozmery_tisk_1_0.xlsx");
    await buildFixtureWorkbook().xlsx.writeFile(filePath);
    return filePath;
  })();
  return fixtureFilePathPromise;
}

after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function loadRealFixtureRows() {
  const filePath = await ensureFixtureFile();
  const workbook = await readWorkbookSheets(filePath);
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
