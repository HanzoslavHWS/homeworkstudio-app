import assert from "node:assert/strict";
import test from "node:test";
import { createIndividualBooth, INDIVIDUAL_BOOTH_ID } from "../domain/individualBooth.ts";
import { createRectanglePlotPolygon, isPlacementValidOnPlot, tryMoveComponentOnPlot } from "../domain/plot.ts";
import { applyGridSnap, INDIVIDUAL_GRID_MM, roundToGridMm, tryMoveComponent } from "../geometry/placement.ts";
import { placeComponent } from "../data/components.ts";
import { adaptCatalogItemToComponentDefinition } from "../domain/generatorBoothComponents.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";
import type { BoothType } from "../domain/models.ts";

const WORKSPACE_10M = { widthMm: 10_000, depthMm: 10_000 };
const L_SHAPE_PLOT = [
  { x: 0, y: 0 },
  { x: 3000, y: 0 },
  { x: 3000, y: 1000 },
  { x: 1000, y: 1000 },
  { x: 1000, y: 2000 },
  { x: 0, y: 2000 },
];

// =========================================================================================
// createIndividualBooth — workspace canvas scaffold, real plot is a SEPARATE polygon.
// =========================================================================================

test("createIndividualBooth: widthMm/depthMm are the WORKSPACE canvas, never the real plot footprint", () => {
  const booth = createIndividualBooth(WORKSPACE_10M, createRectanglePlotPolygon(3000, 2000));
  assert.equal(booth.widthMm, 10_000);
  assert.equal(booth.depthMm, 10_000);
  assert.equal(booth.id, INDIVIDUAL_BOOTH_ID);
});

test("createIndividualBooth: size/area reflect the REAL plot polygon, not the workspace, once one is drawn", () => {
  const booth = createIndividualBooth(WORKSPACE_10M, createRectanglePlotPolygon(3000, 2000));
  assert.equal(booth.area, "6.00 m²");
});

test("createIndividualBooth: with no plot polygon yet, area is honestly '—', never fabricated", () => {
  const booth = createIndividualBooth(WORKSPACE_10M, undefined);
  assert.equal(booth.area, "—");
});

test("createIndividualBooth: no construction parts/collision obstacles/variants — a genuinely empty scaffold, not a typovka in disguise", () => {
  const booth = createIndividualBooth(WORKSPACE_10M);
  assert.deepEqual(booth.constructionParts, []);
  assert.deepEqual(booth.collisionObstacles, []);
  assert.deepEqual(booth.variants, []);
});

test("createIndividualBooth: never fabricates a height — no user-entered height exists yet in this foundation phase", () => {
  const booth = createIndividualBooth(WORKSPACE_10M);
  assert.equal(booth.heightMm, null);
  assert.equal(booth.nominalDimensions, undefined);
});

test("createIndividualBooth: configReady is true so the configurator opens directly (no variant-selection step, like a variants-less typovka booth)", () => {
  const booth = createIndividualBooth(WORKSPACE_10M);
  assert.equal(booth.configReady, true);
});

// =========================================================================================
// Polygon-aware construction placement (domain/plot.ts) — the ACTUAL functions Individual
// mode's Konstrukce step uses; the plot boundary is the real (possibly concave) polygon, never
// the workspace rectangle.
// =========================================================================================

test("isPlacementValidOnPlot: an anchor inside the real L-shaped plot is valid even though the workspace itself is a 10×10m rectangle", () => {
  assert.equal(isPlacementValidOnPlot(L_SHAPE_PLOT, 500, 1500), true);
});

test("isPlacementValidOnPlot: an anchor in the L-shape's cut-away notch (inside the bounding box, outside the real plot) is rejected — proves this is NOT a bounding-rectangle rule", () => {
  assert.equal(isPlacementValidOnPlot(L_SHAPE_PLOT, 2000, 1500), false);
});

