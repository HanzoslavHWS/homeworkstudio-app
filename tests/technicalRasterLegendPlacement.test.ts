import assert from "node:assert/strict";
import test from "node:test";
import {
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
