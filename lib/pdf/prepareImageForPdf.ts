"use client";

/**
 * PDF image optimization (real-usage follow-up: a "Tiskový přehled" export was hitting ~12MB
 * because full-original-resolution photos — often 4000x3000 or larger, straight off a phone/
 * camera — were being embedded as lossless PNG at native pixel size, even though an A4 page only
 * ever shows that photo inside a box a few centimeters across (see
 * lib/pdf/printSurfaceViewLayout.ts). This module is the ONE place that decides the target pixel
 * size and encodes the compressed JPEG — layout code (lib/printSurfacePdf.ts) never re-implements
 * this, and the ORIGINAL uploaded StoredAsset in R2 is never touched by any of this (spec: only the
 * copy embedded in the PDF is optimized).
 */

/**
 * DPI target for a booth photo/render embedded in the PDF — an A4 technical overview is not a
 * photo catalog; 300 DPI at the largest real render box (182mm, single view) is ~2150px, while a
 * two-view side-by-side layout's smaller boxes (see lib/pdf/printSurfaceViewLayout.ts) naturally
 * target fewer pixels — exactly why 200 DPI still looked soft for two views side by side (a
 * relatively small physical box at 200 DPI is still a fairly low absolute pixel count). History:
 * 160/0.82 -> ~6MB; 140/0.76 over-corrected to ~600KB (visibly blurred); 180/0.82 -> ~1-2.5MB but
 * still slightly soft for 2 views; 200/0.86 -> ~450KB, still soft (real-usage follow-up: "u dvou
 * views vedle sebe je fyzický box relativně malý, takže 200 DPI stále znamená jen relativně nízké
 * pixel dimensions"); raised once more to 300/0.90 — quality is now the explicit priority over
 * minimum size (spec: "Neřeš teď minimální velikost... klidně 1-3 MB").
 */
export const PRINT_SURFACE_PDF_IMAGE_DPI = 300;
/** JPEG quality (0-1) for booth photos/renders — a reasonable compromise between file size and visible artifacting for photographic content; kept as ONE named constant, never a magic number inline. */
export const PRINT_SURFACE_PDF_JPEG_QUALITY = 0.9;
/**
 * DPI target for the event logo specifically — a much higher value than booth photos on purpose:
 * the logo box is tiny (34x20mm, see PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM/HEIGHT_MM), so even at
 * genuine print-shop quality (300 DPI) the resulting PNG is a few dozen KB at most — negligible
 * cost for guaranteed sharpness on a brand asset that must never look soft (spec: "Logo je malé a
 * musí zůstat ostré").
 */
export const PRINT_SURFACE_PDF_LOGO_DPI = 300;

export type PrintSurfacePdfImageSize = Readonly<{ widthPx: number; heightPx: number }>;

/**
 * Pure math, no DOM — the target embed size for an image whose CONTAIN-FIT rendered size on the
 * page is `renderedWidthMm`x`renderedHeightMm` (see lib/pdf/imageRect.ts's resolveContainRect,
 * which already preserves the original aspect ratio, so both dimensions here scale by the exact
 * same factor). NEVER upscales: when the original is already smaller than the DPI target in
 * either dimension, the original size is returned unchanged.
 */
export function computeTargetPixelSize(
  renderedWidthMm: number,
  renderedHeightMm: number,
  originalWidthPx: number,
  originalHeightPx: number,
  dpi: number = PRINT_SURFACE_PDF_IMAGE_DPI,
): PrintSurfacePdfImageSize {
  if (originalWidthPx <= 0 || originalHeightPx <= 0 || renderedWidthMm <= 0 || renderedHeightMm <= 0) {
    return { widthPx: Math.max(0, originalWidthPx), heightPx: Math.max(0, originalHeightPx) };
  }
  const mmToPx = (mm: number) => Math.max(1, Math.round((mm / 25.4) * dpi));
  const targetWidthPx = mmToPx(renderedWidthMm);
  const targetHeightPx = mmToPx(renderedHeightMm);
  if (targetWidthPx >= originalWidthPx || targetHeightPx >= originalHeightPx) {
    return { widthPx: originalWidthPx, heightPx: originalHeightPx };
  }
  return { widthPx: targetWidthPx, heightPx: targetHeightPx };
}

export type PreparedPdfImage = Readonly<{
  dataUrl: string;
  format: "JPEG" | "PNG";
  widthPx: number;
  heightPx: number;
  /** Rough byte estimate from the data URL's base64 payload length — cheap (no Blob round trip), accurate to within a percent or two, good enough for the dev-only size diagnostics below (spec section 14: not required to be byte-perfect). */
  approximateBytes: number;
}>;

function approximateDataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.round((base64.length * 3) / 4);
}

