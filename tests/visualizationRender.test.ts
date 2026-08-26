import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisualizationRenderFileName,
  buildVisualizationRenderFingerprint,
  CUSTOMER_CAPTURE_RESOLUTIONS,
  deduplicateRenderFileNames,
  evaluateRenderStaleness,
  fingerprintsEqual,
  isBackgroundModeAllowed,
  latestCustomerRenderForView,
  latestCustomerRendersByView,
  type VisualizationRenderFingerprint,
} from "../domain/visualizationRender.ts";
import { createProjectRecord } from "../domain/project.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import type { ProjectRecord, VisualizationItem, PrintSurfaceAssignment, GraphicFileReference } from "../domain/project.ts";

function baseProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return createProjectRecord({ id: "fp-project", boothId: "booth-1", variantId: "variant-1", ...overrides });
}

function fingerprintOf(overrides: Partial<ProjectRecord> = {}): VisualizationRenderFingerprint {
  return buildVisualizationRenderFingerprint(baseProject(overrides));
}

function assignment(overrides: Partial<PrintSurfaceAssignment> & Pick<PrintSurfaceAssignment, "printSurfaceId">): PrintSurfaceAssignment {
  return {
    sceneReference: "booth", graphicsKind: "fullWrap", artworkStatus: "missing",
    selectedForPrint: false, canonicalWidthMm: 0, canonicalHeightMm: 0,
    productionWidthMm: 0, productionHeightMm: 0, includedInPackage: false, pricedSeparately: true,
    ...overrides,
  };
}

function graphicsFile(overrides: Partial<GraphicFileReference> & Pick<GraphicFileReference, "id" | "name">): GraphicFileReference {
  return { size: 100, mimeType: "image/png", availability: "persistent" as const, ...overrides };
}

function customerRender(overrides: Partial<VisualizationItem> & Pick<VisualizationItem, "viewId" | "createdAt">): VisualizationItem {
  return {
    id: `render-${overrides.viewId}-${overrides.createdAt}`,
    name: "Render", sourceViewId: overrides.viewId!, imageDataUrl: "data:image/png;base64,AA==",
    type: "customer", purpose: "working", reviewStatus: "unreviewed",
    ...overrides,
  };
}

// =========================================================================================
// Visualization v2 — content fingerprint staleness (report sections 14/26): never a timestamp
// heuristic (project.modifiedAt is unreliable), never full scene/GLB hashing.
// =========================================================================================

test("FINGERPRINT: identical project state produces an equal fingerprint", () => {
  assert.ok(fingerprintsEqual(fingerprintOf(), fingerprintOf()));
});

test("FINGERPRINT: changes when a placed component moves, rotates, or resizes", () => {
  const chair = placeComponent(componentCatalog.chair, "c1", 100, 200);
  const before = fingerprintOf({ sceneObjects: [chair] });
  assert.ok(fingerprintsEqual(before, fingerprintOf({ sceneObjects: [chair] })), "sanity: identical input is stable");
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ sceneObjects: [{ ...chair, xMm: chair.xMm + 50 }] })), "position change");
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ sceneObjects: [{ ...chair, rotationDeg: chair.rotationDeg + 90 }] })), "rotation change");
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ sceneObjects: [{ ...chair, widthMm: chair.widthMm + 10 }] })), "size change");
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ sceneObjects: [{ ...chair, visible: false }] })), "visibility change");
});

test("FINGERPRINT: changes when a print surface assignment's artwork or placement changes", () => {
  const before = fingerprintOf({ printSurfaceAssignments: [assignment({ printSurfaceId: "p1", selectedForPrint: true })] });
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ printSurfaceAssignments: [assignment({ printSurfaceId: "p1", selectedForPrint: true, artworkFileId: "art-1" })] })), "artwork assignment");
  const withArt = fingerprintOf({ printSurfaceAssignments: [assignment({ printSurfaceId: "p1", selectedForPrint: true, artworkFileId: "art-1", artworkPlacement: { mode: "stretch", scale: 1, offsetXmm: 0, offsetYmm: 0 } })] });
  const movedArt = fingerprintOf({ printSurfaceAssignments: [assignment({ printSurfaceId: "p1", selectedForPrint: true, artworkFileId: "art-1", artworkPlacement: { mode: "fit", scale: 1.2, offsetXmm: 5, offsetYmm: -5 } })] });
  assert.ok(!fingerprintsEqual(withArt, movedArt), "placement change");
});

