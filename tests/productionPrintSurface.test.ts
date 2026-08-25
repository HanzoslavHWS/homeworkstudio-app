import assert from "node:assert/strict";
import test from "node:test";
import {
  computePrintSurfaceAssignments,
  productionPrintSurfaceDimensions,
  resolveProductionPrintSurface,
} from "../domain/technicalServices.ts";
import {
  P86_CANONICAL_PRINT_SURFACES,
  P86_FASCIA_PRINT_SURFACE,
  P86_PANEL_PRINT_HEIGHT_MM,
  P86_PANEL_PRINT_SURFACES,
  P86_PANEL_PRINT_WIDTH_MM,
} from "../domain/printSurfaces.ts";
import { boothTypes } from "../data/booths.ts";
import { DEFAULT_REALIZATION_PROFILE_ID } from "../data/realizationProfiles.ts";
import { normalizeArtworkPlacement } from "../domain/artworkPlacement.ts";
import type { PrintSurface } from "../domain/models.ts";
import type { PrintSurfaceAssignment } from "../domain/project.ts";

const p86 = boothTypes.find((booth) => booth.internalCode === "P86");
if (!p86) throw new Error("Testovací definice P86 nebyla nalezena.");

const panelSurface = P86_PANEL_PRINT_SURFACES[0]!;

// =========================================================================================
// Graphics production v3: canonical/design surface (PrintSurface.widthMm/heightMm) stays fixed;
// production surface (resolveProductionPrintSurface) is canonical + a realization's own bleed/
// override rule (PrintSurface.productionProfiles[realizationProfileId]). Generic for every
// PrintSurface — never a P86-only mechanism.
// =========================================================================================

test("CANONICAL: canonical dimensions never change regardless of realizationProfileId", () => {
  for (const realizationProfileId of [DEFAULT_REALIZATION_PROFILE_ID, "realization-2", "unknown-profile"]) {
    const resolved = resolveProductionPrintSurface(panelSurface, realizationProfileId);
    assert.equal(resolved.canonicalWidthMm, P86_PANEL_PRINT_WIDTH_MM);
    assert.equal(resolved.canonicalHeightMm, P86_PANEL_PRINT_HEIGHT_MM);
  }
});

