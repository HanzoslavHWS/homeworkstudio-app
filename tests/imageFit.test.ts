import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LETTERBOX_COLOR, fitImageWithLetterbox } from "../lib/ai/imageFit.ts";

// =========================================================================================
// Visualization v3.3a — lib/ai/imageFit.ts, the deterministic aspect-ratio-preserving resize
// used by lib/ai/openaiVisualizationAiProvider.server.ts when OpenAI can't return an image at
// Beauty's exact dimensions. Pure RGBA-buffer math, no THREE/DOM/network.
// =========================================================================================

function solidImage(width: number, height: number, r: number, g: number, b: number, a: number) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

test("NO-OP: identical dimensions return the SAME source reference, byte-identical, no allocation", () => {
  const source = solidImage(10, 5, 1, 2, 3, 4);
  const result = fitImageWithLetterbox(source, 10, 5);
  assert.equal(result, source);
});

test("NEVER STRETCHES: a square source into a wide target is centered with side padding, never smeared horizontally", () => {
  const marker = { r: 30, g: 200, b: 30, a: 255 };
  const source = solidImage(8, 8, marker.r, marker.g, marker.b, marker.a);
  const result = fitImageWithLetterbox(source, 16, 8);
  assert.equal(result.width, 16);
  assert.equal(result.height, 8);
  // scale = min(16/8, 8/8) = 1 -> content stays 8x8, centered at x=4..11.
  for (let x = 0; x < 16; x++) {
    const offset = (4 * 16 + x) * 4; // middle row
    const isContent = x >= 4 && x < 12;
    if (isContent) {
      assert.equal(result.rgba[offset], marker.r, `x=${x} should be content`);
    } else {
      assert.equal(result.rgba[offset], DEFAULT_LETTERBOX_COLOR.r, `x=${x} should be padding`);
      assert.equal(result.rgba[offset + 3], DEFAULT_LETTERBOX_COLOR.a);
    }
  }
});

test("NEVER STRETCHES: a wide source into a tall target is centered with top/bottom padding, never smeared vertically", () => {
  const marker = { r: 10, g: 10, b: 240, a: 255 };
  const source = solidImage(16, 8, marker.r, marker.g, marker.b, marker.a);
  const result = fitImageWithLetterbox(source, 8, 16);
  assert.equal(result.width, 8);
  assert.equal(result.height, 16);
  // scale = min(8/16, 16/8) = 0.5 -> content becomes 8x4, centered at y=6..9.
  for (let y = 0; y < 16; y++) {
    const offset = (y * 8 + 4) * 4; // middle column
    const isContent = y >= 6 && y < 10;
    if (isContent) {
      assert.equal(result.rgba[offset + 2], marker.b, `y=${y} should be content`);
    } else {
      assert.equal(result.rgba[offset], DEFAULT_LETTERBOX_COLOR.r, `y=${y} should be padding`);
    }
  }
});

test("NEVER CROPS: the scaled content never exceeds the target box on either axis (by construction — scale is the MIN of both ratios)", () => {
  // A source far more extreme in aspect than the target — a naive "cover" (as opposed to
  // "contain") implementation would crop this; this one must not.
  const source = solidImage(100, 10, 5, 5, 5, 255);
  const result = fitImageWithLetterbox(source, 20, 20);
  // scale = min(20/100, 20/10) = 0.2 -> scaled content is 20x2, well within the 20x20 target.
  assert.equal(result.width, 20);
  assert.equal(result.height, 20);
  let contentRows = 0;
  for (let y = 0; y < 20; y++) {
    const offset = (y * 20 + 10) * 4;
    if (result.rgba[offset] === 5) contentRows++;
  }
  assert.equal(contentRows, 2, "the full 2px-tall scaled content must be present, nothing cropped away");
});

test("SAME-ASPECT-RATIO RESCALE fills the entire target with no padding at all", () => {
  const marker = { r: 250, g: 10, b: 10, a: 255 };
  const source = solidImage(12, 20, marker.r, marker.g, marker.b, marker.a); // 3:5
  const result = fitImageWithLetterbox(source, 6, 10); // same 3:5 ratio, smaller absolute size
  assert.equal(result.width, 6);
  assert.equal(result.height, 10);
  for (let i = 0; i < 6 * 10; i++) {
    assert.equal(result.rgba[i * 4], marker.r, `pixel ${i} must be content, no padding expected for an exact-aspect rescale`);
  }
});

test("CUSTOM PAD COLOR is honored", () => {
  const source = solidImage(4, 4, 9, 9, 9, 255);
  const result = fitImageWithLetterbox(source, 8, 4, { r: 200, g: 100, b: 50, a: 128 });
  // scale = min(8/4, 4/4) = 1 -> content is 4x4 centered at x=2..5; padding at x=0,1,6,7.
  const paddingOffset = (0 * 8 + 0) * 4;
  assert.equal(result.rgba[paddingOffset], 200);
  assert.equal(result.rgba[paddingOffset + 1], 100);
  assert.equal(result.rgba[paddingOffset + 2], 50);
  assert.equal(result.rgba[paddingOffset + 3], 128);
});

test("DETERMINISTIC: repeated calls on the same input produce byte-identical output", () => {
  const source = solidImage(17, 23, 7, 11, 13, 200);
  const a = fitImageWithLetterbox(source, 40, 30);
  const b = fitImageWithLetterbox(source, 40, 30);
  assert.deepEqual(a.rgba, b.rgba);
});

test("DOES NOT MUTATE the source buffer", () => {
  const source = solidImage(5, 5, 1, 2, 3, 4);
  const snapshot = Uint8Array.from(source.rgba);
  fitImageWithLetterbox(source, 10, 3);
  assert.deepEqual(source.rgba, snapshot);
});

test("REJECTS non-positive target dimensions", () => {
  const source = solidImage(4, 4, 1, 1, 1, 255);
  assert.throws(() => fitImageWithLetterbox(source, 0, 10));
  assert.throws(() => fitImageWithLetterbox(source, 10, -1));
});
