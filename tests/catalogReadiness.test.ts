import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueInternalCode,
  DuplicateInternalCodeError,
  evaluateCatalogReadiness,
  isGeneratorEligible,
} from "../domain/catalogReadiness.ts";
import { derivePricingAvailability, resolvePricingAvailability } from "../domain/catalog.ts";
import type { ComponentDefinition } from "../domain/models.ts";
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
