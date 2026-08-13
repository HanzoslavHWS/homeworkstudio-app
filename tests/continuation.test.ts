import assert from "node:assert/strict";
import test from "node:test";
import { boothTypes } from "../data/booths.ts";
import { componentCatalog, componentCatalogItems, placeComponent } from "../data/components.ts";
import {
  calculationImageLayout,
  createCustomerCalculationViewModel,
  selectCalculationOutputs,
} from "../domain/calculationExport.ts";
import {
  moveComponentDisplayOrder,
  scenePlanBounds,
  sortComponentsFor2D,
} from "../domain/displayOrder.ts";
import {
  createDefaultExportCalculationOptions,
  createDefaultTechnicalRequirements,
  normalizeProjectRecord,
  CURRENT_PROJECT_SCHEMA_VERSION,
  type PrintSurfaceAssignment,
} from "../domain/project.ts";
import {
  createMeasurement3D,
  moveMeasurement3DLabel,
  nominalDimensionAnchors,
} from "../domain/spatialAnnotations.ts";
import {
  createPrintSurfaceExportRows,
  effectiveFasciaRequirement,
  priceCleaning,
  priceContainer,
  priceGraphics,
  TECHNICAL_SERVICE_IDS,
} from "../domain/technicalServices.ts";
import { fitBoundsToViewport } from "../geometry/viewport.ts";

const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;

test("zákaznická kalkulace nepropustí purchase price ani interní poznámky", () => {
  const chair = {
    ...placeComponent(componentCatalog.chair, "chair-customer-safe", 1000, 1000),
    internalNote: "tajná výrobní poznámka 987654",
    customerNote: "Umístit ke stolu",
  };
  const options = {
    ...createDefaultExportCalculationOptions(),
    includeProjectNote: true,
    includeItemNotes: true,
  };
  const result = createCustomerCalculationViewModel({
    company: "Customer s.r.o.",
    customerProjectNote: "Poznámka pro zákazníka",
    currency: "CZK",
    booth: p86,
    sceneObjects: [chair],
    requirements: createDefaultTechnicalRequirements(),
    printSurfaceAssignments: [],
    generatedPlanOutputs: [],
    visualizations: [],
    options,
    catalogItems: componentCatalogItems,
    processedAt: "2026-08-12T10:00:00.000Z",
  });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("purchasePrice"), false);
  assert.equal(serialized.includes("987654"), false);
  assert.equal(serialized.includes("170"), false);
  assert.equal(result.project.customerNote, "Poznámka pro zákazníka");
  assert.deepEqual(result.priceRows.find((row) => row.id === componentCatalog.chair.id)?.customerNotes, ["Umístit ke stolu"]);
});

test("výběr náhledů zahodí smazaná ID, preferuje schválené a drží maximum čtyř", () => {
  const outputs = Array.from({ length: 5 }, (_, index) => ({
    id: `output-${index}`,
    name: `Výstup ${index}`,
    type: "plan2d" as const,
    layers: ["booth"] as const,
    imageDataUrl: "data:image/png;base64,AA==",
    createdAt: `2026-08-12T10:0${index}:00.000Z`,
    reviewStatus: index === 3 ? "reviewed" as const : "unreviewed" as const,
  }));

  assert.equal(selectCalculationOutputs(outputs, ["deleted", "output-2"])[0]?.id, "output-2");
  const automatic = selectCalculationOutputs(outputs, ["deleted"]);
  assert.equal(automatic.length, 4);
  assert.equal(automatic[0]?.id, "output-3");
  assert.deepEqual([1, 2, 3, 4].map(calculationImageLayout), ["one", "two", "three", "four"]);
});

test("úklid používá nominální plochu a sazbu z aktivního ceníku bez hardcodu", () => {
  const requirements = {
    ...createDefaultTechnicalRequirements(),
    cleaning: { status: "daily" as const, note: "", dayCount: 2 },
  };
  const cleaningDefinition = {
    ...componentCatalogItems.find((item) => item.id === TECHNICAL_SERVICE_IDS.cleaningDaily)!,
    pricingEntries: [{ id: "cleaning-test-rate", itemId: TECHNICAL_SERVICE_IDS.cleaningDaily, currency: "CZK" as const, salePrice: 100 }],
  };
  const priced = priceCleaning(requirements, p86, [cleaningDefinition], { currency: "CZK" });
  const missingMultiplier = priceCleaning(
    { ...requirements, cleaning: { status: "daily", note: "" } },
    p86,
    [cleaningDefinition],
    { currency: "CZK" },
  );

  assert.equal(priced?.quantity, 8);
  assert.equal(priced?.totalNet, 800);
  assert.equal(missingMultiplier?.status, "needs-quote");
  assert.match(missingMultiplier?.warning ?? "", /počet dnů/i);
});

test("kontejner je bez individuální ceny warning a s cenou samostatná položka", () => {
  const requirements = {
    ...createDefaultTechnicalRequirements(),
    container: { status: "wanted" as const, volumeSize: "10 m³", note: "" },
  };
  assert.equal(priceContainer(requirements, "CZK")?.status, "needs-quote");
  const priced = priceContainer(
    { ...requirements, container: { ...requirements.container, individualPriceNet: 2500 } },
    "CZK",
  );
  assert.equal(priced?.totalNet, 2500);
  assert.match(priced?.name ?? "", /10 m³/);
});

