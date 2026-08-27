import assert from "node:assert/strict";
import test from "node:test";
import {
  composeStrictLockImage,
  DEFAULT_FEATHER_RADIUS_PX,
  featherMask,
  type PixelBuffer,
} from "../domain/visualizationCompositing.ts";

const BEAUTY_RGB = [10, 20, 30] as const;
const AI_RGB = [200, 210, 220] as const;

function solidBuffer(width: number, height: number, [r, g, b]: readonly [number, number, number], alpha = 255): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}

/** A binary mask: 255 inside the given rectangle (inclusive bounds), 0 everywhere else. */
function rectMask(width: number, height: number, rect: { x0: number; y0: number; x1: number; y1: number }): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
      const v = inside ? 255 : 0;
      const i = (y * width + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function pixelAt(buffer: PixelBuffer, x: number, y: number): readonly [number, number, number, number] {
  const i = (y * buffer.width + x) * 4;
  return [buffer.data[i]!, buffer.data[i + 1]!, buffer.data[i + 2]!, buffer.data[i + 3]!];
}

const SIZE = 30;
const PROTECTED_RECT = { x0: 10, y0: 10, x1: 19, y1: 19 }; // 10x10 square, centered-ish

function standardFixture() {
  return {
    beauty: solidBuffer(SIZE, SIZE, BEAUTY_RGB),
    aiEnvironment: solidBuffer(SIZE, SIZE, AI_RGB),
    protectedMask: rectMask(SIZE, SIZE, PROTECTED_RECT),
  };
}

// =========================================================================================
// Visualization v3 — the pixel-protection guarantee (report sections 7/25/42): protected
// interior pixels of the final image MUST equal the authoritative source, provably, not
// visually-guessed. This is the load-bearing test file for the whole batch.
// =========================================================================================

test("PROTECTED INTERIOR: deep inside the protected mask (>radius from any edge), output is byte-exact the authoritative beauty pixel", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage(fixture);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // Center of the 10x10 protected square, well over DEFAULT_FEATHER_RADIUS_PX (3) from any edge.
  assert.deepEqual(pixelAt(result.composed, 14, 14), [...BEAUTY_RGB, 255]);
});

test("EDITABLE REGION: far outside the protected mask (>radius from any edge), output is byte-exact the AI environment pixel", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage(fixture);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.deepEqual(pixelAt(result.composed, 0, 0), [...AI_RGB, 255]);
  assert.deepEqual(pixelAt(result.composed, SIZE - 1, SIZE - 1), [...AI_RGB, 255]);
});

test("FEATHER BAND: at the exact mask boundary, output is a genuine blend — strictly between beauty and AI on every channel", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 4 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // x=10 is the left edge of the protected rect — squarely inside the feather band.
  const [r, g, b] = pixelAt(result.composed, PROTECTED_RECT.x0, 14);
  assert.ok(r > BEAUTY_RGB[0] && r < AI_RGB[0], `expected a blended R channel, got ${r}`);
  assert.ok(g > BEAUTY_RGB[1] && g < AI_RGB[1], `expected a blended G channel, got ${g}`);
  assert.ok(b > BEAUTY_RGB[2] && b < AI_RGB[2], `expected a blended B channel, got ${b}`);
});

test("FEATHER RADIUS 0: byte-identical to a hard binary cutoff — no blending anywhere, even exactly at the mask edge", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 0 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // Exactly at the boundary pixel (inside the rect by the rect's own inclusive definition):
  assert.deepEqual(pixelAt(result.composed, PROTECTED_RECT.x0, 14), [...BEAUTY_RGB, 255]);
  // One pixel outside the rect:
  assert.deepEqual(pixelAt(result.composed, PROTECTED_RECT.x0 - 1, 14), [...AI_RGB, 255]);
});

test("FEATHERMASK NO-OP: radiusPx <= 0 returns the exact same mask reference, unchanged", () => {
  const mask = rectMask(SIZE, SIZE, PROTECTED_RECT);
  assert.equal(featherMask(mask, 0), mask);
  assert.equal(featherMask(mask, -1), mask);
});

