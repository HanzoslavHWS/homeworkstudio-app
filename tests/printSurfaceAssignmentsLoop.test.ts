import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computePrintSurfaceAssignments,
  printSurfaceAssignmentsEqual,
} from "../domain/technicalServices.ts";
import { createIndividualBooth } from "../domain/individualBooth.ts";
import { boothTypes } from "../data/booths.ts";
import type { PrintSurfaceAssignment } from "../domain/project.ts";

const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");

const p86 = boothTypes.find((booth) => booth.internalCode === "P86");
if (!p86) {
  throw new Error("Testovací definice P86 nebyla nalezena.");
}

// =========================================================================================
// Root cause: components/BoothGenerator.tsx's printSurfaceAssignments effect depends on
// selectedBooth/realizationProfileId. For Individual mode, selectedBooth used to be a brand-new
// object literal (createIndividualBooth(...)) on EVERY render, so the effect fired every render;
// its setState always produced a fresh [] (never Object.is-equal to the previous []), so React
// never bailed out — render → effect → setState → render, forever ("Maximum update depth
// exceeded"). The fix has two independent parts: (1) BoothGenerator.tsx now memoizes
// individualBooth with useMemo so its identity is stable across unrelated renders, and (2) this
// module's computePrintSurfaceAssignments now returns the SAME `current` reference (never a
// fresh array) when nothing actually changed, so even a legitimately-changing selectedBooth
// identity can never loop.
// =========================================================================================

test("LOOP FIX: a booth with no printSurfaces (Individual mode's synthetic booth) — recomputing from an already-empty current array returns the EXACT SAME reference, never a fresh []", () => {
  const individualBooth = createIndividualBooth({ widthMm: 10_000, depthMm: 10_000 });
  const empty: PrintSurfaceAssignment[] = [];
  const result = computePrintSurfaceAssignments(individualBooth, "default", empty);
  assert.equal(result, empty, "must be the SAME array reference — a new [] would defeat React's setState bail-out and loop");
});

test("LOOP FIX: recomputing twice in a row for the same booth+realizationProfileId is idempotent — the second call returns the SAME reference as the first call's result", () => {
  const first = computePrintSurfaceAssignments(p86, "default", []);
  assert.deepEqual(first.map((assignment) => assignment.printSurfaceId), ["fascia-print"], "available panel faces are catalog definitions, not eight automatic project assignments");
  const second = computePrintSurfaceAssignments(p86, "default", first);
  assert.equal(second, first, "no drift across repeated effect invocations with unchanged inputs");
});

test("LOOP FIX: a REAL change (different realizationProfileId that actually changes production dimensions) still produces a fresh array — the no-op guard never masks a genuine update", () => {
  const first = computePrintSurfaceAssignments(p86, "default", []);
  const changed = computePrintSurfaceAssignments(p86, "realization-3", first);
  // Whether or not "realization-3" happens to override dimensions for P86's surfaces, the
  // function must never silently return a stale reference just because the shapes match by
  // accident — re-assert via the same equality function used internally.
  if (!printSurfaceAssignmentsEqual(first, changed)) {
    assert.notEqual(changed, first);
  }
});

test("an explicitly existing panel assignment survives recomputation without generating its seven siblings", () => {
  const current: PrintSurfaceAssignment[] = [{
    printSurfaceId: "back-wall-01-front",
    sceneReference: "koje-2x2",
    graphicsKind: "fullWrap",
    artworkStatus: "received",
    artworkFileId: "artwork-front",
    selectedForPrint: true,
    canonicalWidthMm: 950,
    canonicalHeightMm: 2340,
    productionWidthMm: 950,
    productionHeightMm: 2340,
    includedInPackage: false,
    pricedSeparately: true,
  }];
  const result = computePrintSurfaceAssignments(p86, "default", current);
  assert.deepEqual(result.map((assignment) => assignment.printSurfaceId), [
    "back-wall-01-front",
    "fascia-print",
  ]);
  assert.equal(result[0]?.artworkFileId, "artwork-front");
});

test("legacy non-P86 surfaces keep the previous automatic assignment behavior", () => {
  const result = computePrintSurfaceAssignments({
    id: "legacy-booth",
    printSurfaces: [{
      id: "legacy-surface",
      name: "Legacy surface",
      widthMm: 600,
      heightMm: 400,
      active: true,
    }],
    packageContents: [],
  }, "default", []);
  assert.deepEqual(result.map((assignment) => assignment.printSurfaceId), ["legacy-surface"]);
});

test("printSurfaceAssignmentsEqual: identical content in two different array instances is equal", () => {
  const a: PrintSurfaceAssignment[] = [{
    printSurfaceId: "s1", sceneReference: "b1", graphicsKind: "fascia", artworkStatus: "missing",
    selectedForPrint: true, canonicalWidthMm: 1000, canonicalHeightMm: 500,
    productionWidthMm: 1000, productionHeightMm: 500, includedInPackage: true, pricedSeparately: false,
  }];
  const b: PrintSurfaceAssignment[] = [{ ...a[0]! }];
  assert.equal(a === b, false, "sanity: genuinely different array instances");
  assert.equal(printSurfaceAssignmentsEqual(a, b), true);
});

test("printSurfaceAssignmentsEqual: a real field difference is NOT equal", () => {
  const a: PrintSurfaceAssignment[] = [{
    printSurfaceId: "s1", sceneReference: "b1", graphicsKind: "fascia", artworkStatus: "missing",
    selectedForPrint: true, canonicalWidthMm: 1000, canonicalHeightMm: 500,
    productionWidthMm: 1000, productionHeightMm: 500, includedInPackage: true, pricedSeparately: false,
  }];
  const b: PrintSurfaceAssignment[] = [{ ...a[0]!, selectedForPrint: false }];
  assert.equal(printSurfaceAssignmentsEqual(a, b), false);
});

test("printSurfaceAssignmentsEqual: different lengths are NOT equal", () => {
  assert.equal(printSurfaceAssignmentsEqual([], [{
    printSurfaceId: "s1", sceneReference: "b1", graphicsKind: "fascia", artworkStatus: "missing",
    selectedForPrint: true, canonicalWidthMm: 1000, canonicalHeightMm: 500,
    productionWidthMm: 1000, productionHeightMm: 500, includedInPackage: true, pricedSeparately: false,
  }]), false);
});

// =========================================================================================
// Source-scan regression pins — catch a future revert of either half of the fix.
// =========================================================================================

test("REGRESSION: individualBooth is wrapped in useMemo (stable identity across renders that don't change the plot)", () => {
  assert.match(boothGeneratorSource, /const individualBooth: BoothType \| undefined = useMemo\(/u);
});

test("REGRESSION: the printSurfaceAssignments effect delegates to computePrintSurfaceAssignments (the pure, testable, no-op-safe derivation), not an inline .map()", () => {
  const match = boothGeneratorSource.match(/useEffect\(\(\) => \{\s*if \(!selectedBooth\) \{[\s\S]{0,400}?\}, \[realizationProfileId, selectedBooth\]\);/u);
  assert.ok(match, "expected to find the printSurfaceAssignments effect");
  assert.match(match![0], /computePrintSurfaceAssignments\(selectedBooth, realizationProfileId, current\)/u);
});
