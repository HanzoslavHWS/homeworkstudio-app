import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isTechnicalPointLayer, PLAN_LAYER_PRIORITY } from "../domain/displayOrder.ts";
import { sceneObjectsForLayers } from "../domain/workflow.ts";
import { adaptCatalogItemToComponentDefinition } from "../domain/generatorBoothComponents.ts";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";
import { placeComponent, componentCatalog } from "../data/components.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import type { PlacedComponent } from "../domain/models.ts";

const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
const scenePanelSource = readFileSync(new URL("../components/configurator/ScenePanel.tsx", import.meta.url), "utf8");
const planExportSource = readFileSync(new URL("../lib/planExport.ts", import.meta.url), "utf8");

function sloupekAdmin(documentOverrides: Record<string, unknown> = {}): CatalogItemAdmin {
  return {
    id: "sloupek-uuid",
    internalCode: "BC-SLOUPEK-01",
    kind: "booth_component",
    lifecycleStatus: "active",
    displayName: "Sloupek 2500 mm",
    officialName: null,
    category: "Sloupky",
    unit: null,
    document: {
      widthMm: 40,
      depthMm: 40,
      heightMm: 2500,
      modelUrl: "sloupek.glb",
      sourceAssets: [{ id: "s1", kind: "sketchup", asset: { id: "s1a", storageKey: "sloupek.skp", originalFileName: "sloupek.skp", mimeType: "x", size: 1, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-source" } }],
      ...documentOverrides,
    },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

// =========================================================================================
// 1/2. New booth_component uses the "booth" construction scene layer, never furniture.
// =========================================================================================

test("new booth_component uses the booth (construction) scene layer by default", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekAdmin());
  assert.equal(adapted.sceneLayer, "booth");
});

test("booth_component never defaults to furniture", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekAdmin());
  assert.notEqual(adapted.sceneLayer, "furniture");
});

test("an explicit sceneLayer on the catalog document is never overridden by the booth_component default", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekAdmin({ sceneLayer: "furniture" }));
  assert.equal(adapted.sceneLayer, "furniture", "an explicit document value always wins over the kind-based default");
});

// =========================================================================================
// 3. Furniture still uses the furniture layer — typovka's real catalog fixture, untouched.
// =========================================================================================

test("furniture (M57 chair) still uses the furniture scene layer", () => {
  const chair = placeComponent(componentCatalog.chair, "chair-1", 1000, 1000);
  assert.equal(chair.sceneLayer, "furniture");
});

// =========================================================================================
// 4. Save/load: sceneLayer round-trips through ProjectRecord exactly as stored.
// =========================================================================================

test("construction layer save/load: sceneLayer=\"booth\" round-trips through createProjectRecord/normalizeProjectRecord", () => {
  const definition = adaptCatalogItemToComponentDefinition(sloupekAdmin());
  const placed = placeComponent(definition, "sloupek-1", 1000, 1000);
  assert.equal(placed.sceneLayer, "booth");

  const saved = createProjectRecord({ id: "proj-1", projectType: "individualni", sceneObjects: [placed] });
  const reloaded = normalizeProjectRecord(saved);
  assert.equal(reloaded.sceneObjects[0]?.sceneLayer, "booth");
});

// =========================================================================================
// 5. Construction layer is visible in 2D exports/visualization layer toggles.
// =========================================================================================

test("construction layer visible in 2D: sceneObjectsForLayers includes a booth-layer item when \"booth\" is toggled on", () => {
  const definition = adaptCatalogItemToComponentDefinition(sloupekAdmin());
  const placed = { ...placeComponent(definition, "sloupek-1", 1000, 1000), showIn2D: true };
  assert.deepEqual(sceneObjectsForLayers([placed], ["booth"]), [placed]);
  assert.deepEqual(sceneObjectsForLayers([placed], ["furniture"]), [], "must not leak into the furniture export layer");
});

test("visualization2DLayers default already includes \"booth\" — a new project shows construction pieces in its 2D export by default with no extra wiring", () => {
  const project = createProjectRecord({ id: "proj-2" });
  assert.ok(project.visualization2DLayers.includes("booth"));
});

// =========================================================================================
// 6. Construction layer is available in 3D — the 3D viewer's component loader never gates on
// sceneLayer at all (only visible/showIn3D/a resolved model), so this was never at risk, but
// pin the source shape so a future refactor can't silently add a furniture-only gate.
// =========================================================================================