/**
 * Resizes+re-encodes an already-loaded image element to the size the PDF will actually render it
 * at. Defaults to JPEG (booth photos/renders are always photographic, never need alpha transparency
 * in this document — see the module doc) — flattening onto a white background BEFORE drawing, so a
 * PNG source that happens to carry an (unused) alpha channel can never turn black once re-encoded, a
 * safe universal choice for this image category, not per-pixel alpha detection.
 *
 * `format: "PNG"` is for the ONE other caller that needs it — the event logo (real-usage follow-up:
 * a logo can legitimately be a multi-MB high-resolution PNG even though it's drawn at a tiny
 * 34x20mm box, see PRINT_SURFACE_PDF_LOGO_DPI). PNG mode skips the white-background flatten
 * entirely, preserving any real alpha transparency — never converted to JPEG (spec: "zachovej PNG
 * kvůli ostrým hranám/transparenci").
 *
 * Never upscales either way (see computeTargetPixelSize) — unless `nativeResolution` is set, which
 * skips the DPI/box computation entirely and embeds the image at its own real pixel dimensions.
 * That mode exists ONLY as the fallback callers use when the normal downscaled encode fails (real-
 * usage follow-up: "pokud optimization selže, zkus původní image data") — never the default path,
 * since it defeats the whole point of this module for the common case.
 */
export function prepareImageForPdf(input: Readonly<{
  element: CanvasImageSource;
  originalWidthPx: number;
  originalHeightPx: number;
  renderedWidthMm: number;
  renderedHeightMm: number;
  dpi?: number;
  quality?: number;
  format?: "JPEG" | "PNG";
  nativeResolution?: boolean;
  /** Dev-only diagnostic label (e.g. a view's label/id, or "event logo") — identifies which image failed if the canvas draw/encode below throws. Never included in production output, never logs the image data itself (see logImageProcessingFailure). */
  diagnosticLabel?: string;
}>): PreparedPdfImage | undefined {
  const format = input.format ?? "JPEG";
  const { widthPx, heightPx } = input.nativeResolution
    ? { widthPx: input.originalWidthPx, heightPx: input.originalHeightPx }
    : computeTargetPixelSize(
      input.renderedWidthMm, input.renderedHeightMm, input.originalWidthPx, input.originalHeightPx,
      input.dpi ?? (format === "PNG" ? PRINT_SURFACE_PDF_LOGO_DPI : PRINT_SURFACE_PDF_IMAGE_DPI),
    );
  if (widthPx <= 0 || heightPx <= 0) return undefined;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    if (format === "JPEG") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, widthPx, heightPx);
    }
    ctx.drawImage(input.element, 0, 0, widthPx, heightPx);

    // A cross-origin source (e.g. an R2-presigned URL without permissive CORS headers) taints the
    // canvas — toDataURL() throws a SecurityError. The caller decides what to do about a failure
    // here (see the module's `nativeResolution` fallback and PrintSurfaceExportPanel.tsx's own
    // optimized -> native -> hard-failure chain for booth views) — this function itself never
    // silently invents a "successful" result.
    const dataUrl = format === "JPEG"
      ? canvas.toDataURL("image/jpeg", input.quality ?? PRINT_SURFACE_PDF_JPEG_QUALITY)
      : canvas.toDataURL("image/png");

    return { dataUrl, format, widthPx, heightPx, approximateBytes: approximateDataUrlBytes(dataUrl) };
  } catch (error) {
    if (input.diagnosticLabel) {
      logImageProcessingFailure(input.diagnosticLabel, input.nativeResolution ? "native-resolution-encode" : "optimized-encode", error);
    }
    return undefined;
  }
}

/**
 * Dev-only diagnostic (real-usage follow-up spec section 5) — never logs in production, never logs
 * the image data itself (no data URL/base64, no secrets). Reports exactly which image and which
 * processing phase failed, plus the real error message, so a "why is this PDF missing an image"
 * report can be answered from the browser console instead of guessed at.
 */
export function logImageProcessingFailure(label: string, phase: string, error: unknown): void {
  if (process.env.NODE_ENV === "production") return;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[print-surfaces] image processing failed: ${label} (${phase})`, message);
}

/**
 * Dev-only size diagnostic (spec section 14) — never runs, never logs, in production. Opt-in per
 * call site (never automatic on every prepareImageForPdf call), so it stays a deliberate debugging
 * tool rather than permanent console noise even in development.
 */
export function logPreparedPdfImageDiagnostics(
  label: string,
  original: Readonly<{ widthPx: number; heightPx: number; approximateSourceBytes?: number }>,
  prepared: PreparedPdfImage,
): void {
  if (process.env.NODE_ENV === "production") return;
  const formatKB = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
  const sourceSize = original.approximateSourceBytes ? ` (~${formatKB(original.approximateSourceBytes)})` : "";
  console.debug(
    `[print-surfaces] ${label}: ${original.widthPx}x${original.heightPx}${sourceSize} -> ${prepared.widthPx}x${prepared.heightPx} ${prepared.format} (~${formatKB(prepared.approximateBytes)})`,
  );
}
