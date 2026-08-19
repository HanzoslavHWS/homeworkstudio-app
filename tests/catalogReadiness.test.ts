import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueInternalCode,
  DuplicateInternalCodeError,
  evaluateCatalogReadiness,
  isGeneratorEligible,
} from "../domain/catalogReadiness.ts";
import { derivePricingAvailability, resolvePricingAvailability } from "../domain/catalog.ts";
import type { BoothVariant, ComponentDefinition } from "../domain/models.ts";
import { componentCatalog, componentCatalogItems } from "../data/components.ts";
import { boothTypes } from "../data/booths.ts";
import { effectiveFasciaRequirement, priceGraphics } from "../domain/technicalServices.ts";
import { createDefaultTechnicalRequirements } from "../domain/project.ts";

function baseFurniture(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return {
    id: "test-furniture",
    internalCode: "M99",
    displayName: "Testovací židle",
    type: "chair",
    name: "Testovací židle",
    category: "chairs",
    widthMm: 500,
    depthMm: 500,
    heightMm: 800,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: true,
    sceneLabel: "Testovací židle",
    showIn2D: true,
    showIn3D: true,
    footprint2D: { shape: "rectangle" },
    modelUrl: "/models/test.glb",
    unit: "ks",
    active: true,
    reviewedAt: "2026-08-13T00:00:00.000Z",
    lifecycleStatus: "active",
    catalogItemKind: "furniture",
    ...overrides,
  };
}

test("nullable internalCode je validní stav a nic nerozbije", () => {
  assert.doesNotThrow(() => assertUniqueInternalCode([{ internalCode: undefined }, { internalCode: undefined }], undefined));
});

test("duplicitní neprázdný internalCode je odmítnut, case/whitespace insensitive", () => {
  const existing = [{ internalCode: "M57" }, { internalCode: undefined }];
  assert.throws(() => assertUniqueInternalCode(existing, " m57 "), DuplicateInternalCodeError);
  assert.doesNotThrow(() => assertUniqueInternalCode(existing, "M58"));
});

test("readiness fyzického mobiliáře vyžaduje kód, rozměry, jednotku, scénu a review", () => {
  const complete = evaluateCatalogReadiness(baseFurniture(), "furniture");
  assert.equal(complete.ready, true);
  assert.deepEqual(complete.issues, []);

  const missingCode = evaluateCatalogReadiness(baseFurniture({ internalCode: undefined }), "furniture");
  assert.equal(missingCode.ready, false);
  assert.ok(missingCode.issues.includes("missing_internal_code"));

  const missingDims = evaluateCatalogReadiness(baseFurniture({ widthMm: 0, depthMm: 0 }), "furniture");
  assert.ok(missingDims.issues.includes("missing_dimensions"));

  const missing3d = evaluateCatalogReadiness(baseFurniture({ showIn3D: true, modelUrl: undefined, assets: undefined }), "furniture");
  assert.ok(missing3d.issues.includes("missing_3d_asset"));

  const notReviewed = evaluateCatalogReadiness(baseFurniture({ reviewedAt: undefined }), "furniture");
  assert.ok(notReviewed.issues.includes("requires_review"));
});

test("readiness technického bodu nevyžaduje GLB ani interní kód", () => {
  const technicalPoint: ComponentDefinition = {
    ...baseFurniture({ internalCode: undefined, unit: undefined, modelUrl: undefined, reviewedAt: undefined }),
    showIn2D: true,
    showIn3D: false,
    catalogItemKind: "technical_point",
  };
  const result = evaluateCatalogReadiness(technicalPoint, "technical_point");
  assert.equal(result.ready, true);
});

test("readiness služby nevyžaduje 2D/3D ani cenu — jen jednotku a základní údaje", () => {
  const service: ComponentDefinition = {
    ...baseFurniture({ showIn2D: false, showIn3D: false, modelUrl: undefined, footprint2D: undefined, internalCode: "L99" }),
    unit: "ks",
    pricingEntries: [{ id: "p1", itemId: "test-furniture", currency: "CZK", salePrice: 100 }],
    catalogItemKind: "service",
  };
  const ready = evaluateCatalogReadiness(service, "service");
  assert.equal(ready.ready, true);
  assert.equal("missing_price" in evaluateCatalogReadiness({ ...service, pricingEntries: [] }, "service").issues, false);
});

