import assert from "node:assert/strict";
import test from "node:test";
import {
  binarizeMask,
  composeStrictLockImage,
  computeProtectedFeatherMask,
  DEFAULT_FEATHER_RADIUS_PX,
  featherMask,
  visualizeDiffVsBeauty,
  visualizeFeatherBand,
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

test("v3.3c FEATHER GROWS OUTWARD ONLY: the boundary pixel itself (inside the mask, by rectMask's inclusive bounds) is BYTE-EXACT beauty — never blended, no matter the feather radius — because computeProtectedFeatherMask's max(binarized, blurred) never lets a genuinely-protected pixel drop below 255", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 4 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // x=10 (PROTECTED_RECT.x0) is the left edge column, still INSIDE the protected rect.
  assert.deepEqual(pixelAt(result.composed, PROTECTED_RECT.x0, 14), [...BEAUTY_RGB, 255]);
});

test("v3.3c FEATHER GROWS OUTWARD ONLY: a pixel just OUTSIDE the mask, within the feather radius, is a genuine blend — this is where the feather band actually lives now, not inside the protected region", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 4 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // x=9 is one pixel OUTSIDE the rect (x0=10), well within the radius-4 feather band.
  const [r, g, b] = pixelAt(result.composed, PROTECTED_RECT.x0 - 1, 14);
  assert.ok(r > BEAUTY_RGB[0] && r < AI_RGB[0], `expected a blended R channel, got ${r}`);
  assert.ok(g > BEAUTY_RGB[1] && g < AI_RGB[1], `expected a blended G channel, got ${g}`);
  assert.ok(b > BEAUTY_RGB[2] && b < AI_RGB[2], `expected a blended B channel, got ${b}`);
});

test("v3.3c FEATHER GROWS OUTWARD ONLY: further outside the mask, past the feather radius, output is pure AI again — the band doesn't grow the editable region without bound", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 4 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // x=5 is 5px outside the rect edge (x0=10) — past the radius-4 band.
  assert.deepEqual(pixelAt(result.composed, PROTECTED_RECT.x0 - 5, 14), [...AI_RGB, 255]);
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

// =========================================================================================
// v3.3c — "protected content duplicates/blends" fix. Root cause: the RAW captured protected
// mask is rendered on the SAME `antialias: true` WebGL canvas as every other pass, so thin
// protected geometry (chair legs, fascia edges) can have GPU-softened edge values across its
// ENTIRE width — no pixel in the raw mask is ever cleanly 255, so the OLD symmetric-blur
// compositor treated the whole thin feature as "in the feather band" and blended it with AI
// content everywhere, producing a visible ghost/duplicate. binarizeMask + the outward-only
// combinator in computeProtectedFeatherMask fix this at the root.
// =========================================================================================

test("v3.3c THIN PROTECTED FEATURE (the actual chair-leg bug): a raw mask with NO pixel at value 255 anywhere along a thin feature — every value soft/anti-aliased below 255 — still composites to byte-exact beauty wherever it's >= the binarize threshold, at ANY feather radius", () => {
  const width = 20, height = 5;
  const beauty = solidBuffer(width, height, BEAUTY_RGB);
  const aiEnvironment = solidBuffer(width, height, AI_RGB);

  // Simulates a GPU-antialiased raw capture of a 3px-wide protected strip (columns 8-10):
  // real-world MSAA softens the true edges but NEVER quite reaches 0 or 255 exactly across the
  // whole strip in this fixture, mirroring "no pixel is ever cleanly 255" for a thin object.
  const rawMask: PixelBuffer = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const columnValues = [0, 0, 0, 0, 0, 0, 0, 40, 210, 235, 210, 40, 0, 0, 0, 0, 0, 0, 0, 0]; // index = x
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = columnValues[x]!;
      const i = (y * width + x) * 4;
      rawMask.data[i] = v; rawMask.data[i + 1] = v; rawMask.data[i + 2] = v; rawMask.data[i + 3] = 255;
    }
  }

  for (const featherRadiusPx of [0, 1, 3, 5]) {
    const result = composeStrictLockImage({ beauty, aiEnvironment, protectedMask: rawMask, featherRadiusPx });
    assert.equal(result.ok, true);
    if (result.ok !== true) continue;
    // Columns 8,9,10 have raw values 210/235/210 — all >= the 128 binarize threshold — so they
    // must ALL be byte-exact beauty, regardless of feather radius, exactly the "no ghosting"
    // contract. (Under the old symmetric-blur-only behavior, these would have been visibly
    // blended with AI content at every one of these radii, since no raw value ever reached 255.)
    for (const x of [8, 9, 10]) {
      assert.deepEqual(pixelAt(result.composed, x, 2), [...BEAUTY_RGB, 255], `radius=${featherRadiusPx}, x=${x} must be exact beauty, no ghosting`);
    }
    // Column 7 (raw value 40, well below threshold) stays outside the protected region.
    assert.notDeepEqual(pixelAt(result.composed, 7, 2), [...BEAUTY_RGB, 255], `radius=${featherRadiusPx} — column 7 was never actually protected`);
  }
});

