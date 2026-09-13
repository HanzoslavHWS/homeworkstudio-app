import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUTO_LEGEND_PLACEMENT,
  DEFAULT_IN_PLACE_LEGEND_REGION,
  DEFAULT_LEGEND_PLACEMENT,
  isValidLegendSourceRegion,
  resolveEffectiveLegendPlacement,
  type TechnicalLegendSourceRegion,
} from "../domain/technicalRasterLegendPlacement.ts";

test("resolveEffectiveLegendPlacement: undefined -> today's existing separate-page default", () => {
  assert.deepEqual(resolveEffectiveLegendPlacement(undefined), DEFAULT_LEGEND_PLACEMENT);
});

test("resolveEffectiveLegendPlacement: source-legend-area WITHOUT a region safely falls back to separate-page, never a silent no-legend export", () => {
  assert.deepEqual(resolveEffectiveLegendPlacement({ strategy: "source-legend-area" }), DEFAULT_LEGEND_PLACEMENT);
});

test("resolveEffectiveLegendPlacement: source-legend-area WITH a real region is honored as-is", () => {
  const region: TechnicalLegendSourceRegion = { page: 1, xNormalized: 0.8, yNormalized: 0.8, widthNormalized: 0.15, heightNormalized: 0.15 };
  const placement = { strategy: "source-legend-area" as const, sourceRegion: region };
  assert.deepEqual(resolveEffectiveLegendPlacement(placement), placement);
});

// ============================================================================
// SIMPLIFIED LEGEND BATCH — the shared, hall-agnostic AUTOMATIC default (bottom-left area under
// the raster), consumed only via domain/technicalRaster.ts's own effectiveLegendPlacement. Never
// changes resolveEffectiveLegendPlacement's own DEFAULT_LEGEND_PLACEMENT (separate-page) safety net
// above — that one stays reserved for a "source-legend-area" strategy explicitly chosen with no
// region at all.
// ============================================================================

test("DEFAULT_AUTO_LEGEND_PLACEMENT: a real in-place region, in the bottom-left area (small x, large y — this app's normalized y grows downward) under the raster", () => {
  assert.equal(DEFAULT_AUTO_LEGEND_PLACEMENT.strategy, "source-legend-area");
  assert.equal(DEFAULT_AUTO_LEGEND_PLACEMENT.sourceRegion, DEFAULT_IN_PLACE_LEGEND_REGION);
  assert.ok(isValidLegendSourceRegion(DEFAULT_IN_PLACE_LEGEND_REGION), "the shared default region must itself be a real, valid, in-bounds rectangle");
  assert.ok(DEFAULT_IN_PLACE_LEGEND_REGION.xNormalized < 0.2, "expected the default region anchored near the LEFT edge");
  assert.ok(DEFAULT_IN_PLACE_LEGEND_REGION.yNormalized > 0.6, "expected the default region anchored near the BOTTOM edge (yNormalized grows downward)");
});

test("DEFAULT_AUTO_LEGEND_PLACEMENT is never confused with DEFAULT_LEGEND_PLACEMENT — the low-level separate-page safety net stays completely separate/untouched", () => {
  assert.notEqual(DEFAULT_AUTO_LEGEND_PLACEMENT.strategy, DEFAULT_LEGEND_PLACEMENT.strategy);
  assert.equal(DEFAULT_LEGEND_PLACEMENT.strategy, "separate-page");
  // resolveEffectiveLegendPlacement's own contract (a "source-legend-area" with no region falls
  // back to DEFAULT_LEGEND_PLACEMENT) is completely independent of the new automatic default above.
  assert.deepEqual(resolveEffectiveLegendPlacement({ strategy: "source-legend-area" }), DEFAULT_LEGEND_PLACEMENT);
});

test("isValidLegendSourceRegion: a normal in-bounds rectangle is valid", () => {
  assert.equal(isValidLegendSourceRegion({ page: 1, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.2, heightNormalized: 0.1 }), true);
});

test("isValidLegendSourceRegion: zero/negative width or height is invalid", () => {
  assert.equal(isValidLegendSourceRegion({ page: 1, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0, heightNormalized: 0.1 }), false);
  assert.equal(isValidLegendSourceRegion({ page: 1, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: -0.1, heightNormalized: 0.1 }), false);
});

test("isValidLegendSourceRegion: a rectangle extending past the page edge is invalid", () => {
  assert.equal(isValidLegendSourceRegion({ page: 1, xNormalized: 0.9, yNormalized: 0.1, widthNormalized: 0.2, heightNormalized: 0.1 }), false);
});

test("isValidLegendSourceRegion: negative origin is invalid", () => {
  assert.equal(isValidLegendSourceRegion({ page: 1, xNormalized: -0.1, yNormalized: 0.1, widthNormalized: 0.2, heightNormalized: 0.1 }), false);
});

test("isValidLegendSourceRegion: NaN/Infinity is invalid, never crashes", () => {
  assert.equal(isValidLegendSourceRegion({ page: 1, xNormalized: NaN, yNormalized: 0.1, widthNormalized: 0.2, heightNormalized: 0.1 }), false);
  assert.equal(isValidLegendSourceRegion({ page: 1, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: Infinity, heightNormalized: 0.1 }), false);
});
