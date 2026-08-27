import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDepthDebugPreview,
  correlateProtectedMaskWithRawDepth,
  diagnoseRawDepthBytes,
  linearizeDepth,
  LINEAR_DEPTH_PACK_MAX,
  packDepthToRGBA,
  packLinearDepthRGB,
  unpackLinearDepthRGB,
  unpackRGBAToDepth,
} from "../domain/visualizationDepth.ts";

// =========================================================================================
// Visualization v3.2/v3.2b/v3.2c/v3.2d — depth debug preview. Pure functions over plain RGBA
// byte buffers, same PROVABLE-BY-node:test shape as tests/visualizationCompositing.test.ts
// (domain/visualizationCompositing.ts) — no WebGL context needed, because none of this touches
// THREE/DOM.
//
// v3.2d changed the ACTIVE raw depth pack format from three.js's own fractional RGBADepthPacking
// (packDepthToRGBA/unpackRGBAToDepth/linearizeDepth — live browser diagnostics proved that scheme
// was producing a degenerate capture in this app's actual runtime) to a simple already-linear
// 24-bit RGB pack (packLinearDepthRGB/unpackLinearDepthRGB — see domain/visualizationDepth.ts's
// module doc comment). The OLD scheme's functions are kept, still exported, still tested below —
// they document three.js's own math and remain correct — but buildDepthDebugPreview fixtures from
// here on use packLinearDepthRGB, since that's what createDepthDataMaterial actually produces.
// =========================================================================================

function solidBuffer(width: number, height: number, r: number, g: number, b: number, a: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width, height, data };
}

