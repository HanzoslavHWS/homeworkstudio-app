/**
 * Visualization v3 — the deterministic pixel-compositing algorithm that is the PRIMARY
 * geometry/artwork protection mechanism (report section 6/25) — prompt engineering is a
 * secondary, best-effort layer; this function is what actually guarantees protected pixels in
 * the final image equal the authoritative Three.js render.
 *
 * Deliberately a PURE function over plain RGBA byte buffers — zero THREE.js, zero canvas/DOM,
 * zero dependency of any kind. This is what makes "protected interior pixels are byte-exact"
 * a real, provable node:test rather than a source-scan pin: the algorithm's correctness doesn't
 * depend on a live browser/WebGL context at all. The browser-side wrapper that reads/writes real
 * <canvas> ImageData (lib/visualizationAiComposite.browser.ts) is a thin, separately-untested
 * adapter around this — all the actual protection logic lives here.
 */

export type PixelBuffer = Readonly<{
  width: number;
  height: number;
  /** RGBA, length must equal width * height * 4. */
  data: Uint8ClampedArray;
}>;

export type ComposeStrictLockInput = Readonly<{
  /** The authoritative Three.js customer render — booth/furniture/artwork/floor. */
  beauty: PixelBuffer;
  /** The AI-generated environment image, same dimensions as beauty. */
  aiEnvironment: PixelBuffer;
  /**
   * Single-channel value duplicated across R/G/B (as produced by a flat-material silhouette
   * render): 255 = fully protected (authoritative), 0 = fully editable (AI environment). Expected
   * to be strictly binary as captured — feathering happens only inside this function, never baked
   * into the captured mask itself (report section 5).
   */
  protectedMask: PixelBuffer;
  /** Feather band half-width in pixels, applied only at the mask's edge. 0 = hard binary cutoff, no blending anywhere. Default 3. */
  featherRadiusPx?: number;
}>;

export type ComposeStrictLockResult =
  | Readonly<{ ok: true; composed: PixelBuffer }>
  | Readonly<{ ok: false; reason: "dimension-mismatch" | "invalid-buffer-length" }>;

export const DEFAULT_FEATHER_RADIUS_PX = 3;

function isValidBuffer(buffer: PixelBuffer): boolean {
  return Number.isInteger(buffer.width) && Number.isInteger(buffer.height)
    && buffer.width > 0 && buffer.height > 0
    && buffer.data.length === buffer.width * buffer.height * 4;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Separable box blur (horizontal sliding-window sum, then vertical) over the mask's single
 * channel (read from R, since the mask is R=G=B by convention). O(width*height) regardless of
 * radius — never a naive O(radius^2) convolution. Edge pixels use clamped/replicated borders
 * (the standard, well-defined box-blur-at-image-edge convention), which is exactly why a large
 * radius near an image edge still can't leak AI pixels into a hard-protected interior far from
 * any actual mask edge — only pixels within `radiusPx` of an ACTUAL 0/255 transition ever change.
 * `radiusPx <= 0` is a documented no-op: returns `mask` completely unchanged (byte-identical),
 * satisfying "no feathering at all" as a real code path, not an approximation.
 */
export function featherMask(mask: PixelBuffer, radiusPx: number): PixelBuffer {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return mask;
  const { width, height } = mask;
  const radius = Math.floor(radiusPx);
  const windowSize = radius * 2 + 1;

  const channel = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) channel[i] = mask.data[i * 4]!;

  const horizontal = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += channel[row + clamp(k, 0, width - 1)]!;
    horizontal[row] = sum / windowSize;
    for (let x = 1; x < width; x++) {
      const enter = channel[row + clamp(x + radius, 0, width - 1)]!;
      const leave = channel[row + clamp(x - radius - 1, 0, width - 1)]!;
      sum += enter - leave;
      horizontal[row + x] = sum / windowSize;
    }
  }

  const blurred = new Float64Array(width * height);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += horizontal[clamp(k, 0, height - 1) * width + x]!;
    blurred[x] = sum / windowSize;
    for (let y = 1; y < height; y++) {
      const enter = horizontal[clamp(y + radius, 0, height - 1) * width + x]!;
      const leave = horizontal[clamp(y - radius - 1, 0, height - 1) * width + x]!;
      sum += enter - leave;
      blurred[y * width + x] = sum / windowSize;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(blurred[i]!);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/**
 * Report section 6: FINAL = authoritative booth OVER AI environment, masked. Never resizes —
 * output dimensions always equal the input (beauty) dimensions; any provider-driven resize is
 * the caller's job (domain/visualizationAi.ts's fitWithinMaxInputSize), never this function's.
 * Never mutates `beauty`/`aiEnvironment`/`protectedMask` — always allocates a fresh output buffer.
 */
export function composeStrictLockImage(input: ComposeStrictLockInput): ComposeStrictLockResult {
  const { beauty, aiEnvironment, protectedMask } = input;
  if (
    beauty.width !== aiEnvironment.width || beauty.height !== aiEnvironment.height
    || beauty.width !== protectedMask.width || beauty.height !== protectedMask.height
  ) {
    return { ok: false, reason: "dimension-mismatch" };
  }
  if (!isValidBuffer(beauty) || !isValidBuffer(aiEnvironment) || !isValidBuffer(protectedMask)) {
    return { ok: false, reason: "invalid-buffer-length" };
  }

  const radius = input.featherRadiusPx ?? DEFAULT_FEATHER_RADIUS_PX;
  const effectiveMask = featherMask(protectedMask, radius);
  const { width, height } = beauty;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const maskValue = effectiveMask.data[offset]!;
    if (maskValue >= 255) {
      data[offset] = beauty.data[offset]!;
      data[offset + 1] = beauty.data[offset + 1]!;
      data[offset + 2] = beauty.data[offset + 2]!;
      data[offset + 3] = beauty.data[offset + 3]!;
    } else if (maskValue <= 0) {
      data[offset] = aiEnvironment.data[offset]!;
      data[offset + 1] = aiEnvironment.data[offset + 1]!;
      data[offset + 2] = aiEnvironment.data[offset + 2]!;
      data[offset + 3] = aiEnvironment.data[offset + 3]!;
    } else {
      const alpha = maskValue / 255;
      data[offset] = Math.round(beauty.data[offset]! * alpha + aiEnvironment.data[offset]! * (1 - alpha));
      data[offset + 1] = Math.round(beauty.data[offset + 1]! * alpha + aiEnvironment.data[offset + 1]! * (1 - alpha));
      data[offset + 2] = Math.round(beauty.data[offset + 2]! * alpha + aiEnvironment.data[offset + 2]! * (1 - alpha));
      data[offset + 3] = Math.round(beauty.data[offset + 3]! * alpha + aiEnvironment.data[offset + 3]! * (1 - alpha));
    }
  }

  return { ok: true, composed: { width, height, data } };
}
