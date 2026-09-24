"use client";

/**
 * Technické rastry — the ONE place pdfjs-dist is dynamically imported and configured (worker
 * setup), mirroring lib/printSurfacePdf.ts's `const { jsPDF } = await import("jspdf")` pattern
 * for the same reason: this is a large, browser-only library that must never end up in a
 * server bundle. Every other pdf/*.ts module in this feature (text extraction, layers, rendering)
 * calls loadPdfDocument() rather than importing pdfjs-dist itself.
 */
import { ensurePdfJsWorkerConfigured } from "./pdfJsWorkerConfig.ts";
import { createWhiteModeCanvasContextProxy } from "./pdfWhiteModeCanvasProxy.ts";

/**
 * CORRECTIVE BATCH (editor-only white mode) — the "session" lib/pdf/technicalRasterWhiteRender.ts's
 * `renderWhiteModePage` installs on a document's own canvas factory for the duration of ONE
 * `page.render()` call, so `WhiteModeAwareCanvasFactory` below can apply the SAME fillStyle-forcing
 * Proxy to every canvas pdf.js creates internally (not just the one top-level canvas the caller
 * already wraps itself) — see that module's own doc for the real-file-confirmed root cause this
 * closes (a Form XObject's `/Group /S /Transparency` paints onto a brand new offscreen canvas pdf.js
 * creates via this exact factory, which the top-level-only wrap never reached).
 */
export type PdfJsWhiteModeCanvasSession = Readonly<{
  /**
   * PRODUCTION BATCH (per-source-OCG-layer text-size reduction, part A) — the fillStyle/globalAlpha
   * fields below are now OPTIONAL: a session can be installed for TEXT SCALING ALONE (white mode
   * off, one or more layers configured with a text scale below 100%), in which case
   * `patchedIndices`/`fillColor`/`neutralizeAlphaIndices` are simply omitted/empty and
   * `createWhiteModeCanvasContextProxy` skips its fillStyle/globalAlpha interception entirely —
   * zero behavior change for a render that only ever used the white-mode fields, since those still
   * default to `new Set()` there when omitted.
   */
  patchedIndices?: ReadonlySet<number>;
  fillColor?: string;
  operatorIndexRef: Readonly<{ current: number }>;
  /**
   * CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill) — every operator index
   * where a source `gs` ran while inside the target OCG scope (domain/technicalRasterWhiteModeOperators.ts's
   * own `sourceGsIndicesInsideTarget`). `WhiteModeAwareCanvasFactory.create()` forces `globalAlpha`
   * to `1` at exactly these indices on EVERY canvas it creates — see lib/pdf/pdfWhiteModeCanvasProxy.ts's
   * own doc for why this (not just the fillStyle-forcing trick) is what a real H3 stand's own
   * page-level `/ca 0.76` ExtGState actually requires to be neutralized.
   */
  neutralizeAlphaIndices?: ReadonlySet<number>;
  /** PRODUCTION BATCH, part A — operator index -> font-size multiplier, for every `setFont` (Tf) call reached inside ANY configured text-scale layer's own marked-content span (one entry per layer's own patch plan, merged). Omitted/empty for a render with no active text-scale layer. */
  fontScaleByIndex?: ReadonlyMap<number, number>;
}>;