test("služba může být active i s base sale price = NULL (cena přijde přes Event → PriceList → PricingEntry)", () => {
  const service: ComponentDefinition = {
    ...baseFurniture({ showIn2D: false, showIn3D: false, modelUrl: undefined, footprint2D: undefined, internalCode: "L02", unit: "ks" }),
    pricingEntries: [], // no base price at all, exactly like the Excel T. služby PRICELIST rows
    catalogItemKind: "service",
    lifecycleStatus: "active",
  };
  const readiness = evaluateCatalogReadiness(service, "service");
  assert.equal(readiness.ready, true, "chybějící base cena nesmí sama o sobě blokovat readiness");
  assert.equal(isGeneratorEligible(service, "service"), true, "a proto ani nesmí blokovat generator eligibility");
});

test("event-priced služba je catalog-ready, i když nemá base cenu — cena je pouze v event-specific PricingEntry", () => {
  const service: ComponentDefinition = {
    ...baseFurniture({ showIn2D: false, showIn3D: false, modelUrl: undefined, footprint2D: undefined, internalCode: "L02", unit: "ks" }),
    pricingEntries: [{ id: "event-price", itemId: "test-furniture", currency: "CZK", salePrice: 5100, exhibitionId: "beauty" }],
    catalogItemKind: "service",
  };
  assert.equal(evaluateCatalogReadiness(service, "service").ready, true);
  // No base entry resolves for a DIFFERENT event/context — that's a pricing-availability
  // concern for that project, not a reason to consider the catalog item itself broken.
  assert.equal(resolvePricingAvailability(service, { currency: "CZK", exhibitionId: "other-event" }), "missing");
  assert.equal(resolvePricingAvailability(service, { currency: "CZK", exhibitionId: "beauty" }), "fixed");
});

test("individuálně cenová služba (Kontejner) je catalog-ready bez pevné ceny", () => {
  const container: ComponentDefinition = {
    ...baseFurniture({ showIn2D: false, showIn3D: false, modelUrl: undefined, footprint2D: undefined, internalCode: undefined, unit: "ks" }),
    pricingEntries: [{ id: "container-individual", itemId: "test-furniture", currency: "CZK", priceMode: "individual" }],
    catalogItemKind: "service",
  };
  assert.equal(evaluateCatalogReadiness(container, "service").ready, true);
  assert.equal(resolvePricingAvailability(container, { currency: "CZK" }), "individual");
});

test("pricing availability rozlišuje fixed/individual/included/missing a 0 nikdy nenahrazuje missing", () => {
  assert.equal(derivePricingAvailability(undefined), "missing");
  assert.equal(derivePricingAvailability({ id: "a", itemId: "x", currency: "CZK", salePrice: undefined }), "missing");
  assert.equal(derivePricingAvailability({ id: "b", itemId: "x", currency: "CZK", salePrice: 0 }), "fixed");
  assert.equal(derivePricingAvailability({ id: "c", itemId: "x", currency: "CZK", priceMode: "individual" }), "individual");
  assert.equal(derivePricingAvailability({ id: "d", itemId: "x", currency: "CZK", priceMode: "included", salePrice: 0 }), "included");
});

test("neaktivní/nepřipravená položka je skrytá z generátoru, undefined lifecycleStatus zůstává eligible (M57)", () => {
  const notReady = baseFurniture({ lifecycleStatus: "active", reviewedAt: undefined });
  assert.equal(isGeneratorEligible(notReady, "furniture"), false);

  const needsReview = baseFurniture({ lifecycleStatus: "needs_review" });
  assert.equal(isGeneratorEligible(needsReview, "furniture"), false);

  const legacyNoStatus = baseFurniture({ lifecycleStatus: undefined });
  assert.equal(isGeneratorEligible(legacyNoStatus, "furniture"), true);
});

test("M57 zůstává generator-eligible jako legacy seed (žádný lifecycleStatus nastavený)", () => {
  assert.equal(componentCatalog.chair.internalCode, "M57");
  assert.equal(isGeneratorEligible(componentCatalog.chair as ComponentDefinition), true);
});

