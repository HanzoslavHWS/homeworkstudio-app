import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptCatalogItemToComponentDefinition,
  isPlaceableBoothComponent,
  isProductionReadyBoothComponent,
  selectGeneratorBoothComponents,
} from "../domain/generatorBoothComponents.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";

function fixture(overrides: Partial<CatalogItemAdmin> & { document?: Record<string, unknown> } = {}): CatalogItemAdmin {
  return {
    id: "row-uuid",
    internalCode: null,
    kind: "booth_component",
    lifecycleStatus: "needs_review",
    displayName: "Fixture",
    officialName: null,
    category: null,
    unit: null,
    document: {},
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const glbAsset = {
  id: "glb-1",
  storageKey: "catalog/booth-components/sloupek/models/v1.glb",
  originalFileName: "v1.glb",
  mimeType: "model/gltf-binary" as const,
  size: 500_000,
  createdAt: "2026-08-20T00:00:00.000Z",
  category: "catalog-model" as const,
};

const skpSourceAsset = {
  id: "skp-1",
  kind: "sketchup" as const,
  asset: {
    id: "skp-asset-1",
    storageKey: "catalog/booth-components/sloupek/source/v1.skp",
    originalFileName: "v1.skp",
    mimeType: "application/octet-stream",
    size: 400_000,
    createdAt: "2026-08-20T00:00:00.000Z",
    category: "catalog-source" as const,
  },
};

function sloupekFixture(overrides: Partial<CatalogItemAdmin> = {}, documentOverrides: Record<string, unknown> = {}): CatalogItemAdmin {
  return fixture({
    id: "sloupek-uuid",
    internalCode: "BC-SLOUPEK-01",
    displayName: "Sloupek 2500 mm",
    category: "Sloupky",
    lifecycleStatus: "active",
    document: {
      internalCode: "BC-SLOUPEK-01",
      displayName: "Sloupek 2500 mm",
      category: "Sloupky",
      widthMm: 40,
      depthMm: 40,
      heightMm: 2500,
      modelUrl: glbAsset.storageKey,
      sourceAssets: [skpSourceAsset],
      ...documentOverrides,
    },
    ...overrides,
  });
}

// =========================================================================================
// isProductionReadyBoothComponent — reuses the exact same active+ready+generatorEligible rule
// as the typovka booth picker (domain/generatorBooths.ts), never a looser filter.
// =========================================================================================

test("isProductionReadyBoothComponent: active with GLB+SKP evidenced is production-ready", () => {
  assert.equal(isProductionReadyBoothComponent(sloupekFixture()), true);
});

test("isProductionReadyBoothComponent: needs_review is never production-ready, even with GLB+SKP", () => {
  assert.equal(isProductionReadyBoothComponent(sloupekFixture({ lifecycleStatus: "needs_review" })), false);
});

test("isProductionReadyBoothComponent: archived is never production-ready", () => {
  assert.equal(isProductionReadyBoothComponent(sloupekFixture({ lifecycleStatus: "archived" })), false);
});

test("isProductionReadyBoothComponent: active but missing the SketchUp source is never production-ready (booth_component's own GLB+SKP rule)", () => {
  const missingSkp = sloupekFixture({}, { sourceAssets: [] });
  assert.equal(isProductionReadyBoothComponent(missingSkp), false);
});

test("isProductionReadyBoothComponent: active but missing the GLB is never production-ready", () => {
  const missingGlb = sloupekFixture({}, { modelUrl: undefined });
  assert.equal(isProductionReadyBoothComponent(missingGlb), false);
});

// =========================================================================================
// isPlaceableBoothComponent — additive gate on top of readiness: booth_component's own
// readiness rule never requires widthMm/depthMm (some elements, e.g. límec/rastr, have none),
// but the placement picker needs a real footprint to place/snap/collide against.
// =========================================================================================

test("isPlaceableBoothComponent: real widthMm/depthMm is placeable", () => {
  assert.equal(isPlaceableBoothComponent(sloupekFixture().document), true);
});

test("isPlaceableBoothComponent: no dimensions declared is not placeable, even though it can still be a valid catalog entry", () => {
  const noDims = sloupekFixture({}, { widthMm: undefined, depthMm: undefined });
  assert.equal(isProductionReadyBoothComponent(noDims), true, "still a valid, ready catalog item");
  assert.equal(isPlaceableBoothComponent(noDims.document), false, "but not yet placeable without a real footprint");
});

// =========================================================================================
// adaptCatalogItemToComponentDefinition
// =========================================================================================

test("adaptCatalogItemToComponentDefinition: never fabricates physical dimensions — widthMm/depthMm/heightMm come straight from the document", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekFixture());
  assert.equal(adapted.widthMm, 40);
  assert.equal(adapted.depthMm, 40);
  assert.equal(adapted.heightMm, 2500);
});

