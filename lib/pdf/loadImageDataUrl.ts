"use client";

/**
 * Turns an image URL into a PNG data URL a jsPDF document can `addImage()` directly — jsPDF
 * cannot fetch a URL itself, and browser print-to-PDF (window.print()) has its own separate
 * timing/CORS story this module has nothing to do with (see PrintSurfaceCanvas.tsx/
 * PrintSurfaceExportPanel.tsx's existing print-preview flow, untouched by this).
 *
 * Same-origin URLs (this app's own `/events/<slug>/logo.png`, `/logo/...` static files served
 * from `public/`) always work. A cross-origin URL (e.g. an R2-presigned download URL for a
 * DB-uploaded event logo asset) only works if that host sends permissive CORS headers — if it
 * doesn't, the canvas becomes "tainted" and toDataURL() throws; this function catches that and
 * every other failure and resolves to undefined rather than ever throwing or hanging a PDF build
 * (spec section 4: "PDF nesmí obsahovat prázdné místo jen proto, že logo nebylo načtené včas" —
 * callers render nothing / a text fallback when this resolves to undefined, never a broken image).
 */
export async function loadImageAsDataUrl(url: string, timeoutMs = 8000): Promise<string | undefined> {
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.crossOrigin = "anonymous";
      const timeout = window.setTimeout(() => reject(new Error("timeout")), timeoutMs);
      element.onload = () => { window.clearTimeout(timeout); resolve(element); };
      element.onerror = () => { window.clearTimeout(timeout); reject(new Error("load-error")); };
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    if (canvas.width <= 0 || canvas.height <= 0) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

export type LoadedImageDataUrl = Readonly<{ widthPx: number; heightPx: number; dataUrl: string }>;

/** Same as loadImageAsDataUrl, but also reports the source's real pixel dimensions — jsPDF's addImage needs the aspect ratio to lay an image out without distortion (see lib/presentationPdf.ts's contain-fit math, reused as-is by lib/printSurfacePdf.ts). */
export async function loadImageWithDimensions(url: string, timeoutMs = 8000): Promise<LoadedImageDataUrl | undefined> {
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.crossOrigin = "anonymous";
      const timeout = window.setTimeout(() => reject(new Error("timeout")), timeoutMs);
      element.onload = () => { window.clearTimeout(timeout); resolve(element); };
      element.onerror = () => { window.clearTimeout(timeout); reject(new Error("load-error")); };
      element.src = url;
    });
    const widthPx = image.naturalWidth || image.width;
    const heightPx = image.naturalHeight || image.height;
    if (widthPx <= 0 || heightPx <= 0) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0);
    return { widthPx, heightPx, dataUrl: canvas.toDataURL("image/png") };
  } catch {
    return undefined;
  }
}
