import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    priceLists: [],
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

// =========================================================================================
// LAYER ORDER ARROWS (2026-08-19 follow-up session — REAL runtime root cause): the CSS clip fix
// from the previous pass was necessary but NOT sufficient. The buttons became visible/clickable,
// but moveComponentDisplayOrder's old "forward"/"backward" logic did a blind current+1/-1
// increment — which can land EXACTLY on an existing neighbor's value (e.g. back/middle/front at
// 0/1/2: "forward" on back gives 0+1=1, TYING with middle instead of overtaking it), leaving
// sortComponentsFor2D's stable-sort tie-break to silently preserve the OLD visual order. Clicking
// then visibly did nothing, exactly matching the reported symptom. The fix: forward/backward now
// SWAP the target with its immediate neighbor in the effective current order (never a blind
// increment), and every move renormalizes the whole layer to compact sequential values — which
// also resolves the "many/all items still share the legacy displayOrder2D=0" case, since ties
// are broken by original array position (same rule sortComponentsFor2D already uses), giving even
// an all-zero layer a well-defined first neighbor to swap with.
// =========================================================================================

test("LAYER: the exact QA scenario — A=back/B=middle/C=front, clicking ↑ on A swaps it forward one step at a time, never a blind numeric increment that ties with the neighbor", () => {
  const a = { ...placeComponent(componentCatalog.chair, "layer-item-a", 300, 300), displayOrder2D: 0 };
  const b = { ...placeComponent(componentCatalog.chair, "layer-item-b", 300, 300), displayOrder2D: 1 };
  const c = { ...placeComponent(componentCatalog.chair, "layer-item-c", 300, 300), displayOrder2D: 2 };
  assert.deepEqual(sortComponentsFor2D([a, b, c]).map((item) => item.id), [a.id, b.id, c.id], "back to front: A, B, C");

  const afterFirstUp = moveComponentDisplayOrder([a, b, c], a.id, "forward");
  assert.deepEqual(sortComponentsFor2D(afterFirstUp).map((item) => item.id), [b.id, a.id, c.id], "A swapped with B — B is now back, A middle, C stays front");

  const afterSecondUp = moveComponentDisplayOrder(afterFirstUp, a.id, "forward");
  assert.deepEqual(sortComponentsFor2D(afterSecondUp).map((item) => item.id), [b.id, c.id, a.id], "A swapped with C — B back, C middle, A now front");

  const afterThirdUp = moveComponentDisplayOrder(afterSecondUp, a.id, "forward");
  assert.deepEqual(sortComponentsFor2D(afterThirdUp).map((item) => item.id), [b.id, c.id, a.id], "A is already front — one more click is a safe no-op, order unchanged");
});

test("LAYER: the same scenario in reverse — ↓ swaps backward one step at a time, safe no-op once already at the back", () => {
  const a = { ...placeComponent(componentCatalog.chair, "layer-item-a", 300, 300), displayOrder2D: 0 };
  const b = { ...placeComponent(componentCatalog.chair, "layer-item-b", 300, 300), displayOrder2D: 1 };
  const c = { ...placeComponent(componentCatalog.chair, "layer-item-c", 300, 300), displayOrder2D: 2 };

  const afterFirstDown = moveComponentDisplayOrder([a, b, c], c.id, "backward");
  assert.deepEqual(sortComponentsFor2D(afterFirstDown).map((item) => item.id), [a.id, c.id, b.id], "C swapped with B");

  const afterSecondDown = moveComponentDisplayOrder(afterFirstDown, c.id, "backward");
  assert.deepEqual(sortComponentsFor2D(afterSecondDown).map((item) => item.id), [c.id, a.id, b.id], "C swapped with A — now at the back");

  const afterThirdDown = moveComponentDisplayOrder(afterSecondDown, c.id, "backward");
  assert.deepEqual(sortComponentsFor2D(afterThirdDown).map((item) => item.id), [c.id, a.id, b.id], "C is already at the back — safe no-op");
});

