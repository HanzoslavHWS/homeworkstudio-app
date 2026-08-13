import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueMappingSourceKey,
  buildImportPreview,
  buildMappingSourceKey,
  diffImportRows,
  DuplicateMappingSourceKeyError,
  findConfirmedMapping,
  normalizedMappingName,
  stableRowKey,
  type CatalogMapping,
  type ImportRow,
  type ImportWorkbookSheets,
} from "../domain/importBatch.ts";
import { componentCatalogItems } from "../data/components.ts";

function makeRow(overrides: Partial<ImportRow>): ImportRow {
  return {
    id: overrides.id ?? "row-1",
    importBatchId: "batch-1",
    sourceSheet: "PRICELIST",
    sourceRow: 1,
    rawName: "Test",
    rawValues: {},
    normalizedValues: { price: 100 },
    mappingStatus: "new",
    issues: [],
    ...overrides,
  };
}

test("stejný workbook se znovu naimportuje bez slepé duplicity — nezměněné řádky se poznají", () => {
  const previous = [makeRow({ id: "a", sourceKey: "row-a", normalizedValues: { price: 100 } })];
  const current = [makeRow({ id: "b", sourceKey: "row-a", normalizedValues: { price: 100 } })];
  const diff = diffImportRows(previous, current);
  assert.deepEqual(diff.newKeys, []);
  assert.deepEqual(diff.unchangedKeys, [stableRowKey("PRICELIST", "row-a")]);
  assert.deepEqual(diff.changedKeys, []);
});

test("změněná cena se pozná jako 'changed', ne jako duplicitní nová položka", () => {
  const previous = [makeRow({ id: "a", sourceKey: "row-a", normalizedValues: { price: 100 } })];
  const current = [makeRow({ id: "b", sourceKey: "row-a", normalizedValues: { price: 150 } })];
  const diff = diffImportRows(previous, current);
  assert.deepEqual(diff.changedKeys, [stableRowKey("PRICELIST", "row-a")]);
  assert.deepEqual(diff.newKeys, []);
});

test("položka zmizelá ze zdroje se NEMAŽE automaticky, jen se označí jako missingFromLatestImport", () => {
  const previous = [makeRow({ id: "a", sourceKey: "row-a" }), makeRow({ id: "b", sourceKey: "row-b" })];
  const current = [makeRow({ id: "c", sourceKey: "row-a" })];
  const diff = diffImportRows(previous, current);
  assert.deepEqual(diff.missingFromLatestImport, [stableRowKey("PRICELIST", "row-b")]);
  // Nothing in this module has a delete operation at all — the diff is purely additive information.
});

function mapping(overrides: Partial<CatalogMapping> & Pick<CatalogMapping, "catalogItemId">): CatalogMapping {
  const identity = { sourceSheet: "PRICELIST", category: "Nábytek", rawName: "Židle čalouněná" };
  return {
    id: overrides.id ?? "m1",
    sourceSystem: "excel-pricelist",
    sourceKey: overrides.sourceKey ?? buildMappingSourceKey(identity),
    normalizedName: overrides.normalizedName ?? normalizedMappingName(identity.rawName),
    catalogItemId: overrides.catalogItemId,
    confirmed: overrides.confirmed ?? true,
    createdAt: overrides.createdAt ?? "2026-08-13T00:00:00.000Z",
  };
}

test("potvrzený mapping se najde podle stabilního sourceKey (sheet + kategorie + název), i po znovu-normalizaci názvu", () => {
  const identity = { sourceSheet: "PRICELIST", category: "Nábytek", rawName: "Židle čalouněná" };
  const mappings: readonly CatalogMapping[] = [mapping({ catalogItemId: "chair-basic" })];

  const found = findConfirmedMapping(mappings, "excel-pricelist", { ...identity, rawName: "  Židle  čalouněná " });
  assert.equal(found?.catalogItemId, "chair-basic");

  const unconfirmed = findConfirmedMapping([mapping({ catalogItemId: "chair-basic", confirmed: false })], "excel-pricelist", identity);
  assert.equal(unconfirmed, undefined);
});

test("stejný normalizovaný název ve dvou sheetech/kategoriích je jiná mapping identita, ne kolize", () => {
  const inPricelistFurniture = buildMappingSourceKey({ sourceSheet: "PRICELIST", category: "Nábytek", rawName: "Lamino" });
  const inPricelistLamino = buildMappingSourceKey({ sourceSheet: "PRICELIST", category: "Lamino", rawName: "Lamino" });
  assert.notEqual(inPricelistFurniture, inPricelistLamino, "sheet/kategorie musí ovlivnit identitu, i když je normalizovaný název stejný");

  const mappings: readonly CatalogMapping[] = [
    mapping({ id: "m1", catalogItemId: "item-a", sourceKey: inPricelistFurniture, normalizedName: "lamino" }),
    mapping({ id: "m2", catalogItemId: "item-b", sourceKey: inPricelistLamino, normalizedName: "lamino" }),
  ];
  assert.doesNotThrow(() => {
    assertUniqueMappingSourceKey(mappings.slice(0, 1), "excel-pricelist", inPricelistLamino);
  });
  // Both rows legitimately coexist — same normalizedName, different sourceKey.
  assert.equal(mappings[0]?.catalogItemId, "item-a");
  assert.equal(mappings[1]?.catalogItemId, "item-b");
});

test("duplicitní potvrzený mapping se stejným source_key je odmítnut", () => {
  const sourceKey = buildMappingSourceKey({ sourceSheet: "PRICELIST", category: "T. služby", rawName: "Přípojka el. energie - 2kW" });
  const existing: readonly CatalogMapping[] = [mapping({ catalogItemId: "service-electricity-2kw-230v", sourceKey })];
  assert.throws(() => assertUniqueMappingSourceKey(existing, "excel-pricelist", sourceKey), DuplicateMappingSourceKeyError);
  // A different source system with the same key is not a collision.
  assert.doesNotThrow(() => assertUniqueMappingSourceKey(existing, "other-system", sourceKey));
});

test("dry-run nezapisuje žádná produkční data — vstupní katalog zůstává nezměněný", () => {
  const guardedCatalog = new Proxy(componentCatalogItems, {
    set() {
      throw new Error("buildImportPreview nesmí mutovat katalog");
    },
    deleteProperty() {
      throw new Error("buildImportPreview nesmí mazat z katalogu");
    },
  });

  const sheets: ImportWorkbookSheets = {
    pricelist: [
      ["kategorie", "položka", "ks", "Kč / ks", "item", "€ / pcs", "NÁKLAD Kč / ks", "info"],
      ["Nábytek", "Židle čalouněná", "", 300, "Upholstered chair", 13, 170],
    ],
    dataSheet: [
      ["id", "AAA", "xxx"],
      ["beauty", "For Beauty", "2. - 3. 10. 2026"],
    ],
    czk: [["CZK", "beauty"], ["Přípojka el. energie - 2kW", 5100]],
    eur: [["EUR", "beauty"], ["Přípojka el. energie - 2kW", 231]],
    naklad: [["náklad?", "beauty"], ["Přípojka el. energie - 2kW", ""]],
  };

  const preview = buildImportPreview(sheets, guardedCatalog as typeof componentCatalogItems);
  assert.equal(preview.counts.events, 1);
  assert.equal(preview.counts.catalogRows, 1);
  // No repository, no client, nothing to write to — buildImportPreview only takes plain
  // arrays and returns plain data.
});