test("FINGERPRINT: changes when construction visibility, finishes, booth, or variant change", () => {
  const before = fingerprintOf();
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ constructionVisibility: { assembly: false } })));
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ carpetFinishId: "carpet-red" })));
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ constructionFinishId: "construction-black" })));
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ boothId: "booth-2" })));
  assert.ok(!fingerprintsEqual(before, fingerprintOf({ variantId: "variant-2" })));
});

test("FINGERPRINT: unaffected by a graphicsFiles entry no assignment actually references", () => {
  const assignments = [assignment({ printSurfaceId: "p1", selectedForPrint: true, artworkFileId: "art-1" })];
  const before = fingerprintOf({ printSurfaceAssignments: assignments, graphicsFiles: [graphicsFile({ id: "art-1", name: "a.png" })] });
  const withUnrelatedUpload = fingerprintOf({ printSurfaceAssignments: assignments, graphicsFiles: [graphicsFile({ id: "art-1", name: "a.png" }), graphicsFile({ id: "unused-1", name: "b.png" })] });
  assert.ok(fingerprintsEqual(before, withUnrelatedUpload), "an unreferenced upload must never flip staleness");
});

test("FINGERPRINT: changes when a REFERENCED graphicsFile's storageKey changes (re-upload)", () => {
  const assignments = [assignment({ printSurfaceId: "p1", selectedForPrint: true, artworkFileId: "art-1" })];
  const before = fingerprintOf({ printSurfaceAssignments: assignments, graphicsFiles: [graphicsFile({ id: "art-1", name: "a.png", storageKey: "key-1" })] });
  const after = fingerprintOf({ printSurfaceAssignments: assignments, graphicsFiles: [graphicsFile({ id: "art-1", name: "a.png", storageKey: "key-2" })] });
  assert.ok(!fingerprintsEqual(before, after));
});

test("STALENESS: current when fingerprints match, possibly-outdated when they don't", () => {
  const fp = fingerprintOf();
  const render = customerRender({ viewId: "v1", createdAt: "2026-08-26T10:00:00.000Z", type: "customer", contentFingerprint: fp });
  assert.equal(evaluateRenderStaleness(render, fp), "current");
  assert.equal(evaluateRenderStaleness(render, fingerprintOf({ boothId: "booth-2" })), "possibly-outdated");
});

test("STALENESS: never possibly-outdated for a non-customer render or a missing fingerprint — always unknown", () => {
  const fp = fingerprintOf();
  assert.equal(evaluateRenderStaleness({ type: "technical" }, fp), "unknown");
  assert.equal(evaluateRenderStaleness({ type: "ai" }, fp), "unknown");
  assert.equal(evaluateRenderStaleness({ type: "customer", contentFingerprint: undefined }, fp), "unknown", "legacy customer render captured before fingerprints existed");
});

// =========================================================================================
// Resolution / format / background contract
// =========================================================================================

test("RESOLUTIONS: match the exact numbers from the report", () => {
  assert.deepEqual(CUSTOMER_CAPTURE_RESOLUTIONS.standard, { widthPx: 1600, heightPx: 1200, label: "Standard" });
  assert.deepEqual(CUSTOMER_CAPTURE_RESOLUTIONS.fullhd, { widthPx: 1920, heightPx: 1080, label: "Full HD" });
  assert.deepEqual(CUSTOMER_CAPTURE_RESOLUTIONS.print, { widthPx: 2400, heightPx: 1800, label: "Print" });
});