test("v3.3c binarizeMask: snaps every pixel to exactly 0 or 255 at the given threshold, alpha always 255, default threshold 128", () => {
  const values = [0, 50, 127, 128, 129, 200, 255];
  const mask: PixelBuffer = { width: values.length, height: 1, data: new Uint8ClampedArray(values.length * 4) };
  for (let i = 0; i < values.length; i++) { const v = values[i]!; mask.data[i * 4] = v; mask.data[i * 4 + 1] = v; mask.data[i * 4 + 2] = v; mask.data[i * 4 + 3] = 10; }
  const result = binarizeMask(mask);
  const expected = values.map((v) => (v >= 128 ? 255 : 0));
  for (let i = 0; i < values.length; i++) {
    assert.equal(result.data[i * 4], expected[i], `value ${values[i]} at index ${i}`);
    assert.equal(result.data[i * 4 + 3], 255, "binarized mask is always fully opaque, regardless of input alpha");
  }
});

test("v3.3c binarizeMask: custom threshold is honored", () => {
  const mask: PixelBuffer = { width: 3, height: 1, data: new Uint8ClampedArray(12) };
  mask.data.set([100, 100, 100, 255, 150, 150, 150, 255, 200, 200, 200, 255]);
  const result = binarizeMask(mask, 150);
  assert.equal(result.data[0], 0); // 100 < 150
  assert.equal(result.data[4], 255); // 150 >= 150
  assert.equal(result.data[8], 255); // 200 >= 150
});

test("v3.3c binarizeMask: never mutates its input", () => {
  const mask = rectMask(SIZE, SIZE, PROTECTED_RECT);
  const snapshot = Uint8ClampedArray.from(mask.data);
  binarizeMask(mask);
  assert.deepEqual(mask.data, snapshot);
});

test("v3.3c computeProtectedFeatherMask: radiusPx <= 0 still binarizes (removes raw AA softness) but skips the blur — a hard cutoff, not a no-op passthrough of the raw mask", () => {
  const raw: PixelBuffer = { width: 3, height: 1, data: new Uint8ClampedArray(12) };
  raw.data.set([200, 200, 200, 255, 10, 10, 10, 255, 200, 200, 200, 255]);
  const result = computeProtectedFeatherMask(raw, 0);
  assert.equal(result.data[0], 255, "200 >= 128 threshold -> binarized to 255, even though raw wasn't exactly 255");
  assert.equal(result.data[4], 0);
  assert.equal(result.data[8], 255);
});

test("v3.3c computeProtectedFeatherMask: interior of a large protected region is exactly 255 (max(255, blurred=255) = 255), exterior far away is exactly 0", () => {
  const mask = rectMask(SIZE, SIZE, PROTECTED_RECT);
  const result = computeProtectedFeatherMask(mask, 4);
  const interiorOffset = (14 * SIZE + 14) * 4;
  assert.equal(result.data[interiorOffset], 255);
  const exteriorOffset = (0 * SIZE + 0) * 4;
  assert.equal(result.data[exteriorOffset], 0);
});

test("v3.3c computeProtectedFeatherMask: never mutates its input", () => {
  const mask = rectMask(SIZE, SIZE, PROTECTED_RECT);
  const snapshot = Uint8ClampedArray.from(mask.data);
  computeProtectedFeatherMask(mask, 4);
  assert.deepEqual(mask.data, snapshot);
});

test("v3.3c DEBUG OVERLAY SUPPORT: composeStrictLockImage's ok:true result exposes the ACTUAL effectiveMask used (post binarize+feather), same dimensions as the composite, not the raw captured mask", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 4 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.effectiveMask.width, SIZE);
  assert.equal(result.effectiveMask.height, SIZE);
  // Matches computeProtectedFeatherMask's own contract: deep interior 255, deep exterior 0.
  assert.equal(result.effectiveMask.data[(14 * SIZE + 14) * 4], 255);
  assert.equal(result.effectiveMask.data[(0 * SIZE + 0) * 4], 0);
});