test("pricingUnit pokrývá všechny reálné jednotky z Excelu (ks/m²/bm/den/m³)", () => {
  const units: readonly NonNullable<ComponentDefinition["pricingUnit"]>[] = ["piece", "square-meter", "linear-meter", "day", "cubic-meter"];
  for (const pricingUnit of units) {
    const graphicsService: ComponentDefinition = {
      ...baseFurniture({ showIn2D: false, showIn3D: false, modelUrl: undefined, footprint2D: undefined, internalCode: undefined, unit: undefined, reviewedAt: undefined }),
      pricingUnit,
      catalogItemKind: "graphics_service",
    };
    assert.equal(evaluateCatalogReadiness(graphicsService, "graphics_service").ready, true, `pricingUnit "${pricingUnit}" musí stačit na readiness bez ceny`);
  }
  const missingPricingUnit: ComponentDefinition = {
    ...baseFurniture({ showIn2D: false, showIn3D: false, modelUrl: undefined, footprint2D: undefined, internalCode: undefined, unit: undefined, reviewedAt: undefined }),
    pricingUnit: undefined,
    catalogItemKind: "graphics_service",
  };
  assert.ok(evaluateCatalogReadiness(missingPricingUnit, "graphics_service").issues.includes("missing_pricing_unit"));
});

test("P86 included grafika límce nevytváří duplicitní účtování a odpovídá priceMode 'included'", () => {
  const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;
  const effective = effectiveFasciaRequirement({ status: "notWanted", note: "" }, p86);
  assert.equal(effective.effective, "included");

  const graphics = priceGraphics(
    { ...createDefaultTechnicalRequirements(), fasciaGraphics: { status: "notWanted", note: "" } },
    p86,
    [],
    componentCatalogItems,
    { currency: "CZK" },
  );
  // Exactly one graphics line for fascia — included, zero net, never a second separate charge.
  assert.equal(graphics.length, 1);
  assert.equal(graphics[0]?.includedInPackage, true);
  assert.equal(graphics[0]?.totalNet, 0);

  // Same situation expressed as a PricingEntry.priceMode, for a DB-persisted event override:
  const includedEntry = { id: "p86-fascia-included", itemId: graphics[0]!.itemId, currency: "CZK" as const, priceMode: "included" as const, salePrice: 0 };
  assert.equal(derivePricingAvailability(includedEntry), "included");
});

// =========================================================================================
// READINESS HARDENING — booth/construction/floor_finish/other (previously fell through to a
// near-empty default case, effectively "ready" once displayName+category were set). See
// evaluateCatalogReadiness's kind-based switch.
// =========================================================================================

const fakeSketchupSource = {
  id: "src-1",
  kind: "sketchup" as const,
  asset: {
    id: "asset-1",
    storageKey: "catalog/furniture/p86/source/abc.skp",
    originalFileName: "p86.skp",
    mimeType: "application/octet-stream",
    size: 1234,
    createdAt: "2026-08-13T00:00:00.000Z",
    category: "catalog-source" as const,
  },
};

function boothLike(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return baseFurniture({
    internalCode: "P86",
    category: "typova-koje",
    unit: undefined,
    reviewedAt: undefined,
    showIn2D: undefined,
    showIn3D: undefined,
    footprint2D: undefined,
    modelUrl: "/models/booths/koje-2x2/master.glb",
    widthMm: 2000,
    depthMm: 2000,
    heightMm: 2500,
    catalogItemKind: "booth",
    ...overrides,
  });
}

test("booth: P86-shaped item s validním footprintem (šířka/hloubka/výška) a modelem je ready — bez unit/reviewedAt/scene flagů, protože BoothType je nemá", () => {
  const result = evaluateCatalogReadiness(boothLike(), "booth");
  assert.equal(result.ready, true);
  assert.deepEqual(result.issues, []);
});

test("booth: PrintSurface není globálně vyžadován — P86-shaped item bez printSurfaces zůstává ready", () => {
  const result = evaluateCatalogReadiness(boothLike({ printSurfaces: undefined }), "booth");
  assert.equal(result.ready, true);
});

