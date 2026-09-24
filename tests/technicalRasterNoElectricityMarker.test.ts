import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNoElectricityMarkerGeometry,
  computeNoElectricityMarkerScreenStyle,
  NO_ELECTRICITY_MARKER_FALLBACK_OFFSET_NORMALIZED,
} from "../domain/technicalRasterNoElectricityMarker.ts";

test("AUTO (bbox present): the marker CENTER sits just past the label bbox's own right edge, vertically centered — never covering the number", () => {
  const geometry = computeNoElectricityMarkerGeometry(
    { xNormalized: 0.2, yNormalized: 0.3 },
    { widthNormalized: 0.03, heightNormalized: 0.015 },
  );
  assert.ok(geometry.xNormalized > 0.2 + 0.03, "must sit past the bbox's own right edge, never overlapping the number");
  assert.equal(geometry.yNormalized, 0.3 + 0.015 / 2, "vertically centered on the bbox");
});

test("MANUAL (no bbox): a small, fixed conservative offset from the anchor — never a guessed bbox", () => {
  const geometry = computeNoElectricityMarkerGeometry({ xNormalized: 0.5, yNormalized: 0.5 });
  assert.equal(geometry.xNormalized, 0.5 + NO_ELECTRICITY_MARKER_FALLBACK_OFFSET_NORMALIZED);
  assert.equal(geometry.yNormalized, 0.5);
});

test("geometry is a pure function of anchor + bbox — same inputs always produce the same output", () => {
  const a = computeNoElectricityMarkerGeometry({ xNormalized: 0.11, yNormalized: 0.22 }, { widthNormalized: 0.02, heightNormalized: 0.01 });
  const b = computeNoElectricityMarkerGeometry({ xNormalized: 0.11, yNormalized: 0.22 }, { widthNormalized: 0.02, heightNormalized: 0.01 });
  assert.deepEqual(a, b);
});

test("computeNoElectricityMarkerScreenStyle is zoom-invariant: higher zoom -> smaller pre-transform font size, so the ON-SCREEN size stays constant", () => {
  const at1x = computeNoElectricityMarkerScreenStyle(1);
  const at4x = computeNoElectricityMarkerScreenStyle(4);
  assert.ok(at4x.fontSizePx < at1x.fontSizePx);
  assert.ok(Math.abs(at1x.fontSizePx * 1 - at4x.fontSizePx * 4) < 1e-9, "the ROUND-TRIP (pre-transform size * zoom) must be the same constant target size at any zoom");
});