test("P86 ponechá původní volbu límce, ale efektivně jej účtuje jako zahrnutý", () => {
  const requested = { status: "notWanted" as const, note: "Původní záměr" };
  const effective = effectiveFasciaRequirement(requested, p86);
  const graphics = priceGraphics(
    { ...createDefaultTechnicalRequirements(), fasciaGraphics: requested },
    p86,
    [],
    componentCatalogItems,
    { currency: "CZK" },
  );

  assert.equal(requested.status, "notWanted");
  assert.equal(effective.requested, "notWanted");
  assert.equal(effective.effective, "included");
  assert.equal(graphics[0]?.includedInPackage, true);
  assert.equal(graphics[0]?.totalNet, 0);
});

test("celopolep je nezávislý na límci a účtuje vybrané plochy v m²", () => {
  const assignment: PrintSurfaceAssignment = {
    printSurfaceId: "wrap",
    sceneReference: "booth",
    graphicsKind: "fullWrap",
    artworkStatus: "received",
    selectedForPrint: true,
    canonicalWidthMm: 2000,
    canonicalHeightMm: 3000,
    productionWidthMm: 2010,
    productionHeightMm: 3010,
    includedInPackage: false,
    pricedSeparately: true,
  };
  const definition = {
    ...componentCatalogItems.find((item) => item.id === TECHNICAL_SERVICE_IDS.fullWrapGraphics)!,
    pricingEntries: [{ id: "wrap-test-rate", itemId: TECHNICAL_SERVICE_IDS.fullWrapGraphics, currency: "CZK" as const, salePrice: 50 }],
  };
  const results = priceGraphics(
    { ...createDefaultTechnicalRequirements(), fullWrapGraphics: { status: "ordered", note: "" } },
    undefined,
    [assignment],
    [definition],
    { currency: "CZK" },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.unit, "m²");
  assert.equal(results[0]?.quantity, 6);
  assert.equal(results[0]?.totalNet, 300);
});

test("2D vrstva drží technické body nad nábytkem a ruční pořadí nemění geometrii", () => {
  const furniture = placeComponent(componentCatalog.chair, "furniture", 500, 700);
  const electrical = placeComponent(componentCatalog.electrical, "electrical", 500, 700);
  const geometryBefore = [furniture, electrical].map(({ xMm, yMm, widthMm, depthMm, rotationDeg }) => ({ xMm, yMm, widthMm, depthMm, rotationDeg }));
  const moved = moveComponentDisplayOrder([furniture, electrical], furniture.id, "front");
  const ordered = sortComponentsFor2D(moved);

  assert.equal(ordered.at(-1)?.sceneLayer, "electrical");
  assert.deepEqual(moved.map(({ xMm, yMm, widthMm, depthMm, rotationDeg }) => ({ xMm, yMm, widthMm, depthMm, rotationDeg })), geometryBefore);
  const bounds = scenePlanBounds(2000, 2000, [{ ...furniture, xMm: 2600 }]);
  assert.equal(bounds.maxX, 2600 + furniture.widthMm / 2);
  const fitted = fitBoundsToViewport({ width: 1000, height: 700 }, bounds);
  assert.ok(fitted.zoom > 0);
});

test("3D měření a posun popisku zachovají uzamčené body i hodnotu", () => {
  const measurement = createMeasurement3D("m", [0, 0, 0], [300, 400, 1200]);
  const moved = moveMeasurement3DLabel(measurement, [50, 0, 25]);
  assert.equal(measurement.measuredValueMm, 1300);
  assert.deepEqual(moved.pointA, measurement.pointA);
  assert.deepEqual(moved.pointB, measurement.pointB);
  assert.equal(moved.measuredValueMm, measurement.measuredValueMm);
  assert.deepEqual(nominalDimensionAnchors({ widthMm: 2000, depthMm: 2000, heightMm: 2500 }, "height"), {
    pointA: [0, 0, 0], pointB: [0, 0, 2500], measuredValueMm: 2500,
  });
});

test("tisková plocha exportuje canonical i produkční rozměr a bezpečný stav dat", () => {
  const surface = {
    id: "surface",
    name: "Stěna A",
    widthMm: 2000,
    heightMm: 2500,
    orientation: "portrait" as const,
    pricingUnit: "m²" as const,
    active: true,
  };
  const assignment: PrintSurfaceAssignment = {
    printSurfaceId: surface.id,
    sceneReference: "booth",
    graphicsKind: "fullWrap",
    artworkStatus: "missing",
    selectedForPrint: true,
    canonicalWidthMm: 2000,
    canonicalHeightMm: 2500,
    productionWidthMm: 2020,
    productionHeightMm: 2520,
    includedInPackage: false,
    pricedSeparately: true,
  };
  const rows = createPrintSurfaceExportRows([surface], [assignment]);
  assert.equal(rows[0]?.canonicalDimensions, "2000 × 2500 mm");
  assert.equal(rows[0]?.productionDimensions, "2020 × 2520 mm");
  assert.equal(rows[0]?.artworkStatus, "missing");
  assert.equal(rows[0]?.pricingBasis, "m²");
});

test("migrace starého projektu doplní aktuální schema bez domýšlení obchodních hodnot", () => {
  const migrated = normalizeProjectRecord({ id: "legacy", name: "Legacy" });
  assert.equal(migrated.schemaVersion, CURRENT_PROJECT_SCHEMA_VERSION);
  assert.deepEqual(migrated.measurements3D, []);
  assert.deepEqual(migrated.dimensionOffsets3D, { width: 0, depth: 0, height: 0 });
  assert.deepEqual(migrated.printSurfaceAssignments, []);
  assert.deepEqual(migrated.exportCalculationOptions, createDefaultExportCalculationOptions());
  assert.equal(migrated.technicalRequirements.cleaning.status, "unspecified");
  assert.equal(migrated.technicalRequirements.container.individualPriceNet, undefined);
});