test("tryMoveComponentOnPlot: accepts a move to a valid anchor and rejects one outside the real polygon, never sliding along X/Y like typovka's rigid-obstacle fallback", () => {
  const definition: CatalogItemAdmin = {
    id: "sloupek-uuid",
    internalCode: "BC-SLOUPEK-01",
    kind: "booth_component",
    lifecycleStatus: "active",
    displayName: "Sloupek",
    officialName: null,
    category: "Sloupky",
    unit: null,
    document: { widthMm: 200, depthMm: 200, heightMm: 2500, modelUrl: "sloupek.glb", sourceAssets: [{ id: "s1", kind: "sketchup", asset: { id: "s1a", storageKey: "sloupek.skp", originalFileName: "sloupek.skp", mimeType: "x", size: 1, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-source" } }] },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const component = placeComponent(adaptCatalogItemToComponentDefinition(definition), "sloupek-1", 500, 1500);
  assert.equal(component.definitionId, "sloupek-uuid");
  assert.equal(component.sceneLayer, "booth");

  const accepted = tryMoveComponentOnPlot(L_SHAPE_PLOT, component, 2500, 500);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.component.xMm, 2500);

  const rejected = tryMoveComponentOnPlot(L_SHAPE_PLOT, component, 2000, 1500);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "invalid-position");
  assert.equal(rejected.component, component, "rejected move returns the ORIGINAL component untouched");
});

test("tryMoveComponentOnPlot: a locked component is never moved, even to a valid anchor", () => {
  const definition: CatalogItemAdmin = {
    id: "sloupek-uuid",
    internalCode: "BC-SLOUPEK-01",
    kind: "booth_component",
    lifecycleStatus: "active",
    displayName: "Sloupek",
    officialName: null,
    category: "Sloupky",
    unit: null,
    document: { widthMm: 200, depthMm: 200, modelUrl: "x.glb", sourceAssets: [{ id: "s1", kind: "sketchup", asset: { id: "s1a", storageKey: "x.skp", originalFileName: "x.skp", mimeType: "x", size: 1, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-source" } }] },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const component = { ...placeComponent(adaptCatalogItemToComponentDefinition(definition), "sloupek-1", 500, 1500), userLocked: true };
  const result = tryMoveComponentOnPlot(L_SHAPE_PLOT, component, 2500, 500);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "locked");
});

// =========================================================================================
// applyGridSnap — a generic rectangle-bounds grid snap (kept as a reusable geometry primitive
// even though Individual's real Konstrukce placement now uses the polygon-aware functions
// above, not this — tested here against a plain rectangle fixture, not domain/individualBooth.ts).
// =========================================================================================

const RECT_BOOTH_FIXTURE = { widthMm: 1000, depthMm: 1000 } as Pick<BoothType, "widthMm" | "depthMm">;

test("roundToGridMm: rounds to the nearest 250 mm multiple", () => {
  assert.equal(roundToGridMm(3100), 3000);
  assert.equal(roundToGridMm(3200), 3250);
  assert.equal(INDIVIDUAL_GRID_MM, 250);
});

test("applyGridSnap: clamps the snapped footprint back inside a rectangular floor when rounding would push it out of bounds", () => {
  const snapped = applyGridSnap(RECT_BOOTH_FIXTURE as BoothType, { widthMm: 500, depthMm: 500 }, 950, 950, 0);
  assert.ok(snapped.x - 250 >= 0 && snapped.x + 250 <= 1000);
  assert.ok(snapped.y - 250 >= 0 && snapped.y + 250 <= 1000);
});

test("applyGridSnap then tryMoveComponent: a full move round-trip lands exactly on the grid and is accepted (rectangle path, e.g. a future non-polygon use)", () => {
  const definition: CatalogItemAdmin = {
    id: "sloupek-uuid",
    internalCode: "BC-SLOUPEK-01",
    kind: "booth_component",
    lifecycleStatus: "active",
    displayName: "Sloupek",
    officialName: null,
    category: "Sloupky",
    unit: null,
    document: { widthMm: 200, depthMm: 200, heightMm: 2500, modelUrl: "sloupek.glb", sourceAssets: [{ id: "s1", kind: "sketchup", asset: { id: "s1a", storageKey: "sloupek.skp", originalFileName: "sloupek.skp", mimeType: "x", size: 1, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-source" } }] },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const wideRect = createIndividualBooth({ widthMm: 3000, depthMm: 2000 });
  const component = placeComponent(adaptCatalogItemToComponentDefinition(definition), "sloupek-1", 1000, 1000);
  const snapped = applyGridSnap(wideRect, component, 1080, 1120, component.rotationDeg);
  const moved = tryMoveComponent(wideRect, component, snapped.x, snapped.y);
  assert.equal(moved.accepted, true);
  assert.equal(moved.component.xMm % INDIVIDUAL_GRID_MM, 0);
  assert.equal(moved.component.yMm % INDIVIDUAL_GRID_MM, 0);
});

// =========================================================================================
// Save/load: mode=individual, workspace, plot polygon, floor zones, placed components all
// round-trip through the SAME ProjectRecord document as typovka (domain/project.ts) — no
// separate persistence path, no new DB schema.
// =========================================================================================

test("ProjectRecord save/load: individualPlotPolygon + workspace round-trip through normalizeProjectRecord", () => {
  const polygon = createRectanglePlotPolygon(3500, 2500);
  const saved = createProjectRecord({
    id: "individual-proj-1",
    projectType: "individualni",
    individualPlotPolygon: polygon,
    individualWorkspaceWidthMm: 10_000,
    individualWorkspaceDepthMm: 8_000,
  });
  assert.equal(saved.projectType, "individualni");
  assert.deepEqual(saved.individualPlotPolygon, polygon);
  assert.equal(saved.individualWorkspaceWidthMm, 10_000);
  assert.equal(saved.individualWorkspaceDepthMm, 8_000);

  const reloaded = normalizeProjectRecord(saved);
  assert.deepEqual(reloaded.individualPlotPolygon, polygon);
  assert.equal(reloaded.individualWorkspaceWidthMm, 10_000);
  assert.equal(reloaded.individualWorkspaceDepthMm, 8_000);
});

test("ProjectRecord save/load: a typovy project never carries plot/workspace data (undefined, not fabricated)", () => {
  const saved = createProjectRecord({ id: "typovy-proj-1", projectType: "typovy" });
  assert.equal(saved.individualPlotPolygon, undefined);
  assert.equal(saved.individualWorkspaceWidthMm, undefined);
  assert.equal(saved.individualFloorZones, undefined);
});

test("ProjectRecord save/load: a legacy project with no individual fields at all migrates cleanly (no domýšlení)", () => {
  const migrated = normalizeProjectRecord({ id: "legacy-1", name: "Legacy" });
  assert.equal(migrated.individualPlotPolygon, undefined);
  assert.equal(migrated.individualWidthMm, undefined);
  assert.equal(migrated.individualDepthMm, undefined);
});

test("ProjectRecord save/load: placed booth-component instances keep definitionId/xMm/yMm/rotationDeg through a save/reload cycle", () => {
  const definition: CatalogItemAdmin = {
    id: "panel-uuid",
    internalCode: "BC-PANEL-01",
    kind: "booth_component",
    lifecycleStatus: "active",
    displayName: "Panel",
    officialName: null,
    category: "Panely / stěny",
    unit: null,
    document: { widthMm: 1000, depthMm: 40, heightMm: 2500, modelUrl: "panel.glb", sourceAssets: [{ id: "p1", kind: "sketchup", asset: { id: "p1a", storageKey: "panel.skp", originalFileName: "panel.skp", mimeType: "x", size: 1, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-source" } }] },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const placed = { ...placeComponent(adaptCatalogItemToComponentDefinition(definition), "panel-1", 1000, 250), rotationDeg: 90 };
  const saved = createProjectRecord({
    id: "individual-proj-2",
    projectType: "individualni",
    individualPlotPolygon: createRectanglePlotPolygon(3000, 2000),
    sceneObjects: [placed],
  });
  const reloaded = normalizeProjectRecord(saved);
  const reloadedComponent = reloaded.sceneObjects[0];
  assert.equal(reloadedComponent?.definitionId, "panel-uuid");
  assert.equal(reloadedComponent?.xMm, 1000);
  assert.equal(reloadedComponent?.yMm, 250);
  assert.equal(reloadedComponent?.rotationDeg, 90);
  assert.equal(reloadedComponent?.sceneLayer, "booth");
});