test("LAYER: the exact QA scenario from section 4 — three components ALL starting at the legacy displayOrder2D=0 (never yet reordered) — the FIRST click must still produce a real, deterministic visual change, not a no-op from tied values", () => {
  const a = placeComponent(componentCatalog.chair, "layer-item-a", 100, 100); // displayOrder2D defaults to 0
  const b = placeComponent(componentCatalog.chair, "layer-item-b", 200, 200); // displayOrder2D defaults to 0
  const c = placeComponent(componentCatalog.chair, "layer-item-c", 300, 300); // displayOrder2D defaults to 0
  assert.equal(a.displayOrder2D, 0);
  assert.equal(b.displayOrder2D, 0);
  assert.equal(c.displayOrder2D, 0);
  assert.deepEqual(sortComponentsFor2D([a, b, c]).map((item) => item.id), [a.id, b.id, c.id], "all tied at 0 -> original array order is the well-defined 'current visual order'");

  const moved = moveComponentDisplayOrder([a, b, c], a.id, "forward");
  assert.deepEqual(sortComponentsFor2D(moved).map((item) => item.id), [b.id, a.id, c.id], "A must swap forward past B, a REAL visible change — never a no-op just because all three started tied");
});

test("LAYER: renormalization only ever touches items in the SAME sceneLayer as the moved item — a technical point sharing xy with furniture never has its displayOrder2D changed by a furniture move", () => {
  const furniture = placeComponent(componentCatalog.chair, "layer-item-furniture", 500, 700);
  const electrical = { ...placeComponent(componentCatalog.electrical, "layer-item-electrical", 500, 700), displayOrder2D: 3 };
  const moved = moveComponentDisplayOrder([furniture, electrical], furniture.id, "front");
  assert.equal(moved.find((item) => item.id === electrical.id)!.displayOrder2D, 3, "different layer, completely untouched");
});

test("LAYER: 'front'/'back' (send to absolute front/back) move the target past every other item in the SAME layer, then renormalize — the resulting order is exactly what sortComponentsFor2D would already show", () => {
  const a = { ...placeComponent(componentCatalog.chair, "layer-item-a", 300, 300), displayOrder2D: -3 };
  const b = { ...placeComponent(componentCatalog.chair, "layer-item-b", 300, 300), displayOrder2D: 2 };
  const c = { ...placeComponent(componentCatalog.chair, "layer-item-c", 300, 300), displayOrder2D: 0 };
  // Effective current order (ascending displayOrder2D): a(-3), c(0), b(2) -> back to front.

  const toFront = moveComponentDisplayOrder([a, b, c], a.id, "front");
  assert.deepEqual(sortComponentsFor2D(toFront).map((item) => item.id), [c.id, b.id, a.id], "A jumps past c and b to the absolute front");

  const toBack = moveComponentDisplayOrder([a, b, c], b.id, "back");
  assert.deepEqual(sortComponentsFor2D(toBack).map((item) => item.id), [b.id, a.id, c.id], "B jumps past a and c to the absolute back");
});

test("LAYER: moving a nonexistent componentId is a safe no-op — returns the array unchanged, never throws", () => {
  const a = placeComponent(componentCatalog.chair, "layer-item-a", 300, 300);
  const result = moveComponentDisplayOrder([a], "does-not-exist", "forward");
  assert.deepEqual(result, [a]);
});

test("LAYER: reordering never touches xMm/yMm/rotationDeg/widthMm/depthMm on ANY component, not just the moved one", () => {
  const a = placeComponent(componentCatalog.chair, "layer-item-a", 111, 222);
  const b = placeComponent(componentCatalog.chair, "layer-item-b", 333, 444);
  const before = [a, b].map(({ id, xMm, yMm, rotationDeg, widthMm, depthMm }) => ({ id, xMm, yMm, rotationDeg, widthMm, depthMm }));
  const moved = moveComponentDisplayOrder([a, b], a.id, "front");
  const after = moved.map(({ id, xMm, yMm, rotationDeg, widthMm, depthMm }) => ({ id, xMm, yMm, rotationDeg, widthMm, depthMm }));
  assert.deepEqual(after, before);
});

