"use client";

/**
 * Loads an image URL as an <img> element for a jsPDF document to embed — jsPDF cannot fetch a URL
 * itself, and browser print-to-PDF (window.print()) has its own separate timing/CORS story this
 * module has nothing to do with (see PrintSurfaceCanvas.tsx/PrintSurfaceExportPanel.tsx's existing
 * print-preview flow, untouched by this).
 *
 * Same-origin URLs (this app's own `/events/<slug>/logo.png`, `/logo/...` static files served from
 * `public/`) always work. A cross-origin URL (e.g. an R2-presigned download URL for a DB-uploaded
 * asset) only works reliably for canvas re-encoding if that host sends permissive CORS headers —
 * see lib/pdf/prepareImageForPdf.ts's own try/catch around the actual canvas draw/encode for what
 * happens when it doesn't (a "tainted" canvas throws there, caught, resolves to undefined rather
 * than ever throwing or hanging the whole PDF build — spec: "PDF nesmí obsahovat prázdné místo jen
 * proto, že logo nebylo načtené včas", and the same principle applies to a broken view photo).
 */
export async function loadImageElement(url: string, timeoutMs = 8000): Promise<HTMLImageElement | undefined> {
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.crossOrigin = "anonymous";
      const timeout = window.setTimeout(() => reject(new Error("timeout")), timeoutMs);
      element.onload = () => { window.clearTimeout(timeout); resolve(element); };
      element.onerror = () => { window.clearTimeout(timeout); reject(new Error("load-error")); };
      element.src = url;
    });
  } catch {
    return undefined;
  }
}

/** `format` is optional/backward-compatible: a caller that only ever produced PNG data URLs (every existing test fixture) can omit it, and lib/printSurfacePdf.ts's drawViewImage treats a missing format as "PNG" — the optimized path (lib/pdf/prepareImageForPdf.ts) always sets it explicitly (JPEG for booth photos, PNG for the event logo). */
export type LoadedImageDataUrl = Readonly<{ widthPx: number; heightPx: number; dataUrl: string; format?: "JPEG" | "PNG" }>;