test("booth: chybějící výška (Txx footprint z 'WxD m' patternu nikdy neparsuje výšku) blokuje readiness stejně jako chybějící šířka/hloubka", () => {
  const missingHeight = evaluateCatalogReadiness(boothLike({ heightMm: undefined }), "booth");
  assert.ok(missingHeight.issues.includes("missing_dimensions"));
  assert.equal(missingHeight.ready, false);

  const missingFootprint = evaluateCatalogReadiness(boothLike({ widthMm: 0, depthMm: 0 }), "booth");
  assert.ok(missingFootprint.issues.includes("missing_dimensions"));
});

test("booth: T04 bez 3D modelu (real Batch #2B stub shape) není ready a proto není generatorEligible, i s validními rozměry", () => {
  const t04 = boothLike({ internalCode: "T04", modelUrl: undefined, assets: undefined, lifecycleStatus: "needs_review" });
  const readiness = evaluateCatalogReadiness(t04, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset"));
  assert.equal(isGeneratorEligible(t04, "booth"), false);
});

// Booth (typový stánek) readiness rule, confirmed/finalized by QA (Part 27): GLB is mandatory,
// SKP is explicitly NEVER required — booths were always meant to activate on GLB alone. DWG/
// DXF/PDF/other source files are pure evidence/documentation and never gate readiness either.
test("booth: SKP zdroj (sourceAssets) není nikdy vyžadován — booth s GLB a validním footprintem je ready i bez jakéhokoli sourceAssets záznamu", () => {
  const readiness = evaluateCatalogReadiness(boothLike({ sourceAssets: undefined }), "booth");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.issues, []);
});

test("booth: DWG/DXF/PDF/other zdrojové soubory nikdy neblokují aktivaci, ani samostatně, ani spolu se SKP", () => {
  const onlyDwg = evaluateCatalogReadiness(
    boothLike({ sourceAssets: [{ id: "src-2", kind: "dwg", asset: fakeSketchupSource.asset }] }),
    "booth",
  );
  assert.equal(onlyDwg.ready, true);

  const skpPlusExtras = evaluateCatalogReadiness(
    boothLike({ sourceAssets: [fakeSketchupSource, { id: "src-3", kind: "dwg", asset: fakeSketchupSource.asset }] }),
    "booth",
  );
  assert.equal(skpPlusExtras.ready, true);
});

test("booth: P86 canonical seed (skutečná data/booths.ts definice) je ready a generatorEligible bez jakéhokoli evidovaného SKP — typovky nikdy nevyžadovaly SketchUp source", () => {
  const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;
  const adapted = { ...p86, lifecycleStatus: "active" } as unknown as ComponentDefinition;
  assert.equal("sourceAssets" in adapted, false, "P86 static seed genuinely has no sourceAssets — this test must exercise the real absence, not a mocked one");
  const readiness = evaluateCatalogReadiness(adapted, "booth");
  assert.equal(readiness.ready, true, `P86 mělo být ready, issues: ${readiness.issues.join(", ")}`);
  assert.deepEqual(readiness.issues, []);
  assert.equal(isGeneratorEligible(adapted, "booth"), true);
});

// =========================================================================================
// booth: multi-variant type-booth lines (T04..T25) — one catalog_item, several variants, each
// with its OWN independent GLB. See domain/models.ts's BoothVariant (extended with
// widthMm/depthMm/heightMm/modelAsset/photoAsset) and ComponentDefinition.variants.
// =========================================================================================

const variantModelAsset = {
  id: "variant-model-1",
  storageKey: "catalog/furniture/t04/models/v1.glb",
  originalFileName: "t04-v1.glb",
  mimeType: "model/gltf-binary" as const,
  size: 900_000,
  createdAt: "2026-08-19T00:00:00.000Z",
  category: "catalog-model" as const,
};

const variantSketchupSource = {
  id: "variant-skp-1",
  kind: "sketchup" as const,
  asset: {
    id: "variant-skp-asset-1",
    storageKey: "catalog/furniture/t04/source/v1.skp",
    originalFileName: "t04-v1.skp",
    mimeType: "application/octet-stream",
    size: 400_000,
    createdAt: "2026-08-19T00:00:00.000Z",
    category: "catalog-source" as const,
  },
};

/** Both GLB and SKP — the full "complete variant" requirement (mirrors booth_component's own GLB+SKP rule, scoped per variant). */
function fourCompleteVariants(): readonly BoothVariant[] {
  return fourVariants(() => ({ modelAsset: variantModelAsset, sourceAssets: [variantSketchupSource] }));
}