test("adaptCatalogItemToComponentDefinition: id/internalCode/displayName/category/lifecycleStatus come from the DB row, never a possibly-stale document copy", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekFixture());
  assert.equal(adapted.id, "sloupek-uuid");
  assert.equal(adapted.internalCode, "BC-SLOUPEK-01");
  assert.equal(adapted.displayName, "Sloupek 2500 mm");
  assert.equal(adapted.category, "Sloupky");
  assert.equal(adapted.lifecycleStatus, "active");
  assert.equal(adapted.catalogItemKind, "booth_component");
});

test("adaptCatalogItemToComponentDefinition: fills a 45°-step rotation policy when the document declares none (Octanorm's 8 connection directions) — never overrides a real one", () => {
  const adaptedDefault = adaptCatalogItemToComponentDefinition(sloupekFixture());
  assert.equal(adaptedDefault.rotation.defaultMode, "snap");
  assert.equal(adaptedDefault.rotation.snapStep, 45);
  assert.deepEqual([...adaptedDefault.rotation.quickAngles], [0, 45, 90, 135, 180, 225, 270, 315]);

  const customRotation = { defaultMode: "free" as const, snapStep: 45 as const, quickAngles: [0, 45], allowFreeRotation: true, locked: false };
  const adaptedCustom = adaptCatalogItemToComponentDefinition(sloupekFixture({}, { rotation: customRotation }));
  assert.deepEqual(adaptedCustom.rotation, customRotation);
});

test("adaptCatalogItemToComponentDefinition: never introduces a scale/size-override field — placement stays xMm/yMm/rotationDeg only", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekFixture());
  assert.equal((adapted as Record<string, unknown>).scale, undefined);
});

// =========================================================================================
// selectGeneratorBoothComponents — filter (kind + production-ready + placeable) THEN sort
// (alphabetical by displayName, same convention as "Administrace → Komponenty") THEN adapt.
// =========================================================================================

test("selectGeneratorBoothComponents: hides furniture/booth/other kinds — booth_component only", () => {
  const furniture = fixture({ id: "furniture-uuid", kind: "furniture", lifecycleStatus: "active", document: { widthMm: 500, depthMm: 500, modelUrl: "x.glb", sourceAssets: [skpSourceAsset], showIn2D: true, showIn3D: true, reviewedAt: "2026-08-20T00:00:00.000Z", unit: "ks", internalCode: "F1" } });
  const result = selectGeneratorBoothComponents([sloupekFixture(), furniture]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.catalogItemKind, "booth_component");
});

test("selectGeneratorBoothComponents: hides archived and needs_review components", () => {
  const archived = sloupekFixture({ id: "archived-uuid", lifecycleStatus: "archived" });
  const needsReview = sloupekFixture({ id: "review-uuid", lifecycleStatus: "needs_review" });
  const result = selectGeneratorBoothComponents([sloupekFixture(), archived, needsReview]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "sloupek-uuid");
});

test("selectGeneratorBoothComponents: hides a ready component with no real footprint", () => {
  const noDims = sloupekFixture({ id: "no-dims-uuid" }, { widthMm: undefined, depthMm: undefined });
  const result = selectGeneratorBoothComponents([sloupekFixture(), noDims]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "sloupek-uuid");
});

test("selectGeneratorBoothComponents: sorts alphabetically (cs locale) by displayName", () => {
  const b = sloupekFixture({ id: "b-uuid", displayName: "Panel 1000 mm" }, { displayName: "Panel 1000 mm" });
  const a = sloupekFixture({ id: "a-uuid", displayName: "Dveře 990 mm" }, { displayName: "Dveře 990 mm" });
  const result = selectGeneratorBoothComponents([b, a]);
  assert.deepEqual(result.map((item) => item.displayName), ["Dveře 990 mm", "Panel 1000 mm"]);
});
