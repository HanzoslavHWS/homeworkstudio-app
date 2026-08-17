import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateCatalogReadiness, isGeneratorEligible } from "../domain/catalogReadiness.ts";
import { documentHas3DAsset, computeReadiness, type CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { getComponentModel, getMasterReferenceModel } from "../domain/cad3d.ts";
import { placeComponent, componentCatalog, componentCatalogItems } from "../data/components.ts";
import { boothTypes } from "../data/booths.ts";
import type { ComponentDefinition } from "../domain/models.ts";

// =========================================================================================
// TYPOVKA (booth-as-a-whole) vs INDIVIDUAL (component assembly) — architecture audit tests.
// Only tests with real runtime meaning; no folder-name-only assertions.
// =========================================================================================

// -----------------------------------------------------------------------------------------
// Typová booth = one master GLB
// -----------------------------------------------------------------------------------------

test("typová booth (P86) resolves to exactly one master-reference 3D model — the runtime never composes it from separate wall/column components", () => {
  const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;
  const master = getMasterReferenceModel(p86.assets);
  assert.equal(p86.modelUrl, "/models/booths/koje-2x2/master.glb");
  // P86 carries the SAME single GLB both as the legacy modelUrl string AND as one
  // assets.models3d "master-reference" entry — both point at one master.glb, never a set of
  // separate wall/column part models composed at runtime.
  assert.equal(master?.role, "master-reference");
  assert.equal(master?.url, p86.modelUrl);
  const otherMasterEntries = p86.assets?.models3d?.filter((asset) => asset.role === "master-reference") ?? [];
  assert.equal(otherMasterEntries.length, 1, "exactly one master-reference GLB, not several composed parts");
  const readiness = evaluateCatalogReadiness({ ...p86, lifecycleStatus: "active" } as unknown as ComponentDefinition, "booth");
  assert.equal(readiness.ready, true);
});

test("Txx (typová booth family) without a real GLB stays not ready — no fake master.glb reference is ever invented", () => {
  const txxWithoutModel = { id: "t04", internalCode: "T04", displayName: "T04", type: "booth", name: "T04", category: "Typovky", widthMm: 2000, depthMm: 2000, heightMm: 2500, resizable: false, productionProfiles: {}, rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false }, systemLocked: false, userLocked: false, visible: true, sceneLabel: "T04", unit: "ks", lifecycleStatus: "needs_review" } satisfies ComponentDefinition;
  assert.equal(evaluateCatalogReadiness(txxWithoutModel, "booth").issues.includes("missing_3d_asset"), true);
  assert.equal(isGeneratorEligible(txxWithoutModel, "booth"), false);
});

// -----------------------------------------------------------------------------------------
// Individual = component assembly. placeComponent already generalizes: same definitionId,
// independent instance transform, canonical dimensions read-only.
// -----------------------------------------------------------------------------------------

test("individual component instance carries catalog identity (definitionId) + its own transform (xMm/yMm/rotationDeg)", () => {
  const chair = componentCatalog.chair;
  const instance = placeComponent(chair, "instance-a", 500, 800);
  assert.equal(instance.definitionId, chair.id);
  assert.equal(instance.xMm, 500);
  assert.equal(instance.yMm, 800);
  assert.equal(instance.rotationDeg, 0, "placeComponent starts unrotated; rotation is an independent per-instance concern");
});

test("multiple scene instances share one definitionId but never share mutable state — moving/rotating one never affects the other or the shared definition", () => {
  const chair = componentCatalog.chair;
  const instanceA = placeComponent(chair, "instance-a", 0, 0);
  const instanceB = placeComponent(chair, "instance-b", 1000, 0);
  const rotatedC = { ...placeComponent(chair, "instance-c", 0, 1000), rotationDeg: 90 };

  assert.equal(instanceA.definitionId, chair.id);
  assert.equal(instanceB.definitionId, chair.id);
  assert.equal(rotatedC.definitionId, chair.id);

  // Independent transforms despite sharing one definitionId.
  assert.notEqual(instanceA.xMm, instanceB.xMm);
  assert.equal(rotatedC.rotationDeg, 90);
  assert.equal(instanceA.rotationDeg, 0, "rotating instance C must never leak onto instance A");

  // The shared ComponentDefinition itself is never mutated by placing instances.
  assert.equal(chair.widthMm, 535);
  assert.equal(chair.depthMm, 592);
});