/** Protected Mask's own contract: R=G=B duplicated, 255=covered/foreground, 0=uncovered/background. */
function coverageBuffer(width: number, height: number, covered: readonly boolean[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = covered[i] ? 255 : 0;
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Builds a raw depth RGBA byte-tuple in the v3.2d ACTIVE format: packLinearDepthRGB + alpha always 255. */
function packRawDepthPixel(linearDepth: number): readonly [number, number, number, number] {
  const [r, g, b] = packLinearDepthRGB(linearDepth);
  return [r, g, b, 255];
}

// =========================================================================================
// v3.2d ACTIVE contract: packLinearDepthRGB / unpackLinearDepthRGB
// =========================================================================================

test("v3.2d PACK/UNPACK ROUND TRIP: unpackLinearDepthRGB(packLinearDepthRGB(v)) recovers v within 24-bit quantization error", () => {
  for (const v of [0, 0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 1]) {
    const [r, g, b] = packLinearDepthRGB(v);
    const recovered = unpackLinearDepthRGB(r, g, b);
    assert.ok(Math.abs(recovered - v) < 1 / LINEAR_DEPTH_PACK_MAX + 1e-9, `expected ${recovered} to be within quantization of ${v}`);
  }
});

test("v3.2d LINEAR DEPTH IS MONOTONIC: a nearer packed value always unpacks smaller than a farther one", () => {
  const near = unpackLinearDepthRGB(...packLinearDepthRGB(0.1));
  const mid = unpackLinearDepthRGB(...packLinearDepthRGB(0.5));
  const far = unpackLinearDepthRGB(...packLinearDepthRGB(0.9));
  assert.ok(near < mid);
  assert.ok(mid < far);
});

test("v3.2d PACK BOUNDARIES: v=0 packs to (0,0,0), v=1 packs to the maximum 24-bit value", () => {
  assert.deepEqual(packLinearDepthRGB(0), [0, 0, 0]);
  assert.deepEqual(packLinearDepthRGB(1), [255, 255, 255]);
});

test("v3.2d PACK CLAMPS out-of-range input rather than wrapping/producing garbage", () => {
  assert.deepEqual(packLinearDepthRGB(-5), packLinearDepthRGB(0));
  assert.deepEqual(packLinearDepthRGB(5), packLinearDepthRGB(1));
});

// =========================================================================================
// Legacy/reference contract: packDepthToRGBA / unpackRGBAToDepth / linearizeDepth (three.js's
// OWN RGBADepthPacking math — no longer used by the runtime pipeline, see module doc comment)
// =========================================================================================

test("PACK/UNPACK ROUND TRIP (legacy three.js scheme): unpackRGBAToDepth(packDepthToRGBA(v)) recovers v within 8-bit quantization error", () => {
  for (const v of [0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
    const [r, g, b, a] = packDepthToRGBA(v);
    const recovered = unpackRGBAToDepth(r, g, b, a);
    assert.ok(Math.abs(recovered - v) < 0.01, `expected ${recovered} to be within 0.01 of ${v}`);
  }
});

test("RAW NORMALIZED DEPTH IS MONOTONIC (legacy three.js scheme)", () => {
  const near = unpackRGBAToDepth(...packDepthToRGBA(0.1));
  const mid = unpackRGBAToDepth(...packDepthToRGBA(0.5));
  const far = unpackRGBAToDepth(...packDepthToRGBA(0.9));
  assert.ok(near < mid);
  assert.ok(mid < far);
});

test("LINEARIZE MAPS near->0 AND far->1: perspectiveDepthToViewZ + viewZToOrthographicDepth composed, camera.near/camera.far actual values", () => {
  const near = 0.1;
  const far = 50;
  assert.ok(Math.abs(linearizeDepth(0, near, far) - 0) < 1e-9);
  assert.ok(Math.abs(linearizeDepth(1, near, far) - 1) < 1e-9);
});

// =========================================================================================
// buildDepthDebugPreview (report sections 10-13/22/23, v3.2c "background detection", v3.2d "raw
// depth contract")
// =========================================================================================

test("SYNTHETIC DEPTH FIXTURE — MONOTONIC GRAYSCALE ORDERING: near/mid/far packed linear depths produce near>mid>far debug gray values (near -> light, far -> dark), and the coverage mask's uncovered pixel produces pure black", () => {
  const near = 1;
  const far = 20;
  const linearAt = (dist: number) => (dist - near) / (far - near);

  const width = 4, height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  const setPixel = (x: number, rgba: readonly [number, number, number, number]) => {
    data[x * 4] = rgba[0]; data[x * 4 + 1] = rgba[1]; data[x * 4 + 2] = rgba[2]; data[x * 4 + 3] = rgba[3];
  };
  setPixel(0, packRawDepthPixel(linearAt(2))); // close to camera
  setPixel(1, packRawDepthPixel(linearAt(10)));
  setPixel(2, packRawDepthPixel(linearAt(19))); // close to far plane
  setPixel(3, [0, 0, 0, 255]); // uncovered pixel's raw depth bytes — irrelevant once a mask is given

  const coverageMask = coverageBuffer(width, height, [true, true, true, false]);
  const result = buildDepthDebugPreview({ rawDepth: { width, height, data }, near, far, coverageMask });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;

  const grayAt = (x: number) => result.preview.data[x * 4]!;
  const nearGray = grayAt(0);
  const midGray = grayAt(1);
  const farGray = grayAt(2);
  const backgroundGray = grayAt(3);

  assert.ok(nearGray > midGray, `near (${nearGray}) should be lighter than mid (${midGray})`);
  assert.ok(midGray > farGray, `mid (${midGray}) should be lighter than far (${farGray})`);
  assert.equal(backgroundGray, 0, "uncovered pixel must be pure black");
  // Preview alpha is always fully opaque — never inherits the raw pass's own alpha byte.
  assert.equal(result.preview.data[3], 255);
  assert.equal(result.preview.data[7], 255);
  assert.equal(result.preview.data[11], 255);
  assert.equal(result.preview.data[15], 255);

  // FOREGROUND MIN/MAX NORMALIZATION (v3.2b, report section 5): the uncovered pixel must be
  // excluded from the min/max used to compute the stretch, and stats must report exactly the 3
  // covered pixels — never 4.
  assert.equal(result.stats.foregroundPixelCount, 3);
  assert.equal(result.stats.totalPixelCount, 4);
  assert.ok(result.stats.minLinearDepth !== null && result.stats.maxLinearDepth !== null);
  // The nearest of the 3 foreground samples defines the stretch's white end, so it must land at
  // (or extremely close to) 255 — a naive full near..far linear map would NOT do this (dist=2 out
  // of a 1..20 range is nowhere near the light end of that full range).
  assert.ok(nearGray >= 250, `nearest foreground sample should stretch close to white, got ${nearGray}`);
});

test("v3.2c REGRESSION FIX: a COVERED pixel whose raw depth bytes happen to be R=G=B=0 with a real (nonzero) alpha is treated as FOREGROUND, not background — this exact byte pattern was misclassified by the pre-v3.2c RGB-only sentinel and collapsed the entire preview to black", () => {
  const width = 2, height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  // Pixel 0: legitimate packed depth whose R/G/B all happen to be 0 (v=0, near-plane-adjacent),
  // alpha nonzero in this synthetic fixture (v3.2d's real contract always writes alpha=255, but
  // this test specifically exercises the sentinel's RGB-only ambiguity, not the real format).
  data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 40;
  // Pixel 1: a genuinely different depth, for contrast.
  const [r, g, b, a] = packRawDepthPixel(0.6);
  data[4] = r; data[5] = g; data[6] = b; data[7] = a;

  const coverageMask = coverageBuffer(width, height, [true, true]); // BOTH covered
  const result = buildDepthDebugPreview({ rawDepth: { width, height, data }, near: 0.5, far: 20, coverageMask });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.stats.foregroundPixelCount, 2, "both covered pixels must count as foreground even though pixel 0 has R=G=B=0");
});

test("COVERAGE MASK DEFINES BACKGROUND, NOT RAW BYTES: an uncovered pixel reads as pure black regardless of what non-zero raw depth bytes sit underneath it", () => {
  const width = 2, height = 1;
  const [r, g, b, a] = packRawDepthPixel(0.6);
  const data = new Uint8ClampedArray(width * height * 4);
  data[0] = r; data[1] = g; data[2] = b; data[3] = a; // real-looking depth bytes...
  data[4] = r; data[5] = g; data[6] = b; data[7] = a; // ...identical on both pixels

  const coverageMask = coverageBuffer(width, height, [true, false]); // only pixel 0 is covered
  const result = buildDepthDebugPreview({ rawDepth: { width, height, data }, near: 0.5, far: 20, coverageMask });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.stats.foregroundPixelCount, 1);
  assert.notEqual(result.preview.data[0], 0, "the covered pixel must render its real depth");
  assert.equal(result.preview.data[4], 0, "the uncovered pixel must render pure black even though its raw bytes are identical to the covered one");
});

test("WITHOUT A COVERAGE MASK: only a fully all-zero RGBA pixel (R=G=B=A=0) falls back to background — a R=G=B=0-but-nonzero-alpha pixel is treated as foreground, per the narrower fallback sentinel", () => {
  const width = 2, height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  // Pixel 0: fully all-zero — the only unambiguous "nothing here" byte pattern.
  data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 0;
  // Pixel 1: R=G=B=0 but real alpha — must NOT be treated as background even without a mask.
  data[4] = 0; data[5] = 0; data[6] = 0; data[7] = 90;

  const result = buildDepthDebugPreview({ rawDepth: { width, height, data }, near: 0.5, far: 20 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.stats.foregroundPixelCount, 1);
  assert.equal(result.preview.data[0], 0, "the all-zero pixel is background");
  assert.notEqual(result.preview.data[4], 0, "the R=G=B=0/alpha=90 pixel must be treated as foreground");
});

test("BACKGROUND IS A DEFINED CONSTANT, NEVER COLOR NOISE: a fully-uncovered image (coverage mask all black) becomes exactly gray 0 everywhere, regardless of the underlying raw bytes", () => {
  const buffer = solidBuffer(3, 3, 12, 34, 56, 200); // arbitrary non-zero raw bytes
  const coverageMask = coverageBuffer(3, 3, new Array(9).fill(false));
  const result = buildDepthDebugPreview({ rawDepth: buffer, near: 0.1, far: 10, coverageMask });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  for (let i = 0; i < 9; i++) {
    assert.equal(result.preview.data[i * 4], 0);
    assert.equal(result.preview.data[i * 4 + 1], 0);
    assert.equal(result.preview.data[i * 4 + 2], 0);
  }
  assert.equal(result.stats.foregroundPixelCount, 0);
  assert.equal(result.stats.minLinearDepth, null);
  assert.equal(result.stats.maxLinearDepth, null);
  assert.equal(result.stats.uniqueGrayValueCount, 1, "an all-background image has exactly one gray value: 0");
});

test("MANY DISTINCT DEPTHS PRODUCE MANY GRAYSCALE VALUES: the v3.2/v3.2d regressions (degenerate binary captures) never reappear — a wide spread of foreground depths yields a wide spread of preview grays, not a near-binary collapse", () => {
  const width = 50, height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  const near = 0.5, far = 40;
  for (let x = 0; x < width; x++) {
    const v = (x + 1) / (width + 1);
    const [r, g, b, a] = packRawDepthPixel(v);
    data[x * 4] = r; data[x * 4 + 1] = g; data[x * 4 + 2] = b; data[x * 4 + 3] = a;
  }
  const coverageMask = coverageBuffer(width, height, new Array(width).fill(true));
  const result = buildDepthDebugPreview({ rawDepth: { width, height, data }, near, far, coverageMask });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.stats.foregroundPixelCount, width);
  assert.ok(result.stats.uniqueGrayValueCount > 20, `expected a wide grayscale spread, got only ${result.stats.uniqueGrayValueCount} unique values`);
});

test("DEGENERATE SINGLE-DEPTH FOREGROUND STILL PRODUCES A VISIBLE (NON-BLACK) VALUE: a flat plane fixture (every foreground pixel at the identical linear depth) doesn't divide by zero and doesn't collapse to background black", () => {
  const buffer = solidBuffer(4, 4, ...packRawDepthPixel(0.3));
  const coverageMask = coverageBuffer(4, 4, new Array(16).fill(true));
  const result = buildDepthDebugPreview({ rawDepth: buffer, near: 0.5, far: 10, coverageMask });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.stats.foregroundPixelCount, 16);
  assert.equal(result.stats.minLinearDepth, result.stats.maxLinearDepth);
  assert.notEqual(result.preview.data[0], 0, "a uniform foreground must not read as background black");
});

