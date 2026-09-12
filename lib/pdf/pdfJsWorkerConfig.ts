"use client";

/**
 * Technické rastry — the ONE shared PDF.js worker-configuration helper (manual acceptance batch,
 * "WORKER ERROR" section 30-33). ROOT CAUSE of the real user-facing `No
 * "GlobalWorkerOptions.workerSrc" specified.` error on the Výstupy (export) step:
 * lib/technicalRasterVectorPdf.ts's resolveSourcePageGeometry() dynamically imports
 * `pdfjs-dist/legacy/build/pdf.mjs` DIRECTLY (deliberately, so this module stays unit-testable
 * under plain `node --test` — see its own doc) and calls `getDocument()` on it WITHOUT ever
 * configuring that module's own `GlobalWorkerOptions.workerSrc`. In a real browser, pdf.js always
 * requires an explicit worker script location before parsing anything — omitting it throws
 * exactly that error. This never surfaced in this repo's own tests because pdf.js's "legacy"
 * build auto-detects a non-browser (Node) environment and runs without a worker at all there —
 * the bug only ever showed up for a real user, in a real browser, which is exactly how it was
 * reported.
 *
 * lib/pdf/pdfDocumentLoader.ts's loadPdfDocument() (used by the raster canvas/parser, which the
 * user confirmed DOES work) already configures its OWN `pdfjs-dist` import correctly. This module
 * exists so that fix is written and reused in exactly ONE place (spec section 32: "Nechci další
 * samostatný GlobalWorkerOptions.workerSrc = ... rozházený po components") — every call site
 * passes ITS OWN already-imported pdfjs module namespace plus the matching worker file URL for
 * that same build, rather than each hand-rolling its own `workerSrc = ...` assignment.
 *
 * NOTE: "pdfjs-dist" and "pdfjs-dist/legacy/build/pdf.mjs" are two DIFFERENT module specifiers —
 * each resolves to its OWN separate module instance with its OWN independent
 * `GlobalWorkerOptions` object. Configuring one does not configure the other, so every distinct
 * pdfjs module instance this app imports still calls this function once, with the worker URL that
 * matches ITS OWN build — but always through this one shared helper, never a second ad-hoc
 * literal assignment.
 */
export type PdfJsModuleWithWorkerOptions = Readonly<{ GlobalWorkerOptions: { workerSrc: string } }>;

const configuredModules = new WeakSet<PdfJsModuleWithWorkerOptions>();

/**
 * Configures `pdfjsModule`'s worker location exactly once. A no-op under plain Node (`typeof
 * window === "undefined"`, this repo's `node --test` runner included) — pdf.js's "legacy" build
 * already runs workerless there on its own, and setting a browser-only `new URL(..., import.meta.
 * url)`-resolved workerSrc would serve no purpose in that environment. In a real browser, always
 * configures on the first call for a given module instance and is a harmless no-op on every call
 * after that (guarded by identity, not a boolean the caller has to manage itself).
 */
export function ensurePdfJsWorkerConfigured(pdfjsModule: PdfJsModuleWithWorkerOptions, workerUrl: string | URL): void {
  if (typeof window === "undefined") return;
  if (configuredModules.has(pdfjsModule)) return;
  pdfjsModule.GlobalWorkerOptions.workerSrc = workerUrl.toString();
  configuredModules.add(pdfjsModule);
}