test("canonical dimensions are never mutated by scene placement — the instance gets its OWN copy, the definition stays read-only input", () => {
  const chair = componentCatalog.chair;
  const before = { widthMm: chair.widthMm, depthMm: chair.depthMm, heightMm: chair.heightMm };
  const instance = placeComponent(chair, "instance-a", 0, 0);
  // Simulate a hypothetical resize on the INSTANCE only (never on the shared definition).
  const resizedInstance = { ...instance, widthMm: 700 };
  assert.equal(resizedInstance.widthMm, 700);
  assert.deepEqual({ widthMm: chair.widthMm, depthMm: chair.depthMm, heightMm: chair.heightMm }, before, "the shared ComponentDefinition must be completely unaffected by an instance-level resize");
});

test("scene transform never introduces a scale concept — AssetReference.scale is a literal 1 at the type level (no per-instance GLB scaling in this session)", () => {
  const chair = componentCatalog.chair;
  if (chair.assets) assert.equal(chair.assets.scale, 1);
  const instance = placeComponent(chair, "instance-a", 0, 0);
  assert.equal("scale" in instance, false, "PlacedComponent has no scale field — geometry comes from canonical dims + the GLB itself, never a runtime multiplier");
});

// -----------------------------------------------------------------------------------------
// Runtime 3D resolution — GLB via static URL, R2 modelAsset, or legacy assets.models3d[] are
// all valid; a .skp reference must never satisfy readiness, however it got set.
// -----------------------------------------------------------------------------------------