function fourVariants(overrideByIndex?: (index: number) => Partial<BoothVariant>): readonly BoothVariant[] {
  return [0, 1, 2, 3].map((index) => ({ id: `t04-v${index + 1}`, name: `Varianta ${index + 1}`, ...(overrideByIndex?.(index) ?? {}) }));
}

test("booth + variants: declared variants but NONE have a GLB or SKP -> not ready, both missing_3d_asset AND missing_sketchup_source, even with valid parent footprint", () => {
  const t04 = boothLike({ internalCode: "T04", modelUrl: undefined, variants: fourVariants() });
  const readiness = evaluateCatalogReadiness(t04, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset"));
  assert.ok(readiness.issues.includes("missing_sketchup_source"));
});

test("booth + variants: 3 of 4 variants modelled (all with SKP) is STILL not ready — the parent must never look complete while one variant has no geometry", () => {
  const t04 = boothLike({
    internalCode: "T04",
    modelUrl: undefined,
    variants: fourVariants((index) => (index < 3 ? { modelAsset: variantModelAsset, sourceAssets: [variantSketchupSource] } : { sourceAssets: [variantSketchupSource] })),
  });
  const readiness = evaluateCatalogReadiness(t04, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset"));
  assert.equal(readiness.issues.includes("missing_sketchup_source"), false, "all 4 variants DO have SKP — only GLB is incomplete");
});

test("booth + variants: all 4 have GLB but only 3 of 4 have SKP -> still not ready, missing_sketchup_source (and NOT missing_3d_asset)", () => {
  const t04 = boothLike({
    internalCode: "T04",
    modelUrl: undefined,
    variants: fourVariants((index) => (index < 3 ? { modelAsset: variantModelAsset, sourceAssets: [variantSketchupSource] } : { modelAsset: variantModelAsset })),
  });
  const readiness = evaluateCatalogReadiness(t04, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_sketchup_source"));
  assert.equal(readiness.issues.includes("missing_3d_asset"), false, "all 4 variants DO have GLB — only SKP is incomplete");
});

test("booth + variants: ready once ALL declared variants have their own GLB AND their own SKP, even though the PARENT itself has no modelUrl/modelAsset/sourceAssets at all", () => {
  const t04 = boothLike({
    internalCode: "T04",
    modelUrl: undefined,
    variants: fourCompleteVariants(),
  });
  const readiness = evaluateCatalogReadiness(t04, "booth");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.issues, []);
});

test("booth + variants: parent dimensions (width/depth/height) are still required independently of variant readiness", () => {
  const t04 = boothLike({
    internalCode: "T04",
    modelUrl: undefined,
    heightMm: undefined,
    variants: fourCompleteVariants(),
  });
  const readiness = evaluateCatalogReadiness(t04, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_dimensions"));
  assert.equal(readiness.issues.includes("missing_3d_asset"), false, "all 4 variants ARE modelled — only the parent footprint is missing");
});

test("booth + empty variants array (P86-shaped, variants:[]) is unaffected by the variant rule — falls back to the parent's own has3DAsset exactly as before", () => {
  const readiness = evaluateCatalogReadiness(boothLike({ variants: [] }), "booth");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.issues, []);
});

test("booth + variants: a variant's own modelUrl-only shape doesn't exist — ONLY modelAsset.storageKey counts as a variant's GLB (mirrors the parent's own isRuntimeGlbReference rule, a .skp reference never counts)", () => {
  const t04 = boothLike({
    internalCode: "T04",
    modelUrl: undefined,
    variants: fourVariants((index) => (index === 0 ? { modelAsset: { ...variantModelAsset, storageKey: "catalog/furniture/t04/source/v1.skp" } } : {})),
  });
  const readiness = evaluateCatalogReadiness(t04, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset"));
});

// =========================================================================================
// booth_component — individual booth-construction elements (sloupek/panel/dveře/límec/rastr/
// koberec, ...) evidenced for future individual-booth assembly. Same GLB+SKP-mandatory rule as
// booth, but no footprint-dimensions requirement (many of these elements don't have a single
// meaningful width×depth×height) and no scene-capability requirement (never wired into the
// live generator picker in this phase).
// =========================================================================================

function boothComponentLike(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return baseFurniture({
    internalCode: "KOMP-SLOUPEK",
    category: "Komponenty stánku",
    unit: undefined,
    reviewedAt: undefined,
    showIn2D: undefined,
    showIn3D: undefined,
    footprint2D: undefined,
    widthMm: 0,
    depthMm: 0,
    heightMm: undefined,
    modelUrl: "/models/booth-components/sloupek.glb",
    catalogItemKind: "booth_component",
    sourceAssets: [fakeSketchupSource],
    ...overrides,
  });
}

test("booth_component: s GLB a SKP je ready i bez rozměrů (šířka/hloubka nejsou u komponent stánku vyžadovány)", () => {
  const readiness = evaluateCatalogReadiness(boothComponentLike(), "booth_component");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.issues, []);
});

test("booth_component: bez GLB modelu není ready", () => {
  const readiness = evaluateCatalogReadiness(boothComponentLike({ modelUrl: undefined, assets: undefined }), "booth_component");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset"));
});

test("booth_component: bez evidovaného SKP zdroje není ready, i s GLB modelem", () => {
  const readiness = evaluateCatalogReadiness(boothComponentLike({ sourceAssets: undefined }), "booth_component");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_sketchup_source"));
  assert.equal(isGeneratorEligible({ ...boothComponentLike({ sourceAssets: undefined }), lifecycleStatus: "active" }, "booth_component"), false);
});

test("booth_component: chybějící DWG, DXF nebo PDF nikdy neblokuje readiness — jen GLB a SKP jsou vyžadované", () => {
  const glbSkpOnly = boothComponentLike({ sourceAssets: [fakeSketchupSource] });
  assert.equal(evaluateCatalogReadiness(glbSkpOnly, "booth_component").ready, true);

  const withAllKinds = boothComponentLike({
    sourceAssets: [
      fakeSketchupSource,
      { id: "src-dwg", kind: "dwg", asset: fakeSketchupSource.asset },
      { id: "src-dxf", kind: "dxf", asset: fakeSketchupSource.asset },
      { id: "src-pdf", kind: "pdf", asset: fakeSketchupSource.asset },
    ],
  });
  assert.equal(evaluateCatalogReadiness(withAllKinds, "booth_component").ready, true);
});

test("construction: scene-deklarovaná položka (showIn3D) bez 3D assetu není ready", () => {
  const wall = baseFurniture({ internalCode: undefined, unit: undefined, showIn2D: false, showIn3D: true, modelUrl: undefined, assets: undefined, reviewedAt: "2026-08-13T00:00:00.000Z", catalogItemKind: "construction" });
  const readiness = evaluateCatalogReadiness(wall, "construction");
  assert.ok(readiness.issues.includes("missing_3d_asset"));
  assert.equal(readiness.ready, false);
});

test("construction: pricing-only položka (žádná scene capability deklarovaná, např. 'Stavba octanorm 1 m²') nikdy nevyžaduje GLB — jen review", () => {
  const pricingOnly = baseFurniture({ internalCode: "S10", unit: "m²", showIn2D: undefined, showIn3D: undefined, modelUrl: undefined, assets: undefined, footprint2D: undefined, reviewedAt: undefined, catalogItemKind: "construction" });
  const readiness = evaluateCatalogReadiness(pricingOnly, "construction");
  assert.deepEqual(readiness.issues, ["requires_review"], "nedeklarovaná scene capability nikdy nesmí vynutit missing_3d_asset");
  assert.equal(readiness.ready, false);

  const reviewed = evaluateCatalogReadiness({ ...pricingOnly, reviewedAt: "2026-08-14T00:00:00.000Z" }, "construction");
  assert.equal(reviewed.ready, true, "jednou zkontrolovaná pricing-only construction položka je ready bez GLB");
});

test("floor_finish: nevyžaduje GLB ani pevné width/depth (plocha je dána projektem) — jen unit a review", () => {
  const carpet = baseFurniture({ internalCode: "M01", unit: "m²", widthMm: 0, depthMm: 0, showIn2D: undefined, showIn3D: undefined, modelUrl: undefined, footprint2D: undefined, reviewedAt: "2026-08-14T00:00:00.000Z", catalogItemKind: "floor_finish" });
  const readiness = evaluateCatalogReadiness(carpet, "floor_finish");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.issues, []);
});

test("floor_finish: chybějící unit blokuje readiness", () => {
  const carpet = baseFurniture({ unit: undefined, widthMm: 0, depthMm: 0, showIn2D: undefined, showIn3D: undefined, modelUrl: undefined, footprint2D: undefined, reviewedAt: "2026-08-14T00:00:00.000Z", catalogItemKind: "floor_finish" });
  const readiness = evaluateCatalogReadiness(carpet, "floor_finish");
  assert.ok(readiness.issues.includes("missing_unit"));
  assert.equal(readiness.ready, false);
});

test("other: nikdy se nestane ready jen podle displayName/category (konzervativní default) — vyžaduje explicitní review", () => {
  const mystery = baseFurniture({ internalCode: undefined, unit: undefined, showIn2D: undefined, showIn3D: undefined, modelUrl: undefined, footprint2D: undefined, reviewedAt: undefined, catalogItemKind: "other" });
  const readiness = evaluateCatalogReadiness(mystery, "other");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("requires_review"));
});

