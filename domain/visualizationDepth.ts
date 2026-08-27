/**
 * Visualization v3.2/v3.2b/v3.2c/v3.2d — turns the raw depth control pass into a human-readable
 * grayscale debug preview. Deliberately PURE functions over plain RGBA byte buffers — zero
 * THREE.js, zero canvas/DOM — same "provable by node:test, not just a browser manual QA pass"
 * shape as domain/visualizationCompositing.ts. The browser-side wrapper that reads/writes real
 * <canvas> ImageData (lib/visualizationDepthDebug.browser.ts) is a thin, separately-untested
 * adapter around this.
 *
 * v3.2d — RAW DEPTH CONTRACT CHANGED. Live browser diagnostics (v3.2d report) proved
 * MeshDepthMaterial(RGBADepthPacking) was producing a DEGENERATE capture in this app's actual
 * runtime: raw RGB always (0,0,0), alpha binary 0/255 correlating almost exactly with the
 * Protected Mask silhouette — a coverage mask, not depth data — despite every checkable piece of
 * its public API (the depthPacking constant, constructor option application, the compiled
 * #define) being correct by static analysis of three.js's own source. BoothCadViewer.tsx's Depth
 * pass now uses a small, fully self-written ShaderMaterial (createDepthDataMaterial) instead: it
 * computes LINEAR view-space depth directly in the vertex shader and packs it into RGB only
 * (packLinearDepthRGB below) — alpha is ALWAYS 255, so numeric depth can never again be mistaken
 * for real opacity by any canvas/PNG pipeline (the actual root motivation for the whole
 * v3.2b/c/d chain). unpackRGBAToDepth/packDepthToRGBA/linearizeDepth below document three.js's
 * OWN (now-abandoned, for this pipeline) packing scheme — kept correct and tested for reference,
 * but no longer used by the runtime capture/preview pipeline; packLinearDepthRGB/
 * unpackLinearDepthRGB are the ACTIVE contract.
 */

import type { PixelBuffer } from "./visualizationCompositing";

export type DepthDebugPreviewInput = Readonly<{
  /** The exact RGBADepthPacking capture from BoothCadViewer.tsx's renderControlPassCapture. */
  rawDepth: PixelBuffer;
  /** camera.near/camera.far read LIVE at capture time (ControlPassBundle.depthNear/depthFar). */
  near: number;
  far: number;
  /**
   * v3.2c (report section "Robustnější varianta"): the SAME-frame Protected Mask control pass
   * (ControlPassBundle.protectedMaskDataUrl — flat-white silhouette of every scene object over
   * black) reused as an independent foreground/coverage signal, instead of guessing coverage from
   * the depth bytes themselves. When provided, a pixel is foreground iff this mask reads >= 128
   * (its own established white=covered/black=uncovered contract — same threshold convention as
   * domain/visualizationCompositing.ts). This sidesteps the whole "which packed RGBA byte pattern
   * means background" question — coverage comes from a completely separate, already-correct
   * render, not a heuristic over depth bytes. When no mask is supplied (e.g. a pure unit test
   * exercising just the unpack/linearize math), buildDepthDebugPreview falls back to a narrower
   * RGBA-all-zero sentinel instead — see its own doc comment.
   */
  coverageMask?: PixelBuffer;
}>;

/**
 * Raw-byte diagnostics computed BEFORE any unpack/linearize — report section "Nejprve audituj
 * background detection": lets a human confirm from real browser output whether readRenderTargetPixels
 * actually returned varied packed depth data, or came back degenerate (e.g. every pixel literally
 * (0,0,0,0)), which are two very different failures with very different fixes.
 */
export type RawDepthByteDiagnostics = Readonly<{
  totalPixelCount: number;
  /** Pixels where R=G=B=A=0 exactly — the only combination packDepthToRGBA can never itself produce for a real depth value >0 (v=0 packs to (0,0,0,0), but v=0 means "sitting exactly on the near clip plane," which real geometry never does). */
  rgbaAllZeroCount: number;
  /** Pixels where R=G=B=0 but A!=0 — the exact pattern the OLD (pre-v3.2c) background sentinel misclassified as background. A large count here would confirm that hypothesis; v3.2c's numeric probe (packing realistic near-camera depths) found this pattern is actually rare for typical near/far ranges, but this is measured from REAL captured bytes, not assumed. */
  rgbZeroAlphaNonzeroCount: number;
  uniqueAlphaCount: number;
  alphaMin: number | null;
  alphaMax: number | null;
  /** Up to `sampleLimit` pixels (in scan order) whose RGBA isn't all-zero, with their (x,y) position and raw bytes — enough to eyeball in the dev panel whether the buffer actually contains varied data. */
  firstNonZeroSamples: readonly Readonly<{ x: number; y: number; r: number; g: number; b: number; a: number }>[];
}>;