test("DEFAULT REALIZATION: no productionProfiles entry (today's real P86 data) -> production = canonical, all bleed = 0 — resolved generically, never a P86 hardcode", () => {
  const resolved = resolveProductionPrintSurface(panelSurface, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(resolved.productionWidthMm, resolved.canonicalWidthMm);
  assert.equal(resolved.productionHeightMm, resolved.canonicalHeightMm);
  assert.equal(resolved.bleedLeftMm, 0);
  assert.equal(resolved.bleedRightMm, 0);
  assert.equal(resolved.bleedTopMm, 0);
  assert.equal(resolved.bleedBottomMm, 0);
  assert.equal(resolved.realizationProfileId, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(resolved.printSurfaceId, panelSurface.id);
});

test("BLEED: symmetric left/right/top/bottom allowances correctly compute production width/height (illustrative values only, not real P86 data)", () => {
  const surfaceWithBleed: PrintSurface = {
    ...panelSurface,
    productionProfiles: {
      "realization-2": { bleedLeftMm: 10, bleedRightMm: 10, bleedTopMm: 20, bleedBottomMm: 20 },
    },
  };
  const resolved = resolveProductionPrintSurface(surfaceWithBleed, "realization-2");
  assert.equal(resolved.productionWidthMm, P86_PANEL_PRINT_WIDTH_MM + 20);
  assert.equal(resolved.productionHeightMm, P86_PANEL_PRINT_HEIGHT_MM + 40);
  assert.equal(resolved.canonicalWidthMm, P86_PANEL_PRINT_WIDTH_MM, "canonical is untouched by the bleed rule");
});

test("BLEED: asymmetric allowances (different on each edge) apply independently per edge", () => {
  const surfaceWithBleed: PrintSurface = {
    ...panelSurface,
    productionProfiles: {
      "realization-2": { bleedLeftMm: 5, bleedRightMm: 15, bleedTopMm: 0, bleedBottomMm: 30 },
    },
  };
  const resolved = resolveProductionPrintSurface(surfaceWithBleed, "realization-2");
  assert.equal(resolved.productionWidthMm, P86_PANEL_PRINT_WIDTH_MM + 5 + 15);
  assert.equal(resolved.productionHeightMm, P86_PANEL_PRINT_HEIGHT_MM + 0 + 30);
  assert.equal(resolved.bleedLeftMm, 5);
  assert.equal(resolved.bleedRightMm, 15);
  assert.equal(resolved.bleedTopMm, 0);
  assert.equal(resolved.bleedBottomMm, 30);
});

test("EXPLICIT OVERRIDE: a realization with an explicit widthMm/heightMm rule wins outright over bleed math", () => {
  const surfaceWithExplicitOverride: PrintSurface = {
    ...panelSurface,
    productionProfiles: {
      "realization-3": { widthMm: 1000, heightMm: 2400, bleedLeftMm: 999 },
    },
  };
  const resolved = resolveProductionPrintSurface(surfaceWithExplicitOverride, "realization-3");
  assert.equal(resolved.productionWidthMm, 1000, "explicit widthMm wins over bleedLeftMm");
  assert.equal(resolved.productionHeightMm, 2400);
});

test("P86 GENERIC: the real P86 panel surface resolves through the generic resolver, not a P86-specific code path", () => {
  const resolved = resolveProductionPrintSurface(panelSurface, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(resolved.printSurfaceId, panelSurface.id);
  assert.equal(resolved.canonicalWidthMm, 950);
  assert.equal(resolved.canonicalHeightMm, 2340);
});

test("FASCIA: fascia-print uses the exact same resolver as panels — no separate fascia-specific dimension logic", () => {
  const resolved = resolveProductionPrintSurface(P86_FASCIA_PRINT_SURFACE, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(resolved.canonicalWidthMm, 2000);
  assert.equal(resolved.canonicalHeightMm, 300);
  assert.equal(resolved.productionWidthMm, 2000);
  assert.equal(resolved.productionHeightMm, 300);
});

test("REALIZATION CHANGE: switching realizationProfileId changes the resolved production dimensions when that profile has a rule", () => {
  const surfaceWithBleed: PrintSurface = {
    ...panelSurface,
    productionProfiles: { "realization-2": { bleedLeftMm: 10, bleedRightMm: 10, bleedTopMm: 0, bleedBottomMm: 0 } },
  };
  const withDefault = resolveProductionPrintSurface(surfaceWithBleed, DEFAULT_REALIZATION_PROFILE_ID);
  const withRealization2 = resolveProductionPrintSurface(surfaceWithBleed, "realization-2");
  assert.equal(withDefault.productionWidthMm, P86_PANEL_PRINT_WIDTH_MM);
  assert.equal(withRealization2.productionWidthMm, P86_PANEL_PRINT_WIDTH_MM + 20);
  assert.notEqual(withDefault.productionWidthMm, withRealization2.productionWidthMm);
});

test("ARTWORK PLACEMENT UNCHANGED: computePrintSurfaceAssignments preserves artworkPlacement across a realizationProfileId change — production resolution never touches it", () => {
  const placement = { mode: "fit" as const, scale: 1.4, offsetXmm: 30, offsetYmm: -15 };
  const current: PrintSurfaceAssignment[] = [{
    printSurfaceId: "fascia-print",
    sceneReference: p86.id,
    graphicsKind: "fascia",
    artworkStatus: "received",
    artworkFileId: "artwork-1",
    artworkPlacement: placement,
    selectedForPrint: true,
    canonicalWidthMm: 2000,
    canonicalHeightMm: 300,
    productionWidthMm: 2000,
    productionHeightMm: 300,
    includedInPackage: true,
    pricedSeparately: false,
  }];
  const afterRealizationChange = computePrintSurfaceAssignments(p86, "realization-2", current);
  const updated = afterRealizationChange.find((item) => item.printSurfaceId === "fascia-print");
  assert.ok(updated);
  assert.deepEqual(normalizeArtworkPlacement(updated?.artworkPlacement), normalizeArtworkPlacement(placement));
});

test("GLB/RENDER DIMENSIONS UNCHANGED: the P86 canonical print surface registry (feeding GLB node bindings/UV overlay) has no productionProfiles field on the panel surfaces at all — geometry authoring is completely independent of production resolution", () => {
  for (const surface of P86_PANEL_PRINT_SURFACES) {
    assert.equal(surface.productionProfiles, undefined, `${surface.id} must not carry a production rule that could be mistaken for scene-binding geometry`);
    assert.ok(surface.sceneBinding, `${surface.id} keeps its GLB node binding regardless of any production rule`);
  }
});

test("LEGACY PROJECT: a print surface with productionProfiles fully absent (undefined, not just empty) still resolves to production = canonical", () => {
  const legacySurface: PrintSurface = { id: "legacy-surface", name: "Legacy", widthMm: 600, heightMm: 400, active: true };
  const resolved = resolveProductionPrintSurface(legacySurface, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(resolved.productionWidthMm, 600);
  assert.equal(resolved.productionHeightMm, 400);
});

test("STALE SNAPSHOT: an existing PrintSurfaceAssignment with an outdated productionWidthMm/HeightMm gets overwritten by computePrintSurfaceAssignments's fresh resolution — the old snapshot never permanently wins over the current realization rule", () => {
  const surfaceWithBleed = { ...P86_FASCIA_PRINT_SURFACE, productionProfiles: { "realization-2": { bleedLeftMm: 50, bleedRightMm: 50, bleedTopMm: 0, bleedBottomMm: 0 } } };
  const boothWithBleed = { ...p86, printSurfaces: [surfaceWithBleed] };
  const staleSnapshot: PrintSurfaceAssignment[] = [{
    printSurfaceId: "fascia-print",
    sceneReference: p86.id,
    graphicsKind: "fascia",
    artworkStatus: "received",
    artworkFileId: "artwork-1",
    selectedForPrint: true,
    canonicalWidthMm: 2000,
    canonicalHeightMm: 300,
    // Deliberately stale/wrong numbers, as if computed under a since-changed rule.
    productionWidthMm: 1234,
    productionHeightMm: 999,
    includedInPackage: true,
    pricedSeparately: false,
  }];
  const recomputed = computePrintSurfaceAssignments(boothWithBleed, "realization-2", staleSnapshot);
  const fascia = recomputed.find((item) => item.printSurfaceId === "fascia-print");
  assert.ok(fascia);
  assert.equal(fascia?.productionWidthMm, 2100, "the stale 1234 snapshot must be replaced by the current rule's real result (2000 + 50 + 50)");
  assert.equal(fascia?.productionHeightMm, 300);
});

test("LEGACY REALIZATION: default realization on a full P86 booth with real productionProfiles resolves every surface to production = canonical (no allowances defined today)", () => {
  const assignments = computePrintSurfaceAssignments(p86, DEFAULT_REALIZATION_PROFILE_ID, []);
  for (const assignment of assignments) {
    assert.equal(assignment.productionWidthMm, assignment.canonicalWidthMm);
    assert.equal(assignment.productionHeightMm, assignment.canonicalHeightMm);
  }
});

test("OTHER BOOTH ISOLATION: a non-P86 surface with its own productionProfiles rule resolves independently — P86's registry/hardcoded constants never leak into another booth's resolution", () => {
  const otherBoothSurface: PrintSurface = {
    id: "other-booth-surface",
    name: "Jiný stánek",
    widthMm: 1200,
    heightMm: 800,
    active: true,
    productionProfiles: { "realization-4": { bleedLeftMm: 25, bleedRightMm: 25, bleedTopMm: 25, bleedBottomMm: 25 } },
  };
  const resolved = resolveProductionPrintSurface(otherBoothSurface, "realization-4");
  assert.equal(resolved.productionWidthMm, 1250);
  assert.equal(resolved.productionHeightMm, 850);
  // P86's own canonical constants must be nowhere near this result.
  assert.notEqual(resolved.productionWidthMm, P86_PANEL_PRINT_WIDTH_MM);
  assert.notEqual(resolved.canonicalWidthMm, P86_PANEL_PRINT_WIDTH_MM);
});

test("BACKWARD-COMPATIBLE PROJECTION: productionPrintSurfaceDimensions (the pre-existing function computePrintSurfaceAssignments/assignArtworkToPrintSurface already call) still returns the exact same {widthMm, heightMm} shape, now backed by the richer resolver", () => {
  const surfaceWithBleed: PrintSurface = {
    ...panelSurface,
    productionProfiles: { "realization-2": { bleedLeftMm: 10, bleedRightMm: 10, bleedTopMm: 5, bleedBottomMm: 5 } },
  };
  const dims = productionPrintSurfaceDimensions(surfaceWithBleed, "realization-2");
  const resolved = resolveProductionPrintSurface(surfaceWithBleed, "realization-2");
  assert.deepEqual(dims, { widthMm: resolved.productionWidthMm, heightMm: resolved.productionHeightMm });
});

test("REGISTRY SANITY: P86_CANONICAL_PRINT_SURFACES includes both panels and fascia-print, all still active and resolvable through the generic resolver", () => {
  for (const surface of P86_CANONICAL_PRINT_SURFACES) {
    const resolved = resolveProductionPrintSurface(surface, DEFAULT_REALIZATION_PROFILE_ID);
    assert.equal(resolved.printSurfaceId, surface.id);
    assert.equal(resolved.productionWidthMm, surface.widthMm);
    assert.equal(resolved.productionHeightMm, surface.heightMm);
  }
});