test("DOES NOT MUTATE THE RAW INPUT OR THE COVERAGE MASK: both Uint8ClampedArrays are byte-identical before and after conversion", () => {
  const buffer = solidBuffer(2, 2, ...packRawDepthPixel(0.4));
  const bufferSnapshot = Uint8ClampedArray.from(buffer.data);
  const coverageMask = coverageBuffer(2, 2, [true, false, true, false]);
  const maskSnapshot = Uint8ClampedArray.from(coverageMask.data);
  buildDepthDebugPreview({ rawDepth: buffer, near: 0.5, far: 30, coverageMask });
  assert.deepEqual(buffer.data, bufferSnapshot);
  assert.deepEqual(coverageMask.data, maskSnapshot);
});

test("PREVIEW DIMENSIONS MATCH THE RAW PASS: same width/height as the input, so it lines up with the other 5 control-pass tiles", () => {
  const buffer = solidBuffer(17, 9, ...packRawDepthPixel(0.3));
  const result = buildDepthDebugPreview({ rawDepth: buffer, near: 0.1, far: 5 });
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.preview.width, 17);
  assert.equal(result.preview.height, 9);
});

test("COVERAGE MASK DIMENSION MISMATCH IS REJECTED", () => {
  const buffer = solidBuffer(4, 4, ...packRawDepthPixel(0.3));
  const mismatchedMask = coverageBuffer(3, 3, new Array(9).fill(true));
  const result = buildDepthDebugPreview({ rawDepth: buffer, near: 0.1, far: 5, coverageMask: mismatchedMask });
  assert.deepEqual(result, { ok: false, reason: "invalid-buffer-length" });
});

