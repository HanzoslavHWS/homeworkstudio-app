/**
 * Visualization v3.3a — deterministic, aspect-ratio-preserving image fit. Exists specifically for
 * lib/ai/openaiVisualizationAiProvider.server.ts's dimension-normalization fallback (report
 * v3.3a section 1): when OpenAI can't/won't return an image at the exact Beauty width/height, the
 * returned environment image must still land on the composite pipeline at Beauty's EXACT pixel
 * dimensions, without ever stretching (non-uniform scale) or cropping the AI content.
 *
 * Pure RGBA-buffer math — no THREE/DOM/network — same "provable by node:test" shape as
 * domain/visualizationCompositing.ts. Lives in lib/ai/ (not domain/) because it's tightly specific
 * to server-side AI-provider image handling, not general visualization business logic — same
 * reasoning as sibling pngEncoder.ts/pngDecoder.ts.
 */

export type RgbaImage = Readonly<{ width: number; height: number; rgba: Uint8Array }>;

export const DEFAULT_LETTERBOX_COLOR = { r: 0, g: 0, b: 0, a: 255 } as const;

/**
 * "Contain" resize: scales `source` UNIFORMLY — both axes by the identical factor, so its own
 * aspect ratio is exactly preserved, never a non-uniform stretch — to the largest size that fits
 * entirely within targetWidth x targetHeight, centers it, and pads the remaining margin with
 * `padColor`. Never crops any source content (the scaled content is always <= the target box on
 * both axes by construction). Nearest-neighbor sampling — fully deterministic, no randomness, no
 * external state. A byte-identical no-op (returns `source` itself) when dimensions already match.
 */
export function fitImageWithLetterbox(
  source: RgbaImage,
  targetWidth: number,
  targetHeight: number,
  padColor: Readonly<{ r: number; g: number; b: number; a: number }> = DEFAULT_LETTERBOX_COLOR,
): RgbaImage {
  if (source.width === targetWidth && source.height === targetHeight) return source;
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth <= 0 || targetHeight <= 0) {
    throw new RangeError("fitImageWithLetterbox: target dimensions must be positive integers.");
  }
  if (source.width <= 0 || source.height <= 0 || source.rgba.length !== source.width * source.height * 4) {
    throw new RangeError("fitImageWithLetterbox: invalid source image.");
  }

  const scale = Math.min(targetWidth / source.width, targetHeight / source.height);
  const scaledWidth = Math.max(1, Math.round(source.width * scale));
  const scaledHeight = Math.max(1, Math.round(source.height * scale));
  const offsetX = Math.floor((targetWidth - scaledWidth) / 2);
  const offsetY = Math.floor((targetHeight - scaledHeight) / 2);

  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let i = 0; i < targetWidth * targetHeight; i++) {
    const offset = i * 4;
    out[offset] = padColor.r;
    out[offset + 1] = padColor.g;
    out[offset + 2] = padColor.b;
    out[offset + 3] = padColor.a;
  }

  for (let y = 0; y < scaledHeight; y++) {
    const destY = offsetY + y;
    if (destY < 0 || destY >= targetHeight) continue;
    const srcY = Math.min(source.height - 1, Math.floor(y / scale));
    for (let x = 0; x < scaledWidth; x++) {
      const destX = offsetX + x;
      if (destX < 0 || destX >= targetWidth) continue;
      const srcX = Math.min(source.width - 1, Math.floor(x / scale));
      const srcOffset = (srcY * source.width + srcX) * 4;
      const destOffset = (destY * targetWidth + destX) * 4;
      out[destOffset] = source.rgba[srcOffset]!;
      out[destOffset + 1] = source.rgba[srcOffset + 1]!;
      out[destOffset + 2] = source.rgba[srcOffset + 2]!;
      out[destOffset + 3] = source.rgba[srcOffset + 3]!;
    }
  }
  return { width: targetWidth, height: targetHeight, rgba: out };
}
