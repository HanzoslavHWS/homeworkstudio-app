/**
 * Visualization v3/v3.3c — the thin browser wrapper around the pure, already-tested
 * domain/visualizationCompositing.ts algorithm. `.browser.ts` here means "needs `document`/
 * `Image`/`<canvas>`, browser-only" (the R2 `.server.ts` convention means "carries a secret" —
 * different axis, same suffix pattern reused for clarity). This is the ONLY file allowed to touch
 * canvas for compositing — everything protection-relevant already lives in the pure function.
 */
import {
  composeStrictLockImage,
  visualizeDiffVsBeauty,
  visualizeFeatherBand,
  type PixelBuffer,
} from "../domain/visualizationCompositing";

export type CompositeStrictLockBrowserInput = Readonly<{
  beautyDataUrl: string;
  aiEnvironmentDataUrl: string;
  protectedMaskDataUrl: string;
  featherRadiusPx?: number;
  /** v3.3c — dev-only debug overlay opt-in (report "debug overlay"). When true, also builds and returns the 3 debug PNGs below. Never used in the production save path (AiVisualizationPanel.tsx only passes it when NODE_ENV !== "production"), and never affects `dataUrl` itself. */
  debug?: boolean;
}>;

/** v3.3c debug overlay tiles — display-only, never persisted. */
export type CompositeDebugOverlays = Readonly<{
  /** The ACTUAL mask used to composite (post binarize + outward-only feather), not the raw captured Protected Mask — grayscale, same convention (255=protected, 0=editable). */
  effectiveMaskDataUrl: string;
  /** Highlights exactly the pixels that were blended (0 < mask < 255) — should only ever appear on the editable side of a protected boundary. */
  featherBandDataUrl: string;
  /** |composed - beauty| heatmap — solid black across the whole protected region if the composite is correct; any bright spot inside protected geometry is a duplication/ghosting bug made visible at a glance. */
  diffVsBeautyDataUrl: string;
}>;

export type CompositeStrictLockBrowserResult =
  | Readonly<{ ok: true; dataUrl: string; widthPx: number; heightPx: number; debug?: CompositeDebugOverlays }>
  | Readonly<{ ok: false; reason: "dimension-mismatch" | "invalid-buffer-length" | "image-load-failed" | "canvas-unavailable" }>;

async function loadImageToPixelBuffer(dataUrl: string, targetWidth?: number, targetHeight?: number): Promise<PixelBuffer> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const width = targetWidth ?? image.naturalWidth;
  const height = targetHeight ?? image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");
  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { width, height, data: imageData.data };
}

function pixelBufferToDataUrl(buffer: PixelBuffer): string {
  const canvas = document.createElement("canvas");
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");
  const imageData = ctx.createImageData(buffer.width, buffer.height);
  imageData.data.set(buffer.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Loads beauty/AI-environment/protected-mask images, resizes the AI environment and mask to the
 * beauty (authoritative) resolution — a mechanical resize only, never the excluded "AI upscaler"
 * feature — composites via the pure algorithm, and returns a PNG dataURL. The protection
 * guarantee lives entirely in composeStrictLockImage; this function only moves bytes in and out
 * of real ImageData. `debug: true` additionally builds the 3 debug overlay PNGs (report v3.3c) —
 * display-only, never affects `dataUrl`/`widthPx`/`heightPx`.
 */
export async function compositeStrictLockInBrowser(input: CompositeStrictLockBrowserInput): Promise<CompositeStrictLockBrowserResult> {
  try {
    const beauty = await loadImageToPixelBuffer(input.beautyDataUrl);
    const [protectedMask, aiEnvironment] = await Promise.all([
      loadImageToPixelBuffer(input.protectedMaskDataUrl, beauty.width, beauty.height),
      loadImageToPixelBuffer(input.aiEnvironmentDataUrl, beauty.width, beauty.height),
    ]);

    const result = composeStrictLockImage({ beauty, aiEnvironment, protectedMask, featherRadiusPx: input.featherRadiusPx });
    if (result.ok !== true) return { ok: false, reason: result.reason };

    const dataUrl = pixelBufferToDataUrl(result.composed);
    const debug: CompositeDebugOverlays | undefined = input.debug
      ? {
          effectiveMaskDataUrl: pixelBufferToDataUrl(result.effectiveMask),
          featherBandDataUrl: pixelBufferToDataUrl(visualizeFeatherBand(result.effectiveMask)),
          diffVsBeautyDataUrl: pixelBufferToDataUrl(visualizeDiffVsBeauty(result.composed, beauty)),
        }
      : undefined;

    return { ok: true, dataUrl, widthPx: result.composed.width, heightPx: result.composed.height, debug };
  } catch {
    return { ok: false, reason: "image-load-failed" };
  }
}
