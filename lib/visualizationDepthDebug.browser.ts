/**
 * Visualization v3.2 — the thin browser wrapper around the pure, already-tested
 * domain/visualizationDepth.ts unpack/linearize math. Same `.browser.ts` convention as
 * lib/visualizationAiComposite.browser.ts (needs `document`/`Image`/`<canvas>`) — deliberately its
 * own small file rather than reusing that one, since strict-lock compositing is out of scope for
 * this batch and must stay untouched.
 */
import {
  buildDepthDebugPreview,
  correlateProtectedMaskWithRawDepth,
  diagnoseRawDepthBytes,
  type DepthDebugStats,
  type ProtectedMaskDepthCorrelation,
  type RawDepthByteDiagnostics,
} from "../domain/visualizationDepth";
import type { PixelBuffer } from "../domain/visualizationCompositing";

export type DepthDebugPreviewBrowserInput = Readonly<{
  /** ControlPassBundle.depthDataUrl — the raw RGBADepthPacking capture, untouched. */
  depthDataUrl: string;
  /** ControlPassBundle.depthNear/depthFar — the LIVE camera near/far read at capture time. */
  near: number;
  far: number;
  /**
   * v3.2c: ControlPassBundle.protectedMaskDataUrl from the SAME capture — reused as an
   * independent foreground/coverage signal (report section "Robustnější varianta"). Optional so
   * this function still works (falling back to a narrower RGBA-all-zero background sentinel) when
   * a caller genuinely has no mask to hand it.
   */
  protectedMaskDataUrl?: string;
}>;

export type DepthDebugPreviewBrowserResult =
  | Readonly<{
      ok: true;
      dataUrl: string;
      widthPx: number;
      heightPx: number;
      stats: DepthDebugStats;
      /** Raw-byte audit of the depth capture, computed BEFORE any unpack (report section "Nejprve audituj background detection") — lets a human confirm from real browser output whether the capture itself was empty/degenerate. */
      rawDiagnostics: RawDepthByteDiagnostics;
      /** v3.2d report section 6 — cross-tabulation of Protected Mask foreground/background against the raw depth buffer's all-zero-RGBA/alpha=255 byte patterns. Null only if protectedMaskDataUrl wasn't provided or its dimensions don't match. */
      protectedMaskCorrelation: ProtectedMaskDepthCorrelation | null;
    }>
  | Readonly<{ ok: false; reason: "invalid-buffer-length" | "invalid-near-far" | "image-load-failed" | "canvas-unavailable" }>;

async function loadDepthPixelBuffer(dataUrl: string): Promise<PixelBuffer> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
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
 * Loads the raw depth capture (and, when given, the same-frame Protected Mask as an independent
 * coverage signal), unpacks + linearizes into a human-readable grayscale preview via the pure
 * algorithm, and returns a PNG dataURL — display-only (report section 12). Never touches or
 * replaces ControlPassBundle.depthDataUrl itself; any future provider that needs the raw packed
 * depth keeps reading that field directly.
 */
export async function buildDepthDebugPreviewDataUrl(input: DepthDebugPreviewBrowserInput): Promise<DepthDebugPreviewBrowserResult> {
  try {
    const [rawDepth, coverageMask] = await Promise.all([
      loadDepthPixelBuffer(input.depthDataUrl),
      input.protectedMaskDataUrl ? loadDepthPixelBuffer(input.protectedMaskDataUrl) : Promise.resolve(undefined),
    ]);
    const rawDiagnostics = diagnoseRawDepthBytes(rawDepth);
    const protectedMaskCorrelation = coverageMask ? correlateProtectedMaskWithRawDepth(rawDepth, coverageMask) : null;

    const result = buildDepthDebugPreview({ rawDepth, near: input.near, far: input.far, coverageMask });
    if (result.ok !== true) return { ok: false, reason: result.reason };

    const canvas = document.createElement("canvas");
    canvas.width = result.preview.width;
    canvas.height = result.preview.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "canvas-unavailable" };
    const imageData = ctx.createImageData(result.preview.width, result.preview.height);
    imageData.data.set(result.preview.data);
    ctx.putImageData(imageData, 0, 0);

    return {
      ok: true,
      dataUrl: canvas.toDataURL("image/png"),
      widthPx: result.preview.width,
      heightPx: result.preview.height,
      stats: result.stats,
      rawDiagnostics,
      protectedMaskCorrelation,
    };
  } catch {
    return { ok: false, reason: "image-load-failed" };
  }
}