test("LAYER: displayOrder2D is a pure 2D-render-order concern — cad3d.ts's viewer transform (placedComponentToViewerTransform) has no notion of it, so reordering can never affect the 3D scene", () => {
  const source = readFileSync(new URL("../domain/cad3d.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /displayOrder2D/u, "the 3D transform layer must never read this 2D-only field");
});

test("LAYER: BoothCadViewer.tsx's furniture placement loop never reads displayOrder2D either — 3D instancing/positioning is completely independent of 2D layer order", () => {
  const source = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /displayOrder2D/u);
});

test("LAYER: save/reload (normalizeProjectRecord) preserves displayOrder2D exactly as set — layer order is NOT transient React state, it round-trips through the same project document as xMm/yMm", () => {
  const a = { ...placeComponent(componentCatalog.chair, "layer-item-a", 300, 300), displayOrder2D: 7 };
  const b = { ...placeComponent(componentCatalog.chair, "layer-item-b", 300, 300) }; // never explicitly moved
  const normalized = normalizeProjectRecord({ id: "proj-layer-order", sceneObjects: [a, b] } as never);
  assert.equal(normalized.sceneObjects.find((item) => item.id === a.id)?.displayOrder2D, 7);
  assert.equal(normalized.sceneObjects.find((item) => item.id === b.id)?.displayOrder2D, 0, "legacy/never-set records default to 0, never undefined, so a later sort is always well-defined");
});

test("LAYER: BoothGenerator.tsx's saveProject persists placedComponents (displayOrder2D included) directly as sceneObjects — no separate/filtered serialization path that could silently drop it", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(source, /sceneObjects:\s*placedComponents/u);
});

test("LAYER: ScenePanel wires the up/down buttons to the real onMoveComponentDisplayOrder domain call for EVERY furniture item — not a dead/no-op handler", () => {
  const source = readFileSync(new URL("../components/configurator/ScenePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /onMoveBackward=\{\(\) => props\.onMoveComponentDisplayOrder\(component\.id, "backward"\)\}/u);
  assert.match(source, /onMoveForward=\{\(\) => props\.onMoveComponentDisplayOrder\(component\.id, "forward"\)\}/u);
});

test("LAYER: BoothGenerator.tsx wires ScenePanel's onMoveComponentDisplayOrder to the real domain moveComponentDisplayOrder + setPlacedComponents — not a stub", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(source, /onMoveComponentDisplayOrder=\{\(componentId, direction\) => setPlacedComponents\(\(items\) => \[\.\.\.moveComponentDisplayOrder\(items, componentId, direction\)\]\)\}/u);
});

test("LAYER: SceneItem never disables the move-up/move-down buttons based on selection — moving a component never deselects it (selection is orthogonal to display order)", () => {
  const source = readFileSync(new URL("../components/configurator/ScenePanel.tsx", import.meta.url), "utf8");
  const buttonBlock = source.slice(source.indexOf('sceneOrderButton" onClick={props.onMoveBackward}'), source.indexOf('sceneOrderButton" onClick={props.onMoveForward}') + 80);
  assert.doesNotMatch(buttonBlock, /disabled=/u);
});

test("LAYER CSS regression guard: .sceneActions provides 4 button slots (120px / 4x30px), matching .sceneItem's widened 3rd column — the old 2-slot (60px) grid silently clipped the move-up/move-down buttons via .sceneItem's overflow:hidden, which is exactly why clicking them appeared to do nothing", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const actionsRule = css.match(/\.sceneActions\s*\{[^}]*\}/u);
  assert.ok(actionsRule);
  assert.match(actionsRule![0], /width:\s*120px/u);
  assert.match(actionsRule![0], /repeat\(4,\s*30px\)/u);

  const itemRule = css.match(/\.sceneItem\s*\{[^}]*\}/u);
  assert.ok(itemRule);
  assert.match(itemRule![0], /120px/u, ".sceneItem's 3rd grid column must be widened to match, or the 4-button .sceneActions grid gets clipped again");
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
