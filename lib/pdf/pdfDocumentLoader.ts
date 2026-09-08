"use client";

/**
 * Technické rastry — the ONE place pdfjs-dist is dynamically imported and configured (worker
 * setup), mirroring lib/printSurfacePdf.ts's `const { jsPDF } = await import("jspdf")` pattern
 * for the same reason: this is a large, browser-only library that must never end up in a
 * server bundle. Every other pdf/*.ts module in this feature (text extraction, layers, rendering)
 * calls loadPdfDocument() rather than importing pdfjs-dist itself.
 */
export type PdfJsDocument = Readonly<{
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  getOptionalContentConfig(): Promise<PdfJsOptionalContentConfig>;
  /** Public, documented pdf.js API (`PDFDocumentProxy.destroy()`) — releases the document's worker/WASM resources. Callers that keep a document around across renders (see components/workflow/technicalRasters/TechnicalRasterCanvas.tsx) must call this before dropping their reference (a new upload, or unmount) so a replaced raster doesn't leak its previous document's worker. */
  destroy(): Promise<void>;
}>;

/** `transform` is pdf.js's own public `PageViewport.transform` — a standard 6-value PDF affine matrix `[a,b,c,d,e,f]` mapping a raw page-space point `(x,y)` to `(a*x+c*y+e, b*x+d*y+f)` in this viewport's own space. It already encodes the page's rotation AND the top-left/Y-down flip pdf.js uses for canvas rendering — see lib/pdf/rasterStandLabelDetection.ts for the one place this app applies it, so raster stand-label positions stay correct on a rotated PDF page (verified: at rotation 0 this produces byte-identical results to the plain width/height-only math this type used to expose). */
export type PdfJsViewport = Readonly<{ width: number; height: number; transform: readonly [number, number, number, number, number, number] }>;

/** A page's compiled drawing operators — fully public/documented pdf.js API (`PDFOperatorList` in pdfjs-dist's own published types). `argsArray` is intentionally mutable here: lib/pdf/technicalRasterWhiteRender.ts reads it read-only for analysis only, it never assigns into pdf.js's own copy (see that module's doc for why). */
export type PdfJsOperatorList = { fnArray: readonly number[]; argsArray: unknown[] };

/** `(index: number) => boolean` — a genuinely public, typed pdf.js render() option (`OperationsFilter` in pdfjs-dist's published types), NOT an internal API. Returning `false` skips that operator; this app only ever uses it to OBSERVE which operator is about to run (always returning `true`), never to skip one — see lib/pdf/technicalRasterWhiteRender.ts. */
export type PdfJsOperationsFilter = (index: number) => boolean;

export type PdfJsPage = Readonly<{
  getViewport(params: { scale: number }): PdfJsViewport;
  getTextContent(): Promise<{ items: readonly PdfJsTextItem[] }>;
  getOperatorList(params?: { intent?: string }): Promise<PdfJsOperatorList>;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    /** pdf.js's render() defaults this to `canvasContext.canvas` and, if truthy, re-derives a FRESH 2D context from it — discarding a custom/wrapped `canvasContext` entirely. lib/pdf/technicalRasterWhiteRender.ts explicitly passes `null` here to keep its proxied context in effect; every other caller can omit this field. */
    canvas?: unknown;
    viewport: PdfJsViewport;
    optionalContentConfigPromise?: Promise<PdfJsOptionalContentConfig>;
    intent?: string;
    operationsFilter?: PdfJsOperationsFilter;
  }): { promise: Promise<void> };
}>;

export type PdfJsTextItem = Readonly<{
  str: string;
  width: number;
  height: number;
  transform: readonly [number, number, number, number, number, number];
}>;

export type PdfJsOptionalContentGroup = Readonly<{ name: string | null }>;

export type PdfJsOptionalContentConfig = Readonly<{
  getOrder(): readonly string[] | null;
  getGroup(id: string): PdfJsOptionalContentGroup | null;
  isVisible(id: string): boolean;
  setVisibility(id: string, visible: boolean): void;
}>;

let workerConfigured = false;

/**
 * Loads a PDF document either from a URL (a presigned R2 download URL in practice — see
 * lib/storage/assetClient.ts, used for the raster preview) or from raw bytes (used to parse a
 * just-picked technical-report File client-side BEFORE it's uploaded — spec section 25 wants
 * parse warnings/stats shown to the user as an immediate preview, not only after a round trip).
 * Never mutates/writes the source either way; this is always a read-only handle.
 */
export async function loadPdfDocument(source: string | Readonly<{ data: ArrayBuffer }>): Promise<PdfJsDocument> {
  const pdfjs = await import("pdfjs-dist");
  if (!workerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    workerConfigured = true;
  }
  const task = typeof source === "string" ? pdfjs.getDocument({ url: source }) : pdfjs.getDocument({ data: source.data });
  return (await task.promise) as unknown as PdfJsDocument;
}
