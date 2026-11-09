import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseServiceSheet,
  planCatalogWorkbookImport,
  resolveCategory,
  type RawCell,
  type ServiceRowPlan,
  type WorkbookSheetInput,
} from "../domain/catalogExcelImport.ts";
import { applyCatalogItemEdit, buildCatalogItemCreateDocument, parseCatalogItemAdminCreateInput, parseCatalogItemAdminEdit, type CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { BUILT_IN_CATALOG_CATEGORIES } from "../domain/catalogClassification.ts";

const CATEGORIES = BUILT_IN_CATALOG_CATEGORIES;
const KEYS = ["id", "generator_code", "abf_code", "display_name", "official_name", "official_name_en", "category", "unit_code", "power_kw", "show_2d", "show_3d", "catalog_visible", "catalog_name", "catalog_description", "catalog_sort", "note", "lifecycle_status"];
const LABELS = KEYS.map((key) => `label ${key}`);

/** One data row by key; unspecified keys stay empty. */
const row = (values: Readonly<Record<string, RawCell>>): RawCell[] => KEYS.map((key) => values[key] ?? null);
const META: WorkbookSheetInput = { name: "_meta", grid: [["key", "value"], ["template_format", "catalog-template/1"], ["environment", "DEV"]] };
const workbook = (...rows: RawCell[][]): WorkbookSheetInput[] => [META, { name: "Sluzby", grid: [KEYS, LABELS, ...rows] }];
const plan = (rows: RawCell[][], items: readonly CatalogItemAdmin[] = []) => planCatalogWorkbookImport(workbook(...rows), { items, categories: CATEGORIES, targetEnvironment: "DEV" });
const only = (rows: RawCell[][], items: readonly CatalogItemAdmin[] = []): ServiceRowPlan => {
  const result = plan(rows, items);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
};

const L02_ID = "6b22b294-2a6d-436b-8211-80320b02a2e8";
const card = (overrides: Partial<CatalogItemAdmin> & Readonly<{ document?: Record<string, unknown> }> = {}): CatalogItemAdmin => ({
  id: L02_ID,
  internalCode: "L02",
  abfCode: "L02",
  itemType: "SERVICE",
  kind: "service",
  lifecycleStatus: "active",
  displayName: "Elektrická energie - 2kW",
  officialName: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230V",
  officialNameEn: "POWER SUPPLY UP TO 2 kW/230V",
  category: "service-electricity",
  unit: "ks",
  unitCode: "ks",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...overrides,
  // Ready like the real L02 (category + unit in the document, 2D footprint) — the lifecycle guard re-checks readiness.
  document: { displayName: "Elektrická energie - 2kW", category: "service-electricity", unit: "ks", footprint2D: { shape: "rectangle" }, serviceTechnical: { serviceCategory: "electricity", powerKw: 2 }, showIn2D: true, showIn3D: false, catalogPublication: { visible: true, name: "Elektrická energie - 2kW" }, ...(overrides.document ?? {}) },
} as CatalogItemAdmin);

const L02_ROW = { generator_code: "L02", abf_code: "L02", display_name: "Elektrická energie - 2kW", official_name: "ELEKTRICKÁ ENERGIE - PŘÍKON DO  2 kW/230V", official_name_en: "POWER SUPPLY UP TO 2 kW/230V", category: "Elektřina", unit_code: "ks", power_kw: 2, show_2d: "ANO", show_3d: "NE", catalog_visible: "ANO", catalog_name: "Elektrická energie - 2kW" };

test("Sluzby parse: row 1 keys, row 2 labels ignored, data from row 3, blank rows skipped, ANO/NE → boolean, Czech decimal comma, category name → register id", () => {
  const parsed = parseServiceSheet([KEYS, LABELS, row({ generator_code: "L01", display_name: "E 0,5", category: "elektrina", power_kw: "0,5", show_2d: "ano", show_3d: "NE" }), row({}), [null, "   "]], CATEGORIES);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows.length, 1);
  const cells = parsed.rows[0]!.cells;
  assert.equal(parsed.rows[0]!.rowNumber, 3);
  assert.deepEqual(cells.category, { state: "value", value: "service-electricity" });
  assert.deepEqual(cells.power_kw, { state: "value", value: 0.5 });
  assert.deepEqual(cells.show_2d, { state: "value", value: true });
  assert.deepEqual(cells.show_3d, { state: "value", value: false });
  assert.deepEqual(cells.note, { state: "empty" });
});

