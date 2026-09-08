import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_RENDER_SCALE,
  MAX_CANVAS_AREA_PX,
  MAX_CANVAS_DIMENSION_PX,
  MAX_RENDER_SCALE,
  computeEffectiveRenderScale,
  isWithinCanvasPixelBudget,
} from "../domain/technicalRasterRenderScale.ts";

// =========================================================================================
// Technické rastry — dynamic pdf.js render resolution (spec batch 4, UI section 9/10/11/30). Real
// page dimensions here are Hala 1.pdf's own (992x680pt, verified against the real fixture in an
// earlier hotfix's diagnostic) so the pixel-budget math is checked against an actual production
// page, not an arbitrary made-up size.
// =========================================================================================

const HALA1_WIDTH_PT = 992;
const HALA1_HEIGHT_PT = 680;

test("zoom 1 -> BASE_RENDER_SCALE (today's existing baseline, unchanged)", () => {
  const scale = computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, 1);
  assert.equal(scale, BASE_RENDER_SCALE);
});

test("zoom 6 -> strictly higher than zoom 1's scale (sharper at typical working zoom)", () => {
  const atZoom1 = computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, 1);
  const atZoom6 = computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, 6);
  assert.ok(atZoom6 > atZoom1, `expected zoom=6 scale (${atZoom6}) > zoom=1 scale (${atZoom1})`);
});

test("zoom 35 (the UI's real max, ~3500%) -> capped, never grows further than zoom 6's already-capped value for the SAME page", () => {
  const atZoom6 = computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, 6);
  const atZoom35 = computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, 35);
  assert.ok(atZoom35 <= atZoom6 * 1.0001, `expected zoom=35 scale (${atZoom35}) to be capped at/below zoom=6's (${atZoom6})`);
  assert.ok(atZoom35 <= MAX_RENDER_SCALE);
});

test("result is monotonically non-decreasing in zoom, up to the cap", () => {
  const scales = [1, 2, 3, 4, 6, 8, 12, 20, 35].map((zoom) => computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, zoom));
  for (let i = 1; i < scales.length; i += 1) {
    assert.ok(scales[i]! >= scales[i - 1]!, `scale must never decrease as zoom increases: ${scales.join(", ")}`);
  }
});

test("never below BASE_RENDER_SCALE even at very low zoom (never softer than today's shipped baseline)", () => {
  const scale = computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, 0.02);
  assert.equal(scale, BASE_RENDER_SCALE);
});

test("pixel budget: at every zoom level from 1 to 35, the real Hala 1.pdf page never produces a canvas exceeding the pixel-dimension/area budget", () => {
  for (const zoom of [1, 2, 3, 6, 10, 20, 35, 40]) {
    const scale = computeEffectiveRenderScale(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, zoom);
    assert.ok(
      isWithinCanvasPixelBudget(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, scale),
      `zoom=${zoom} produced scale=${scale}, canvas ${Math.ceil(HALA1_WIDTH_PT * scale)}x${Math.ceil(HALA1_HEIGHT_PT * scale)} — exceeds budget`,
    );
  }
});

test("pixel budget guard rejects an intentionally oversized canvas (sanity check on the helper itself)", () => {
  assert.equal(isWithinCanvasPixelBudget(HALA1_WIDTH_PT, HALA1_HEIGHT_PT, 100), false, "992x680 at scale 100 is a ~99200x68000 canvas — must fail the budget check");
});

test("a much larger page (e.g. a big hall plan) still respects the pixel budget at high zoom — the cap is driven by the page's OWN size, never a fixed scale alone", () => {
  const bigWidthPt = 5000;
  const bigHeightPt = 3500;
  const scale = computeEffectiveRenderScale(bigWidthPt, bigHeightPt, 35);
  assert.ok(isWithinCanvasPixelBudget(bigWidthPt, bigHeightPt, scale));
  assert.ok(scale < BASE_RENDER_SCALE * 35, "must be capped well below the naive zoom-driven value for a page this large");
});

test("degenerate page size (0 or negative) never throws or divides by zero — falls back to the plain zoom-driven scale", () => {
  assert.doesNotThrow(() => computeEffectiveRenderScale(0, 0, 6));
  const scale = computeEffectiveRenderScale(0, 0, 6);
  assert.ok(Number.isFinite(scale) && scale > 0);
});

test("MAX_CANVAS_DIMENSION_PX/MAX_CANVAS_AREA_PX are themselves sane, real-world safe values (spec section 11: never a runaway canvas)", () => {
  assert.ok(MAX_CANVAS_DIMENSION_PX < 16384, "stays under common browser single-dimension canvas limits");
  assert.ok(MAX_CANVAS_AREA_PX < 268_000_000, "stays comfortably under common browser canvas area limits");
});
