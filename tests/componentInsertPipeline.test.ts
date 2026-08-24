import assert from "node:assert/strict";
import test from "node:test";
import { placeComponent } from "../data/components.ts";
import { adaptCatalogItemToComponentDefinition } from "../domain/generatorBoothComponents.ts";
import { resolveComponentModelReference } from "../domain/cad3d.ts";
import { resolveDefaultAnchorOnPlot } from "../domain/plot.ts";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";

// =========================================================================================
// Turn 5 LIVE QA sections 27-38/52: CRITICAL BUG — a real Admin-uploaded booth_component
// ("sloupek") was invisible after insert, in BOTH 2D and 3D. Root-caused (not guessed) to TWO
// independent bugs:
//   (A) 2D: addComponent always inserted at a HARDCODED world point (1000, 1500), which could
//       land far outside the current plot/Fit-scoped viewport — a real, correctly-rendered DOM
//       element that was simply off-screen, not actually invisible.
//   (B) 3D: data/components.ts's placeComponent never copied ComponentDefinition.modelAsset/
//       modelUrl onto PlacedComponent, and BoothCadViewer.tsx's 3D loader only ever read the
//       legacy assets.models3d[] shape — so a real R2-uploaded booth_component (which carries its
//       GLB as modelAsset, never as models3d[]) NEVER had a resolvable 3D model at the
//       PlacedComponent-instance level, regardless of position.
// This test traces the REAL runtime shape end to end (catalog_item -> adapter ->
// ComponentDefinition -> placeComponent -> PlacedComponent -> resolveComponentModelReference ->
// save/load) using a fixture shaped exactly like production data (modelAsset, not the legacy
// models3d[] static-fixture shape) — never a fake component, per the report's explicit
// instruction not to bypass readiness or invent a fake component. The GLTFLoader network fetch
// itself is the one external boundary this test does NOT cross (no browser/three.js DOM
// available under node:test) — everything up to and including the resolved model REFERENCE is
// real, untouched application code.
// =========================================================================================