test("Sluzby parse: missing required column is a sheet error; unknown column only a warning; label row is never read as keys", () => {
  const missing = parseServiceSheet([["generator_code", "display_name"], ["Kód", "Název"]], CATEGORIES);
  assert.ok(missing.issues.some((issue) => issue.severity === "error" && issue.message.includes("category")));
  const unknown = parseServiceSheet([[...KEYS, "extra"], LABELS, row({ generator_code: "X1", display_name: "X", category: "Internet" })], CATEGORIES);
  assert.ok(unknown.issues.every((issue) => issue.severity === "warning"));
  assert.equal(unknown.rows.length, 1);
});

test("Category: register id or Czech name; unknown and ambiguous names are refused", () => {
  assert.equal(resolveCategory("service-internet", CATEGORIES).category?.id, "service-internet");
  assert.equal(resolveCategory("INTERNET", CATEGORIES).category?.id, "service-internet");
  assert.match(resolveCategory("Plyn", CATEGORIES).message!, /není v registru/u);
  const twice = [...CATEGORIES, { ...CATEGORIES.find((category) => category.id === "service-internet")!, id: "dup-internet" }];
  assert.match(resolveCategory("Internet", twice).message!, /vícekrát/u);
  // A category of another group (product) does not belong on Sluzby.
  const wrongGroup = only([row({ generator_code: "X1", display_name: "X", category: "Židle" })]);
  assert.equal(wrongGroup.action, "conflict");
});

test("Empty cell = unchanged: a row with only identity + name changes nothing and clears nothing", () => {
  const result = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina" })], [card()]);
  assert.equal(result.action, "unchanged");
  assert.deepEqual(result.changes, []);
});

