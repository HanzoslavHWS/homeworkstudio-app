import test from "node:test";
import assert from "node:assert/strict";
import { mapNormalizedPointToRect, resolveContainRect } from "../lib/pdf/imageRect.ts";

// =========================================================================================
// Marker-overlay follow-up (spec section 9) — pure geometry, no jsPDF dependency.
// =========================================================================================

test("mapNormalizedPointToRect: 0.5/0.5 maps to the exact center of the rendered image rect", () => {
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  const point = mapNormalizedPointToRect(0.5, 0.5, rect);
  assert.equal(point.x, 10 + 50);
  assert.equal(point.y, 20 + 30);
});

test("mapNormalizedPointToRect: 0/0 maps to the rect's top-left corner", () => {
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  const point = mapNormalizedPointToRect(0, 0, rect);
  assert.equal(point.x, 10);
  assert.equal(point.y, 20);
});

test("mapNormalizedPointToRect: 1/1 maps to the rect's bottom-right corner", () => {
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  const point = mapNormalizedPointToRect(1, 1, rect);
  assert.equal(point.x, 10 + 100);
  assert.equal(point.y, 20 + 60);
});

test("resolveContainRect: a wide box + a narrower (more portrait) image contains by height, horizontally centered — the rect is SMALLER than the box", () => {
  // box: 160 x 60mm; image: 800x600px (4:3, aspect 1.333) — box aspect (160/60=2.667) > image aspect, so height-constrained.
  const box = { x: 0, y: 0, width: 160, height: 60 };
  const rect = resolveContainRect(box, 800, 600);
  assert.equal(rect.height, 60); // full box height used
  assert.equal(rect.width, 60 * (800 / 600)); // 80mm — narrower than the 160mm box
  assert.ok(rect.width < box.width);
  assert.equal(rect.x, box.x + (box.width - rect.width) / 2); // horizontally centered within the box
  assert.equal(rect.y, box.y); // top-aligned, never vertically shifted
});

test("resolveContainRect: a tall/narrow image inside a wide box is width-constrained, height shrinks below the box", () => {
  // image 600x1600px (very tall, aspect 0.375) inside a 100x140 box (aspect 0.714) — image aspect < box aspect -> width-constrained branch.
  const box = { x: 5, y: 5, width: 100, height: 140 };
  const rect = resolveContainRect(box, 600, 1600);
  assert.equal(rect.width, box.height * (600 / 1600)); // height-driven width — smaller than box.width
  assert.ok(rect.width < box.width);
  assert.equal(rect.height, box.height);
});

test("a marker's position is computed against the CONTAIN-fitted image rect, never the outer layout box (spec section 6) — same normalized point yields a DIFFERENT pixel position depending on which rect is used", () => {
  const box = { x: 0, y: 0, width: 160, height: 60 };
  const imageRect = resolveContainRect(box, 800, 600); // narrower than box — see the test above
  const pointAgainstImageRect = mapNormalizedPointToRect(1, 0.5, imageRect);
  const pointAgainstBoxDirectly = mapNormalizedPointToRect(1, 0.5, box);
  assert.notEqual(pointAgainstImageRect.x, pointAgainstBoxDirectly.x, "the box is wider than the rendered image, so mapping against the box directly would place the marker off the actual photo");
  // the correct (image-rect-based) x must land INSIDE the box bounds, at the image's own right edge, not the box's.
  assert.equal(pointAgainstImageRect.x, imageRect.x + imageRect.width);
  assert.ok(pointAgainstImageRect.x < box.x + box.width);
});

test("resolveContainRect: degenerate zero-size box or image never throws, returns a zero-area rect", () => {
  assert.deepEqual(resolveContainRect({ x: 1, y: 2, width: 0, height: 10 }, 800, 600), { x: 1, y: 2, width: 0, height: 0 });
  assert.deepEqual(resolveContainRect({ x: 1, y: 2, width: 10, height: 10 }, 0, 600), { x: 1, y: 2, width: 0, height: 0 });
});