test("INVALID BUFFER LENGTH IS REJECTED", () => {
  const result = buildDepthDebugPreview({
    rawDepth: { width: 4, height: 4, data: new Uint8ClampedArray(10) },
    near: 0.1,
    far: 10,
  });
  assert.deepEqual(result, { ok: false, reason: "invalid-buffer-length" });
});

test("INVALID NEAR/FAR IS REJECTED: far must be strictly greater than a positive near", () => {
  const buffer = solidBuffer(2, 2, ...packRawDepthPixel(0.5));
  assert.equal(buildDepthDebugPreview({ rawDepth: buffer, near: 0, far: 10 }).ok, false);
  assert.equal(buildDepthDebugPreview({ rawDepth: buffer, near: 5, far: 5 }).ok, false);
  assert.equal(buildDepthDebugPreview({ rawDepth: buffer, near: 10, far: 5 }).ok, false);
});

// =========================================================================================
// v3.2c — raw-byte diagnostics (report section "Přidej v dev diagnostice před jakýmkoliv
// unpackem"). Computed BEFORE any unpack/linearize.
// =========================================================================================

test("diagnoseRawDepthBytes: counts totals, all-zero-RGBA, and RGB-zero/alpha-nonzero separately", () => {
  const width = 4, height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  // pixel 0: fully all-zero
  data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 0;
  // pixel 1: RGB zero, alpha nonzero (the ambiguous pattern)
  data[4] = 0; data[5] = 0; data[6] = 0; data[7] = 77;
  // pixel 2: ordinary varied bytes
  data[8] = 10; data[9] = 20; data[10] = 30; data[11] = 40;
  // pixel 3: same alpha as pixel 2 (to check unique-alpha counting), different RGB
  data[12] = 99; data[13] = 98; data[14] = 97; data[15] = 40;

  const diagnostics = diagnoseRawDepthBytes({ width, height, data });
  assert.equal(diagnostics.totalPixelCount, 4);
  assert.equal(diagnostics.rgbaAllZeroCount, 1);
  assert.equal(diagnostics.rgbZeroAlphaNonzeroCount, 1);
  assert.equal(diagnostics.uniqueAlphaCount, 3); // 0, 77, 40
  assert.equal(diagnostics.alphaMin, 0);
  assert.equal(diagnostics.alphaMax, 77);
  // 3 non-all-zero pixels: index 1 (RGB zero/alpha 77), 2, 3
  assert.equal(diagnostics.firstNonZeroSamples.length, 3);
  assert.deepEqual(diagnostics.firstNonZeroSamples[0], { x: 1, y: 0, r: 0, g: 0, b: 0, a: 77 });
  assert.deepEqual(diagnostics.firstNonZeroSamples[1], { x: 2, y: 0, r: 10, g: 20, b: 30, a: 40 });
  assert.deepEqual(diagnostics.firstNonZeroSamples[2], { x: 3, y: 0, r: 99, g: 98, b: 97, a: 40 });
});