function furnitureBase(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return {
    id: "test", internalCode: "M99", displayName: "Test", type: "furniture", name: "Test", category: "Nábytek",
    widthMm: 500, depthMm: 500, resizable: false, productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false, userLocked: false, visible: true, sceneLabel: "Test", unit: "ks", showIn3D: true,
    reviewedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

test("runtime model resolver accepts a static modelUrl", () => {
  assert.equal(evaluateCatalogReadiness(furnitureBase({ modelUrl: "/models/test/master.glb" }), "furniture").issues.includes("missing_3d_asset"), false);
});

test("runtime model resolver accepts an R2 modelAsset.storageKey", () => {
  assert.equal(evaluateCatalogReadiness(furnitureBase({ modelAsset: { id: "a", storageKey: "catalog/furniture/M99/models/x.glb", originalFileName: "x.glb", mimeType: "model/gltf-binary", size: 100, createdAt: "2026-08-17T00:00:00.000Z", category: "catalog-model" } }), "furniture").issues.includes("missing_3d_asset"), false);
});

test("runtime model resolver accepts legacy assets.models3d[]", () => {
  const withLegacyAssets = furnitureBase({ assets: { sourceId: "x", scale: 1, unit: "mm", models3d: [{ id: "m", url: "/models/test/master.glb", role: "component", unit: "mm", axisSystem: "x-right-y-depth-z-up" }] } });
  assert.equal(evaluateCatalogReadiness(withLegacyAssets, "furniture").issues.includes("missing_3d_asset"), false);
  assert.notEqual(getComponentModel(withLegacyAssets.assets), undefined);
});

test("runtime model resolver NEVER treats a .skp reference as a usable GLB — modelUrl, modelAsset.storageKey, and assets.models3d[].url are all checked", () => {
  assert.equal(evaluateCatalogReadiness(furnitureBase({ modelUrl: "/models/test/source.skp" }), "furniture").issues.includes("missing_3d_asset"), true);
  assert.equal(evaluateCatalogReadiness(furnitureBase({ modelAsset: { id: "a", storageKey: "catalog/furniture/M99/models/source.skp", originalFileName: "source.skp", mimeType: "model/gltf-binary", size: 100, createdAt: "2026-08-17T00:00:00.000Z", category: "catalog-model" } }), "furniture").issues.includes("missing_3d_asset"), true);
  const withSkpLegacyAsset = furnitureBase({ assets: { sourceId: "x", scale: 1, unit: "mm", models3d: [{ id: "m", url: "/models/test/source.skp", role: "component", unit: "mm", axisSystem: "x-right-y-depth-z-up" }] } });
  assert.equal(evaluateCatalogReadiness(withSkpLegacyAsset, "furniture").issues.includes("missing_3d_asset"), true);
});

test("admin document resolver (documentHas3DAsset) also never accepts a .skp reference", () => {
  assert.equal(documentHas3DAsset({ modelUrl: "/models/test/source.skp" }), false);
  assert.equal(documentHas3DAsset({ modelUrl: "/models/test/master.glb" }), true);
  assert.equal(documentHas3DAsset({ modelAsset: { id: "a", storageKey: "catalog/furniture/M99/models/source.skp", originalFileName: "source.skp", mimeType: "model/gltf-binary", size: 100, createdAt: "2026-08-17T00:00:00.000Z", category: "catalog-model" } }), false);
});

test("source.skp is never required for readiness — sketchupUrl is not referenced anywhere in the readiness rules", () => {
  const readinessSource = readFileSync(new URL("../domain/catalogReadiness.ts", import.meta.url), "utf8");
  assert.doesNotMatch(readinessSource, /sketchupUrl/u);
  // An item with NO sketchupUrl at all can still be fully ready.
  const readyNoSketchup = furnitureBase({ modelUrl: "/models/test/master.glb", footprint2D: { shape: "rectangle" }, showIn2D: true });
  assert.equal(("sketchupUrl" in readyNoSketchup), false);
  assert.equal(evaluateCatalogReadiness(readyNoSketchup, "furniture").ready, true);
});

test("sketchupUrl, when present, is never fed into the 3D loading path (domain/cad3d.ts only ever reads assets.models3d[].url, never sketchupUrl)", () => {
  const cad3dSource = readFileSync(new URL("../domain/cad3d.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cad3dSource, /sketchupUrl/u);
});

// -----------------------------------------------------------------------------------------
// PrintSurface compatibility — individual construction components will carry PrintSurface
// metadata; confirm the existing document-merge machinery already preserves it (no new editor
// this session, just the architectural guarantee).
// -----------------------------------------------------------------------------------------

test("PrintSurface metadata is structurally independent of 3D/capability fields — an item can carry printSurfaces regardless of showIn2D/showIn3D/modelAsset state", () => {
  const withPrintSurfaces: CatalogItemAdmin["document"] = {
    ...furnitureBase({ modelUrl: "/models/test/master.glb" }),
    printSurfaces: [{ id: "front", name: "Přední strana", widthMm: 600, heightMm: 400, materialRole: "PRINT_SURFACE", active: true }],
  };
  assert.equal((withPrintSurfaces.printSurfaces as unknown[]).length, 1);
  const item: CatalogItemAdmin = { id: "x", internalCode: "M99", kind: "construction", lifecycleStatus: "needs_review", displayName: "Panel", officialName: null, category: "Stavba", unit: "m²", document: withPrintSurfaces, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" };
  // Readiness computation must not touch/strip printSurfaces as a side effect.
  computeReadiness(item);
  assert.equal((item.document.printSurfaces as unknown[]).length, 1, "readiness evaluation must be read-only w.r.t. printSurfaces");
});

test("no material/color/kind-name inference of printable anywhere in the readiness or admin domain layers", () => {
  const readinessSource = readFileSync(new URL("../domain/catalogReadiness.ts", import.meta.url), "utf8");
  const adminSource = readFileSync(new URL("../domain/catalogItemsAdmin.ts", import.meta.url), "utf8");
  const assignmentPattern = /\bprintable\s*[:=]/u;
  assert.doesNotMatch(readinessSource, assignmentPattern);
  assert.doesNotMatch(adminSource, assignmentPattern);
  assert.doesNotMatch(readinessSource, /materialRole|swatchColor|textureUrl/u, "readiness must never key off material/color fields");
});

// -----------------------------------------------------------------------------------------
// Component classification — kind + category already distinguish placeable furniture from
// wall/column/fascia/door/floor/lighting without a new giant enum.
// -----------------------------------------------------------------------------------------

test("CatalogItemKind already covers the individual-component families named in the folder audit (construction/furniture/floor_finish/other) — no new enum needed", () => {
  const modelsSource = readFileSync(new URL("../domain/models.ts", import.meta.url), "utf8");
  const kindsMatch = modelsSource.match(/export const CATALOG_ITEM_KINDS = \[([\s\S]*?)\] as const;/u);
  assert.ok(kindsMatch);
  const kinds = kindsMatch![1]!.match(/"([a-z_]+)"/gu)!.map((entry) => entry.replace(/"/gu, ""));
  for (const requiredKind of ["furniture", "construction", "floor_finish", "other"]) {
    assert.ok(kinds.includes(requiredKind), `CatalogItemKind must already cover "${requiredKind}"`);
  }
});

test("M57 canonical furniture remains generator-eligible after this session's has3DAsset hardening", () => {
  assert.equal(isGeneratorEligible(componentCatalog.chair as ComponentDefinition), true);
});

test("componentCatalogItems (the generator's own static catalog) never references a .skp path as a runtime model", () => {
  for (const item of componentCatalogItems) {
    if (item.modelUrl) assert.doesNotMatch(item.modelUrl, /\.skp$/iu);
  }
});