test("other: pokud deklaruje scene capability, stále vyžaduje odpovídající 2D/3D reprezentaci", () => {
  const mystery = baseFurniture({ internalCode: undefined, unit: undefined, showIn2D: false, showIn3D: true, modelUrl: undefined, assets: undefined, reviewedAt: "2026-08-14T00:00:00.000Z", catalogItemKind: "other" });
  const readiness = evaluateCatalogReadiness(mystery, "other");
  assert.ok(readiness.issues.includes("missing_3d_asset"));
  assert.equal(readiness.ready, false);
});

// -----------------------------------------------------------------------------------------
// Readiness ≠ identity/price/import-status — section 2 of the hardening spec.
// -----------------------------------------------------------------------------------------

test("internalCode samo o sobě nikdy nezpůsobí readiness — furniture/booth s kódem, ale bez zbytku dat, zůstává not ready", () => {
  const furnitureWithCodeOnly = baseFurniture({ internalCode: "M99", unit: undefined, widthMm: 0, depthMm: 0, showIn2D: undefined, showIn3D: undefined, modelUrl: undefined, footprint2D: undefined, reviewedAt: undefined });
  assert.equal(evaluateCatalogReadiness(furnitureWithCodeOnly, "furniture").ready, false);

  const boothWithCodeOnly = boothLike({ modelUrl: undefined, assets: undefined, widthMm: 0, depthMm: 0, heightMm: undefined });
  assert.equal(evaluateCatalogReadiness(boothWithCodeOnly, "booth").ready, false);
});