/**
 * Pure, pre-unpack audit of a raw captured buffer (report section "Přidej v dev diagnostice před
 * jakýmkoliv unpackem"). Never mutates `buffer`.
 */
export function diagnoseRawDepthBytes(buffer: PixelBuffer, sampleLimit = 20): RawDepthByteDiagnostics {
  const totalPixelCount = buffer.width * buffer.height;
  let rgbaAllZeroCount = 0;
  let rgbZeroAlphaNonzeroCount = 0;
  const seenAlpha = new Uint8Array(256);
  let uniqueAlphaCount = 0;
  let alphaMin = Infinity;
  let alphaMax = -Infinity;
  const firstNonZeroSamples: Readonly<{ x: number; y: number; r: number; g: number; b: number; a: number }>[] = [];

  for (let i = 0; i < totalPixelCount; i++) {
    const offset = i * 4;
    const r = buffer.data[offset]!;
    const g = buffer.data[offset + 1]!;
    const b = buffer.data[offset + 2]!;
    const a = buffer.data[offset + 3]!;

    if (r === 0 && g === 0 && b === 0 && a === 0) rgbaAllZeroCount++;
    else if (r === 0 && g === 0 && b === 0) rgbZeroAlphaNonzeroCount++;

    if (!seenAlpha[a]) { seenAlpha[a] = 1; uniqueAlphaCount++; }
    if (a < alphaMin) alphaMin = a;
    if (a > alphaMax) alphaMax = a;

    if (firstNonZeroSamples.length < sampleLimit && (r !== 0 || g !== 0 || b !== 0 || a !== 0)) {
      (firstNonZeroSamples as { x: number; y: number; r: number; g: number; b: number; a: number }[]).push({
        x: i % buffer.width,
        y: Math.floor(i / buffer.width),
        r, g, b, a,
      });
    }
  }

  return {
    totalPixelCount,
    rgbaAllZeroCount,
    rgbZeroAlphaNonzeroCount,
    uniqueAlphaCount,
    alphaMin: totalPixelCount > 0 ? alphaMin : null,
    alphaMax: totalPixelCount > 0 ? alphaMax : null,
    firstNonZeroSamples,
  };
}

/**
 * Diagnostics for the dev debug panel (report section 7) — lets a human confirm the preview isn't
 * degenerate without opening devtools. `minLinearDepth`/`maxLinearDepth` are the LINEAR (near=0,
 * far=1) values actually found among foreground pixels, i.e. the range the contrast stretch below
 * normalizes against — null when there is no foreground at all.
 */
export type DepthDebugStats = Readonly<{
  near: number;
  far: number;
  totalPixelCount: number;
  foregroundPixelCount: number;
  minLinearDepth: number | null;
  maxLinearDepth: number | null;
  /** How many distinct 0..255 gray values appear in the produced preview — a preview collapsed to 2 (report section 11 acceptance) is exactly what this catches. */
  uniqueGrayValueCount: number;
}>;

export type DepthDebugPreviewResult =
  | Readonly<{ ok: true; preview: PixelBuffer; stats: DepthDebugStats }>
  | Readonly<{ ok: false; reason: "invalid-buffer-length" | "invalid-near-far" }>;

// Three.js src/renderers/shaders/ShaderChunk/packing.glsl.js's own pack/unpack constants,
// reimplemented in JS over 0..255 byte channels instead of a 0..1 GLSL vec4 — same math, never a
// home-grown approximation (report section 11).
const PACK_UPSCALE = 256 / 255;
const UNPACK_DOWNSCALE = 255 / 256;
const SHIFT_RIGHT_8 = 1 / 256;
const PACK_FACTORS = [256 * 256 * 256, 256 * 256, 256] as const;
const UNPACK_FACTORS = [
  UNPACK_DOWNSCALE / PACK_FACTORS[0],
  UNPACK_DOWNSCALE / PACK_FACTORS[1],
  UNPACK_DOWNSCALE / PACK_FACTORS[2],
  UNPACK_DOWNSCALE / 1,
] as const;

