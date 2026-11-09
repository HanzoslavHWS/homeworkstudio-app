import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { planCatalogWorkbookImport, type CatalogRowPlan, type RawCell, type WorkbookSheetInput } from "../domain/catalogExcelImport.ts";
import { buildCatalogItemCreateDocument, parseCatalogItemAdminCreateInput, parseCatalogItemAdminEdit, type CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { BUILT_IN_CATALOG_CATEGORIES } from "../domain/catalogClassification.ts";
import type { CatalogVariantSet } from "../domain/catalogVariants.ts";

const CATEGORIES = BUILT_IN_CATALOG_CATEGORIES;
const P_KEYS = ["id", "generator_code", "abf_code", "display_name", "official_name", "official_name_en", "category", "unit_code", "width_mm", "depth_mm", "height_mm", "color", "material", "show_2d", "show_3d", "variant_set", "variant_scope", "usage_agreement_payer", "catalog_visible", "catalog_name", "catalog_description", "catalog_sort", "note", "lifecycle_status"];
const S_KEYS = ["id", "generator_code", "abf_code", "display_name", "official_name", "official_name_en", "category", "unit_code", "power_kw", "show_2d", "show_3d", "catalog_visible", "catalog_name", "catalog_description", "catalog_sort", "note", "lifecycle_status"];
const META: WorkbookSheetInput = { name: "_meta", grid: [["key", "value"], ["template_format", "catalog-template/1"], ["environment", "DEV"]] };
const SERBUS: CatalogVariantSet = { id: "a4e2a267-b1f0-4e5f-b6e5-038921deea55", code: "KOBERCE-SERBUS", name: "Koberce SERBUS", kind: "carpet", isActive: true, variants: [] };

const pRow = (values: Readonly<Record<string, RawCell>>): RawCell[] => P_KEYS.map((key) => values[key] ?? null);
const sRow = (values: Readonly<Record<string, RawCell>>): RawCell[] => S_KEYS.map((key) => values[key] ?? null);
const book = (products: RawCell[][], services: RawCell[][] = []): WorkbookSheetInput[] => [
  META,
  { name: "Produkty", grid: [P_KEYS, P_KEYS, ...products] },
  { name: "Sluzby", grid: [S_KEYS, S_KEYS, ...services] },
];
const plan = (products: RawCell[][], items: readonly CatalogItemAdmin[] = [], services: RawCell[][] = []) => planCatalogWorkbookImport(book(products, services), { items, categories: CATEGORIES, variantSets: [SERBUS], targetEnvironment: "DEV" });
const only = (products: RawCell[][], items: readonly CatalogItemAdmin[] = []): CatalogRowPlan => {
  const result = plan(products, items);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
};
const lastError = (row: CatalogRowPlan) => row.issues.filter((issue) => issue.severity === "error").at(-1)?.message ?? "";

/** M20 as the real file has it. */
const M20 = { generator_code: "M20", abf_code: "M20", display_name: "Pult plný s policí 50x50x80", official_name: "PULT PLNÝ S POLICÍ  50X50X80 cm", official_name_en: "RAISING COUNTER WITH ONE SHELF 50X50X80 cm", category: "Pulty", unit_code: "ks", width_mm: 500, depth_mm: 500, height_mm: 800, color: "Bílá", material: "Hliník/desky", show_2d: "ANO", show_3d: "ANO", catalog_visible: "ANO", catalog_name: "Pult plný s policí 50x50x80" };

/** An active, READY furniture card (like M57) — code, unit, dimensions, 2D footprint, reviewed. */
const product = (overrides: Partial<CatalogItemAdmin> & Readonly<{ document?: Record<string, unknown> }> = {}): CatalogItemAdmin => ({
  id: "3c6dad26-0af7-4d1d-8c06-7f6196e3c48f",
  internalCode: "M20",
  abfCode: "M20",
  itemType: "PRODUCT",
  kind: "furniture",
  lifecycleStatus: "active",
  displayName: "Pult plný s policí 50x50x80",
  officialName: "PULT PLNÝ S POLICÍ 50X50X80 cm",
  officialNameEn: "RAISING COUNTER WITH ONE SHELF 50X50X80 cm",
  category: "product-counters",
  unit: "ks",
  unitCode: "ks",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-05T10:00:00.123456+00:00",
  ...overrides,
  document: {
    displayName: "Pult plný s policí 50x50x80", category: "product-counters", unit: "ks", widthMm: 500, depthMm: 500, heightMm: 800,
    attributes: { color: "Bílá", material: "Hliník/desky", extra: [{ key: "Nosnost", value: "50 kg" }] }, showIn2D: true, showIn3D: true, footprint2D: { shape: "rectangle" }, modelAsset: { id: "glb-1", storageKey: "catalog/m20.glb" },
    reviewedAt: "2026-11-05T09:00:00Z", photoAsset: { id: "photo-1", storageKey: "catalog/m20.png" }, catalogPublication: { visible: true, name: "Pult plný s policí 50x50x80" },
    ...(overrides.document ?? {}),
  },
} as CatalogItemAdmin);

test("Produkty create: category name → register id, PRODUCT/furniture, dimensions in mm, colour + material, 3D = ANO kept as a requirement, ONE create input", () => {
  const created = only([pRow(M20)]);
  assert.equal(created.sheet, "Produkty");
  assert.equal(created.action, "create");
  const input = parseCatalogItemAdminCreateInput(created.createInput);
  assert.deepEqual([input.itemType, input.kind, input.category, input.internalCode, input.abfCode, input.unitCode], ["PRODUCT", "furniture", "product-counters", "M20", "M20", "ks"]);
  assert.deepEqual([input.widthMm, input.depthMm, input.heightMm], [500, 500, 800]);
  assert.deepEqual(input.attributes, { color: "Bílá", material: "Hliník/desky" });
  assert.equal(input.showIn3D, true, "3D = ANO without a GLB is stored as the requirement");
  assert.equal(input.officialName, "PULT PLNÝ S POLICÍ 50X50X80 cm", "official name: only whitespace normalized, never corrected");
  const document = buildCatalogItemCreateDocument(input);
  assert.ok(!("lifecycleStatus" in document) && !("modelAsset" in document) && !("reviewedAt" in document));
  assert.deepEqual(document.catalogPublication, { visible: true, name: "Pult plný s policí 50x50x80" });
  // "Ostatní mobiliář" is the register category "Nábytek" (id kept from the first cards).
  assert.equal(only([pRow({ ...M20, generator_code: "M32", abf_code: "M32", category: "Ostatní mobiliář", height_mm: 2500, official_name: "VITRÍNA PROSKLENÁ 50X50X250 cm", official_name_en: null, display_name: "Vitrína" })]).createInput!.category, "Nábytek");
});

test("Bílá needs no swatch book; an empty swatch book / scope never assigns one (no carpet default), on create or update", () => {
  const created = only([pRow({ ...M20, variant_set: null, variant_scope: null })]);
  assert.equal(created.createInput!.variantOptions, undefined);
  assert.ok(!("variantOptions" in buildCatalogItemCreateDocument(parseCatalogItemAdminCreateInput(created.createInput))));
  // Even a carpet category: empty cells = no swatch book.
  const carpet = only([pRow({ generator_code: "M09", display_name: "Koberec", category: "Koberce", unit_code: "m2" })]);
  assert.equal(carpet.action, "create");
  assert.equal(carpet.createInput!.variantOptions, undefined);
  // Existing swatch book stays when the cells are empty.
  const withBook = product({ document: { variantOptions: { variantSetId: SERBUS.id, scope: "billed_by_card" } } });
  assert.equal(only([pRow(M20)], [withBook]).action, "unchanged");
});

test("Swatch book by code + scope (label or id); scope is required with a book and meaningless without one; #SMAZAT removes it", () => {
  const set = only([pRow({ ...M20, variant_set: "koberce-serbus", variant_scope: "Všechny barvy vzorníku" })]);
  assert.deepEqual(set.createInput!.variantOptions, { variantSetId: SERBUS.id, scope: "all_variants" });
  assert.deepEqual(parseCatalogItemAdminCreateInput(set.createInput).variantOptions, { variantSetId: SERBUS.id, scope: "all_variants" });
  assert.match(lastError(only([pRow({ ...M20, variant_set: "KOBERCE-SERBUS" })])), /Rozsah barev je povinný/u);
  assert.match(lastError(only([pRow({ ...M20, variant_scope: "billed_by_card" })])), /bez vzorníku/u);
  assert.match(lastError(only([pRow({ ...M20, variant_set: "NEEXISTUJE", variant_scope: "billed_by_card" })])), /neexistuje/u);
  const withBook = product({ document: { variantOptions: { variantSetId: SERBUS.id, scope: "billed_by_card" } } });
  const scopeOnly = only([pRow({ ...M20, variant_scope: "all_variants" })], [withBook]);
  assert.deepEqual(scopeOnly.edit!.variantOptions, { variantSetId: SERBUS.id, scope: "all_variants" });
  const removed = only([pRow({ ...M20, variant_set: "#SMAZAT" })], [withBook]);
  assert.equal(removed.edit!.variantOptions, null);
  assert.equal(parseCatalogItemAdminEdit(removed.edit).variantOptions, null);
});

test("Category conversion is per sheet: a product category on Sluzby and a service category on Produkty are conflicts", () => {
  assert.match(lastError(only([pRow({ ...M20, category: "Elektřina" })])), /nepatří na list Produkty/u);
  const result = plan([], [], [sRow({ generator_code: "X1", display_name: "X", category: "Pulty" })]);
  assert.match(lastError(result.rows[0]!), /nepatří na list Sluzby/u);
  assert.match(lastError(only([pRow({ ...M20, category: "Neexistuje" })])), /není v registru/u);
});

test("Dimensions: mm; 0 is a value; Czech decimal comma; never deletable", () => {
  const zero = only([pRow({ ...M20, height_mm: 0 })], [product({ lifecycleStatus: "needs_review" })]);
  assert.deepEqual(zero.changes.map((change) => [change.field, change.before, change.after]), [["height_mm", 800, 0]]);
  assert.equal(zero.edit!.heightMm, 0);
  assert.equal(only([pRow({ ...M20, width_mm: "500,5" })], [product()]).edit!.widthMm, 500.5);
  assert.equal(only([pRow({ ...M20, width_mm: "#SMAZAT" })], [product()]).action, "conflict");
});

test("Dimensions entered in centimetres are refused with the concrete row and value — never converted", () => {
  // M21 of the real file: the name says 50X50X110 cm, the height cell holds 110.
  const m21 = only([pRow({ ...M20, generator_code: "M21", abf_code: "M21", display_name: "Pult plný s policí 50x50x110", official_name: "PULT PLNÝ S POLICÍ  50X50X110 cm", official_name_en: "RAISING COUNTER WITH ONE SHELF 50X50X110 cm", height_mm: 110 })]);
  assert.equal(m21.action, "conflict");
  assert.equal(m21.createInput, undefined);
  const issue = m21.issues.find((entry) => entry.field === "height_mm")!;
  assert.match(issue.message, /Výška \(mm\) = 110 — podle názvu .*centimetry \(1100 mm\)/u);
  // Below 100 mm without a contradiction in the name is only a warning — small components are valid.
  const small = only([pRow({ ...M20, official_name: null, official_name_en: null, display_name: "Držák", width_mm: 40, depth_mm: 40 })]);
  assert.equal(small.action, "create");
  assert.deepEqual(small.issues.map((issue) => [issue.severity, issue.field]), [["warning", "width_mm"], ["warning", "depth_mm"]]);
  assert.match(small.issues[0]!.message, /méně než 100 mm/u);
  assert.equal(small.createInput!.widthMm, 40);
  // A small value that the name contradicts is still a conflict (5X5X3 cm stated, 3 in the cell = cm).
  assert.equal(only([pRow({ ...M20, official_name: "DRŽÁK 5X5X3 cm", official_name_en: null, display_name: "Držák", width_mm: 50, depth_mm: 50, height_mm: 3 })]).action, "conflict");
  // The correct values pass (M23: 1000 × 500 × 1100 for 100X50X110 cm; M26 1100 without a size in the name).
  assert.equal(only([pRow({ ...M20, official_name: "PULT PLNÝ S POLICÍ 100X50X110 cm", width_mm: 1000, depth_mm: 500, height_mm: 1100 })]).action, "create");
  const m26 = only([pRow({ ...M20, generator_code: "M26", abf_code: "M26", display_name: "Pult plný čtvrtkruh", official_name: "PULT PLNÝ ČTVRTKRUH", official_name_en: "QUARTER CIRCLE RAISING COUNTER WITH ONE SHELF, HEIGHT 80 OR 100 cm", width_mm: 1000, depth_mm: 1000, height_mm: 1100, catalog_description: "Lze objednat i ve výšce 80cm" })]);
  assert.equal(m26.action, "create");
  assert.equal(m26.createInput!.heightMm, 1100);
  assert.equal(m26.createInput!.catalogPublication!.shortDescription, "Lze objednat i ve výšce 80cm");
});

test("Code collisions: across sheets, ABF code as default generator code, and the cross-code rule inside the file and against the catalog", () => {
  // The same code on both sheets.
  const both = plan([pRow(M20)], [], [sRow({ generator_code: "M20", display_name: "X", category: "Internet" })]);
  assert.deepEqual(both.rows.map((row) => [row.sheet, row.action]), [["Produkty", "conflict"], ["Sluzby", "conflict"]]);
  // Empty generator code takes the ABF code …
  const fallback = only([pRow({ ...M20, generator_code: null })]);
  assert.equal(fallback.createInput!.internalCode, "M20");
  // … only without a collision: another card already uses M20 as its generator code.
  const taken = { ...product({ id: "00000000-0000-4000-8000-000000000009", internalCode: "M20", abfCode: "X20" }) } as CatalogItemAdmin;
  assert.equal(only([pRow({ ...M20, generator_code: null, abf_code: "M20" })], [taken]).action, "conflict");
  // Inside the file: row A has no generator code (→ M20 from its ABF code), row B has generator code M20.
  const fileFallback = plan([pRow({ ...M20, generator_code: null }), pRow({ ...M20, abf_code: "M2X" })]);
  assert.deepEqual(fileFallback.rows.map((row) => row.action), ["conflict", "conflict"]);
  // Inside the file: generator code of one row = ABF code of another.
  const cross = plan([pRow({ ...M20, generator_code: "K1", abf_code: "K2" }), pRow({ ...M20, generator_code: "K3", abf_code: "K1" })]);
  assert.deepEqual(cross.rows.map((row) => row.action), ["conflict", "conflict"]);
  assert.match(lastError(cross.rows[0]!), /ABF kódem jiného řádku \(Produkty ř\. 4\)/u);
  // A Produkty row that matches a SERVICE card.
  assert.match(lastError(only([pRow(M20)], [product({ itemType: "SERVICE", kind: "service" })])), /typu SERVICE — na list Produkty nepatří/u);
  assert.deepEqual(both.bySheet, { Produkty: { create: 0, update: 0, unchanged: 0, conflict: 1 }, Sluzby: { create: 0, update: 0, unchanged: 0, conflict: 1 } });
});

test("Names are compared case-sensitively: 'Wifi' → 'WIFI' is a real change; internal and catalog name are independent fields; same card id", () => {
  const i20: CatalogItemAdmin = {
    id: "9bf98ab8-4479-4b61-9eeb-9313e6b281e9", internalCode: "I20", abfCode: "I20", itemType: "SERVICE", kind: "service", lifecycleStatus: "active",
    displayName: "Internet Wifi", officialName: "INTERNET - WIFI PŘIPOJENÍ (MIMO VENKOVNÍ PLOCHY)", officialNameEn: "INTERNET - WIFI CONNECTION", category: "service-internet", unit: "ks", unitCode: "ks",
    createdAt: "2026-11-06T09:00:00Z", updatedAt: "2026-11-06T11:00:00.5+00:00",
    document: { displayName: "Internet Wifi", category: "service-internet", unit: "ks", showIn2D: true, showIn3D: false, footprint2D: { shape: "rectangle" }, serviceTechnical: { serviceCategory: "internet" }, catalogPublication: { visible: true, name: "Internet Wifi" } },
  } as CatalogItemAdmin;
  const row = sRow({ generator_code: "I20", abf_code: "I20", display_name: "Internet WIFI", official_name: "INTERNET - WIFI PŘIPOJENÍ (MIMO VENKOVNÍ PLOCHY)", official_name_en: "INTERNET - WIFI CONNECTION", category: "Internet", unit_code: "ks", show_2d: "ANO", show_3d: "NE", catalog_visible: "ANO", catalog_name: "Internet Wifi " });
  const result = plan([], [i20], [row]).rows[0]!;
  assert.equal(result.action, "update");
  assert.equal(result.itemId, i20.id, "same card, no new one");
  assert.deepEqual(result.changes.map((change) => [change.field, change.before, change.after]), [["display_name", "Internet Wifi", "Internet WIFI"]]);
  assert.deepEqual(parseCatalogItemAdminEdit(result.edit), { displayName: "Internet WIFI" }, "the catalog name is NOT synchronized from the internal name");
  assert.equal(result.expectedUpdatedAt, i20.updatedAt);
  // Only the catalog name in another case → only that field changes.
  const catalogOnly = plan([], [i20], [sRow({ generator_code: "I20", display_name: "Internet Wifi", category: "Internet", catalog_name: "Internet WIFI" })]).rows[0]!;
  assert.deepEqual(parseCatalogItemAdminEdit(catalogOnly.edit), { catalogPublication: { name: "Internet WIFI" } });
});

test("Update: colour change keeps material and further parameters; agreement keeps its note; #SMAZAT clears colour / agreement", () => {
  const color = only([pRow({ ...M20, color: "Černá" })], [product()]);
  assert.deepEqual(color.edit!.attributes, { extra: [{ key: "Nosnost", value: "50 kg" }], color: "Černá", material: "Hliník/desky" });
  const clearColor = only([pRow({ ...M20, color: "#SMAZAT" })], [product()]);
  assert.deepEqual(clearColor.edit!.attributes, { extra: [{ key: "Nosnost", value: "50 kg" }], material: "Hliník/desky" });
  const agreement = product({ document: { usageAgreement: { payerLabel: "PVA", note: "Smlouva 2026" } } });
  assert.deepEqual(only([pRow({ ...M20, usage_agreement_payer: "ABF" })], [agreement]).edit!.usageAgreement, { payerLabel: "ABF", note: "Smlouva 2026" });
  assert.equal(only([pRow({ ...M20, usage_agreement_payer: "#SMAZAT" })], [agreement]).edit!.usageAgreement, null);
  assert.deepEqual(parseCatalogItemAdminCreateInput(only([pRow({ ...M20, usage_agreement_payer: "PVA" })]).createInput).usageAgreement, { payerLabel: "PVA" });
});

test("Lifecycle of an active product is kept: a change that would make it un-ready (width 0) is a conflict; other fields update normally", () => {
  assert.match(lastError(only([pRow({ ...M20, width_mm: 0 })], [product()])), /K doplnění \(missing_dimensions\)/u);
  const ok = only([pRow({ ...M20, catalog_description: "Bílý pult" })], [product()]);
  assert.equal(ok.action, "update");
  assert.deepEqual(parseCatalogItemAdminEdit(ok.edit), { catalogPublication: { shortDescription: "Bílý pult" } });
});

test("Repeated import of a product row against the card it created → unchanged", () => {
  const created = only([pRow({ ...M20, variant_set: "KOBERCE-SERBUS", variant_scope: "billed_by_card", usage_agreement_payer: "PVA" })]);
  const input = parseCatalogItemAdminCreateInput(created.createInput);
  const card = product({ lifecycleStatus: "needs_review", officialName: input.officialName ?? null, officialNameEn: input.officialNameEn ?? null, document: {} });
  const stored = { ...card, document: buildCatalogItemCreateDocument(input) } as CatalogItemAdmin;
  const again = only([pRow({ ...M20, variant_set: "KOBERCE-SERBUS", variant_scope: "billed_by_card", usage_agreement_payer: "PVA" })], [stored]);
  assert.equal(again.action, "unchanged", JSON.stringify(again.changes));
});

const REAL_6 = path.resolve("_IMPORT", "Generator_ABF_Katalog(6).xlsx");
test("Real _IMPORT/Generator_ABF_Katalog(6).xlsx: 20 products + 28 services in one plan; M21 corrected to 1100 mm; M26 one card, 1100 mm + description; I12/I22 hidden", { skip: !existsSync(REAL_6) && "_IMPORT workbook not present (gitignored)" }, async () => {
  const { extractStrictSheetGrid, readWorkbookFromBufferTolerant } = await import("../lib/import/xlsxReader.server.ts");
  const workbook = await readWorkbookFromBufferTolerant(readFileSync(REAL_6));
  const sheets = workbook.worksheets.map((sheet) => ({ name: sheet.name, grid: extractStrictSheetGrid(workbook, sheet.name) }));
  const result = planCatalogWorkbookImport(sheets, { items: [], categories: CATEGORIES, variantSets: [SERBUS], targetEnvironment: "DEV" });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.bySheet, { Produkty: { create: 20, update: 0, unchanged: 0, conflict: 0 }, Sluzby: { create: 28, update: 0, unchanged: 0, conflict: 0 } });
  // Produkty!K4 was corrected 110 → 1100 (user-approved, 2026-11-06); the cm check itself stays covered above.
  const m21 = result.rows.find((row) => row.label === "M21")!;
  assert.equal(m21.action, "create");
  assert.equal(m21.createInput!.heightMm, 1100);
  const m26 = result.rows.filter((row) => row.label === "M26");
  assert.equal(m26.length, 1);
  assert.equal(m26[0]!.createInput!.heightMm, 1100);
  assert.equal(m26[0]!.createInput!.catalogPublication!.shortDescription, "Lze objednat i ve výšce 80cm");
  assert.ok(result.rows.filter((row) => row.sheet === "Produkty" && row.action === "create").every((row) => row.createInput!.variantOptions === undefined));
  for (const code of ["I12", "I22"]) assert.equal(result.rows.find((row) => row.label === code)!.createInput!.catalogPublication!.visible, false);
  const l09 = result.rows.find((row) => row.label === "L09")!.createInput!;
  assert.match(l09.officialName!, /9 kW\/400V/u);
  assert.match(l09.officialNameEn!, /9 kW\/230V/u);
  assert.equal(result.rows.find((row) => row.label === "I20")!.createInput!.displayName, "Internet WIFI");
  assert.equal(result.rows.find((row) => row.label === "I20")!.createInput!.catalogPublication!.name, "Internet Wifi");
});
