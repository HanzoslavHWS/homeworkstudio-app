/**
 * Visualization v3 — the thin browser wrapper around the pure, already-tested
 * domain/visualizationCompositing.ts algorithm. `.browser.ts` here means "needs `document`/
 * `Image`/`<canvas>`, browser-only" (the R2 `.server.ts` convention means "carries a secret" —
 * different axis, same suffix pattern reused for clarity). This is the ONLY file allowed to touch
 * canvas for compositing — everything protection-relevant already lives in the pure function.
 */
import { composeStrictLockImage, type PixelBuffer } from "../domain/visualizationCompositing";

export type CompositeStrictLockBrowserInput = Readonly<{
  beautyDataUrl: string;
  aiEnvironmentDataUrl: string;
  protectedMaskDataUrl: string;
  featherRadiusPx?: number;
}>;

export type CompositeStrictLockBrowserResult =
  | Readonly<{ ok: true; dataUrl: string; widthPx: number; heightPx: number }>
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

/**
 * Loads beauty/AI-environment/protected-mask images, resizes the AI environment and mask to the
 * beauty (authoritative) resolution — a mechanical resize only, never the excluded "AI upscaler"
 * feature — composites via the pure algorithm, and returns a PNG dataURL. The protection
 * guarantee lives entirely in composeStrictLockImage; this function only moves bytes in and out
 * of real ImageData.
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

    const canvas = document.createElement("canvas");
    canvas.width = result.composed.width;
    canvas.height = result.composed.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "canvas-unavailable" };
    const imageData = ctx.createImageData(result.composed.width, result.composed.height);
    imageData.data.set(result.composed.data);
    ctx.putImageData(imageData, 0, 0);

    return { ok: true, dataUrl: canvas.toDataURL("image/png"), widthPx: result.composed.width, heightPx: result.composed.height };
  } catch {
    return { ok: false, reason: "image-load-failed" };
  }
}