test("REGRESSION: BoothCadViewer.tsx's 3D component loader filters only on visible/showIn3D/model — never on sceneLayer", () => {
  const boothCadViewerSource = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
  const match = boothCadViewerSource.match(/const componentModels = components\.flatMap\([\s\S]{0,300}?\}\);/u);
  assert.ok(match, "expected to find the componentModels flatMap filter");
  assert.doesNotMatch(match![0], /sceneLayer/u);
  // Turn 5 (report section 28/36): the filter variable is now `source` (resolveComponentModelReference's
  // result — legacy models3d[], OR a real modelAsset/modelUrl), not `model` — same visible/showIn3D
  // gate, still never sceneLayer-based.
  assert.match(match![0], /component\.visible && component\.showIn3D && source/u);
});

// =========================================================================================
// 7. Old project layers still normalize — NO blind migration of legacy furniture-tagged
// booth_component instances. Whatever was saved is exactly what comes back.
// =========================================================================================

test("BACKWARD COMPAT: a legacy individual project with a booth_component instance saved as sceneLayer=\"furniture\" (pre-fix) is loaded verbatim, never silently rewritten to \"booth\"", () => {
  const legacyPlaced: PlacedComponent = { ...placeComponent(adaptCatalogItemToComponentDefinition(sloupekAdmin()), "legacy-sloupek", 1000, 1000), sceneLayer: "furniture" };
  const saved = createProjectRecord({ id: "legacy-proj", projectType: "individualni", sceneObjects: [legacyPlaced] });
  const reloaded = normalizeProjectRecord(saved);
  assert.equal(reloaded.sceneObjects[0]?.sceneLayer, "furniture", "no blind migration — old data is preserved exactly as stored");
});

test("BACKWARD COMPAT: a legacy project document with no booth-layer items at all (predates this SceneLayer value) still migrates cleanly", () => {
  const migrated = normalizeProjectRecord({ id: "legacy-2", name: "Legacy" });
  assert.deepEqual(migrated.sceneObjects, []);
});

// =========================================================================================
// 8/typovka regression — the priority/technical-point rules typovka already relies on.
// =========================================================================================

test("isTechnicalPointLayer: furniture and booth are real volumes, never technical-point symbols", () => {
  assert.equal(isTechnicalPointLayer("furniture"), false);
  assert.equal(isTechnicalPointLayer("booth"), false);
});

test("isTechnicalPointLayer: electrical/water/waste/annotations are technical-point symbols", () => {
  assert.equal(isTechnicalPointLayer("electrical"), true);
  assert.equal(isTechnicalPointLayer("water"), true);
  assert.equal(isTechnicalPointLayer("waste"), true);
  assert.equal(isTechnicalPointLayer("annotations"), true);
});

test("PLAN_LAYER_PRIORITY: booth (construction) stacks BEHIND furniture, unchanged furniture/technical priorities", () => {
  assert.ok(PLAN_LAYER_PRIORITY.booth < PLAN_LAYER_PRIORITY.furniture);
  assert.equal(PLAN_LAYER_PRIORITY.furniture, 30, "typovka's existing furniture priority must stay exactly the same");
  assert.equal(PLAN_LAYER_PRIORITY.electrical, 40);
});

test("REGRESSION: the 2D placed-component renderer routes booth-layer items to constructionComponent, never technicalComponent (the circular-badge class hides the dimension label and would misrender a real construction piece)", () => {
  assert.match(boothGeneratorSource, /item\.sceneLayer === "booth"\s*\n?\s*\?\s*"constructionComponent"/u);
});

test("REGRESSION: ScenePanel.tsx renders a separate \"Konstrukce stánku\" tree group for booth-layer components, never merged into \"Mobiliář\"", () => {
  assert.match(scenePanelSource, /"Konstrukce stánku"/u);
  assert.match(scenePanelSource, /sceneLayer === "booth"/u);
});

test("REGRESSION: lib/planExport.ts's PNG export fills booth-layer pieces as solid volumes (like furniture), not hollow technical-point symbols", () => {
  assert.match(planExportSource, /isTechnicalPointLayer\(item\.sceneLayer\) \? "#ffffff" : "#f5f5f4"/u);
});

test("REGRESSION: ComponentLibrary.tsx (typovka furniture/technical picker) is still untouched by the new layer", () => {
  const componentLibrarySource = readFileSync(new URL("../components/configurator/ComponentLibrary.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(componentLibrarySource, /"booth"/u);
});
