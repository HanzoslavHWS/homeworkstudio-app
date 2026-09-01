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
  | Readonly<{
      ok: true;
      composed: PixelBuffer;
      /** v3.3c debug overlay support (report "debug overlay... protected mask, feather band") — the ACTUAL mask used for this composite (post binarizeMask + computeProtectedFeatherMask), never the raw captured one. Lets a debug view show exactly what governed each pixel's beauty/AI/blend decision. */
      effectiveMask: PixelBuffer;
    }>
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
 * v3.3c fix — the RAW captured protected mask is NOT actually strictly binary in practice, even
 * though renderControlPassCapture's own comment documents it as such: it's rendered on the SAME
 * `antialias: true` WebGL canvas as every other pass, so the GPU's own MSAA resolve already
 * softens every silhouette edge before this code ever sees it. For most large protected shapes
 * (booth panels, walls) that sub-pixel softness is invisible. For THIN protected geometry — chair
 * legs, fascia edges, anything only 1-3px wide at capture resolution — the AA softening can reach
 * every single pixel across the feature's whole width, so it never contains a single raw value
 * that's cleanly 255. This function removes that GPU-introduced ambiguity by thresholding at the
 * midpoint BEFORE any of our own intentional feathering — turning "quietly always partially
 * transparent" back into "definitely protected, exactly as wide as the real geometry."
 */
export function binarizeMask(mask: PixelBuffer, threshold = 128): PixelBuffer {
  const { width, height } = mask;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = mask.data[i * 4]! >= threshold ? 255 : 0;
    data[i * 4] = value; data[i * 4 + 1] = value; data[i * 4 + 2] = value; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/**
 * v3.3c fix — the mask actually used to composite (report "binary protected interior... feather
 * jen na hraně masky, ne uvnitř"). Previous behavior fed the RAW captured mask straight into
 * featherMask's symmetric box blur, which produces a ramp centered ON the edge — eroding radiusPx
 * INTO genuinely-protected territory on every boundary, which for thin objects (a 2px-wide chair
 * leg with a 3px feather radius) meant the ENTIRE feature never had a single fully-protected
 * pixel — a visible blend/ghost of AI content through supposedly-locked geometry.
 *
 * This combinator instead: (1) binarizes the raw mask (see binarizeMask above, strips GPU AA
 * softness), (2) box-blurs THAT clean binary mask, (3) takes the pixelwise MAX of the binarized
 * and blurred values. Because max(255, anything) is always 255, every pixel the binarized mask
 * calls protected stays at EXACTLY 255 — 100% beauty, zero blend — no matter how thin the feature
 * or how close to an edge. The blur's only remaining effect is on pixels the binarized mask calls
 * editable (0): there, max(0, blurred) yields a smooth ramp UP toward 255 as the pixel nears a
 * protected edge — i.e. the feather band only ever grows OUTWARD into the editable/environment
 * side of the boundary, never inward. `radiusPx <= 0` skips the blur entirely (still binarized,
 * still a hard cutoff, matching featherMask's own documented no-op convention).
 */
export function computeProtectedFeatherMask(rawMask: PixelBuffer, radiusPx: number): PixelBuffer {
  const binarized = binarizeMask(rawMask);
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) return binarized;

  const blurred = featherMask(binarized, radiusPx);
  const { width, height } = binarized;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = Math.max(binarized.data[i * 4]!, blurred.data[i * 4]!);
    data[i * 4] = value; data[i * 4 + 1] = value; data[i * 4 + 2] = value; data[i * 4 + 3] = 255;
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
  const effectiveMask = computeProtectedFeatherMask(protectedMask, radius);
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

  return { ok: true, composed: { width, height, data }, effectiveMask };
}

/**
 * v3.3c debug overlay (report "debug overlay... feather band"): highlights exactly the pixels
 * computeProtectedFeatherMask actually blended (0 < effectiveMask value < 255) — everywhere else
 * is black. Since the fix, this band can only ever appear on the EDITABLE side of a protected
 * boundary (see computeProtectedFeatherMask's own doc comment) — a human looking at this overlay
 * can directly confirm the band never reaches into protected geometry.
 */
export function visualizeFeatherBand(
  effectiveMask: PixelBuffer,
  highlightColor: Readonly<{ r: number; g: number; b: number }> = { r: 255, g: 0, b: 255 },
): PixelBuffer {
  const { width, height } = effectiveMask;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const value = effectiveMask.data[offset]!;
    const inBand = value > 0 && value < 255;
    data[offset] = inBand ? highlightColor.r : 0;
    data[offset + 1] = inBand ? highlightColor.g : 0;
    data[offset + 2] = inBand ? highlightColor.b : 0;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

/**
 * v3.3c debug overlay (report "final composite difference vs beauty, ať je hned vidět, kde se to
 * duplikuje"): a grayscale heatmap of |composed - beauty| per pixel (max across R/G/B, amplified
 * for visibility). A CORRECT composite reads as solid black across the entire protected region
 * (composed === beauty there, by construction) and only shows brightness in the legitimately
 * AI-replaced editable region — any unexpected bright spot INSIDE what should be protected
 * geometry is a duplication/ghosting bug, made visible at a glance instead of needing a pixel
 * inspector.
 */
export function visualizeDiffVsBeauty(composed: PixelBuffer, beauty: PixelBuffer, amplify = 4): PixelBuffer {
  const { width, height } = composed;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const diffR = Math.abs(composed.data[offset]! - beauty.data[offset]!);
    const diffG = Math.abs(composed.data[offset + 1]! - beauty.data[offset + 1]!);
    const diffB = Math.abs(composed.data[offset + 2]! - beauty.data[offset + 2]!);
    const value = Math.min(255, Math.max(diffR, diffG, diffB) * amplify);
    data[offset] = value; data[offset + 1] = value; data[offset + 2] = value; data[offset + 3] = 255;
  }
  return { width, height, data };
}