export type PdfJsDocument = Readonly<{
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  getOptionalContentConfig(): Promise<PdfJsOptionalContentConfig>;
  /**
   * CORRECTIVE BATCH (editor-only white mode) — installs/clears the active white-mode session (see
   * `PdfJsWhiteModeCanvasSession`'s own doc) on this document's own canvas factory. Optional so
   * every pre-existing `PdfJsDocument` fake in this feature's test suite (none of which exercise a
   * real pdf.js canvas factory at all) keeps compiling unchanged; the real `loadPdfDocument()`
   * result below always implements it.
   */
  setWhiteModeCanvasSession?(session: PdfJsWhiteModeCanvasSession | undefined): void;
  /**
   * Releases the document's worker/WASM resources. Callers that keep a document around across
   * renders (see components/workflow/technicalRasters/TechnicalRasterCanvas.tsx) must call this
   * before dropping their reference (a new upload, or unmount) so a replaced raster doesn't leak
   * its previous document's worker.
   *
   * NOT literally `PDFDocumentProxy.destroy()` — that method doesn't exist (verified directly
   * against pdfjs-dist 6.3.289's source: `PDFDocumentProxy` only has `cleanup()`, which merely
   * clears cached page data, not the worker). The real resource owner is the `PDFDocumentLoadingTask`
   * that `pdfjs.getDocument()` returns — `loadPdfDocument()` below resolves that task's own
   * `.promise` to get the `PDFDocumentProxy` callers actually use, but keeps the task itself in a
   * closure and routes `destroy()` there. This field exists so every call site has exactly ONE
   * thing to call, without needing to know pdf.js's two-object loading-task/document-proxy split.
   */
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

/**
 * CORRECTIVE BATCH (editor-only white mode) — pdf.js's `getDocument({ CanvasFactory })` option
 * accepts a CONSTRUCTOR (it always does `new CanvasFactory({ownerDocument, enableHWA})` itself
 * internally — confirmed directly against pdfjs-dist 6.3.289's source), used for EVERY canvas pdf.js
 * creates on its own for the lifetime of that document: transparency-group compositing, soft masks,
 * tiling patterns, shading meshes — never the ONE top-level canvas a caller hands to `page.render()`
 * itself, which this app already manages directly. Mirrors pdf.js's own (internal, unexported)
 * `DOMCanvasFactory` exactly for `create`/`reset`/`destroy` (real `<canvas>` element, real 2D
 * context, `willReadFrequently: true` — matching what `BaseCanvasFactory.create()` does) — the ONLY
 * difference is `create()` wraps the real context in `createWhiteModeCanvasContextProxy` whenever an
 * "active session" is currently set via `setActiveSession`. With no active session (every ordinary,
 * non-white-mode render — the overwhelming majority of this app's rendering) `create()` returns the
 * exact same plain, unwrapped context pdf.js's own default factory would have — zero behavior
 * change, so this can never regress a render that isn't currently in the middle of white mode.
 *
 * Root cause this exists to fix (see lib/pdf/technicalRasterWhiteRender.ts's own module doc for the
 * full story, confirmed empirically via scripts/technicalRasterEditorWhiteModeRealDiagnostic.ts): a
 * Form XObject's own `/Group /S /Transparency` makes pdf.js's CanvasGraphics#beginGroup create a
 * brand-new offscreen canvas via exactly this factory and paint the Form's own content onto THAT
 * context — a fillStyle-forcing wrap that only ever covers the top-level canvas never sees those
 * fills at all. Wrapping every canvas THIS factory ever creates, all driven by the one shared
 * `operatorIndexRef`/`patchedIndices` (a single continuous index across the WHOLE flattened operator
 * list, regardless of which physical canvas ends up painting a given operator — confirmed directly),
 * closes that gap without ever risking whitening anything outside the pre-computed target indices.
 */
export class WhiteModeAwareCanvasFactory {
  #ownerDocument: Document;
  #activeSession: PdfJsWhiteModeCanvasSession | undefined;

  constructor({ ownerDocument = globalThis.document }: Readonly<{ ownerDocument?: Document; enableHWA?: boolean }> = {}) {
    this.#ownerDocument = ownerDocument;
  }

  setActiveSession(session: PdfJsWhiteModeCanvasSession | undefined): void {
    this.#activeSession = session;
  }

  create(width: number, height: number): Readonly<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }> {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = this.#ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const rawContext = canvas.getContext("2d", { willReadFrequently: true });
    if (!rawContext) throw new Error("Unable to obtain a 2D canvas rendering context.");
    const context = this.#activeSession
      ? createWhiteModeCanvasContextProxy(
        rawContext,
        this.#activeSession.patchedIndices ?? new Set(),
        this.#activeSession.fillColor ?? "",
        this.#activeSession.operatorIndexRef,
        this.#activeSession.neutralizeAlphaIndices ?? new Set(),
        this.#activeSession.fontScaleByIndex ?? new Map(),
      )
      : rawContext;
    return { canvas, context };
  }

  reset(canvasAndContext: { canvas: HTMLCanvasElement | null }, width: number, height: number): void {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: { canvas: HTMLCanvasElement | null; context: unknown }): void {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified");
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

/**
 * `pdfjs.getDocument()` returns a `PDFDocumentLoadingTask`, whose OWN `.promise` resolves to the
 * `PDFDocumentProxy` every other pdf/*.ts module in this feature actually calls `getPage()`/
 * `getOptionalContentConfig()` on. The loading task — not the proxy — is what owns `.destroy()`
 * (confirmed directly against pdfjs-dist 6.3.289's source: `PDFDocumentProxy` only has
 * `cleanup()`, which merely clears cached page data, never the worker). This pure function is the
 * ONE place that wiring happens: it keeps `loadingTask` alive only inside its own closure and
 * returns a thin wrapper around the resolved proxy whose `destroy()` calls back into the task, so
 * every caller still has exactly one object with exactly one lifecycle method to call — never a
 * raw, undestroyable `PDFDocumentProxy` leaking out of this module.
 *
 * Exported (and kept pdfjs-dist-import-free, taking already-resolved objects) specifically so
 * tests/pdfDocumentLoader.test.ts can exercise this EXACT wiring against pdfjs-dist's own real
 * `getDocument()` result (a synthetic in-memory PDF, not a hand-typed mock) — this is what
 * regression-tested the original "document.destroy is not a function" bug, which no earlier test
 * caught because every mock/fake `PdfJsDocument` used in this feature's other tests was
 * hand-typed to already include a working `destroy`, matching the TYPE contract but not pdf.js's
 * actual runtime shape.
 */
export function wrapPdfDocumentProxy(
  loadingTask: Readonly<{ destroy(): Promise<void> }>,
  proxy: Omit<PdfJsDocument, "destroy">,
  /** CORRECTIVE BATCH (editor-only white mode) — the SAME `WhiteModeAwareCanvasFactory` instance `loadPdfDocument` handed to `getDocument({ CanvasFactory })` for this document, so the returned `PdfJsDocument` can implement `setWhiteModeCanvasSession`. Optional (defaults to no-op) so `tests/pdfDocumentLoader.test.ts`'s own direct calls — which predate this batch and never touch canvas rendering — keep working unchanged. */
  canvasFactory?: WhiteModeAwareCanvasFactory,
): PdfJsDocument {
  let destroyed = false;
  return {
    get numPages() { return proxy.numPages; },
    getPage: (pageNumber: number) => proxy.getPage(pageNumber),
    getOptionalContentConfig: () => proxy.getOptionalContentConfig(),
    setWhiteModeCanvasSession: (session) => canvasFactory?.setActiveSession(session),
    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      await loadingTask.destroy();
    },
  };
}

/**
 * Resolves a `PDFDocumentLoadingTask` into the plain resolved proxy `loadPdfDocument` wraps —
 * split out from `loadPdfDocument` itself (spec batch 5, UI section 25) specifically so
 * tests/pdfDocumentLoader.test.ts can exercise this EXACT failure-path wiring against pdfjs-dist's
 * own real `getDocument()` result (a genuinely invalid PDF, not a hand-typed mock).
 *
 * ROOT CAUSE fixed here: `pdfjs.getDocument()` returns a task that owns worker/network resources
 * from the moment it's created — but reading pdf.js's own source (PDFDocumentLoadingTask, this
 * pinned 6.3.289) shows that when `loadingTask.promise` REJECTS (a network failure, an invalid
 * PDF, an expired signed URL returning a non-2xx status, ...), pdf.js only rejects that promise —
 * it never calls the task's own `destroy()`, so the task's worker is silently ORPHANED unless the
 * caller explicitly destroys it. The previous implementation here just `await`ed the promise with
 * no catch, so every failed load (and, once a retry-on-failure was added elsewhere in this batch,
 * every retry too) leaked one worker. This wraps the await in try/catch and destroys the task
 * before rethrowing, so a failed load leaves nothing behind — the exact same discipline
 * `TechnicalRasterCanvas.tsx`'s own loading effect already applies on ITS cleanup path, just
 * closing the gap for the "never even got a PdfJsDocument to call destroy() on" case.
 */
export async function loadingTaskToDocument(
  loadingTask: Readonly<{ promise: Promise<unknown>; destroy(): Promise<void> }>,
): Promise<Omit<PdfJsDocument, "destroy">> {
  try {
    return (await loadingTask.promise) as unknown as Omit<PdfJsDocument, "destroy">;
  } catch (error) {
    await loadingTask.destroy();
    throw error;
  }
}

/**
 * Loads a PDF document either from a URL (a presigned R2 download URL in practice — see
 * lib/storage/assetClient.ts, used for the raster preview) or from raw bytes (used to parse a
 * just-picked technical-report File client-side BEFORE it's uploaded — spec section 25 wants
 * parse warnings/stats shown to the user as an immediate preview, not only after a round trip).
 * Never mutates/writes the source either way; this is always a read-only handle.
 */
export async function loadPdfDocument(source: string | Readonly<{ data: ArrayBuffer }>): Promise<PdfJsDocument> {
  const pdfjs = await import("pdfjs-dist");
  ensurePdfJsWorkerConfigured(pdfjs, new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url));

  // CORRECTIVE BATCH (editor-only white mode) — `getDocument({ CanvasFactory })` only ever accepts
  // a CONSTRUCTOR (it calls `new CanvasFactory({...})` internally itself), never a pre-built
  // instance, so the only way to get a handle on THIS document's own factory instance afterward is
  // to have its constructor capture itself into a variable in this closure — construction happens
  // synchronously inside `getDocument()`, before it returns, so `canvasFactory` is always set by
  // the time it's read below.
  let canvasFactory: WhiteModeAwareCanvasFactory | undefined;
  class CapturingWhiteModeAwareCanvasFactory extends WhiteModeAwareCanvasFactory {
    constructor(options?: ConstructorParameters<typeof WhiteModeAwareCanvasFactory>[0]) {
      super(options);
      canvasFactory = this;
    }
  }

  const loadingTask = typeof source === "string"
    ? pdfjs.getDocument({ url: source, CanvasFactory: CapturingWhiteModeAwareCanvasFactory })
    : pdfjs.getDocument({ data: source.data, CanvasFactory: CapturingWhiteModeAwareCanvasFactory });
  const proxy = await loadingTaskToDocument(loadingTask);
  return wrapPdfDocumentProxy(loadingTask, proxy, canvasFactory);
}