test("NE and 0 are real values, not empty: show_2d NE → false, power 0 → 0 kW", () => {
  const result = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", show_2d: "NE", power_kw: 0 })], [card()]);
  assert.equal(result.action, "update");
  assert.deepEqual(result.changes.map((change) => [change.field, change.before, change.after]), [["power_kw", 2, 0], ["show_2d", true, false]]);
  assert.equal(result.edit!.showIn2D, false);
  // serviceTechnical is replaced whole: the service category survives, powerKw becomes 0.
  assert.deepEqual(result.edit!.serviceTechnical, { serviceCategory: "electricity", powerKw: 0 });
  // Text "0" counts too.
  assert.equal(only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", power_kw: "0" })], [card()]).changes[0]!.after, 0);
});

test("#SMAZAT clears allowed optional values, is refused for required/boolean ones, and is a no-op when already empty", () => {
  const cleared = only([row({ generator_code: "L02", category: "Elektřina", display_name: "Elektrická energie - 2kW", official_name_en: "#SMAZAT", catalog_name: "#smazat", power_kw: "#SMAZAT" })], [card()]);
  assert.equal(cleared.action, "update");
  assert.deepEqual(cleared.changes.map((change) => [change.field, change.after]), [["official_name_en", null], ["power_kw", null], ["catalog_name", null]]);
  assert.equal(cleared.edit!.officialNameEn, null);
  assert.deepEqual(cleared.edit!.catalogPublication, { name: null });
  assert.deepEqual(cleared.edit!.serviceTechnical, { serviceCategory: "electricity" });
  for (const key of ["display_name", "category", "show_2d", "catalog_visible"]) {
    const refused = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", [key]: "#SMAZAT" })], [card()]);
    assert.equal(refused.action, "conflict", key);
  }
  const noop = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", note: "#SMAZAT" })], [card()]);
  assert.equal(noop.action, "unchanged");
  assert.ok(noop.issues.some((issue) => issue.severity === "warning"));
});

test("Invalid values are reported per row and never written: bad boolean, negative power, bad unit, too long catalog name", () => {
  for (const values of [{ show_2d: "ano?" }, { power_kw: -1 }, { power_kw: "abc" }, { unit_code: "parsec" }, { catalog_name: "x".repeat(121) }, { catalog_sort: 1.5 }]) {
    const result = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", ...values })], [card()]);
    assert.equal(result.action, "conflict", JSON.stringify(values));
    assert.equal(result.edit, undefined);
  }
});

test("Duplicates in the file: two rows with the same code are both conflicts (no merge, case-insensitive)", () => {
  const result = plan([row({ generator_code: "L77", display_name: "A", category: "Elektřina" }), row({ generator_code: "l77", display_name: "B", category: "Elektřina" }), row({ generator_code: "L78", display_name: "C", category: "Elektřina" })]);
  assert.deepEqual(result.rows.map((entry) => entry.action), ["conflict", "conflict", "create"]);
  assert.match(result.rows[0]!.issues.at(-1)!.message, /řádcích Sluzby ř\. 3, Sluzby ř\. 4/u);
  // Same ABF code under different generator codes is a duplicate too.
  const abf = plan([row({ generator_code: "A1", abf_code: "Z9", display_name: "A", category: "Internet" }), row({ generator_code: "A2", abf_code: "Z9", display_name: "B", category: "Internet" })]);
  assert.deepEqual(abf.rows.map((entry) => entry.action), ["conflict", "conflict"]);
});

test("Two rows reaching the same existing card through different keys are both conflicts", () => {
  const result = plan([row({ id: L02_ID, display_name: "X", category: "Elektřina" }), row({ generator_code: "L02", display_name: "Y", category: "Elektřina" })], [card()]);
  assert.deepEqual(result.rows.map((entry) => entry.action), ["conflict", "conflict"]);
});

test("Identity collisions: id → generator code → ABF code; contradictions, unknown id, code changes and DB duplicates are conflicts", () => {
  const other = card({ id: "00000000-0000-4000-8000-000000000001", internalCode: "L03", abfCode: "L03", displayName: "Elektrická energie - 3kW" });
  const base = { display_name: "Elektrická energie - 2kW", category: "Elektřina" };
  // generator code → L02, ABF code → L03
  assert.match(only([row({ ...base, generator_code: "L02", abf_code: "L03" })], [card(), other]).issues.at(-1)!.message, /Rozporná identita/u);
  // id → L02, generator code → L03
  assert.equal(only([row({ ...base, id: L02_ID, generator_code: "L03" })], [card(), other]).action, "conflict");
  // id not in catalog
  assert.match(only([row({ ...base, id: "00000000-0000-4000-8000-0000000000ff" })], [card()]).issues.at(-1)!.message, /neexistuje/u);
  // id matches, but the file renames its generator code → never a silent code change
  assert.match(only([row({ ...base, id: L02_ID, generator_code: "L02X" })], [card()]).issues.at(-1)!.message, /změnu kódu import neprovádí/u);
  // the code exists twice in the catalog
  assert.match(only([row({ ...base, generator_code: "L02" })], [card(), card({ id: "00000000-0000-4000-8000-000000000002", abfCode: null })]).issues.at(-1)!.message, /2 karet/u);
  // matched card is not a service
  assert.equal(only([row({ ...base, generator_code: "L02" })], [card({ itemType: "PRODUCT", kind: "furniture" })]).action, "conflict");
  // a new card whose generator code is another card's ABF code (cross-code collision)
  const crossing = card({ id: "00000000-0000-4000-8000-000000000003", internalCode: "M99", abfCode: "L50" });
  assert.equal(only([row({ ...base, generator_code: "L50" })], [crossing]).action, "conflict");
});

test("Identity by id alone fills a missing ABF code, but only if no other card has it", () => {
  const withoutAbf = card({ abfCode: null });
  const fill = only([row({ id: L02_ID, abf_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina" })], [withoutAbf]);
  assert.equal(fill.action, "update");
  assert.equal(fill.edit!.abfCode, "L02");
  const taken = only([row({ id: L02_ID, abf_code: "L03", display_name: "Elektrická energie - 2kW", category: "Elektřina" })], [withoutAbf, card({ id: "00000000-0000-4000-8000-000000000004", internalCode: "L03", abfCode: "L03" })]);
  assert.equal(taken.action, "conflict");
});

test("Create: needs name, category and a code; the create input and follow-up edit are accepted by the admin parsers; lifecycle is not set", () => {
  assert.equal(only([row({ generator_code: "L99", category: "Elektřina" })]).action, "conflict");
  assert.equal(only([row({ generator_code: "L99", display_name: "X" })]).action, "conflict");
  assert.equal(only([row({ display_name: "X", category: "Elektřina" })]).action, "conflict");
  const created = only([row({ generator_code: "L01", abf_code: "L01", display_name: "Elektrická energie - 0,5kW", official_name: "ELEKTRICKÁ  ENERGIE", category: "Elektřina", unit_code: "ks", power_kw: 0.5, show_2d: "ANO", show_3d: "NE", catalog_visible: "NE", catalog_name: "E", lifecycle_status: "Aktivní" })]);
  assert.equal(created.action, "create");
  const input = parseCatalogItemAdminCreateInput(created.createInput);
  assert.equal(input.itemType, "SERVICE");
  assert.equal(input.kind, "service");
  assert.equal(input.internalCode, "L01");
  assert.equal(input.officialName, "ELEKTRICKÁ ENERGIE");
  assert.equal(input.showIn3D, false);
  assert.ok(!("lifecycleStatus" in (created.createInput as object)));
  assert.ok(created.issues.some((issue) => issue.field === "lifecycle_status"));
  // One insert: power and publication are part of the create input itself (no follow-up edit).
  assert.equal(input.powerKw, 0.5);
  assert.deepEqual(input.catalogPublication, { visible: false, name: "E" });
  const document = buildCatalogItemCreateDocument(input);
  assert.deepEqual(document.serviceTechnical, { powerKw: 0.5 });
  assert.deepEqual(document.catalogPublication, { visible: false, name: "E" });
  assert.ok(!("lifecycleStatus" in document));
});

test("Update edit is accepted by the admin edit parser and only carries changed fields; lifecycle mismatch is a warning, never a change", () => {
  const result = only([row({ ...L02_ROW, official_name_en: "POWER SUPPLY 2 kW", lifecycle_status: "Neaktivní" })], [card()]);
  assert.equal(result.action, "update");
  assert.deepEqual(parseCatalogItemAdminEdit(result.edit), { officialNameEn: "POWER SUPPLY 2 kW" });
  assert.ok(result.issues.some((issue) => issue.field === "lifecycle_status" && issue.severity === "warning"));
});

test("Repeated import: applying the plan and planning the same file again gives only 'unchanged' (whitespace in official names included)", () => {
  const first = only([row(L02_ROW)], [card({ document: { showIn3D: undefined, catalogPublication: { visible: true } } })]);
  assert.equal(first.action, "update");
  assert.deepEqual(first.changes.map((change) => change.field), ["show_3d", "catalog_name"]);
  // Apply exactly what the plan would save.
  const before = card({ document: { showIn3D: undefined, catalogPublication: { visible: true } } });
  const after = { ...before, document: applyCatalogItemEdit(before.document, parseCatalogItemAdminEdit(first.edit)) } as CatalogItemAdmin;
  const second = only([row(L02_ROW)], [after]);
  assert.equal(second.action, "unchanged");
  // A created card re-imported: simulate the create + follow-up the plan describes.
  const create = only([row({ ...L02_ROW, generator_code: "L05", abf_code: "L05" })]);
  const input = parseCatalogItemAdminCreateInput(create.createInput);
  // Same document createCatalogItemAdmin inserts (service category merged from the category).
  const built = buildCatalogItemCreateDocument(input);
  const createdDocument = { ...built, serviceTechnical: { ...(built.serviceTechnical as object), serviceCategory: "electricity" } };
  const createdCard = card({ id: "00000000-0000-4000-8000-000000000005", internalCode: "L05", abfCode: "L05", lifecycleStatus: "needs_review", officialName: input.officialName ?? null, officialNameEn: input.officialNameEn ?? null, document: {} });
  const reimport = only([row({ ...L02_ROW, generator_code: "L05", abf_code: "L05" })], [{ ...createdCard, document: createdDocument } as CatalogItemAdmin]);
  assert.equal(reimport.action, "unchanged", JSON.stringify(reimport.changes));
});

test("Workbook: helper sheets ignored, empty data sheets ignored, a non-empty unsupported or unknown sheet is reported explicitly", () => {
  const result = planCatalogWorkbookImport([
    META,
    { name: "Navod", grid: [["text"], ["more"], ["lots of help"]] },
    { name: "Produkty", grid: [["generator_code"], ["Kód"]] },
    { name: "Komplety", grid: [["generator_code"], ["Kód"], ["P86"]] },
    { name: "Moje", grid: [["a"], ["b"], ["c"]] },
    { name: "Sluzby", grid: [KEYS, LABELS] },
  ], { items: [], categories: CATEGORIES });
  assert.deepEqual(result.sheets.map((sheet) => [sheet.name, sheet.status]), [["_meta", "helper"], ["Navod", "helper"], ["Produkty", "empty"], ["Komplety", "unsupported_with_data"], ["Moje", "unknown_with_data"], ["Sluzby", "empty"]]);
  assert.equal(result.issues.filter((issue) => issue.severity === "error").length, 2);
  assert.deepEqual(result.summary, { create: 0, update: 0, unchanged: 0, conflict: 0, warnings: 0 });
});

test("Workbook: _meta template version is checked; environment mismatch is a warning", () => {
  const noMeta = planCatalogWorkbookImport([{ name: "Sluzby", grid: [KEYS, LABELS] }], { items: [], categories: CATEGORIES });
  assert.ok(noMeta.issues.some((issue) => issue.severity === "warning"));
  const wrong = planCatalogWorkbookImport([{ name: "_meta", grid: [["template_format", "catalog-template/2"]] }], { items: [], categories: CATEGORIES });
  assert.ok(wrong.issues.some((issue) => issue.severity === "error"));
  const prod = planCatalogWorkbookImport([{ name: "_meta", grid: [["template_format", "catalog-template/1"], ["environment", "PROD"]] }], { items: [], categories: CATEGORIES, targetEnvironment: "DEV" });
  assert.ok(prod.issues.some((issue) => issue.severity === "warning" && issue.message.includes("PROD")));
});

const REAL_CATALOG = path.resolve("_IMPORT", "Generator_ABF_Katalog(2).xlsx");
test("Real _IMPORT/Generator_ABF_Katalog(2).xlsx: 28 services (21 L, 7 I), I12/I22 hidden from the catalog, L09 kept as the source states", { skip: !existsSync(REAL_CATALOG) && "_IMPORT workbook not present (gitignored)" }, async () => {
  const { extractStrictSheetGrid, readWorkbookFromBufferTolerant } = await import("../lib/import/xlsxReader.server.ts");
  const book = await readWorkbookFromBufferTolerant(readFileSync(REAL_CATALOG));
  const sheets = book.worksheets.map((sheet) => ({ name: sheet.name, grid: extractStrictSheetGrid(book, sheet.name) }));
  const result = planCatalogWorkbookImport(sheets, { items: [card({ document: { showIn3D: undefined, catalogPublication: { visible: true } } })], categories: CATEGORIES, targetEnvironment: "DEV" });
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows.length, 28);
  assert.equal(result.rows.filter((entry) => entry.label.startsWith("L")).length, 21);
  assert.equal(result.rows.filter((entry) => entry.label.startsWith("I")).length, 7);
  assert.deepEqual(result.summary, { create: 27, update: 1, unchanged: 0, conflict: 0, warnings: 0 });
  for (const code of ["I12", "I22"]) assert.equal(result.rows.find((entry) => entry.label === code)!.createInput!.catalogPublication!.visible, false, code);
  const l09 = result.rows.find((entry) => entry.label === "L09")!.createInput!;
  assert.match(l09.officialName!, /9 kW\/400V/u);
  assert.match(l09.officialNameEn!, /9 kW\/230V/u);
  // L02 already exists in DEV: only the two fields the card lacks are updated.
  const l02 = result.rows.find((entry) => entry.label === "L02")!;
  assert.deepEqual(l02.changes.map((change) => change.field), ["show_3d", "catalog_name"]);
});

test("Excel TRUE/FALSE: accepted as ANO/NE in yes/no columns, explicitly refused elsewhere — never read as empty", () => {
  const accepted = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", show_2d: false, show_3d: false })], [card({ document: { showIn3D: undefined } })]);
  assert.deepEqual(accepted.changes.map((change) => [change.field, change.after]), [["show_2d", false], ["show_3d", false]]);
  for (const key of ["display_name", "power_kw", "catalog_name", "unit_code"]) {
    const refused = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", [key]: true })], [card()]);
    assert.equal(refused.action, "conflict", key);
    assert.match(refused.issues[0]!.message, /logická hodnota PRAVDA/u, key);
  }
  const excelError = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", power_kw: { excelError: "#N/A" } })], [card()]);
  assert.equal(excelError.action, "conflict");
  assert.match(excelError.issues[0]!.message, /chybu Excelu #N\/A/u);
});

test("Strict reader: Excel booleans, boolean formula results and error cells are kept (the price-import reader is unchanged)", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const { extractSheetGrid, extractStrictSheetGrid, readWorkbookFromBuffer } = await import("../lib/import/xlsxReader.server.ts");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sluzby");
  sheet.addRow(["show_2d", "show_3d", "power_kw", "display_name", "catalog_visible", "catalog_sort"]);
  sheet.addRow([false, { formula: "1=1", result: true }, { formula: "NA()", result: { error: "#N/A" } }, "X", true, { formula: "1+1" }]);
  const reread = await readWorkbookFromBuffer(Buffer.from(await book.xlsx.writeBuffer()));
  // The last cell is a formula without a stored value — never "empty".
  assert.deepEqual(extractStrictSheetGrid(reread, "Sluzby")[1], [false, true, { excelError: "#N/A" }, "X", true, { excelError: "vzorec bez uložené hodnoty" }]);
  assert.deepEqual(extractSheetGrid(reread, "Sluzby")[1], [null, null, null, "X", null, null]);
});

test("Lifecycle of existing cards is kept: a 2D/3D change that would downgrade an active card is a conflict, not a silent status change", () => {
  // An active but legacy-imperfect card (no unit): any 2D/3D save re-checks readiness and would fall back to "K doplnění".
  const legacy = { unit: null, unitCode: null, document: { unit: undefined } } as const;
  const result = only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", show_3d: "ANO" })], [card(legacy)]);
  assert.equal(result.action, "conflict");
  assert.match(result.issues.at(-1)!.message, /K doplnění \(missing_unit\)/u);
  // Other fields of the same card still update (they never re-check readiness); a non-active card updates 2D/3D normally.
  assert.equal(only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", catalog_name: "Nový" })], [card(legacy)]).action, "update");
  assert.equal(only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", show_3d: "ANO" })], [card({ ...legacy, lifecycleStatus: "needs_review" })]).action, "update");
  // A ready active card (like the real L02) keeps its status through the 2D/3D change.
  assert.equal(only([row({ generator_code: "L02", display_name: "Elektrická energie - 2kW", category: "Elektřina", show_3d: "ANO" })], [card()]).action, "update");
});

test("Concurrency: every update carries the updated_at of the card it was planned against", () => {
  const result = only([row(L02_ROW)], [card({ updatedAt: "2026-11-03T12:43:50.728477+00:00", document: { showIn3D: undefined } })]);
  assert.equal(result.action, "update");
  assert.equal(result.expectedUpdatedAt, "2026-11-03T12:43:50.728477+00:00");
});

test("Writer refuses a plan with conflicts or workbook errors before touching the database", async () => {
  const { applyCatalogExcelImportPlan } = await import("../lib/db/catalogExcelImport.supabase.ts");
  const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
  let touched = 0;
  const environment = { NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: "https://wpbivmobbqcqmyehunog.supabase.co", SUPABASE_EXPECTED_PROJECT_REF: "wpbivmobbqcqmyehunog", SUPABASE_SECRET_KEY: "x" };
  const client = createScriptSupabaseClient({ environment, createClient: () => ({ from: () => { touched += 1; throw new Error("nesmí se zavolat"); } }) as never });
  const conflicting = plan([row({ generator_code: "L77", display_name: "A", category: "Elektřina" }), row({ generator_code: "L77", display_name: "B", category: "Elektřina" })]);
  await assert.rejects(applyCatalogExcelImportPlan(client, conflicting), /konflikty/u);
  const unsupported = planCatalogWorkbookImport([META, { name: "Komplety", grid: [["a"], ["b"], ["P86"]] }], { items: [], categories: CATEGORIES });
  await assert.rejects(applyCatalogExcelImportPlan(client, unsupported), /chyby sešitu/u);
  assert.equal(touched, 0);
});