function realSloupekCatalogItem(): CatalogItemAdmin {
  return {
    id: "sloupek-real-uuid",
    internalCode: "BC-SLOUPEK-01",
    kind: "booth_component",
    lifecycleStatus: "active",
    displayName: "Sloupek 40x40",
    officialName: null,
    category: "Sloupky",
    unit: null,
    document: {
      widthMm: 40,
      depthMm: 40,
      heightMm: 2500,
      // The REAL production shape for an Admin-uploaded component: modelAsset (R2 StoredAsset),
      // never assets.models3d[] (that shape only exists on static demo fixtures).
      modelAsset: { id: "asset-1", storageKey: "catalog/booth_component/sloupek-real-uuid/models/sloupek.glb", originalFileName: "sloupek.glb", mimeType: "model/gltf-binary", size: 48_000, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-model" },
      sourceAssets: [{ id: "s1", kind: "sketchup", asset: { id: "s1a", storageKey: "sloupek.skp", originalFileName: "sloupek.skp", mimeType: "x", size: 1, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-source" } }],
    },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

test("PIPELINE step 1-4: adapter produces a ComponentDefinition that keeps modelAsset, sceneLayer='booth', and a real footprint", () => {
  const definition = adaptCatalogItemToComponentDefinition(realSloupekCatalogItem());
  assert.equal(definition.id, "sloupek-real-uuid");
  assert.equal(definition.sceneLayer, "booth");
  assert.equal(definition.widthMm, 40);
  assert.equal(definition.depthMm, 40);
  assert.ok(definition.modelAsset, "adapter must NOT drop modelAsset");
  assert.equal(definition.modelAsset?.storageKey, "catalog/booth_component/sloupek-real-uuid/models/sloupek.glb");
});

test("PIPELINE step 5-11: placeComponent produces a PlacedComponent with a unique id, finite xMm/yMm/rotationDeg, sceneLayer=booth, and modelAsset preserved (the bug: this used to be silently dropped)", () => {
  const definition = adaptCatalogItemToComponentDefinition(realSloupekCatalogItem());
  const plot = [{ x: 1000, y: 1000 }, { x: 4000, y: 1000 }, { x: 4000, y: 3000 }, { x: 1000, y: 3000 }];
  const anchor = resolveDefaultAnchorOnPlot(plot);
  const instance = placeComponent(definition, `${definition.type}-${crypto.randomUUID()}`, anchor.x, anchor.y);

  assert.ok(instance.id.length > 0);
  assert.equal(instance.definitionId, "sloupek-real-uuid");
  assert.ok(Number.isFinite(instance.xMm));
  assert.ok(Number.isFinite(instance.yMm));
  assert.ok(Number.isFinite(instance.rotationDeg));
  assert.equal(instance.sceneLayer, "booth");
  assert.equal(instance.visible, true);
  assert.equal(instance.showIn2D, true);
  assert.equal(instance.showIn3D, true);
  assert.ok(instance.modelAsset, "placeComponent must propagate modelAsset onto the PlacedComponent instance — this was the 3D root cause");
  assert.equal(instance.modelAsset?.storageKey, "catalog/booth_component/sloupek-real-uuid/models/sloupek.glb");
});

test("PIPELINE step 11 (boundary): the default insert anchor always lands inside-or-on the real plot polygon, never a fixed point that could be far outside it — this was the 2D root cause", () => {
  // A plot drawn far away from world origin (e.g. the user drew it in a corner of a large workspace) —
  // the OLD hardcoded (1000, 1500) insert point would have landed nowhere near it.
  const remotePlot = [{ x: 15000, y: 15000 }, { x: 18000, y: 15000 }, { x: 18000, y: 18000 }, { x: 15000, y: 18000 }];
  const anchor = resolveDefaultAnchorOnPlot(remotePlot);
  assert.ok(anchor.x >= 15000 && anchor.x <= 18000);
  assert.ok(anchor.y >= 15000 && anchor.y <= 18000);
});

test("PIPELINE step 14 (3D resolution): resolveComponentModelReference resolves a real modelAsset-based instance to a 'stored' source with the correct storageKey and the documented footprint-center-floor anchor — this is the exact call BoothCadViewer.tsx's effect makes per component", () => {
  const definition = adaptCatalogItemToComponentDefinition(realSloupekCatalogItem());
  const instance = placeComponent(definition, "sloupek-instance-1", 2000, 2000);

  const resolved = resolveComponentModelReference(instance);
  assert.ok(resolved);
  assert.equal(resolved?.kind, "stored");
  if (resolved?.kind === "stored") {
    assert.equal(resolved.asset.storageKey, "catalog/booth_component/sloupek-real-uuid/models/sloupek.glb");
    assert.equal(resolved.anchor, "footprint-center-floor");
  }
});

test("PIPELINE step 15 (save/load): the placed instance, including modelAsset, survives a full ProjectRecord save/reload cycle", () => {
  const definition = adaptCatalogItemToComponentDefinition(realSloupekCatalogItem());
  const instance = placeComponent(definition, "sloupek-instance-1", 2000, 2000);

  const saved = createProjectRecord({ id: "pipeline-save-test", projectType: "individualni", sceneObjects: [instance] });
  const reloaded = normalizeProjectRecord(saved);

  const reloadedInstance = reloaded.sceneObjects.find((item) => item.id === "sloupek-instance-1");
  assert.ok(reloadedInstance);
  assert.equal(reloadedInstance?.sceneLayer, "booth");
  assert.equal(reloadedInstance?.modelAsset?.storageKey, "catalog/booth_component/sloupek-real-uuid/models/sloupek.glb");
});

test("PIPELINE (legacy path unaffected): a static demo fixture with no active modelAsset/modelUrl still resolves through assets.models3d[]", () => {
  const legacyDefinition = adaptCatalogItemToComponentDefinition({
    ...realSloupekCatalogItem(),
    document: {
      widthMm: 40,
      depthMm: 40,
      heightMm: 2500,
      assets: { sourceId: "legacy-src", scale: 1, unit: "mm", models3d: [{ id: "m1", url: "/models/sloupek.glb", role: "component", unit: "mm", axisSystem: "x-right-y-depth-z-up", anchor: "footprint-center-floor" }] },
    },
  });
  const instance = placeComponent(legacyDefinition, "legacy-instance-1", 1000, 1000);
  const resolved = resolveComponentModelReference(instance);
  assert.equal(resolved?.kind, "legacy");
  if (resolved?.kind === "legacy") {
    assert.equal(resolved.asset.url, "/models/sloupek.glb");
  }
});