test("base cena sama o sobě nikdy nezpůsobí readiness — položka s pricingEntries, ale bez zbytku požadovaných dat, zůstává not ready", () => {
  const pricedButIncomplete = baseFurniture({
    unit: undefined,
    widthMm: 0,
    depthMm: 0,
    showIn2D: undefined,
    showIn3D: undefined,
    modelUrl: undefined,
    footprint2D: undefined,
    reviewedAt: undefined,
    pricingEntries: [{ id: "p1", itemId: "test", currency: "CZK", salePrice: 999 }],
  });
  assert.equal(evaluateCatalogReadiness(pricedButIncomplete, "furniture").ready, false);
});

test("EXACT_SAFE import status samo o sobě nikdy nezpůsobí readiness — čerstvě importovaná needs_review položka (identita + kategorie potvrzené, nic jiného) zůstává not ready ve všech dotčených kinds", () => {
  const freshImport = baseFurniture({
    internalCode: "M99",
    category: "Nábytek",
    unit: undefined,
    widthMm: 0,
    depthMm: 0,
    showIn2D: undefined,
    showIn3D: undefined,
    modelUrl: undefined,
    footprint2D: undefined,
    reviewedAt: undefined,
    lifecycleStatus: "needs_review",
  });
  for (const kind of ["furniture", "booth", "booth_component", "construction", "floor_finish", "other"] as const) {
    const readiness = evaluateCatalogReadiness(freshImport, kind);
    assert.equal(readiness.ready, false, `kind=${kind} nesmí být ready jen z EXACT_SAFE identity/kategorie`);
    assert.equal(isGeneratorEligible(freshImport, kind), false);
  }
});