test("v3.3c visualizeFeatherBand: highlights ONLY pixels strictly between 0 and 255, black everywhere else, and (per the outward-only fix) the band never appears on the protected side of a boundary", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage({ ...fixture, featherRadiusPx: 4 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const band = visualizeFeatherBand(result.effectiveMask);
  assert.equal(band.width, SIZE);
  assert.equal(band.height, SIZE);
  // Deep interior (255) and deep exterior (0) are both OUT of band -> black.
  assert.deepEqual([band.data[(14 * SIZE + 14) * 4], band.data[(14 * SIZE + 14) * 4 + 1], band.data[(14 * SIZE + 14) * 4 + 2]], [0, 0, 0]);
  assert.deepEqual([band.data[(0 * SIZE + 0) * 4], band.data[(0 * SIZE + 0) * 4 + 1], band.data[(0 * SIZE + 0) * 4 + 2]], [0, 0, 0]);
  // The boundary pixel itself is inside the mask (255, never blended) -> NOT in the band.
  const boundaryOffset = (14 * SIZE + PROTECTED_RECT.x0) * 4;
  assert.equal(band.data[boundaryOffset], 0, "the boundary pixel is fully protected (255), never part of the feather band");
  // One pixel outside the boundary IS in the blend zone -> highlighted.
  const justOutsideOffset = (14 * SIZE + (PROTECTED_RECT.x0 - 1)) * 4;
  assert.notEqual(band.data[justOutsideOffset], 0, "just outside the boundary must be inside the feather band");
});

test("v3.3c visualizeFeatherBand: custom highlight color is honored, alpha always opaque", () => {
  const mask: PixelBuffer = { width: 2, height: 1, data: new Uint8ClampedArray(8) };
  mask.data.set([120, 120, 120, 255, 255, 255, 255, 255]); // pixel 0 mid-band, pixel 1 fully protected
  const band = visualizeFeatherBand(mask, { r: 10, g: 20, b: 30 });
  assert.deepEqual([band.data[0], band.data[1], band.data[2], band.data[3]], [10, 20, 30, 255]);
  assert.deepEqual([band.data[4], band.data[5], band.data[6], band.data[7]], [0, 0, 0, 255]);
});

test("v3.3c visualizeDiffVsBeauty: solid black across the entire protected region (composed === beauty there by construction), bright in the AI-replaced editable region", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage(fixture);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const diff = visualizeDiffVsBeauty(result.composed, fixture.beauty);
  // Deep protected interior: zero diff.
  const interiorOffset = (14 * SIZE + 14) * 4;
  assert.equal(diff.data[interiorOffset], 0);
  // Deep editable region: large diff (AI_RGB vs BEAUTY_RGB differ by 190/190/190, amplified and clamped to 255).
  const exteriorOffset = (0 * SIZE + 0) * 4;
  assert.equal(diff.data[exteriorOffset], 255);
});

test("v3.3c visualizeDiffVsBeauty: would visibly flag a synthetic 'ghosting' bug — a composed buffer that diverges from beauty INSIDE the protected region reads as bright there, not black", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage(fixture);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  // Simulate a hypothetical regression: corrupt one interior "protected" pixel in the composed
  // buffer so it no longer matches beauty (as if some future change reintroduced ghosting).
  const corrupted: PixelBuffer = { width: result.composed.width, height: result.composed.height, data: Uint8ClampedArray.from(result.composed.data) };
  const interiorOffset = (14 * SIZE + 14) * 4;
  corrupted.data[interiorOffset] = fixture.beauty.data[interiorOffset]! + 50;
  const diff = visualizeDiffVsBeauty(corrupted, fixture.beauty);
  assert.notEqual(diff.data[interiorOffset], 0, "a ghosting regression inside the protected region must show up as non-black in the diff overlay");
});

test("v3.3c visualizeDiffVsBeauty: never mutates its inputs", () => {
  const fixture = standardFixture();
  const result = composeStrictLockImage(fixture);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const composedSnapshot = Uint8ClampedArray.from(result.composed.data);
  const beautySnapshot = Uint8ClampedArray.from(fixture.beauty.data);
  visualizeDiffVsBeauty(result.composed, fixture.beauty);
  assert.deepEqual(result.composed.data, composedSnapshot);
  assert.deepEqual(fixture.beauty.data, beautySnapshot);
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