function fract(value: number): number {
  return value - Math.floor(value);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Three.js's unpackRGBAToDepth: packed RGBA (each channel 0..255, as read from a captured PNG)
 * -> raw normalized depth in [0,1], where 0 = the near clip plane and 1 = the far clip plane.
 * This is the SAME non-linear, perspective-compressed depth the packed bytes always represented
 * — "raw normalized depth" in report section 11/12, never the linearized debug value.
 */
export function unpackRGBAToDepth(r: number, g: number, b: number, a: number): number {
  return (r / 255) * UNPACK_FACTORS[0]
    + (g / 255) * UNPACK_FACTORS[1]
    + (b / 255) * UNPACK_FACTORS[2]
    + (a / 255) * UNPACK_FACTORS[3];
}

/**
 * Three.js's packDepthToRGBA — the exact inverse of {@link unpackRGBAToDepth}, producing the same
 * 0..255 byte channels the GPU shader would write for a given raw normalized depth `v` in [0,1].
 * Exists so tests can build synthetic fixtures with KNOWN packed depths (report section 23)
 * without a WebGL context, and to prove the unpack above really is the math's inverse — not used
 * by any runtime capture/debug path (those only ever unpack real GPU output).
 */
export function packDepthToRGBA(v: number): readonly [number, number, number, number] {
  const clamped = clamp01(v);
  const r = fract(clamped * PACK_FACTORS[0]);
  const g = fract(clamped * PACK_FACTORS[1]);
  const b = fract(clamped * PACK_FACTORS[2]);
  const a = clamped;
  const packedG = g - r * SHIFT_RIGHT_8;
  const packedB = b - g * SHIFT_RIGHT_8;
  const packedA = a - b * SHIFT_RIGHT_8;
  return [
    Math.round(clamp01(r * PACK_UPSCALE) * 255),
    Math.round(clamp01(packedG * PACK_UPSCALE) * 255),
    Math.round(clamp01(packedB * PACK_UPSCALE) * 255),
    Math.round(clamp01(packedA * PACK_UPSCALE) * 255),
  ];
}

/**
 * Three.js's perspectiveDepthToViewZ + viewZToOrthographicDepth, composed: converts the raw
 * normalized (non-linear) depth into a LINEAR [0,1] view-space depth, 0 = near, 1 = far. This is
 * what makes a debug preview human-readable — raw depth is heavily compressed near the camera, so
 * viewing it directly (or naively scaling 0..1 to 0..255) reads as almost entirely one shade
 * (report sections 9-11). Values outside the frustum after linearization are clamped to [0,1] by
 * the caller, not here — this function is the pure math, unclamped.
 */
export function linearizeDepth(normalizedDepth: number, near: number, far: number): number {
  const viewZ = (near * far) / ((far - near) * normalizedDepth - far);
  return (viewZ + near) / (near - far);
}

/**
 * v3.2d — the ACTIVE raw depth pack format: a plain 24-bit big-endian integer split across R/G/B,
 * encoding a value already in LINEAR [0,1] (0=near, 1=far — computed on the GPU from the real
 * camera.near/camera.far, see createDepthDataMaterial in BoothCadViewer.tsx). Deliberately NOT
 * three.js's own fractional packDepthToRGBA scheme — that needs `fract(v * 256^3)` in the
 * fragment shader, a single float multiply/fract at the very edge of what `highp` precision can
 * represent exactly; this format only ever needs floor/mod on numbers up to 16777215, comfortably
 * inside float32 exact-integer range (2^24), so it can't silently degrade under lower GPU/driver
 * float precision the way the abandoned scheme could have. MUST match the literal 16777215.0 in
 * BoothCadViewer.tsx's createDepthDataMaterial fragment shader — a source-scan test pins this.
 */
export const LINEAR_DEPTH_PACK_MAX = 256 * 256 * 256 - 1;

/** Mirrors createDepthDataMaterial's fragment shader math exactly — lets tests build fixtures with KNOWN packed depths without a WebGL context, and documents the exact inverse of {@link unpackLinearDepthRGB}. */
export function packLinearDepthRGB(v: number): readonly [number, number, number] {
  const scaled = Math.round(clamp01(v) * LINEAR_DEPTH_PACK_MAX);
  const r = Math.floor(scaled / 65536) % 256;
  const g = Math.floor(scaled / 256) % 256;
  const b = scaled % 256;
  return [r, g, b];
}

/** The ACTIVE raw depth unpack: packed RGB (each channel 0..255) -> already-LINEAR [0,1] depth (0=near, 1=far). No separate linearization step needed — createDepthDataMaterial does that on the GPU before packing. Alpha is intentionally ignored: the contract guarantees it's always 255 (real opacity, never data). */
export function unpackLinearDepthRGB(r: number, g: number, b: number): number {
  const scaled = r * 65536 + g * 256 + b;
  return scaled / LINEAR_DEPTH_PACK_MAX;
}

/**
 * v3.2d report section 6 ("PIXEL CORRELATION TEST") — cross-tabulates the Protected Mask's real
 * foreground/background call against the raw depth buffer's own all-zero-RGBA / alpha=255 byte
 * patterns, pixel for pixel. This is what turned "raw depth looks binary" from a hunch into a
 * confirmed, quantified finding (v3.2d report: rgbaAllZero count ≈ Protected Mask foreground
 * count, rgbZeroAlphaNonzero count ≈ Protected Mask background count) — kept as a permanent dev
 * diagnostic so a future regression is caught the same quantified way, not re-guessed. Pure,
 * never mutates either buffer; requires matching dimensions.
 */
export type ProtectedMaskDepthCorrelation = Readonly<{
  protectedForegroundCount: number;
  protectedBackgroundCount: number;
  protectedForegroundAndRawAllZero: number;
  protectedForegroundAndRawAlpha255: number;
  protectedBackgroundAndRawAllZero: number;
  protectedBackgroundAndRawAlpha255: number;
}>;

export function correlateProtectedMaskWithRawDepth(
  rawDepth: PixelBuffer,
  protectedMask: PixelBuffer,
): ProtectedMaskDepthCorrelation | null {
  if (
    rawDepth.width !== protectedMask.width || rawDepth.height !== protectedMask.height
    || rawDepth.data.length !== rawDepth.width * rawDepth.height * 4
    || protectedMask.data.length !== protectedMask.width * protectedMask.height * 4
  ) {
    return null;
  }

  let protectedForegroundCount = 0;
  let protectedBackgroundCount = 0;
  let protectedForegroundAndRawAllZero = 0;
  let protectedForegroundAndRawAlpha255 = 0;
  let protectedBackgroundAndRawAllZero = 0;
  let protectedBackgroundAndRawAlpha255 = 0;

  const totalPixelCount = rawDepth.width * rawDepth.height;
  for (let i = 0; i < totalPixelCount; i++) {
    const offset = i * 4;
    const r = rawDepth.data[offset]!;
    const g = rawDepth.data[offset + 1]!;
    const b = rawDepth.data[offset + 2]!;
    const a = rawDepth.data[offset + 3]!;
    const allZero = r === 0 && g === 0 && b === 0 && a === 0;
    const alpha255 = a === 255;
    const protectedForeground = protectedMask.data[offset]! >= COVERAGE_MASK_THRESHOLD;

    if (protectedForeground) {
      protectedForegroundCount++;
      if (allZero) protectedForegroundAndRawAllZero++;
      if (alpha255) protectedForegroundAndRawAlpha255++;
    } else {
      protectedBackgroundCount++;
      if (allZero) protectedBackgroundAndRawAllZero++;
      if (alpha255) protectedBackgroundAndRawAlpha255++;
    }
  }

  return {
    protectedForegroundCount,
    protectedBackgroundCount,
    protectedForegroundAndRawAllZero,
    protectedForegroundAndRawAlpha255,
    protectedBackgroundAndRawAllZero,
    protectedBackgroundAndRawAlpha255,
  };
}

/** Protected Mask's own established contract (domain/visualizationCompositing.ts): R=G=B duplicated, 255=covered, 0=uncovered. >=128 is the same "which side of the silhouette edge" threshold used there. */
const COVERAGE_MASK_THRESHOLD = 128;

/**
 * Builds the human-readable depth debug preview (report sections 10-13, v3.2b section 5, v3.2c
 * "background detection"): near -> light, far -> dark, background (pixels with no geometry) ->
 * pure black.
 *
 * v3.2c fix: foreground/background is now determined by `input.coverageMask` (the SAME-frame
 * Protected Mask pass) whenever it's supplied — an independent, already-correct render, not a
 * guess over the depth bytes. The PREVIOUS (v3.2b) approach — "R=G=B=0 means background" — turned
 * out unsafe as a long-term contract per this batch's report: RGBADepthPacking's ALPHA channel
 * carries real depth information (not opacity), so a real foreground pixel COULD in principle
 * still land on R=G=B=0 with a meaningful alpha, and that combination can't be told apart from the
 * pass's actual (0,0,0,255) black-clear-color background using RGB alone. When no coverage mask is
 * given (e.g. a pure unit test exercising just the unpack/linearize math), this falls back to the
 * strictly narrower RGBA-all-zero sentinel (R=G=B=A=0) — never RGB-only — since packDepthToRGBA can
 * only ever produce all-four-zero for raw depth exactly 0 (sitting on the near clip plane, which
 * real geometry never does) or a genuinely empty/untouched pixel.
 *
 * Contrast (v3.2b, unchanged): stretched against the ACTUAL foreground min/max linear depth found
 * in this image, never a flat 0..1 map across the full camera.near..camera.far range — camera.far
 * is routinely far beyond the booth itself, so a naive near/far-wide mapping would compress the
 * entire visible booth into a handful of adjacent gray values. This is a DISPLAY-ONLY contrast
 * stretch; camera.near/camera.far still drive the (unstretched) linearization math, so the
 * raw/provider depth contract is untouched, and `stats` reports exactly what range was used so a
 * human can confirm the preview isn't degenerate (report section 7). Never mutates `rawDepth` or
 * `coverageMask` — always allocates a fresh output buffer.
 */
export function buildDepthDebugPreview(input: DepthDebugPreviewInput): DepthDebugPreviewResult {
  const { rawDepth, near, far, coverageMask } = input;
  if (
    !Number.isInteger(rawDepth.width) || !Number.isInteger(rawDepth.height)
    || rawDepth.width <= 0 || rawDepth.height <= 0
    || rawDepth.data.length !== rawDepth.width * rawDepth.height * 4
  ) {
    return { ok: false, reason: "invalid-buffer-length" };
  }
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
    return { ok: false, reason: "invalid-near-far" };
  }
  if (
    coverageMask
    && (coverageMask.width !== rawDepth.width || coverageMask.height !== rawDepth.height
      || coverageMask.data.length !== coverageMask.width * coverageMask.height * 4)
  ) {
    return { ok: false, reason: "invalid-buffer-length" };
  }

  const { width, height } = rawDepth;
  const totalPixelCount = width * height;
  const isForeground = new Uint8Array(totalPixelCount);
  const linearDepthByPixel = new Float64Array(totalPixelCount);
  let minLinearDepth = Infinity;
  let maxLinearDepth = -Infinity;
  let foregroundPixelCount = 0;

  for (let i = 0; i < totalPixelCount; i++) {
    const offset = i * 4;
    const r = rawDepth.data[offset]!;
    const g = rawDepth.data[offset + 1]!;
    const b = rawDepth.data[offset + 2]!;
    const a = rawDepth.data[offset + 3]!;

    const covered = coverageMask
      ? coverageMask.data[offset]! >= COVERAGE_MASK_THRESHOLD
      : !(r === 0 && g === 0 && b === 0 && a === 0);
    if (!covered) continue;

    // v3.2d: the raw buffer is already-linear (0=near,1=far) per packLinearDepthRGB — no
    // separate unpackRGBAToDepth+linearizeDepth step needed (that pair documents the abandoned
    // three.js RGBADepthPacking scheme, see the module doc comment above). near/far are still
    // validated/reported in `stats` below for provenance, just no longer used in this line.
    const linear = clamp01(unpackLinearDepthRGB(r, g, b));
    linearDepthByPixel[i] = linear;
    isForeground[i] = 1;
    foregroundPixelCount++;
    if (linear < minLinearDepth) minLinearDepth = linear;
    if (linear > maxLinearDepth) maxLinearDepth = linear;
  }

  const hasForeground = foregroundPixelCount > 0;
  const foregroundRange = hasForeground ? maxLinearDepth - minLinearDepth : 0;

  const data = new Uint8ClampedArray(totalPixelCount * 4);
  const seenGray = new Uint8Array(256);
  let uniqueGrayValueCount = 0;
  for (let i = 0; i < totalPixelCount; i++) {
    const offset = i * 4;
    let gray = 0;
    if (isForeground[i]) {
      // Degenerate case (every foreground pixel at the identical depth, e.g. a single flat
      // plane fixture): mid-gray, so the preview still visibly differs from pure background
      // black rather than dividing by zero.
      const stretched = foregroundRange > 1e-9 ? (linearDepthByPixel[i]! - minLinearDepth) / foregroundRange : 0.5;
      gray = Math.round((1 - clamp01(stretched)) * 255);
    }
    if (!seenGray[gray]) { seenGray[gray] = 1; uniqueGrayValueCount++; }
    data[offset] = gray;
    data[offset + 1] = gray;
    data[offset + 2] = gray;
    data[offset + 3] = 255;
  }

  return {
    ok: true,
    preview: { width, height, data },
    stats: {
      near,
      far,
      totalPixelCount,
      foregroundPixelCount,
      minLinearDepth: hasForeground ? minLinearDepth : null,
      maxLinearDepth: hasForeground ? maxLinearDepth : null,
      uniqueGrayValueCount,
    },
  };
}
