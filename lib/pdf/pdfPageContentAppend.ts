/**
 * Technické rastry — corrective batch (post real-file acceptance test) section 1: a safe,
 * type-checked layer for reading/writing a PDF page's `/Contents` entry, which pdf-lib itself never
 * fully protects you from mishandling.
 *
 * ROOT CAUSE of the real "Contents.push is not a function" export crash: `/Contents` is legally
 * EITHER a single (always indirect) stream reference OR an array of stream references (PDF spec
 * 7.8.2) — never assumable as one or the other. `lib/technicalRasterVectorPdf.ts`'s own vector
 * white-mode rewrite replaced a page's `/Contents` with a single bare `PDFRef`
 * (`copiedPage.node.set(PDFName.of("Contents"), newStreamRef)`), which is completely valid PDF on
 * its own — but pdf-lib's OWN internal `PDFPageLeaf.addContentStream()` (invoked by every
 * `page.drawText()`/`drawRectangle()`/`drawCircle()`/`drawSvgPath()` call, i.e. every technical
 * symbol, realization line, and in-place legend this app draws) unconditionally calls
 * `.push()` on whatever `/Contents` currently resolves to, WITHOUT checking it's actually an array
 * first:
 *
 *   addContentStream(ref) {
 *     const Contents = this.normalizedEntries().Contents || this.context.obj([]);
 *     this.set(Names.Contents, Contents);
 *     Contents.push(ref);              // <-- crashes if Contents is a bare PDFRawStream
 *   }
 *
 * `normalizedEntries()` calls `normalize()`, which ONLY converts a single-stream `/Contents` into
 * an array the FIRST time it ever runs on a given `PDFPageLeaf` instance (guarded by a private
 * `normalized` flag). If `page.node.newExtGState(...)` (used for "Krytí bílé" < 100%, which the
 * white-mode ExtGState registration calls) runs BEFORE the white-mode rewrite's own `.set()` — as
 * it does, since the ExtGState must exist before the tokenizer can reference it — that FIRST
 * `normalize()` call latches the `normalized` flag `true` while `/Contents` still holds the
 * ORIGINAL (pre-rewrite) content. The white-mode code then overwrites `/Contents` with a bare
 * single ref again; the flag stays stale-true, so the NEXT `normalize()` call (triggered by the
 * first overlay symbol/badge/legend draw) is a no-op and never re-wraps it — `Contents()` resolves
 * to a bare `PDFRawStream`, and `.push()` throws exactly the reported error. This reproduces
 * reliably for any real project using the default 60% "Pracovní — bílé" opacity with ANY placed
 * technical symbol, realization badge, or legend to draw afterward — i.e. almost every real export.
 *
 * FIX: never let `/Contents` be anything other than a real `PDFArray` once THIS module has touched
 * it — every function below leaves `/Contents` as a genuine `PDFArray` (a live object, not a
 * snapshot), so any LATER `.push()` — ours or pdf-lib's own internal one — always succeeds,
 * regardless of pdf-lib's private `normalized` bookkeeping. No function here ever performs a blind
 * `as any[]`/`.push()` without first confirming, via `instanceof`, exactly what `/Contents`
 * currently is.
 */
import { PDFArray, PDFName, PDFRef, PDFStream, type PDFContext, type PDFPage } from "pdf-lib";

export type PageContentsShape =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "single"; ref: PDFRef; stream: PDFStream }>
  | Readonly<{ status: "array"; array: PDFArray }>;

/**
 * Classifies a page's CURRENT `/Contents` entry into exactly one of the three PDF-legal shapes —
 * pure inspection, never mutates anything. Throws only for a genuinely malformed `/Contents` (some
 * 4th object type entirely) rather than silently guessing how to treat it.
 */
export function resolvePageContentsShape(context: PDFContext, page: PDFPage): PageContentsShape {
  const entry = page.node.get(PDFName.of("Contents"));
  if (entry === undefined) return { status: "missing" };
  const resolved = context.lookup(entry);
  if (resolved instanceof PDFArray) return { status: "array", array: resolved };
  if (resolved instanceof PDFStream) {
    // /Contents as a single stream must be an indirect reference per spec — `entry` is already
    // that PDFRef in every real case; the `context.register` fallback exists only so this can
    // never throw on a hypothetical malformed direct-stream entry.
    const ref = entry instanceof PDFRef ? entry : context.register(resolved);
    return { status: "single", ref, stream: resolved };
  }
  throw new Error(`Unexpected /Contents object type (got ${resolved === undefined ? "undefined" : resolved === null ? "null" : resolved.constructor?.name ?? typeof resolved}).`);
}

/**
 * Appends ONE new content stream ref to a page's `/Contents`, preserving whatever was already
 * there IN ORDER (existing content always comes first) — covers all three legal shapes explicitly:
 *
 *   - missing   -> creates a new direct array `[newStreamRef]`
 *   - single    -> converts to `[existingRef, newStreamRef]`
 *   - array     -> `.push(newStreamRef)` on the real, already-existing PDFArray
 *
 * Never a blind `as any[]`/`.push()` — the shape is always established via
 * `resolvePageContentsShape`'s own `instanceof` checks first.
 */
export function appendContentStreamToPage(context: PDFContext, page: PDFPage, newStreamRef: PDFRef): void {
  const shape = resolvePageContentsShape(context, page);
  if (shape.status === "missing") {
    page.node.set(PDFName.of("Contents"), context.obj([newStreamRef]));
    return;
  }
  if (shape.status === "single") {
    page.node.set(PDFName.of("Contents"), context.obj([shape.ref, newStreamRef]));
    return;
  }
  shape.array.push(newStreamRef);
}

/**
 * Replaces a page's ENTIRE `/Contents` with exactly one new stream (used by the white-mode rewrite,
 * which decodes/merges/patches EVERY existing content stream into one new one, so this is a true
 * replacement, never an append). Always writes a real `PDFArray` — `[newStreamRef]` — rather than a
 * bare `PDFRef`, which is the ONE change that makes this whole class of crash structurally
 * impossible: any later `.push()` (ours or pdf-lib's own internal `addContentStream`) always finds
 * a genuine array, regardless of pdf-lib's own private per-page `normalized` state.
 */
export function replacePageContentsWithSingleStream(context: PDFContext, page: PDFPage, newStreamRef: PDFRef): void {
  page.node.set(PDFName.of("Contents"), context.obj([newStreamRef]));
}

/**
 * CORRECTIVE BATCH (3rd) sections 9/11 — a thin convenience over `appendContentStreamToPage` for
 * callers that already have a finished, raw content-stream STRING to add (a vector-outline glyph
 * fill, or a bare `/OC <name> BDC`/`EMC` marker-content bracket) rather than a pre-registered
 * `PDFRef` — registers the bytes as a new stream object and appends it via the SAME safe shape
 * handling every other append in this module uses, so a caller never has to touch
 * `context.stream`/`context.register`/`.push()` directly.
 */
export function appendRawContentChunk(context: PDFContext, page: PDFPage, contentString: string): void {
  const streamRef = context.register(context.stream(contentString, {}));
  appendContentStreamToPage(context, page, streamRef);
}
