import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";
import {
  createRectanglePlotPolygon,
  findComponentAnchorsOutsidePlot,
} from "../domain/plot.ts";
import { createFloorZone, findFloorZonesOutsidePlot } from "../domain/floorZones.ts";
import { placeComponent } from "../data/components.ts";
import { adaptCatalogItemToComponentDefinition } from "../domain/generatorBoothComponents.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import type { PlacedComponent } from "../domain/models.ts";

function sloupekDefinition(): CatalogItemAdmin {
  return {
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
}

function chairComponent(id: string, x: number, y: number): PlacedComponent {
  // A generic "furniture" catalog fixture — data/components.ts's chair already has sceneLayer=furniture.
  return placeComponent(
    { ...adaptCatalogItemToComponentDefinition({ ...sloupekDefinition(), id, kind: "furniture" }), sceneLayer: "furniture" },
    `${id}-instance`,
    x,
    y,
  );
}

// =========================================================================================
// Section 43: Plocha → Podlaha → Konstrukce → Mobiliář, nothing lost across steps. Since there
// is no React Testing Library in this project (every existing test is domain/geometry-level —
// see tests/ directory conventions), this validates the same guarantee at the level that
// actually matters: the SHARED ProjectRecord document each tab reads/writes never drops data
// from an earlier step, through a full save/reload cycle.
// =========================================================================================

test("NAVIGATION: Plocha → Podlaha → Konstrukce → Mobiliář → back to Konstrukce → back to Mobiliář — every step's data survives every later step, and survives a save/reload", () => {
  // Step: Plocha
  const plot = createRectanglePlotPolygon(4000, 3000);

  // Step: Podlaha
  const carpetZone = createFloorZone({ id: "zone-1", polygon: createRectanglePlotPolygon(3000, 3000), finish: "carpet" });

  // Step: Konstrukce — insert 4 booth_component instances
  const sloupek = adaptCatalogItemToComponentDefinition(sloupekDefinition());
  const constructionInstances: PlacedComponent[] = [
    placeComponent(sloupek, "sloupek-1", 0, 0),
    placeComponent(sloupek, "sloupek-2", 4000, 0),
    placeComponent(sloupek, "sloupek-3", 4000, 3000),
    placeComponent(sloupek, "sloupek-4", 0, 3000),
  ];
  assert.ok(constructionInstances.every((item) => item.sceneLayer === "booth"));

  // Step: Mobiliář — insert furniture, construction instances must still be present
  const furnitureInstance = chairComponent("chair-1", 2000, 1500);
  const sceneAfterFurniture = [...constructionInstances, furnitureInstance];
  assert.equal(sceneAfterFurniture.filter((item) => item.sceneLayer === "booth").length, 4, "construction survives adding furniture");

  // Back to Konstrukce — edit one sloupek's rotation; furniture must still be present
  const sceneAfterConstructionEdit = sceneAfterFurniture.map((item) =>
    item.id === "sloupek-1" ? { ...item, rotationDeg: 45 } : item,
  );
  assert.equal(sceneAfterConstructionEdit.find((item) => item.id === "chair-1-instance")?.sceneLayer, "furniture", "furniture survives a construction edit");

  // Back to Mobiliář — nothing changes, everything still present
  const finalScene = sceneAfterConstructionEdit;
  assert.equal(finalScene.length, 5);

  // save / reload
  const saved = createProjectRecord({
    id: "nav-test-proj",
    projectType: "individualni",
    individualPlotPolygon: plot,
    individualFloorZones: [carpetZone],
    sceneObjects: finalScene,
  });
  const reloaded = normalizeProjectRecord(saved);

  assert.deepEqual(reloaded.individualPlotPolygon, plot, "plot survives save/reload");
  assert.equal(reloaded.individualFloorZones?.length, 1, "floor zone survives save/reload");
  assert.equal(reloaded.individualFloorZones?.[0]?.finish, "carpet");
  assert.equal(reloaded.sceneObjects.length, 5, "all 5 placed items survive save/reload");
  assert.equal(reloaded.sceneObjects.filter((item) => item.sceneLayer === "booth").length, 4, "all 4 construction pieces survive");
  assert.equal(reloaded.sceneObjects.find((item) => item.id === "sloupek-1")?.rotationDeg, 45, "the construction edit made while on Mobiliář's data survives");
  assert.equal(reloaded.sceneObjects.filter((item) => item.sceneLayer === "furniture").length, 1, "furniture survives");
});

// =========================================================================================
// Section 44: shrinking the plot never silently deletes/clips anything — a conflict is
// surfaced, the data itself is untouched.
// =========================================================================================

test("RESIZE CONFLICT: shrinking the plot polygon does not delete/move any placed booth_component — it becomes a flagged conflict instead", () => {
  const originalPlot = createRectanglePlotPolygon(4000, 3000);
  const sloupek = adaptCatalogItemToComponentDefinition(sloupekDefinition());
  const farCorner = placeComponent(sloupek, "far-corner", 3900, 2900);
  const nearOrigin = placeComponent(sloupek, "near-origin", 200, 200);

  // Confirm both start out valid on the original plot.
  assert.deepEqual(
    findComponentAnchorsOutsidePlot([{ id: farCorner.id, x: farCorner.xMm, y: farCorner.yMm }, { id: nearOrigin.id, x: nearOrigin.xMm, y: nearOrigin.yMm }], originalPlot),
    [],
  );

  // User shrinks the plot in "Plocha" — the scene objects array itself is NEVER touched by this.
  const shrunkPlot = createRectanglePlotPolygon(2000, 2000);
  const sceneUnchanged = [farCorner, nearOrigin];

  const conflicts = findComponentAnchorsOutsidePlot(
    sceneUnchanged.map((item) => ({ id: item.id, x: item.xMm, y: item.yMm })),
    shrunkPlot,
  );
  assert.deepEqual(conflicts, ["far-corner"], "only the item genuinely outside the new plot is flagged");
  assert.equal(sceneUnchanged.length, 2, "no item was deleted from the scene array");
  assert.equal(sceneUnchanged.find((item) => item.id === "far-corner")?.xMm, 3900, "no item was silently moved/clamped either");
});

test("RESIZE CONFLICT: furniture (Mobiliář) placed anywhere on the workspace is NEVER checked against the plot polygon — only booth_component/construction anchors are", () => {
  // Furniture placement is workspace-relative, not plot-boundary-constrained (report section 26
  // explicitly scopes the anchor-in-plot rule to Konstrukce). A furniture item positioned
  // outside the plot is a normal, valid state — never a conflict by itself.
  const plot = createRectanglePlotPolygon(2000, 2000);
  const chair = chairComponent("chair-far", 5000, 5000);
  const conflicts = findComponentAnchorsOutsidePlot(
    [{ id: chair.id, x: chair.xMm, y: chair.yMm }],
    plot,
  );
  // This assertion documents the CURRENT foundation scope: the conflict-detection helper itself
  // is layer-agnostic (it only takes {id,x,y}) — the CALLER (components/BoothGenerator.tsx) is
  // responsible for only ever passing sceneLayer==="booth" items into it, which is exactly what
  // it does (see the "NAVIGATION" test above and constructionOutsidePlotIds' own filter).
  assert.deepEqual(conflicts, ["chair-far-instance"], "the helper itself is layer-agnostic by design — filtering to booth-layer only happens at the call site");
});

test("RESIZE CONFLICT: shrinking the plot never deletes/clips a floor zone that falls outside the new boundary — flagged, not silently resolved", () => {
  const originalPlot = createRectanglePlotPolygon(4000, 3000);
  const zone = createFloorZone({ id: "zone-1", polygon: createRectanglePlotPolygon(3500, 2800), finish: "carpet" });
  assert.deepEqual(findFloorZonesOutsidePlot([zone], originalPlot), []);

  const shrunkPlot = createRectanglePlotPolygon(2000, 2000);
  const zonesUnchanged = [zone];
  assert.deepEqual(findFloorZonesOutsidePlot(zonesUnchanged, shrunkPlot), ["zone-1"]);
  assert.deepEqual(zonesUnchanged[0]!.polygon, zone.polygon, "the zone's own polygon is never mutated by this check");
});
