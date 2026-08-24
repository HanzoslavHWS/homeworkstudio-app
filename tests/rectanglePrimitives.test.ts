import assert from "node:assert/strict";
import test from "node:test";
import {
  createRectanglePrimitive,
  duplicatePrimitive,
  mergePrimitivesToPolygon,
  rectanglePrimitivePolygon,
  rotatePrimitive90,
} from "../domain/rectanglePrimitives.ts";
import { plotAreaSquareMeters } from "../domain/plot.ts";
import { validatePolygon } from "../geometry/polygons.ts";

// =========================================================================================
// Turn 5 LIVE QA sections 5-11/48: rectangle-primitive authoring — insert/move/rotate/delete/
// duplicate, and the union action ("Sloučit do plochy stánku") that turns a valid, CONNECTED set
// of primitives into one real booth polygon via geometry/polygonBoolean.ts (the `polygon-clipping`
// library — never a hand-rolled clip/union engine).
// =========================================================================================

test("PRIMITIVE: created at a center point, corners are exactly width/depth apart, no rotation by default", () => {
  const primitive = createRectanglePrimitive({ id: "a", xMm: 2500, yMm: 2500, widthMm: 5000, depthMm: 5000 });
  const polygon = rectanglePrimitivePolygon(primitive);
  assert.equal(plotAreaSquareMeters(polygon), 25);
  assert.deepEqual(polygon, [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }, { x: 0, y: 5000 }]);
});

test("PRIMITIVE: rotatePrimitive90 cycles 0 -> 90 -> 180 -> 270 -> 0, area is unaffected by rotation", () => {
  let primitive = createRectanglePrimitive({ id: "a", xMm: 1000, yMm: 1000, widthMm: 4000, depthMm: 2000 });
  const steps = [90, 180, 270, 0];
  for (const expected of steps) {
    primitive = rotatePrimitive90(primitive);
    assert.equal(primitive.rotationDeg, expected);
    assert.equal(plotAreaSquareMeters(rectanglePrimitivePolygon(primitive)), 8);
  }
});

test("PRIMITIVE: duplicatePrimitive offsets the copy by one grid step — never an exact silent stack on the original", () => {
  const original = createRectanglePrimitive({ id: "a", xMm: 1000, yMm: 1000, widthMm: 1000, depthMm: 1000 });
  const copy = duplicatePrimitive(original, "b");
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.xMm, original.xMm);
  assert.notEqual(copy.yMm, original.yMm);
});

test("UNION: A 5000x5000 + B 2000x3000 attached at A's edge -> valid single-region union, correct combined area, no double-count", () => {
  const a = createRectanglePrimitive({ id: "a", xMm: 2500, yMm: 2500, widthMm: 5000, depthMm: 5000 }); // spans x:[0,5000] y:[0,5000]
  const b = createRectanglePrimitive({ id: "b", xMm: 6000, yMm: 1500, widthMm: 2000, depthMm: 3000 }); // spans x:[5000,7000] y:[0,3000] — touches A's right edge
  const result = mergePrimitivesToPolygon([a, b]);
  assert.equal(result.status, "merged");
  if (result.status === "merged") {
    assert.equal(plotAreaSquareMeters(result.polygon), 25 + 6, "25 m^2 (A) + 6 m^2 (B), no overlap to double-count");
  }
});

test("UNION: overlapping primitives produce the correct union area (overlap counted once, not twice)", () => {
  const a = createRectanglePrimitive({ id: "a", xMm: 2000, yMm: 2000, widthMm: 4000, depthMm: 4000 }); // x:[0,4000] y:[0,4000], 16 m^2
  const b = createRectanglePrimitive({ id: "b", xMm: 5000, yMm: 2000, widthMm: 4000, depthMm: 4000 }); // x:[3000,7000] y:[0,4000], 16 m^2, overlaps A in x:[3000,4000] (1000x4000 = 4 m^2)
  const result = mergePrimitivesToPolygon([a, b]);
  assert.equal(result.status, "merged");
  if (result.status === "merged") {
    assert.equal(plotAreaSquareMeters(result.polygon), 16 + 16 - 4, "union area = sum minus the shared overlap, never double-counted");
  }
});

test("UNION: edge-adjacent primitives (touching, zero overlap) still merge into one connected polygon", () => {
  const a = createRectanglePrimitive({ id: "a", xMm: 1500, yMm: 1500, widthMm: 3000, depthMm: 3000 }); // x:[0,3000]
  const b = createRectanglePrimitive({ id: "b", xMm: 4500, yMm: 1500, widthMm: 3000, depthMm: 3000 }); // x:[3000,6000] — shares the x=3000 edge exactly
  const result = mergePrimitivesToPolygon([a, b]);
  assert.equal(result.status, "merged");
  if (result.status === "merged") {
    assert.equal(plotAreaSquareMeters(result.polygon), 9 + 9);
  }
});

test("UNION: disconnected primitives (a real gap between them) cannot be merged into a single booth polygon — hard failure, never a fake connecting edge", () => {
  const a = createRectanglePrimitive({ id: "a", xMm: 500, yMm: 500, widthMm: 1000, depthMm: 1000 }); // x:[0,1000]
  const b = createRectanglePrimitive({ id: "b", xMm: 5500, yMm: 500, widthMm: 1000, depthMm: 1000 }); // x:[5000,6000] — a 4000mm gap
  const result = mergePrimitivesToPolygon([a, b]);
  assert.equal(result.status, "disconnected");
  if (result.status === "disconnected") {
    assert.equal(result.regionCount, 2);
  }
});

test("UNION: an empty primitive list cannot be merged", () => {
  const result = mergePrimitivesToPolygon([]);
  assert.equal(result.status, "no-primitives");
});

// =========================================================================================
// Live QA regression (Turn 5): two EXACTLY overlapping primitives (a real, expected user
// scenario — e.g. two primitives added back-to-back before either was moved) produced a merged
// polygon with a trailing zero-length edge (polygon-clipping returns explicitly-closed rings;
// this app's own polygons are implicitly closed) — invisible to area math but a hard
// validatePolygon failure ("Hrana s nulovou délkou"), caught live in the browser.
// =========================================================================================

test("UNION REGRESSION: two exactly identical/overlapping primitives merge into a clean, VALID polygon — no trailing zero-length closing edge", () => {
  const a = createRectanglePrimitive({ id: "a", xMm: 5000, yMm: 5000, widthMm: 1000, depthMm: 1000 });
  const b = createRectanglePrimitive({ id: "b", xMm: 5000, yMm: 5000, widthMm: 1000, depthMm: 1000 });
  const result = mergePrimitivesToPolygon([a, b]);
  assert.equal(result.status, "merged");
  if (result.status === "merged") {
    assert.equal(result.polygon.length, 4, "no duplicated closing vertex");
    assert.equal(validatePolygon(result.polygon).valid, true);
    assert.equal(plotAreaSquareMeters(result.polygon), 1);
  }
});
