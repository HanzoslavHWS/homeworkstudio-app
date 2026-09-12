import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAffineTransform,
  invertAffineTransform,
  normalizedDisplayPointToRawPdfPoint,
  normalizedDisplayRectToRawPdfBoundingBox,
  type AffineTransform6,
} from "../domain/technicalRasterExportPlacementGeometry.ts";

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${actual} to be close to ${expected}`);
}

test("invertAffineTransform: rotation-0 pdf.js-style transform ([1,0,0,-1,0,H], a pure y-flip) is its own inverse", () => {
  const H = 800;
  const transform: AffineTransform6 = [1, 0, 0, -1, 0, H];
  const inverse = invertAffineTransform(transform);
  assert.deepEqual(inverse.map((v) => v + 0), transform.map((v) => v + 0), "mathematically identical (a stray -0 vs 0 is not a real discrepancy)");
});

test("invertAffineTransform + applyAffineTransform: forward then inverse recovers the original point, for several representative rotation-like transforms", () => {
  const cases: readonly AffineTransform6[] = [
    [1, 0, 0, -1, 0, 800], // rotation 0
    [0, 1, 1, 0, 0, 0], // rotation-90-like (axis swap)
    [0, -1, -1, 0, 600, 800], // rotation-270-like with offset
    [-1, 0, 0, 1, 600, 0], // rotation-180-like
    [2, 0, 0, -2, 10, 500], // a non-unit scale + translation, still invertible
  ];
  for (const transform of cases) {
    for (const point of [{ x: 0, y: 0 }, { x: 100, y: 250 }, { x: 599.9, y: 799.9 }]) {
      const forward = applyAffineTransform(transform, point.x, point.y);
      const inverse = invertAffineTransform(transform);
      const back = applyAffineTransform(inverse, forward.x, forward.y);
      assertClose(back.x, point.x, 1e-6);
      assertClose(back.y, point.y, 1e-6);
    }
  }
});

test("invertAffineTransform: throws on a genuinely singular matrix, never silently returns garbage", () => {
  assert.throws(() => invertAffineTransform([0, 0, 0, 0, 0, 0]));
});

test("normalizedDisplayPointToRawPdfPoint: rotation 0 — center of the page maps to raw (W/2, H/2), origin (0,0) maps to raw (0, H)", () => {
  const W = 600;
  const H = 800;
  const viewportTransform: AffineTransform6 = [1, 0, 0, -1, 0, H]; // pdf.js's own scale=1/rotation=0 formula
  const center = normalizedDisplayPointToRawPdfPoint(0.5, 0.5, W, H, viewportTransform);
  assertClose(center.x, W / 2);
  assertClose(center.y, H / 2);

  const topLeft = normalizedDisplayPointToRawPdfPoint(0, 0, W, H, viewportTransform);
  assertClose(topLeft.x, 0);
  assertClose(topLeft.y, H); // top-left DISPLAY (y=0) is the raw page's TOP edge (y=H, since raw y grows up)

  const bottomRight = normalizedDisplayPointToRawPdfPoint(1, 1, W, H, viewportTransform);
  assertClose(bottomRight.x, W);
  assertClose(bottomRight.y, 0);
});

test("normalizedDisplayPointToRawPdfPoint: a rotated (90-like) transform still round-trips through the SAME forward transform correctly", () => {
  // Display dims are swapped for a 90-rotated page (raw W=600,H=800 -> display 800x600).
  const displayW = 800;
  const displayH = 600;
  const viewportTransform: AffineTransform6 = [0, 1, 1, 0, 0, 0];
  const point = normalizedDisplayPointToRawPdfPoint(0.25, 0.75, displayW, displayH, viewportTransform);
  // Forward-transform the raw point back through the SAME transform and confirm it reproduces the display point we started from.
  const forwardAgain = applyAffineTransform(viewportTransform, point.x, point.y);
  assertClose(forwardAgain.x, 0.25 * displayW);
  assertClose(forwardAgain.y, 0.75 * displayH);
});

// ============================================================================
// Corrective batch section 7 — normalizedDisplayRectToRawPdfBoundingBox (the legend's own
// "source-legend-area" placement geometry).
// ============================================================================

test("normalizedDisplayRectToRawPdfBoundingBox: rotation 0 — a bottom-right region maps to a raw box near the page's own bottom-right raw corner", () => {
  const W = 600;
  const H = 800;
  const viewportTransform: AffineTransform6 = [1, 0, 0, -1, 0, H];
  const box = normalizedDisplayRectToRawPdfBoundingBox({ xNormalized: 0.8, yNormalized: 0.9, widthNormalized: 0.15, heightNormalized: 0.08 }, W, H, viewportTransform);
  assertClose(box.x, 0.8 * W);
  assertClose(box.width, 0.15 * W);
  // display y grows DOWN, raw y grows UP — the region's own bottom edge (display y=0.98) becomes the raw box's own LOWER y.
  assertClose(box.y, (1 - 0.98) * H);
  assertClose(box.height, 0.08 * H);
});

test("normalizedDisplayRectToRawPdfBoundingBox: a 90-degree-rotated transform still produces a real, positive-area axis-aligned box (never assumes raw axes match display axes)", () => {
  const displayW = 800;
  const displayH = 600;
  const viewportTransform: AffineTransform6 = [0, 1, 1, 0, 0, 0];
  const box = normalizedDisplayRectToRawPdfBoundingBox({ xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.2, heightNormalized: 0.3 }, displayW, displayH, viewportTransform);
  assert.ok(box.width > 0 && box.height > 0, "a rotated region must still resolve to a real, positive-area raw box");
});

test("normalizedDisplayRectToRawPdfBoundingBox: the full-page region (0,0,1,1) resolves to exactly the page's own raw bounding box", () => {
  const W = 600;
  const H = 800;
  const viewportTransform: AffineTransform6 = [1, 0, 0, -1, 0, H];
  const box = normalizedDisplayRectToRawPdfBoundingBox({ xNormalized: 0, yNormalized: 0, widthNormalized: 1, heightNormalized: 1 }, W, H, viewportTransform);
  assertClose(box.x, 0);
  assertClose(box.y, 0);
  assertClose(box.width, W);
  assertClose(box.height, H);
});