test("LARGE RADIUS STRESS: even with a feather radius comparable to the protected region, the deep interior (still >radius from any edge) stays exact", () => {
  // A larger canvas with generous margins: the box blur's influence near a corner extends
  // `radius` px along EACH axis independently (it's separable, not circular/Euclidean), so a
  // point must be more than `radius` away from the mask on BOTH axes to be guaranteed
  // uncontaminated — a smaller canvas where the mask fills most of it leaves no such point.
  const bigSize = 50;
  const bigRect = { x0: 15, y0: 15, x1: 34, y1: 34 }; // 20x20 square, 15px margin on every side
  const fixture = { beauty: solidBuffer(bigSize, bigSize, BEAUTY_RGB), aiEnvironment: solidBuffer(bigSize, bigSize, AI_RGB), protectedMask: rectMask(bigSize, bigSize, bigRect) };
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 6 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // Center of the 20x20 square — far more than 6px from any edge.
  assert.deepEqual(pixelAt(result.composed, 24, 24), [...BEAUTY_RGB, 255]);
  // Far corner — 15px margin, well over radius 6 on both axes.
  assert.deepEqual(pixelAt(result.composed, 0, 0), [...AI_RGB, 255]);
});

test("RESOLUTION: output width/height always equal the beauty (source) buffer's, never resized", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage(fixture);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.composed.width, SIZE);
  assert.equal(result.composed.height, SIZE);
});

test("NO MUTATION: composeStrictLockImage never mutates the beauty/aiEnvironment/protectedMask input buffers", () => {
  const fixture = standardFixture();
  const beautyClone = new Uint8ClampedArray(fixture.beauty.data);
  const aiClone = new Uint8ClampedArray(fixture.aiEnvironment.data);
  const maskClone = new Uint8ClampedArray(fixture.protectedMask.data);
  composeStrictLockImage(fixture);
  assert.deepEqual(fixture.beauty.data, beautyClone);
  assert.deepEqual(fixture.aiEnvironment.data, aiClone);
  assert.deepEqual(fixture.protectedMask.data, maskClone);
});

test("DIMENSION MISMATCH: mismatched buffer dimensions return a typed ok:false, never throw or silently composite", () => {
  const fixture = standardFixture();
  const wrongSize = solidBuffer(SIZE + 1, SIZE, AI_RGB);
  const result = composeStrictLockImage({ ...fixture, aiEnvironment: wrongSize });
  assert.equal(result.ok, false);
  if (result.ok !== false) return;
  assert.equal(result.reason, "dimension-mismatch");
});

test("INVALID BUFFER LENGTH: a buffer whose data length doesn't match width*height*4 is rejected, never throws", () => {
  const fixture = standardFixture();
  const corrupt: PixelBuffer = { width: SIZE, height: SIZE, data: new Uint8ClampedArray(4) };
  const result = composeStrictLockImage({ ...fixture, beauty: corrupt });
  assert.equal(result.ok, false);
  if (result.ok !== false) return;
  assert.equal(result.reason, "invalid-buffer-length");
});

test("ARTWORK MASK STANDALONE: the SAME compositing function, given only an artwork-specific mask, protects artwork pixels independently of any booth-mask strategy", () => {
  // Simulates report section 42's "artwork protected region can never be replaced" test:
  // a small artwork rectangle INSIDE a larger area that is otherwise fully editable in this
  // mask (i.e. no booth-mask involved at all) — proving artwork protection doesn't depend on
  // whatever the booth-compositing strategy is, since here there IS no booth mask, only artwork.
  const artworkRect = { x0: 10, y0: 10, x1: 19, y1: 19 }; // 10x10, same margins as PROTECTED_RECT — safely beyond DEFAULT_FEATHER_RADIUS_PX (3) from the check points below
  const fixture = { beauty: solidBuffer(SIZE, SIZE, BEAUTY_RGB), aiEnvironment: solidBuffer(SIZE, SIZE, AI_RGB), protectedMask: rectMask(SIZE, SIZE, artworkRect) };
  const result = composeStrictLockImage(fixture);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.deepEqual(pixelAt(result.composed, 14, 14), [...BEAUTY_RGB, 255], "artwork interior stays exact");
  assert.deepEqual(pixelAt(result.composed, 0, 0), [...AI_RGB, 255], "outside artwork is fully AI-editable");
});

test("DEFAULT FEATHER: omitting featherRadiusPx uses DEFAULT_FEATHER_RADIUS_PX, not zero", () => {
  const fixture = standardFixture();
  const withDefault = composeStrictLockImage(fixture);
  const withExplicitDefault = composeStrictLockImage({ ...fixture, featherRadiusPx: DEFAULT_FEATHER_RADIUS_PX });
  assert.equal(withDefault.ok, true);
  assert.equal(withExplicitDefault.ok, true);
  if (withDefault.ok !== true || withExplicitDefault.ok !== true) return;
  assert.deepEqual(withDefault.composed.data, withExplicitDefault.composed.data);
});