test("BACKGROUND: transparent is only ever allowed for PNG, never JPEG", () => {
  assert.equal(isBackgroundModeAllowed("png", "transparent"), true);
  assert.equal(isBackgroundModeAllowed("jpeg", "transparent"), false);
  assert.equal(isBackgroundModeAllowed("jpeg", "white"), true);
  assert.equal(isBackgroundModeAllowed("jpeg", "light-neutral"), true);
});

// =========================================================================================
// Filename / dedup
// =========================================================================================

test("FILENAME: sanitizes diacritics and produces the FOR_<EVENT>_<PROJECT>_<View>.<ext> shape", () => {
  assert.equal(
    buildVisualizationRenderFileName({ eventName: "Beauty", projectName: "Test01", viewName: "Hlavní", extension: "jpg" }),
    "FOR_BEAUTY_Test01_Hlavni.jpg",
  );
  assert.equal(
    buildVisualizationRenderFileName({ eventName: "Beauty", projectName: "Test01", viewName: "Pohled od vstupu", extension: "png" }),
    "FOR_BEAUTY_Test01_Pohled_od_vstupu.png",
  );
});

test("DEDUP: two views sharing a generated filename get deterministic -2/-3 suffixes, never overwriting", () => {
  const files = [
    { viewId: "v1", fileName: "FOR_BEAUTY_Test01_Hlavni.jpg" },
    { viewId: "v2", fileName: "FOR_BEAUTY_Test01_Hlavni.jpg" },
    { viewId: "v3", fileName: "FOR_BEAUTY_Test01_Levy.jpg" },
  ];
  const deduped = deduplicateRenderFileNames(files);
  assert.deepEqual(deduped.map((file) => file.fileName), [
    "FOR_BEAUTY_Test01_Hlavni.jpg",
    "FOR_BEAUTY_Test01_Hlavni-2.jpg",
    "FOR_BEAUTY_Test01_Levy.jpg",
  ]);
});

// =========================================================================================
// Latest render per view
// =========================================================================================

test("LATEST PER VIEW: latestCustomerRenderForView picks the most recent createdAt for that view only", () => {
  const renders = [
    customerRender({ viewId: "v1", createdAt: "2026-08-26T09:00:00.000Z" }),
    customerRender({ viewId: "v1", createdAt: "2026-08-26T11:00:00.000Z" }),
    customerRender({ viewId: "v2", createdAt: "2026-08-26T12:00:00.000Z" }),
  ];
  assert.equal(latestCustomerRenderForView(renders, "v1")?.createdAt, "2026-08-26T11:00:00.000Z");
  assert.equal(latestCustomerRenderForView(renders, "v3"), undefined);
});

test("LATEST PER VIEW: ignores technical/ai items and items missing a viewId", () => {
  const renders: VisualizationItem[] = [
    { id: "t1", name: "T", sourceViewId: "Hlavní", imageDataUrl: "x", type: "technical", purpose: "working", createdAt: "2026-08-26T12:00:00.000Z", reviewStatus: "unreviewed" },
    customerRender({ viewId: "v1", createdAt: "2026-08-26T09:00:00.000Z" }),
  ];
  const map = latestCustomerRendersByView(renders);
  assert.equal(map.size, 1);
  assert.equal(map.get("v1")?.id, renders[1]!.id);
});

// =========================================================================================
// Generic non-P86 fixture (report section 32) — nothing hardcoded to a specific booth.
// =========================================================================================

test("GENERIC: a fully synthetic non-P86/non-koje-2x2 booth/variant fingerprints and dedups the same way", () => {
  const fp = buildVisualizationRenderFingerprint(createProjectRecord({ id: "generic", boothId: "future-booth-x", variantId: "future-variant-y" }));
  assert.equal(fp.boothId, "future-booth-x");
  assert.equal(fp.variantId, "future-variant-y");
  assert.equal(
    buildVisualizationRenderFileName({ eventName: "FutureExpo", projectName: "Client99", viewName: "Roh A", extension: "jpg" }),
    "FOR_FUTUREEXPO_Client99_Roh_A.jpg",
  );
});