test("diagnoseRawDepthBytes: an ENTIRELY-empty capture (every pixel all-zero) is unambiguously flagged — rgbaAllZeroCount equals totalPixelCount, zero non-zero samples", () => {
  const buffer = solidBuffer(5, 5, 0, 0, 0, 0);
  const diagnostics = diagnoseRawDepthBytes(buffer);
  assert.equal(diagnostics.rgbaAllZeroCount, 25);
  assert.equal(diagnostics.totalPixelCount, 25);
  assert.equal(diagnostics.firstNonZeroSamples.length, 0);
  assert.equal(diagnostics.uniqueAlphaCount, 1);
});

test("diagnoseRawDepthBytes respects sampleLimit and never mutates the input", () => {
  const buffer = solidBuffer(30, 1, 5, 6, 7, 8);
  const snapshot = Uint8ClampedArray.from(buffer.data);
  const diagnostics = diagnoseRawDepthBytes(buffer, 5);
  assert.equal(diagnostics.firstNonZeroSamples.length, 5);
  assert.deepEqual(buffer.data, snapshot);
});

// =========================================================================================
// v3.2d — correlateProtectedMaskWithRawDepth (report section 6, "PIXEL CORRELATION TEST"). This
// is what turned "raw depth looks binary" from a hunch into a quantified finding.
// =========================================================================================

test("correlateProtectedMaskWithRawDepth: reproduces the v3.2d degenerate-capture signature — protected-foreground pixels are all-zero-RGBA, protected-background pixels have alpha=255", () => {
  const width = 4, height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  // pixels 0,1 (protected foreground): the v3.2d bug signature — all-zero RGBA.
  data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 0;
  data[4] = 0; data[5] = 0; data[6] = 0; data[7] = 0;
  // pixels 2,3 (protected background): black clear color, alpha forced opaque.
  data[8] = 0; data[9] = 0; data[10] = 0; data[11] = 255;
  data[12] = 0; data[13] = 0; data[14] = 0; data[15] = 255;

  const protectedMask = coverageBuffer(width, height, [true, true, false, false]);
  const correlation = correlateProtectedMaskWithRawDepth({ width, height, data }, protectedMask);
  assert.notEqual(correlation, null);
  assert.deepEqual(correlation, {
    protectedForegroundCount: 2,
    protectedBackgroundCount: 2,
    protectedForegroundAndRawAllZero: 2,
    protectedForegroundAndRawAlpha255: 0,
    protectedBackgroundAndRawAllZero: 0,
    protectedBackgroundAndRawAlpha255: 2,
  });
});

test("correlateProtectedMaskWithRawDepth: a HEALTHY capture (varied non-zero foreground depths) shows near-zero protectedForegroundAndRawAllZero — the metric that would have caught v3.2d immediately", () => {
  const width = 3, height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  const [r, g, b] = packLinearDepthRGB(0.4);
  data[0] = r; data[1] = g; data[2] = b; data[3] = 255;
  data[4] = 0; data[5] = 0; data[6] = 0; data[7] = 255; // background
  data[8] = 0; data[9] = 0; data[10] = 0; data[11] = 255; // background

  const protectedMask = coverageBuffer(width, height, [true, false, false]);
  const correlation = correlateProtectedMaskWithRawDepth({ width, height, data }, protectedMask);
  assert.notEqual(correlation, null);
  assert.equal(correlation!.protectedForegroundAndRawAllZero, 0);
  assert.equal(correlation!.protectedBackgroundAndRawAllZero, 0); // background here is alpha=255, not all-zero
  assert.equal(correlation!.protectedBackgroundAndRawAlpha255, 2);
});

test("correlateProtectedMaskWithRawDepth: mismatched dimensions return null, never throw", () => {
  const rawDepth = solidBuffer(4, 4, 0, 0, 0, 0);
  const protectedMask = coverageBuffer(3, 3, new Array(9).fill(true));
  assert.equal(correlateProtectedMaskWithRawDepth(rawDepth, protectedMask), null);
});
