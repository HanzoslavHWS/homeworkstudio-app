/**
 * Technické rastry — TRUE VECTOR PDF export (spec batch 9, "PŮVODNÍ RASTR NESMÍ BÝT OBRÁZEK"),
 * replacing the earlier rasterized-background hybrid (spec batch 7) after real-file manual review
 * rejected it. See the batch 9 report for the full audit; the short version:
 *
 *   - jsPDF (this app's other PDF-WRITING dependency, still used unchanged by
 *     lib/printSurfacePdf.ts/lib/presentationPdf.ts/lib/graphicsProductionPdf.ts) cannot parse or
 *     embed an EXISTING PDF page's own content stream — it can only draw brand-new content. That
 *     was the root cause of the earlier hybrid needing a rasterized background at all.
 *   - pdf-lib CAN load an existing PDF and copy a page's content stream/resources/MediaBox/
 *     rotation into a new document (`PDFDocument.copyPages`) with ZERO rasterization — verified
 *     directly against the real `_IMPORT/Hala 1.pdf` fixture: the copied, saved, and RE-PARSED
 *     page still has its original 270+ real text items and 22,000+ real vector/text content-
 *     stream operators, and (confirmed via its own Resources dict) the source page has NO image
 *     XObjects at all — it was never a raster to begin with.
 *   - `copyPages` does NOT automatically carry over the document CATALOG's `/OCProperties` (the
 *     structure that makes Optional Content Groups appear/toggle in a viewer's layers panel) —
 *     verified empirically (a naive copy reports zero visible OCGs via pdf.js). This module
 *     reconstructs `/OCProperties` by name-matching the already-copied OCG objects (which DO
 *     survive as part of the page's own /Resources/Properties, since copyPages recursively copies
 *     everything the page references) — verified to restore all 12 of Hala 1.pdf's real OCG names,
 *     in their original order, with the original default ON/OFF state.
 *
 * Two separate libraries, two separate jobs (spec section 37: "pokud musíš přejít na pdf-lib,
 * udělej to čistě"): pdf.js (via lib/pdf/pdfDocumentLoader.ts, this app's ONE existing PDF-reading
 * mechanism, unchanged) is used here ONLY to read the source page's rotation-aware geometry
 * (`page.getViewport({scale:1})`'s width/height/transform) — never to rasterize/render anything.
 * pdf-lib does the actual writing: copy the page, reconstruct layers, draw new vector overlay
 * content (technical symbols + legend) on top, save.
 *
 * Technical overlay OCG: CORRECTIVE BATCH (3rd, post real-file acceptance test) sections 10/11 add
 * a real "GENERÁTOR DATA" Optional Content Group (see `ensureGeneratorDataOcg`/
 * `appendGeneratorDataOcgToCatalog` below) wrapping every generator-added overlay piece (technical
 * placement markers, realization underlines, the in-place legend when used) in proper
 * `/OC <name> BDC ... EMC` marked content — this module's own `reconstructOcProperties` keeps the
 * SOURCE OCGs fully intact and untouched by this addition.
 */
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFString, PDFRawStream, PDFRef, LineCapStyle, decodePDFRawStream, rgb, type PDFPage, type PDFContext } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { NOTO_SANS_CZECH_BOLD_BASE64 } from "./fonts/graphicsProductionFont.ts";
import { isValidNormalizedCoordinate, normalizedDisplayPointToRawPdfPoint, normalizedDisplayRectToRawPdfBoundingBox, type AffineTransform6 } from "../domain/technicalRasterExportPlacementGeometry.ts";
import type { TechnicalRasterExportLegendEntry, TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";
import { resolveEffectiveLegendPlacement, type TechnicalLegendPlacement } from "../domain/technicalRasterLegendPlacement.ts";
import { detectStandLayerId } from "../domain/technicalRasterWhiteModeOperators.ts";
import { computeVectorWhiteModeContentStream } from "../domain/technicalRasterVectorWhiteMode.ts";
import { appendRawContentChunk, replacePageContentsWithSingleStream, resolvePageContentsShape } from "./pdf/pdfPageContentAppend.ts";
import {
  EXPORT_POWER_LABEL_FONT_SIZE_PT,
  EXPORT_STAR_SYMBOL_FONT_SIZE_PT,
  EXPORT_TEXT_SYMBOL_FONT_SIZE_PT,
  EXPORT_WATER_DROP_HEIGHT_PT,
  EXPORT_WIFI_SYMBOL_WIDTH_PT,
  REALIZATION_UNDERLINE_THICKNESS_PT,
} from "../domain/technicalRasterExportSymbolSize.ts";
import { TECHNICAL_REALIZATION_GROUPS, type TechnicalRealizationGroupInfo } from "../domain/technicalRasterRealization.ts";
import { buildVectorGlyphPathOperators, type GlyphOutlineCommand, type PositionedGlyphOutline } from "../domain/technicalRasterVectorGlyphOutline.ts";
import { ensurePdfJsWorkerConfigured } from "./pdf/pdfJsWorkerConfig.ts";

/**
 * A small set of typed failure codes for this pipeline's own genuinely distinct, anticipated
 * failure modes (spec batch 13 section 33 — added only where it improves testability, never a
 * wholesale error-architecture rewrite). Every OTHER failure — a malformed source PDF, an
 * embedFont failure, pdf-lib's own internal errors — still surfaces as whatever error pdf.js/
 * pdf-lib themselves throw; this class is not a universal wrapper.
 */
export class TechnicalRasterVectorExportError extends Error {
  readonly code: "INVALID_PAGE" | "WHITE_MODE_UNSUPPORTED";
  /** Only set for `WHITE_MODE_UNSUPPORTED` — the 1-based SOURCE page number the transform failed on, so a caller/UI can say exactly where the problem is. */
  readonly page?: number;
  constructor(code: "INVALID_PAGE" | "WHITE_MODE_UNSUPPORTED", message: string, page?: number) {
    super(message);
    this.name = "TechnicalRasterVectorExportError";
    this.code = code;
    this.page = page;
  }
}

function hexToRgbFraction(hex: string): ReturnType<typeof rgb> {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!match) return rgb(0.42, 0.44, 0.45);
  return rgb(parseInt(match[1]!, 16) / 255, parseInt(match[2]!, 16) / 255, parseInt(match[3]!, 16) / 255);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * CorelDRAW compatibility diagnostic (corrective batch section 6): pdf-lib's `PDFPageLeaf` defaults
 * `autoNormalizeCTM` to `true` for EVERY page, including one produced by `copyPages` — the first
 * time the page is "normalized" (which happens the moment ANY `page.draw*()` call, or
 * `newExtGState`, first touches it), pdf-lib SPLITS the already-copied source content into THREE
 * separate `/Contents` array entries: a bare `q`, the original content stream unchanged, and a bare
 * `Q` — then appends the overlay's own draws as a FOURTH entry. Verified directly (`corel-diagnostic`
 * script, not committed — see the batch report) against a real export: `/Contents` came back as an
 * array of 4 streams, the middle two being exactly `q` / `<original content>` / `Q`.
 *
 * This wrapping exists so `page.scaleContent()`/`translateContent()` (used when a page is later
 * EMBEDDED as a form XObject elsewhere) can safely prepend a transform — this pipeline never calls
 * either, so the wrap serves no purpose here and only adds risk: per PDF spec 7.8.2 a compliant
 * reader must treat an array `/Contents` as one CONCATENATED stream, so a `q` opened in one array
 * entry and closed by a `Q` in a LATER entry is valid — but it is exactly the shape a less strict
 * PDF importer (a plausible, concrete explanation for the technical overlay disappearing on import
 * into CorelDRAW 2018, per this batch's own section 6 investigation) could mishandle if it processes
 * array entries independently instead of concatenating first. Disabling it collapses the export back
 * down to the simplest possible shape: the ORIGINAL copied content stream, unmodified, followed by
 * ONE additional stream for this app's own overlay — never split, never wrapped in an extra push/pop
 * that serves no functional purpose for a page this pipeline never rescales/retranslates.
 *
 * `autoNormalizeCTM` is `private readonly` in pdf-lib's own .d.ts (no public toggle exists) — this
 * reaches past that on purpose, defensively (only ever writes the field if it's actually present as
 * a boolean, so a future pdf-lib upgrade that removes/renames it degrades to a silent no-op rather
 * than a crash). Setting it must happen BEFORE anything else touches the page (OCG reconstruction
 * never touches Contents so it's unaffected either way; white mode reads Contents but only WRITES on
 * success so timing relative to it doesn't matter; drawing/newExtGState calls are what actually
 * trigger normalization, and both always happen after this in each call site).
 */
function disableUnnecessaryAutoNormalizeCtm(page: PDFPage): void {
  const node = page.node as unknown as { autoNormalizeCTM?: unknown };
  if (typeof node.autoNormalizeCTM === "boolean") node.autoNormalizeCTM = false;
}

// ============================================================================
// Source page geometry (pdf.js — read-only measurement, never a render call)
// ============================================================================

export type SourcePageGeometry = Readonly<{
  displayWidthPt: number;
  displayHeightPt: number;
  viewportTransform: AffineTransform6;
}>;

/**
 * `pdfBytes` is never mutated/written back anywhere — read-only. Deliberately imports
 * `pdfjs-dist/legacy/build/pdf.mjs` directly (the same technique
 * scripts/technicalRasterRealDiagnostic.ts and tests/pdfDocumentLoader.test.ts already use) rather
 * than this app's usual lib/pdf/pdfDocumentLoader.ts wrapper: that wrapper's worker-file URL
 * (`new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`) is only ever resolved
 * correctly by webpack/Next's own bundler-level URL-asset handling — verified directly, it throws
 * "Cannot find module" under plain Node. This "legacy" build needs no separate worker file at all
 * in either environment, which is what keeps this module (and the whole export pipeline built on
 * it) directly unit-testable with `node --test`, not just exercised by hand in the browser.
 */
export async function resolveSourcePageGeometry(pdfBytes: Uint8Array, page: number): Promise<SourcePageGeometry> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // ROOT CAUSE of the real user-facing "No GlobalWorkerOptions.workerSrc specified." error on the
  // Výstupy (export) step (manual acceptance batch, section 30-33): this import is a SEPARATE
  // module instance from the one lib/pdf/pdfDocumentLoader.ts's own loadPdfDocument() configures
  // for the (already-working) raster canvas/parser — its own GlobalWorkerOptions was never set at
  // all. Reuses that SAME shared helper (never a second ad-hoc `workerSrc = ...` literal) with the
  // matching "legacy" worker build; a no-op under plain Node, where this build already runs
  // workerless on its own (see ensurePdfJsWorkerConfigured's own doc for why that never showed up
  // in this repo's tests).
  ensurePdfJsWorkerConfigured(pdfjsLib, new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url));
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) });
  try {
    const document = await loadingTask.promise;
    // Explicit, descriptive range check (spec batch 13 section 5) BEFORE ever calling
    // document.getPage() — pdf.js's own out-of-range error ("Invalid page request.") is genuine
    // and already fails atomically (nothing is written before this point), but is not specific
    // enough to distinguish "wrong page number" from any other load failure in a caller's own
    // error handling/logging. This never changes WHETHER an invalid page fails — only makes the
    // failure clearly identifiable.
    if (!Number.isInteger(page) || page < 1 || page > document.numPages) {
      throw new TechnicalRasterVectorExportError("INVALID_PAGE", `Stránka ${page} neexistuje (dokument má ${document.numPages} stránek).`);
    }
    const pdfPage = await document.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    return { displayWidthPt: viewport.width, displayHeightPt: viewport.height, viewportTransform: viewport.transform as unknown as AffineTransform6 };
  } finally {
    await loadingTask.destroy();
  }
}

// ============================================================================
// OCG (Optional Content Group / PDF layers) reconstruction — spec section 16/32.
// ============================================================================

export type OcgReconstructionResult = Readonly<{
  /** False only when the source has no /OCProperties at all (a PDF without layers) — never attempted, never a failure. */
  attempted: boolean;
  sourceOcgCount: number;
  /** How many of the source's own OCG names were found among the copied page's own resources and successfully re-registered at the new document's catalog level. */
  reconstructedOcgCount: number;
  reconstructedOcgNames: readonly string[];
  /** Source OCG names that could NOT be matched/reconstructed (spec section 16: "NEPŘEDSTÍRAT, že layers zůstaly" — always reported honestly, never silently dropped). */
  unmatchedOcgNames: readonly string[];
  /**
   * Whether `/D /Order` was actually written (corrective batch section 5): a real viewer's own
   * Layers panel needs this to show the groups as a real hierarchy at all — `/OCGs` + `/D/ON`/`/OFF`
   * alone leaves Acrobat's own panel empty even though the groups technically exist and toggle via
   * content-stream visibility. False only when the source itself had no usable `/D/Order` (or none
   * of its entries could be matched) — never a fabricated placeholder order.
   */
  orderReconstructed: boolean;
}>;

function decodePdfTextLike(value: unknown): string | undefined {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.decodeText();
  return undefined;
}

/** Every real OCG name in the SOURCE document's own `/OCProperties /OCGs` array, in original order (spec section 5/16: names come straight from the PDF, never hardcoded). Empty when the source has no/unsupported OCProperties structure. */
function readSourceOcgNamesInOrder(srcDoc: PDFDocument): readonly string[] {
  const srcOcProps = srcDoc.catalog.lookup(PDFName.of("OCProperties"));
  if (!(srcOcProps instanceof PDFDict)) return [];
  const srcOcgsArr = srcOcProps.lookup(PDFName.of("OCGs"));
  if (!(srcOcgsArr instanceof PDFArray)) return [];
  const names: string[] = [];
  for (let i = 0; i < srcOcgsArr.size(); i += 1) {
    const ocg = srcDoc.context.lookup(srcOcgsArr.get(i));
    const name = ocg instanceof PDFDict ? decodePdfTextLike(ocg.lookup(PDFName.of("Name"))) : undefined;
    if (name) names.push(name);
  }
  return names;
}

/**
 * Maps every OCG NAME found in the copied page's own `/Resources/Properties` dict to its (copied,
 * new-document) `PDFRef` — the copied page's Properties dict is where `copyPages` actually left the
 * OCG dictionary objects the page's content stream references (spec section 16), so this is the
 * ONE place both `reconstructOcProperties` (catalog-level layer panel) and the vector white-mode
 * transform (content-stream OCG identity) resolve "which copied object is the OCG named X" from —
 * never two separate, potentially-diverging lookups.
 */
function buildOcgNameToCopiedRefMap(newDoc: PDFDocument, copiedPage: PDFPage): ReadonlyMap<string, PDFRef> {
  const nameToCopiedRef = new Map<string, PDFRef>();
  const copiedResources = copiedPage.node.lookup(PDFName.of("Resources"));
  if (copiedResources instanceof PDFDict) {
    const props = copiedResources.lookup(PDFName.of("Properties"));
    if (props instanceof PDFDict) {
      for (const key of props.keys()) {
        const ref = props.get(key);
        const ocg = newDoc.context.lookup(ref);
        const name = ocg instanceof PDFDict ? decodePdfTextLike(ocg.lookup(PDFName.of("Name"))) : undefined;
        if (name && "objectNumber" in (ref as object)) nameToCopiedRef.set(name, ref as PDFRef);
      }
    }
  }
  return nameToCopiedRef;
}

/**
 * Reconstructs the new document's catalog-level `/OCProperties` (order + default ON/OFF state)
 * from the SOURCE document's own `/OCProperties`, by matching OCG NAMES against the objects
 * already present in the copied page's own `/Resources/Properties` dict (copyPages already copied
 * those recursively — this function only re-registers them at the catalog level, it copies no new
 * page content). Never throws — a source PDF with a differently-shaped or absent OCProperties
 * structure simply reports `attempted: false` (or a partial match), never crashes the export.
 */
/**
 * Recursively rebuilds one `/Order` array (or nested subtree — spec 8.11.4.3 allows entries to be
 * an OCG ref, a nested array forming a sub-hierarchy, or a display-only heading `PDFString`),
 * replacing every source OCG ref with its COPIED equivalent (name-matched, same as ON/OFF above)
 * and dropping anything unmatched — never leaving a dangling reference to an object that doesn't
 * exist in the new document. A nested subtree that ends up with zero real OCG refs after remapping
 * (e.g. only a heading string survives) is dropped entirely — a heading with nothing under it is
 * not meaningful structure, just noise in the layers panel.
 */
function remapOrderArray(srcArr: PDFArray, srcDoc: PDFDocument, ctx: PDFContext, nameToCopiedRef: ReadonlyMap<string, PDFRef>): PDFArray {
  const result = PDFArray.withContext(ctx);
  let sawRealEntry = false;
  for (let i = 0; i < srcArr.size(); i += 1) {
    const entry = srcArr.get(i);
    const resolved = srcDoc.context.lookup(entry);
    if (entry instanceof PDFRef) {
      const name = resolved instanceof PDFDict ? decodePdfTextLike(resolved.lookup(PDFName.of("Name"))) : undefined;
      const copiedRef = name ? nameToCopiedRef.get(name) : undefined;
      if (copiedRef) { result.push(copiedRef); sawRealEntry = true; }
      continue;
    }
    if (entry instanceof PDFArray) {
      const nested = remapOrderArray(entry, srcDoc, ctx, nameToCopiedRef);
      if (nested.size() > 0) { result.push(nested); sawRealEntry = true; }
      continue;
    }
    if (entry instanceof PDFString || entry instanceof PDFHexString) {
      result.push(PDFString.of(entry.decodeText()));
    }
  }
  return sawRealEntry ? result : PDFArray.withContext(ctx);
}

/** Remaps a flat list of OCG refs (`/Locked`, or one `/RBGroups` member) the same name-matched way `/Order` does — dropping unmatched entries, never a dangling ref. */
function remapFlatOcgRefList(srcArr: PDFArray, srcDoc: PDFDocument, ctx: PDFContext, nameToCopiedRef: ReadonlyMap<string, PDFRef>): PDFArray {
  const result = PDFArray.withContext(ctx);
  for (let i = 0; i < srcArr.size(); i += 1) {
    const ref = srcArr.get(i);
    const ocg = srcDoc.context.lookup(ref);
    const name = ocg instanceof PDFDict ? decodePdfTextLike(ocg.lookup(PDFName.of("Name"))) : undefined;
    const copiedRef = name ? nameToCopiedRef.get(name) : undefined;
    if (copiedRef) result.push(copiedRef);
  }
  return result;
}

export function reconstructOcProperties(srcDoc: PDFDocument, newDoc: PDFDocument, copiedPage: PDFPage): OcgReconstructionResult {
  const none: OcgReconstructionResult = { attempted: false, sourceOcgCount: 0, reconstructedOcgCount: 0, reconstructedOcgNames: [], unmatchedOcgNames: [], orderReconstructed: false };
  const srcOcProps = srcDoc.catalog.lookup(PDFName.of("OCProperties"));
  if (!(srcOcProps instanceof PDFDict)) return none;

  const srcNamesInOrder = readSourceOcgNamesInOrder(srcDoc);
  if (srcNamesInOrder.length === 0) return { ...none, attempted: true };

  const srcD = srcOcProps.lookup(PDFName.of("D"));

  const offNames = new Set<string>();
  if (srcD instanceof PDFDict) {
    const offArr = srcD.lookup(PDFName.of("OFF"));
    if (offArr instanceof PDFArray) {
      for (let i = 0; i < offArr.size(); i += 1) {
        const ocg = srcDoc.context.lookup(offArr.get(i));
        const name = ocg instanceof PDFDict ? decodePdfTextLike(ocg.lookup(PDFName.of("Name"))) : undefined;
        if (name) offNames.add(name);
      }
    }
  }

  const nameToCopiedRef = buildOcgNameToCopiedRefMap(newDoc, copiedPage);

  const reconstructedNames: string[] = [];
  const unmatchedNames: string[] = [];
  const orderedRefs: PDFRef[] = [];
  for (const name of srcNamesInOrder) {
    const ref = nameToCopiedRef.get(name);
    if (ref) { orderedRefs.push(ref); reconstructedNames.push(name); } else { unmatchedNames.push(name); }
  }
  if (orderedRefs.length === 0) return { attempted: true, sourceOcgCount: srcNamesInOrder.length, reconstructedOcgCount: 0, reconstructedOcgNames: [], unmatchedOcgNames: unmatchedNames, orderReconstructed: false };

  const ctx = newDoc.context;
  const ocgsArr = PDFArray.withContext(ctx);
  orderedRefs.forEach((ref) => ocgsArr.push(ref));
  const onArr = PDFArray.withContext(ctx);
  const offArr = PDFArray.withContext(ctx);
  for (const ref of orderedRefs) {
    const ocg = newDoc.context.lookup(ref);
    const name = ocg instanceof PDFDict ? decodePdfTextLike(ocg.lookup(PDFName.of("Name"))) : undefined;
    (name && offNames.has(name) ? offArr : onArr).push(ref);
  }

  const dDict = PDFDict.withContext(ctx);
  const srcBaseState = srcD instanceof PDFDict ? srcD.lookup(PDFName.of("BaseState")) : undefined;
  dDict.set(PDFName.of("BaseState"), srcBaseState instanceof PDFName ? srcBaseState : PDFName.of("ON"));
  dDict.set(PDFName.of("ON"), onArr);
  dDict.set(PDFName.of("OFF"), offArr);

  // /Order (corrective batch section 5 — the actual root cause of "Acrobat shows no layers at
  // all"): reconstruct the SOURCE's own order tree (preserving nested groups/headings) rather than
  // a synthesized flat list, since a real hall-plan PDF may group layers under headings. Falls back
  // to a flat order (still every reconstructed OCG, in source order) only when the source itself
  // had no `/Order` to preserve — Acrobat's Layers panel needs SOME `/Order` to show anything at
  // all, and a flat list is still an honest, correct reconstruction, never a guess at grouping.
  const srcOrder = srcD instanceof PDFDict ? srcD.lookup(PDFName.of("Order")) : undefined;
  const orderArr = srcOrder instanceof PDFArray ? remapOrderArray(srcOrder, srcDoc, ctx, nameToCopiedRef) : PDFArray.withContext(ctx);
  const finalOrderArr = orderArr.size() > 0 ? orderArr : (() => { const flat = PDFArray.withContext(ctx); orderedRefs.forEach((ref) => flat.push(ref)); return flat; })();
  dDict.set(PDFName.of("Order"), finalOrderArr);

  if (srcD instanceof PDFDict) {
    const srcLocked = srcD.lookup(PDFName.of("Locked"));
    if (srcLocked instanceof PDFArray) {
      const lockedArr = remapFlatOcgRefList(srcLocked, srcDoc, ctx, nameToCopiedRef);
      if (lockedArr.size() > 0) dDict.set(PDFName.of("Locked"), lockedArr);
    }
    // /AS (automatic view/print/export usage rules) is deliberately NOT reconstructed: its entries
    // are dicts containing their OWN nested OCG refs in the SOURCE document's numbering, and a
    // plain PDFArray.clone() would carry those source refs over unchanged — dangling or, worse,
    // colliding with unrelated object numbers in the new document. Silently omitting an obscure
    // usage-application feature is safe; writing a corrupt reference is not.
    const srcListMode = srcD.lookup(PDFName.of("ListMode"));
    if (srcListMode instanceof PDFName) dDict.set(PDFName.of("ListMode"), srcListMode);
    const srcName = srcD.lookup(PDFName.of("Name"));
    if (srcName) { const decoded = decodePdfTextLike(srcName); if (decoded) dDict.set(PDFName.of("Name"), PDFString.of(decoded)); }
    const srcCreator = srcD.lookup(PDFName.of("Creator"));
    if (srcCreator) { const decoded = decodePdfTextLike(srcCreator); if (decoded) dDict.set(PDFName.of("Creator"), PDFString.of(decoded)); }
  }

  const srcRBGroups = srcOcProps.lookup(PDFName.of("RBGroups"));
  if (srcRBGroups instanceof PDFArray) {
    const rbGroupsArr = PDFArray.withContext(ctx);
    for (let i = 0; i < srcRBGroups.size(); i += 1) {
      const group = srcDoc.context.lookup(srcRBGroups.get(i));
      if (!(group instanceof PDFArray)) continue;
      const remapped = remapFlatOcgRefList(group, srcDoc, ctx, nameToCopiedRef);
      if (remapped.size() > 0) rbGroupsArr.push(remapped);
    }
    if (rbGroupsArr.size() > 0) dDict.set(PDFName.of("RBGroups"), rbGroupsArr);
  }

  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  newDoc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));

  return {
    attempted: true,
    sourceOcgCount: srcNamesInOrder.length,
    reconstructedOcgCount: reconstructedNames.length,
    reconstructedOcgNames: reconstructedNames,
    unmatchedOcgNames: unmatchedNames,
    orderReconstructed: finalOrderArr.size() > 0,
  };
}

// ============================================================================
// GENERÁTOR DATA OCG (corrective batch 3rd, sections 10/11) — a NEW Optional Content Group holding
// every piece of content THIS generator adds on top of the copied source page (technical placement
// markers, realization underlines, and an in-place legend overlay when that placement strategy is
// used) — never the white-mode rewrite of the SOURCE page's own fills, which is a transformation of
// EXISTING content, not new generator content (spec's own explicit distinction). Real manual
// acceptance found that turning OFF all 12 of the source PDF's own layers in Acrobat left the
// generated markers/underlines still visible, since nothing tagged them as belonging to anything.
//
// `reconstructOcProperties` above rebuilds the new document's `/OCProperties` FROM SCRATCH on every
// call (once per exported page) — a pre-existing behavior this batch does not change. The functions
// below are deliberately idempotent/re-appending so the SAME "GENERÁTOR DATA" OCG object (one ref,
// created once and threaded through the caller's own per-page loop — see `ensureGeneratorDataOcg`'s
// own doc) is correctly re-registered into whatever `/OCProperties` state the latest
// `reconstructOcProperties` call left, on every page, without ever creating a SECOND object.
// ============================================================================

const GENERATOR_DATA_OCG_NAME = "GENERÁTOR DATA";

function ensureDictChild(parent: PDFDict, ctx: PDFContext, key: string): PDFDict {
  const existing = parent.lookup(PDFName.of(key));
  if (existing instanceof PDFDict) return existing;
  const fresh = PDFDict.withContext(ctx);
  parent.set(PDFName.of(key), fresh);
  return fresh;
}

function ensureArrayChild(parent: PDFDict, ctx: PDFContext, key: string): PDFArray {
  const existing = parent.lookup(PDFName.of(key));
  if (existing instanceof PDFArray) return existing;
  const fresh = PDFArray.withContext(ctx);
  parent.set(PDFName.of(key), fresh);
  return fresh;
}

function arrayContainsRef(array: PDFArray, ref: PDFRef): boolean {
  for (let i = 0; i < array.size(); i += 1) {
    if (array.get(i)?.toString() === ref.toString()) return true;
  }
  return false;
}

function pushRefIfAbsent(array: PDFArray, ref: PDFRef): void {
  if (!arrayContainsRef(array, ref)) array.push(ref);
}

/**
 * Registers `ocgRef` into the new document's CURRENT `/OCProperties` — `/OCGs`, `/D/ON` (never
 * `/D/OFF`: default state is always ON, spec's own explicit requirement) and `/D/Order` — creating
 * any missing structure from scratch (a source PDF with no layers at all must still be able to
 * receive this one generator layer). Every mutation is idempotent, so calling this again for the
 * SAME ref on a LATER page (after that page's own `reconstructOcProperties` call has already
 * rebuilt `/OCProperties` around the SOURCE layers) only ever re-adds the generator OCG back in,
 * never duplicates it.
 */
function appendGeneratorDataOcgToCatalog(newDoc: PDFDocument, ocgRef: PDFRef): void {
  const ctx = newDoc.context;
  const ocProps = ensureDictChild(newDoc.catalog, ctx, "OCProperties");
  pushRefIfAbsent(ensureArrayChild(ocProps, ctx, "OCGs"), ocgRef);
  const dDict = ensureDictChild(ocProps, ctx, "D");
  if (!(dDict.lookup(PDFName.of("BaseState")) instanceof PDFName)) dDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  pushRefIfAbsent(ensureArrayChild(dDict, ctx, "ON"), ocgRef);
  pushRefIfAbsent(ensureArrayChild(dDict, ctx, "Order"), ocgRef);
}

/**
 * Creates the "GENERÁTOR DATA" OCG object ONCE per whole export (reusing `existingRef` on every
 * subsequent page — the caller threads its own `let generatorDataOcgRef` across its per-page loop,
 * never creating a second object) and ensures `copiedPage`'s own `/Resources/Properties` maps SOME
 * key name to it, returning that key so the caller's own raw `/OC <name> BDC ... EMC` content can
 * reference it. Must be called for EVERY page that carries generator overlay content, since each
 * page needs its OWN `/Resources/Properties` entry pointing at the (shared) OCG ref — `/Resources`
 * is never shared between pages, unlike the catalog-level OCG object itself.
 */
function ensureGeneratorDataOcg(newDoc: PDFDocument, copiedPage: PDFPage, existingRef: PDFRef | undefined): Readonly<{ ref: PDFRef; propertyName: string }> {
  const ctx = newDoc.context;
  const ref = existingRef ?? ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of(GENERATOR_DATA_OCG_NAME) }));
  appendGeneratorDataOcgToCatalog(newDoc, ref);

  const resources = ensureDictChild(copiedPage.node, ctx, "Resources");
  const properties = ensureDictChild(resources, ctx, "Properties");
  const existingKey = properties.keys().find((key) => properties.get(key)?.toString() === ref.toString());
  const propertyKey = existingKey ?? properties.uniqueKey("GenData");
  if (!existingKey) properties.set(propertyKey, ref);
  return { ref, propertyName: propertyKey.decodeText() };
}

// ============================================================================
// Vector "Pracovní — bílé" white mode for the EXPORT (corrective batch section 4) — see
// domain/technicalRasterVectorWhiteMode.ts's own module doc for the actual tokenizer/rewriter
// algorithm. Everything HERE is pdf-lib plumbing: find which resource-dictionary property NAME(s)
// the copied page's own content stream would use to tag the stand layer, read/decode/concatenate
// the page's real content stream(s), run the pure rewriter, and (only on success) replace Contents
// with the patched bytes. Uses the EXACT SAME name-based stand-layer detection
// (detectStandLayerId) the live editor's own white mode already uses, so "which layer is white
// mode allowed to touch" can never disagree between the editor and the export.
// ============================================================================

export type VectorWhiteModeDiagnostic =
  | Readonly<{ status: "not_requested" }>
  | Readonly<{ status: "applied"; whitenedFillCommandCount: number; opacity: number }>
  | Readonly<{ status: "unsupported"; reason: string }>;

/** Every resource-dictionary key (no leading "/") in the copied page's own `/Resources/Properties` that resolves to the SAME OCG object as the source's own detected "stand layer" — the set a BDC `/OC <Name>` operator must match against (see computeVectorWhiteModeContentStream's own doc). Empty when no stand layer could be unambiguously detected, or when the page's content stream never actually tags it. */
function findVectorWhiteModeTargetPropertyNames(srcDoc: PDFDocument, newDoc: PDFDocument, copiedPage: PDFPage): ReadonlySet<string> {
  const srcNames = readSourceOcgNamesInOrder(srcDoc);
  const detection = detectStandLayerId(srcNames.map((name) => ({ id: name, name })));
  if (detection.status !== "found") return new Set();
  const nameToCopiedRef = buildOcgNameToCopiedRefMap(newDoc, copiedPage);
  const targetRef = nameToCopiedRef.get(detection.layerId);
  if (!targetRef) return new Set();

  const propertyNames = new Set<string>();
  const resources = copiedPage.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) {
    const props = resources.lookup(PDFName.of("Properties"));
    if (props instanceof PDFDict) {
      for (const key of props.keys()) {
        const ref = props.get(key);
        if (ref instanceof PDFRef && ref.toString() === targetRef.toString()) propertyNames.add(key.decodeText());
      }
    }
  }
  return propertyNames;
}

/**
 * Reads a page's `/Contents` (a single stream, or an array of streams concatenated per spec 7.8.2)
 * as one fully decoded (Flate/etc. already applied) byte buffer. Uses the SAME
 * `resolvePageContentsShape` classification `lib/pdf/pdfPageContentAppend.ts` uses for writing, so
 * reading and writing can never disagree about what shape `/Contents` currently is.
 */
function readPageContentBytes(newDoc: PDFDocument, copiedPage: PDFPage): Uint8Array {
  const shape = resolvePageContentsShape(newDoc.context, copiedPage);
  const streams: PDFRawStream[] = [];
  if (shape.status === "array") {
    for (let i = 0; i < shape.array.size(); i += 1) {
      const stream = newDoc.context.lookup(shape.array.get(i));
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  } else if (shape.status === "single" && shape.stream instanceof PDFRawStream) {
    streams.push(shape.stream);
  }
  const chunks: Uint8Array[] = [];
  for (const stream of streams) {
    if (chunks.length > 0) chunks.push(new Uint8Array([32]));
    chunks.push(decodePDFRawStream(stream).decode());
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}

// ============================================================================
// CORRECTIVE BATCH (white mode / Form XObject support) — real-file evidence (Hala 3_2026-
// ver.12_NOVY_3.pdf, the FOR BEAUTY raster) proved the previous "a Do inside the target OCG span is
// always unsupported" rule was too strict: that PDF draws every stand fill inside its own Form
// XObject (`/FmNN Do`, each a `/Group /S /Transparency` form with its own `/Resources`) rather than
// with direct fill operators in the page's own content, unlike the FOR DECOR Hala 1 control file.
// The sections below teach `applyVectorWhiteMode` to recurse into such Forms — resolving/patching
// their own content, safely (clone-on-write) when a Form is shared with non-target content, with
// cycle protection for a malformed/self-referencing XObject graph — while the pure tokenizer itself
// (domain/technicalRasterVectorWhiteMode.ts) stays zero-pdf-lib-dependency: it only ever reports
// resource NAMES reached via `Do` and applies caller-supplied renames, never inspects a PDF object.
// ============================================================================

/** One (ref, content, dict) a `context.assign`/`context.register` must apply — deferred to the very end (`applyFormWhiteningPlan`) so nothing is written to the real document until the ENTIRE recursive plan (all levels) has succeeded (spec: "no partial output ever", now proven across Form recursion too). `isClone` chooses `context.assign(ref, ...)` (mutate the ORIGINAL ref in place — safe only when exclusively reached from the target scope) vs. `context.register` at a ref already reserved via `context.nextRef()` during planning (a genuine new object, for the shared-Form case). */
type FormMutationPlan = Readonly<{ ref: PDFRef; content: Uint8Array; dict: PDFDict; needsOpacityResources: boolean }>;
/** A NEW `/Resources/XObject` entry (`name -> ref`) to add to some resource dict once the plan is applied — always the SAME dict object a `renameFormInvocations` edit already redirected a target-scope `Do` call to reference by this exact name. */
type ResourceDictAddition = Readonly<{ resources: PDFDict; name: string; ref: PDFRef }>;

type FormPlanResult =
  | Readonly<{ status: "ok"; content: Uint8Array; mutations: readonly FormMutationPlan[]; resourceDictAdditions: readonly ResourceDictAddition[]; whitenedFillCommandCount: number; wrappedSpanCount: number }>
  | Readonly<{ status: "unsupported"; reason: string }>;

/** Copies every dict entry EXCEPT the ones that only ever describe the ORIGINAL encoded bytes (spec: this transform always emits fresh, uncompressed content, so a stale `/Filter`/`/DecodeParms`/`/Length` from the source must never survive onto the patched stream). Semantic entries a Form XObject actually needs — `/Type`, `/Subtype`, `/FormType`, `/Group`, `/BBox`, `/Matrix`, `/Resources` — are preserved byte-for-byte, so PLACEMENT GEOMETRY is never altered (spec section 9). */
function copyFormDictEntriesForRewrite(context: PDFContext, originalDict: PDFDict): PDFDict {
  const fresh = PDFDict.withContext(context);
  // PDFName.asString()/.toString() both include the leading "/" (verified directly — "Filter" alone
  // would never match, silently leaving the ORIGINAL /Filter entry on a stream now holding fresh
  // UNCOMPRESSED bytes, corrupting the object the moment anything tries to decode it).
  const skip = new Set(["/Length", "/Filter", "/DecodeParms"]);
  for (const key of originalDict.keys()) {
    if (skip.has(key.asString())) continue;
    fresh.set(key, originalDict.get(key));
  }
  return fresh;
}

/** `/Resources` is genuinely OPTIONAL on a Form XObject per spec — absent means "resolve resource names against whatever resources the INVOKING context (page or parent Form) already has" (spec section 6's own resource-inheritance audit). Never fabricates a resource that doesn't already exist somewhere in that chain. */
function resolveEffectiveResources(ownResources: PDFDict | undefined, inheritedResources: PDFDict | undefined): PDFDict | undefined {
  return ownResources ?? inheritedResources;
}

/** Resolves one `Do`-invoked name against an XObject resource dict into its ref + dereferenced stream, confirming it's a plain Form (never an Image or anything else this transform can't safely recurse into). `undefined` — not a thrown error — for anything not safely resolvable, so the caller can produce ONE clear, specific "unsupported" reason at the actual call site. */
function resolveFormXObject(context: PDFContext, resources: PDFDict, name: string): Readonly<{ ref: PDFRef; stream: PDFRawStream }> | undefined {
  const xobjectDict = resources.lookup(PDFName.of("XObject"));
  if (!(xobjectDict instanceof PDFDict)) return undefined;
  const entry = xobjectDict.get(PDFName.of(name));
  if (!(entry instanceof PDFRef)) return undefined;
  const stream = context.lookup(entry);
  if (!(stream instanceof PDFRawStream)) return undefined;
  const subtype = stream.dict.lookup(PDFName.of("Subtype"));
  if (!(subtype instanceof PDFName) || subtype.asString() !== "/Form") return undefined;
  return { ref: entry, stream };
}

let formCloneNameCounter = 0;
/** A short, collision-checked synthetic resource name for a cloned Form's own new `/XObject` entry — never `PDFDict.uniqueKey`'s random-suffix style, since a deterministic, readable name (`W8Clone0`, `W8Clone1`, ...) is easier to recognize while debugging a real export, and collision with a REAL source name is astronomically unlikely given the distinct prefix (checked anyway, defensively). */
function nextFormCloneResourceName(existingNames: ReadonlySet<string>): string {
  for (;;) {
    const candidate = `W8Clone${formCloneNameCounter}`;
    formCloneNameCounter += 1;
    if (!existingNames.has(candidate)) return candidate;
  }
}

/**
 * Recursively plans the white-mode transform for ONE content stream (the page's own, or a Form
 * XObject's own) reached from inside the target scope, WITHOUT writing anything to `context` yet
 * (spec: "no partial output ever" — a deeper recursion failure must never leave a half-applied
 * mutation behind). `pathRefs` is the cycle guard (spec section 5): the set of Form refs currently
 * on the ACTIVE recursion path (never "ever visited" — the exact same Form legitimately reached
 * twice from two SIBLING positions is not a cycle, only a Form appearing in its OWN ancestor chain
 * is). `sharedRefs` is computed ONCE, up front, from the page's own top-level scan (spec section
 * 10): any Form ref ALSO reachable from OUTSIDE the target scope at the page's own top level is
 * cloned-on-write here rather than mutated in place, so its other, unrelated usage is never
 * recolored. (A deeper Form shared with something ELSE several levels down, never touching the
 * page's own top-level content, is not separately detected — see the batch's own final report for
 * this documented limitation.)
 */
function planFormXObjectWhitening(params: Readonly<{
  context: PDFContext;
  content: Uint8Array;
  ownResources: PDFDict | undefined;
  inheritedResources: PDFDict | undefined;
  targetOcPropertyNames: ReadonlySet<string>;
  assumeEntireStreamIsTarget: boolean;
  opacityFraction: number;
  extGStateName: string | undefined;
  sharedRefs: ReadonlySet<string>;
  pathRefs: ReadonlySet<string>;
}>): FormPlanResult {
  const { context, content, ownResources, inheritedResources, targetOcPropertyNames, assumeEntireStreamIsTarget, opacityFraction, extGStateName, sharedRefs, pathRefs } = params;

  const firstPass = computeVectorWhiteModeContentStream(content, {
    targetOcPropertyNames,
    opacityFraction,
    extGStateName,
    assumeEntireStreamIsTarget,
    allowFormXObjects: true,
  });
  if (firstPass.status === "unsupported") return firstPass;
  if (firstPass.formInvocationsInsideTarget.length === 0) {
    return { status: "ok", content: firstPass.content, mutations: [], resourceDictAdditions: [], whitenedFillCommandCount: firstPass.whitenedFillCommandCount, wrappedSpanCount: firstPass.wrappedSpanCount };
  }

  const effectiveResources = resolveEffectiveResources(ownResources, inheritedResources);
  if (!effectiveResources) {
    return { status: "unsupported", reason: "Cílová vrstva odkazuje na Form XObject, ale nelze najít žádný zdrojový slovník (/Resources) pro jeho vyhledání." };
  }
  const xobjectDict = effectiveResources.lookup(PDFName.of("XObject"));
  const existingXObjectNames = new Set(xobjectDict instanceof PDFDict ? xobjectDict.keys().map((key) => key.asString()) : []);

  const mutations: FormMutationPlan[] = [];
  const resourceDictAdditions: ResourceDictAddition[] = [];
  const renamesForThisLevel = new Map<string, string>();
  let whitenedFillCommandCount = firstPass.whitenedFillCommandCount;
  let wrappedSpanCount = firstPass.wrappedSpanCount;

  for (const invocation of firstPass.formInvocationsInsideTarget) {
    const resolved = resolveFormXObject(context, effectiveResources, invocation.name);
    if (!resolved) {
      return { status: "unsupported", reason: `Cílová vrstva vyvolává "/${invocation.name} Do", ale odkazovaný zdroj není bezpečně rozpoznatelný Form XObject (např. obrázek) — nelze bezpečně přebarvit jen výplň.` };
    }
    const refKey = resolved.ref.toString();
    if (pathRefs.has(refKey)) {
      return { status: "unsupported", reason: "Cyklický odkaz na Form XObject v cílové vrstvě (Form odkazuje sám na sebe přes řetězec vyvolání) — nelze bezpečně přebarvit." };
    }

    const formOwnResources = resolved.stream.dict.lookup(PDFName.of("Resources"));
    const childPlan = planFormXObjectWhitening({
      context,
      content: decodePDFRawStream(resolved.stream).decode(),
      ownResources: formOwnResources instanceof PDFDict ? formOwnResources : undefined,
      inheritedResources: effectiveResources,
      targetOcPropertyNames: new Set(),
      assumeEntireStreamIsTarget: true,
      opacityFraction,
      extGStateName,
      sharedRefs,
      pathRefs: new Set([...pathRefs, refKey]),
    });
    if (childPlan.status === "unsupported") return childPlan;

    mutations.push(...childPlan.mutations);
    resourceDictAdditions.push(...childPlan.resourceDictAdditions);
    whitenedFillCommandCount += childPlan.whitenedFillCommandCount;
    wrappedSpanCount += childPlan.wrappedSpanCount;

    const patchedDict = copyFormDictEntriesForRewrite(context, resolved.stream.dict);
    const isShared = sharedRefs.has(refKey);
    // CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill): a Form's own patched
    // content can now reference our ExtGState even at opacityFraction===1, whenever ITS OWN source
    // content contained a `gs` call that needed neutralizing (see computeVectorWhiteModeContentStream's
    // own hasSourceGsInsideTarget doc) — `childPlan.wrappedSpanCount > 0` is the correct, general
    // signal for "this Form's own patched bytes actually invoke our ExtGState by name", never the
    // stale `opacityFraction < 1` check alone.
    const needsOpacityResources = childPlan.wrappedSpanCount > 0;
    if (!isShared) {
      mutations.push({ ref: resolved.ref, content: childPlan.content, dict: patchedDict, needsOpacityResources });
    } else {
      const newRef = context.nextRef();
      mutations.push({ ref: newRef, content: childPlan.content, dict: patchedDict, needsOpacityResources });
      const newName = nextFormCloneResourceName(existingXObjectNames);
      existingXObjectNames.add(newName);
      renamesForThisLevel.set(invocation.name, newName);
      resourceDictAdditions.push({ resources: effectiveResources, name: newName, ref: newRef });
    }
  }

  let finalContent = firstPass.content;
  if (renamesForThisLevel.size > 0) {
    const secondPass = computeVectorWhiteModeContentStream(content, {
      targetOcPropertyNames,
      opacityFraction,
      extGStateName,
      assumeEntireStreamIsTarget,
      allowFormXObjects: true,
      renameFormInvocations: renamesForThisLevel,
    });
    // Structurally the SAME content already tokenized successfully once above — this can only ever
    // repeat that same success, never newly fail. Falling back to the first pass's own content
    // instead of throwing keeps this defensive rather than a hard crash on a truly impossible path.
    if (secondPass.status === "patched") finalContent = secondPass.content;
  }

  return { status: "ok", content: finalContent, mutations, resourceDictAdditions, whitenedFillCommandCount, wrappedSpanCount };
}

/** Ensures `resources` (a Form's own, or the page's own) has an `/ExtGState` entry named `extGStateName` pointing at `extGStateRef` — reuses `ensureDictChild` (already used by the GENERÁTOR DATA OCG work above) so every recursed Form our own `q/gs/Q` wrapping or `gs`-reassertion touches can actually resolve that name. Adding this key is always harmless even when `resources` turns out to be SHARED with unrelated content (an unused resource-dict entry changes nothing for content that never references it by name). */
function ensureExtGStateAvailable(context: PDFContext, resources: PDFDict, extGStateName: string, extGStateRef: PDFRef): void {
  const extGStateDict = ensureDictChild(resources, context, "ExtGState");
  if (!(extGStateDict.get(PDFName.of(extGStateName)) instanceof PDFRef)) extGStateDict.set(PDFName.of(extGStateName), extGStateRef);
}

/** Applies an ENTIRELY SUCCESSFUL plan (from `planFormXObjectWhitening`, invoked only once the whole recursive tree has already resolved without any "unsupported") to the real document — every `context.assign`/`context.register`/resource-dict `.set()` happens here, and only here, so a caller can be certain nothing was written until this runs. */
function applyFormWhiteningPlan(context: PDFContext, plan: FormPlanResult & { status: "ok" }, extGStateRef: PDFRef | undefined, extGStateName: string | undefined): void {
  for (const mutation of plan.mutations) {
    // PDFRawStream.of takes a real PDFDict directly (unlike context.stream(), whose own TS
    // declaration only accepts a plain LiteralObject even though its runtime would accept this
    // fine too) — mutation.dict is already a real PDFDict built by copyFormDictEntriesForRewrite.
    const streamObj = PDFRawStream.of(mutation.dict, mutation.content);
    context.assign(mutation.ref, streamObj);
    if (mutation.needsOpacityResources && extGStateRef && extGStateName) {
      const formResources = mutation.dict.lookup(PDFName.of("Resources"));
      if (formResources instanceof PDFDict) ensureExtGStateAvailable(context, formResources, extGStateName, extGStateRef);
    }
  }
  for (const addition of plan.resourceDictAdditions) {
    const xobjectDict = ensureDictChild(addition.resources, context, "XObject");
    xobjectDict.set(PDFName.of(addition.name), addition.ref);
  }
}

/**
 * Applies "Pracovní — bílé" to `copiedPage`'s own content stream, at `opacityFraction` (the exact
 * same 0-1 "Krytí bílé" fraction the live editor uses — spec: "60 % v editoru = 60 % v exportu").
 * Never a raster fallback of any kind (spec, non-negotiable) — on `"unsupported"`, the page's
 * content stream is left completely untouched and the caller is expected to export with the
 * source's ORIGINAL (still fully vector) colors, exactly like the live editor already falls back to
 * an unpatched render when its own equivalent detection fails.
 *
 * CORRECTIVE BATCH (white mode / Form XObject support) — the target OCG span may invoke Form
 * XObjects (`/FmNN Do`) instead of drawing fills directly (real evidence: Hala 3_2026-
 * ver.12_NOVY_3.pdf/FOR BEAUTY). `planFormXObjectWhitening` recursively resolves/patches those
 * (cycle-protected, clone-on-write when shared with non-target content, resource-inheritance-aware)
 * entirely in memory; only once the WHOLE recursive plan succeeds does `applyFormWhiteningPlan`
 * write anything to the real document — a deeper "unsupported" still means the page's own content
 * stream (and every Form it references) is left completely untouched, exactly like the pre-existing
 * single-content-stream policy this replaces.
 */
function applyVectorWhiteMode(srcDoc: PDFDocument, newDoc: PDFDocument, copiedPage: PDFPage, opacityFraction: number): VectorWhiteModeDiagnostic {
  const targetPropertyNames = findVectorWhiteModeTargetPropertyNames(srcDoc, newDoc, copiedPage);
  if (targetPropertyNames.size === 0) {
    return { status: "unsupported", reason: "Vrstva stánků nebyla ve zdrojovém PDF jednoznačně nalezena — export proto použije originální barvy." };
  }

  // CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill): registered
  // UNCONDITIONALLY now, even at opacityFraction===1 — real H3 evidence shows the SOURCE PDF can
  // set its own alpha (a genuine `/ca 0.76` ExtGState) via a `gs` call reached from inside the
  // target scope, completely independent of the project's own "Krytí bílé" slider. Without our own
  // `ca:1` ExtGState always available to re-assert after any such source `gs`, a "fully opaque"
  // 100% white-mode request could still render translucent, letting the hall's own background grid
  // show through the stand fill. `computeVectorWhiteModeContentStream` only ever actually EMITS a
  // `gs` invoking this (via `hasSourceGsInsideTarget`'s own pre-scan) when the source content
  // genuinely needs it — for a target span/Form with no `gs` at all (H1, every existing synthetic
  // fixture), this object is registered but never referenced by any `gs` operator, so the resulting
  // content-stream TEXT is byte-for-byte unchanged from before this batch.
  const extGStateDict = newDoc.context.obj({ Type: "ExtGState", ca: opacityFraction });
  const extGStateRef = newDoc.context.register(extGStateDict);
  const extGStateName = copiedPage.node.newExtGState("TechRasterWhite", extGStateRef).decodeText();

  const pageResources = copiedPage.node.lookup(PDFName.of("Resources"));
  const contentBytes = readPageContentBytes(newDoc, copiedPage);

  // Pass 1 (page-level, discovery only) — never allowed to recurse yet: we first need the FULL set
  // of page-level "outside target" Do invocations (for shared-Form detection) before deciding
  // anything about the forms reached from INSIDE the target span.
  const pageScan = computeVectorWhiteModeContentStream(contentBytes, {
    targetOcPropertyNames: targetPropertyNames,
    opacityFraction,
    extGStateName,
    allowFormXObjects: true,
  });
  if (pageScan.status === "unsupported") return pageScan;

  const sharedRefs = new Set<string>();
  if (pageScan.formInvocationsInsideTarget.length > 0 && pageResources instanceof PDFDict) {
    const insideRefs = new Set(
      pageScan.formInvocationsInsideTarget
        .map((invocation) => resolveFormXObject(newDoc.context, pageResources, invocation.name)?.ref.toString())
        .filter((ref): ref is string => ref !== undefined),
    );
    for (const invocation of pageScan.formInvocationsOutsideTarget) {
      const ref = resolveFormXObject(newDoc.context, pageResources, invocation.name)?.ref.toString();
      if (ref && insideRefs.has(ref)) sharedRefs.add(ref);
    }
  }

  const plan = planFormXObjectWhitening({
    context: newDoc.context,
    content: contentBytes,
    ownResources: pageResources instanceof PDFDict ? pageResources : undefined,
    inheritedResources: undefined,
    targetOcPropertyNames: targetPropertyNames,
    assumeEntireStreamIsTarget: false,
    opacityFraction,
    extGStateName,
    sharedRefs,
    pathRefs: new Set(),
  });
  if (plan.status === "unsupported") return plan;

  applyFormWhiteningPlan(newDoc.context, plan, extGStateRef, extGStateName);
  const newStreamRef = newDoc.context.register(newDoc.context.stream(plan.content, {}));
  // ROOT CAUSE of the real "Contents.push is not a function" export crash (see
  // lib/pdf/pdfPageContentAppend.ts's own module doc for the full mechanism): a bare
  // `.set(Contents, newStreamRef)` here left /Contents as a single ref, which pdf-lib's own
  // internal addContentStream() (used by every later overlay draw call) blindly `.push()`es onto —
  // crashing whenever this ran before that private bookkeeping had a chance to see the replacement.
  // replacePageContentsWithSingleStream always leaves /Contents as a genuine PDFArray instead.
  replacePageContentsWithSingleStream(newDoc.context, copiedPage, newStreamRef);
  return { status: "applied", whitenedFillCommandCount: plan.whitenedFillCommandCount, opacity: opacityFraction };
}

/**
 * Enforces the corrective-batch policy (post real-file acceptance test, section 2): when
 * "Pracovní — bílé" is REQUESTED, the export must either (A) actually apply it, or (B) safely FAIL
 * the whole export with a clear error — NEVER silently complete with the page's original colors,
 * and never any kind of raster fallback. The previous behavior (fall back to original colors,
 * report "unsupported" only in a diagnostic the user might not see) is exactly what this replaces —
 * a real export must never produce a different visual result than what the user asked for.
 */
function requireVectorWhiteModeApplied(diagnostic: VectorWhiteModeDiagnostic, page: number): VectorWhiteModeDiagnostic {
  if (diagnostic.status === "unsupported") {
    throw new TechnicalRasterVectorExportError(
      "WHITE_MODE_UNSUPPORTED",
      `Stránku ${page} nelze bezpečně převést do pracovního bílého režimu (${diagnostic.reason}). Export byl zastaven — vypněte pracovní bílý režim nebo použijte originální barvy.`,
      page,
    );
  }
  return diagnostic;
}

// ============================================================================
// Overlay symbols — real vector/text, never emoji/bitmap (spec section 17). Corrective batch
// section 3: NO mandatory circular badge (the previous ~19pt filled-circle backdrop, verified by
// manual review to visually dominate a busy hall plan, is gone entirely) — a compact colored
// text/glyph directly at the placement point, sized from the central constants in
// domain/technicalRasterExportSymbolSize.ts, never a literal pt number inline here.
//
// CORRECTIVE BATCH (3rd, post real-file acceptance test) sections 8/9 — the kW/EL/INT/IP/"*" labels
// below are drawn as TRUE VECTOR OUTLINES (filled Bézier paths), never `page.drawText()`/PDF
// text-showing operators. Root cause (see domain/technicalRasterVectorGlyphOutline.ts's own header
// doc for the full elimination argument): CorelDRAW 2018 was found to drop exactly these
// `page.drawText()`-based generator labels on import, while every OTHER generator overlay element
// (the realization underline's `drawLine`, the water-drop's `drawSvgPath` below) — which carry no
// font/text operator at all — import correctly. The embedded NotoSansCzech font is a Type0
// composite font (`/Identity-H` encoding, `CIDFontType2` descendant, embedded `FontFile2`) — a
// documented category of PDF-import incompatibility in several Corel versions. Converting only
// these generator-added marker glyphs to vector geometry sidesteps that question entirely: filled
// path geometry renders identically in any PDF-conformant consumer, independent of composite-font
// support. The SOURCE PDF's own text is completely untouched either way.
//
// GENERATED LEGEND BATCH — the generated legend's OWN text (heading/descriptions/realization names)
// now uses this EXACT same vector-outline mechanism too (previously still `page.drawText()` via a
// real pdf-lib `PDFFont`, which is exactly the Type0/CIDFont shape this whole section exists to
// avoid) — see drawLegendPage/drawInPlaceLegend further below.
// ============================================================================

/** Runtime-verified shape of a fontkit glyph outline command (`{command, args}`) — NOT part of `@pdf-lib/fontkit`'s own .d.ts (which only exposes the imperative `Path.moveTo()`-style builder methods), confirmed directly against the installed package's own bundled source. */
type FontkitGlyphPathCommand = Readonly<{ command: "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo" | "closePath"; args: readonly number[] }>;

function convertFontkitPathCommand(command: FontkitGlyphPathCommand): GlyphOutlineCommand {
  switch (command.command) {
    case "moveTo":
      return { type: "moveTo", x: command.args[0]!, y: command.args[1]! };
    case "lineTo":
      return { type: "lineTo", x: command.args[0]!, y: command.args[1]! };
    case "quadraticCurveTo":
      return { type: "quadraticCurveTo", cx: command.args[0]!, cy: command.args[1]!, x: command.args[2]!, y: command.args[3]! };
    case "bezierCurveTo":
      return { type: "bezierCurveTo", c1x: command.args[0]!, c1y: command.args[1]!, c2x: command.args[2]!, c2y: command.args[3]!, x: command.args[4]!, y: command.args[5]! };
    case "closePath":
    default:
      return { type: "closePath" };
  }
}

type ShapingFont = ReturnType<typeof fontkit.create>;

/**
 * Shapes `text` through a fontkit font loaded INDEPENDENTLY of pdf-lib's own `newDoc.embedFont`
 * (see this section's own header doc for why: this bypasses PDF text-showing operators/font
 * embedding entirely for these glyphs) into the pure `PositionedGlyphOutline` shape
 * domain/technicalRasterVectorGlyphOutline.ts's own converter expects.
 */
function shapeTextToPositionedGlyphOutlines(font: ShapingFont, text: string): readonly PositionedGlyphOutline[] {
  const run = font.layout(text);
  const glyphs: PositionedGlyphOutline[] = [];
  let advanceOffset = 0;
  for (let i = 0; i < run.glyphs.length; i += 1) {
    const glyph = run.glyphs[i]!;
    const rawCommands = (glyph.path as unknown as { commands: readonly FontkitGlyphPathCommand[] }).commands;
    glyphs.push({ commands: rawCommands.map(convertFontkitPathCommand), advanceOffset });
    advanceOffset += run.positions[i]?.xAdvance ?? glyph.advanceWidth;
  }
  return glyphs;
}

/** Total advance width for `text` shaped through `font`, in the SAME font design units `shapeTextToPositionedGlyphOutlines` positions glyphs in (i.e. NOT yet scaled to points) — used to center a marker label exactly like `PDFFont.widthOfTextAtSize` did before this conversion, just measured from the fontkit run instead of pdf-lib's own font wrapper. */
function measureShapedTextWidthInDesignUnits(font: ShapingFont, text: string): number {
  return font.layout(text).positions.reduce((sum, position) => sum + position.xAdvance, 0);
}

function formatColorComponent(value: number): string {
  const rounded = Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return String(rounded);
}

/** Draws `text` as a single filled vector-outline content chunk, appended via the same safe `/Contents`-shape-handling every other overlay append in this pipeline uses — never a `page.drawText()` call, never a PDF font resource. `(originX, originY)` is the glyph run's own baseline-left origin, exactly where `page.drawText` would place it. */
function drawVectorOutlineText(page: PDFPage, originX: number, originY: number, text: string, shapingFont: ShapingFont, fontSizePt: number, color: ReturnType<typeof rgb>): void {
  const glyphs = shapeTextToPositionedGlyphOutlines(shapingFont, text);
  const pathOperators = buildVectorGlyphPathOperators(glyphs, originX, originY, shapingFont.unitsPerEm, fontSizePt);
  if (!pathOperators) return;
  const rgbColor = color as unknown as { red: number; green: number; blue: number };
  const content = `${formatColorComponent(rgbColor.red)} ${formatColorComponent(rgbColor.green)} ${formatColorComponent(rgbColor.blue)} rg\n${pathOperators}`;
  appendRawContentChunk(page.doc.context, page, content);
}

/**
 * Centered short colored text — used for powerLabel (kW/EL), textLabel (IP/INT), fallback (?).
 * Drawn as vector-outline geometry (see this section's own header doc), directly in the
 * presentation's own color, no backdrop of any kind. CORRECTIVE BATCH (4th, export-polish-only):
 * `fontSizePt` is now an explicit caller-supplied parameter (never a single shared constant read
 * internally) so `drawPlacementSymbol` below can size electricity's own power labels independently
 * of INT/IP/fallback — see `EXPORT_POWER_LABEL_FONT_SIZE_PT`'s own doc for why.
 */
function drawTextSymbol(page: PDFPage, x: number, y: number, color: ReturnType<typeof rgb>, text: string, shapingFont: ShapingFont, fontSizePt: number): void {
  const width = (measureShapedTextWidthInDesignUnits(shapingFont, text) / shapingFont.unitsPerEm) * fontSizePt;
  drawVectorOutlineText(page, x - width / 2, y - fontSizePt * 0.35, text, shapingFont, fontSizePt, color);
}

/**
 * A plain colored asterisk glyph (spec section 17/29: genuinely vector geometry via the SAME
 * embedded font as every other label here — never a Unicode "✱" the font subset might lack), no
 * backdrop. `sizePt` is an explicit caller-supplied parameter (GENERATED LEGEND BATCH — was
 * previously read from the single shared `EXPORT_STAR_SYMBOL_FONT_SIZE_PT` constant internally) so
 * the generated legend can reuse this EXACT drawing code at its own, smaller/legend-appropriate
 * scale — never a hand-drawn visual copy of the same symbol.
 */
function drawStarSymbol(page: PDFPage, x: number, y: number, color: ReturnType<typeof rgb>, shapingFont: ShapingFont, sizePt: number): void {
  const width = (measureShapedTextWidthInDesignUnits(shapingFont, "*") / shapingFont.unitsPerEm) * sizePt;
  drawVectorOutlineText(page, x - width / 2, y - sizePt * 0.4, "*", shapingFont, sizePt, color);
}

/**
 * A real vector teardrop (spec section 17: "kapka", "žádné emoji, žádná bitmapa") — the SAME SVG
 * path the editor's on-screen symbol already uses (components/workflow/technicalRasters/
 * TechnicalRasterCanvas.tsx), drawn here via pdf-lib's own SVG-path support instead of an inline
 * React <svg>, directly in the service's own color, no backdrop. `heightPt` is an explicit
 * caller-supplied parameter (GENERATED LEGEND BATCH — was previously the single shared
 * `EXPORT_WATER_DROP_HEIGHT_PT` constant) for the same legend-reuse reason as drawStarSymbol above.
 */
function drawWaterDropSymbol(page: PDFPage, x: number, y: number, color: ReturnType<typeof rgb>, heightPt: number): void {
  // The path's own bounding box is roughly 14 units wide by 13.5 tall (x:5-19, y:2-15.5 in its
  // native 24x24-ish coordinate space) — scaled so its actual on-page HEIGHT matches the given
  // heightPt, never a magic ratio against the old circle radius.
  const scale = heightPt / 13.5;
  page.drawSvgPath("M12 2C12 2 5 11 5 15.5A7 7 0 0019 15.5C19 11 12 2 12 2Z", {
    x: x - 12 * scale,
    y: y + 12 * scale,
    scale,
    color,
  });
}

/**
 * CORRECTIVE BATCH (real production — "every imported operational service must be placeable"): the
 * SAME stroked (never filled) wifi-arcs glyph the editor's own on-screen marker uses
 * (components/workflow/technicalRasters/TechnicalRasterCanvas.tsx's wifiIcon renderer). No fill, no
 * backdrop — same discipline as `drawWaterDropSymbol`/`drawStarSymbol` above. `widthPt` is an
 * explicit caller-supplied parameter (GENERATED LEGEND BATCH — was previously the single shared
 * `EXPORT_WIFI_SYMBOL_WIDTH_PT` constant) so the generated legend can reuse this same glyph too,
 * for a component override that still explicitly selects the icon-only "wifiIcon" renderer (the
 * CENTRAL default for a real WIFI report label is the plain "WiFi" text label — see
 * domain/technicalRasterServicePresentation.ts's own doc — but this renderer stays real/drawable).
 */
function drawWifiSymbol(page: PDFPage, x: number, y: number, color: ReturnType<typeof rgb>, widthPt: number): void {
  // The path's own bounding box is roughly 20 units wide (x:2-22) by 16.8 tall (y:3.5-20.3) in its
  // native 24x24-ish coordinate space — scaled off its WIDTH, matching the given widthPt.
  const scale = widthPt / 20;
  page.drawSvgPath("M2 8.5C7.5 3.5 16.5 3.5 22 8.5M5.5 12.5C9.5 9 14.5 9 18.5 12.5M9 16.5C10.5 15 13.5 15 15 16.5M12 20.2v.1", {
    x: x - 12 * scale,
    y: y + 12 * scale,
    scale,
    borderColor: color,
    borderWidth: 2.5 * scale,
  });
}

function drawPlacementSymbol(page: PDFPage, x: number, y: number, item: TechnicalRasterExportPlacementItem, markerShapingFont: ShapingFont): void {
  const color = hexToRgbFraction(item.presentation.color);
  switch (item.presentation.renderer) {
    case "refrigeratedStar":
      drawStarSymbol(page, x, y, color, markerShapingFont, EXPORT_STAR_SYMBOL_FONT_SIZE_PT);
      return;
    case "waterDrop":
      drawWaterDropSymbol(page, x, y, color, EXPORT_WATER_DROP_HEIGHT_PT);
      return;
    case "wifiIcon":
      drawWifiSymbol(page, x, y, color, EXPORT_WIFI_SYMBOL_WIDTH_PT);
      return;
    case "powerLabel":
      // CORRECTIVE BATCH (4th, export-polish-only) — electricity's own power labels ("2 kW"/"5 kW"/
      // "6 kW"/"9 kW"/"EL") use their own, independently-tuned size; never shared with INT/IP below.
      drawTextSymbol(page, x, y, color, item.presentation.displayLabel ?? "?", markerShapingFont, EXPORT_POWER_LABEL_FONT_SIZE_PT);
      return;
    case "textLabel":
    case "fallback":
    default:
      drawTextSymbol(page, x, y, color, item.presentation.displayLabel ?? "?", markerShapingFont, EXPORT_TEXT_SYMBOL_FONT_SIZE_PT);
  }
}

// ============================================================================
// Realization underline (corrective batch, post real-file acceptance test, section 4/5/14) —
// REPLACES the previous "badge" drawing (a white box + dark outline + redrawn stand number), which
// FAILED manual acceptance. Now a single ordinary vector stroke — no fill, no transparency, no
// nested object structure — the simplest possible Corel-friendly primitive (spec section 14: "velmi
// jednoduchý vector path/stroke... žádná zbytečná transparency / masking / complex object
// structure"). Deliberately separate drawing code from the technical symbols above (a completely
// different concern — WHO builds the stand, never WHAT service sits where) and anchored to the
// stand's own label position (computed entirely in domain/technicalRasterRealizationUnderline.ts,
// shared verbatim with the editor), so it structurally cannot collide with a placed technical
// symbol, and NEVER redraws/covers the source PDF's own stand-number text.
// ============================================================================

export type TechnicalRasterExportRealizationUnderlineItem = Readonly<{
  standId: string;
  /** Normalized page-space geometry — the SAME rectangle domain/technicalRasterRealizationUnderline.ts's computeRealizationUnderlineGeometry produces for the editor; this drawing code only ever converts its two endpoints through the rotation-aware raw-PDF-point transform, it never computes geometry itself. */
  xNormalized: number;
  yNormalized: number;
  widthNormalized: number;
  /** The resolved realization group's own central color (domain/technicalRasterRealization.ts) — this drawing code paints whatever color it's given, it never resolves the group itself. */
  color: string;
}>;

function drawRealizationUnderline(page: PDFPage, item: TechnicalRasterExportRealizationUnderlineItem, geometry: SourcePageGeometry): void {
  const start = normalizedDisplayPointToRawPdfPoint(item.xNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  const end = normalizedDisplayPointToRawPdfPoint(item.xNormalized + item.widthNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  page.drawLine({
    start,
    end,
    thickness: REALIZATION_UNDERLINE_THICKNESS_PT,
    color: hexToRgbFraction(item.color),
    lineCap: LineCapStyle.Round,
  });
}

// ============================================================================
// GENERATED LEGEND BATCH — every generated legend row (technical + realization), in BOTH the
// separate-page fallback and the in-place ("source-legend-area") strategy, is now drawn through
// this ONE shared function so both strategies stay visually consistent and reuse the EXACT same
// vector symbol renderers real technical placements use (drawStarSymbol/drawWaterDropSymbol/
// drawWifiSymbol/drawTextSymbol above) — never a hand-drawn visual copy of the real symbol.
// `sizes` lets each strategy pick its OWN scale (spec section 11: "legend size and placement-marker
// size are separate concerns" — these are ALSO separate from the real EXPORT_*_SIZE_PT marker
// constants, which stay completely untouched). SMALL POLISH BATCH — the IN-PLACE legend's own
// technical rows additionally draw one small colored dot beside this real symbol (see
// drawInPlaceLegend below) purely so the category color reads at a glance; that dot is a small
// ADDITIONAL cue, never a replacement for the real symbol drawn here.
// ============================================================================

type LegendSymbolSizes = Readonly<{ textFontSizePt: number; starFontSizePt: number; waterDropHeightPt: number; wifiWidthPt: number }>;

/** `(x, y)` is the symbol's own CENTER point — same convention drawPlacementSymbol's real marker drawing already uses. */
function drawLegendEntrySymbol(page: PDFPage, x: number, y: number, entry: TechnicalRasterExportLegendEntry, shapingFont: ShapingFont, sizes: LegendSymbolSizes): void {
  const color = hexToRgbFraction(entry.color);
  switch (entry.renderer) {
    case "refrigeratedStar":
      drawStarSymbol(page, x, y, color, shapingFont, sizes.starFontSizePt);
      return;
    case "waterDrop":
      drawWaterDropSymbol(page, x, y, color, sizes.waterDropHeightPt);
      return;
    case "wifiIcon":
      drawWifiSymbol(page, x, y, color, sizes.wifiWidthPt);
      return;
    case "powerLabel":
    case "textLabel":
    case "fallback":
    default:
      drawTextSymbol(page, x, y, color, entry.displayLabel ?? "?", shapingFont, sizes.textFontSizePt);
  }
}

/**
 * GENERATED LEGEND BATCH section 13 — the realization legend now lists ONLY the canonical groups
 * that actually have at least one real underline in the CURRENT export (never a fixed always-all-4
 * key, which was the previous behavior) — matched by each group's own central `color`
 * (domain/technicalRasterRealization.ts), since every real underline item already carries that
 * exact color and colors are guaranteed distinct per group. Returns entries in the SAME fixed
 * canonical order (GENDAI/CREATIV EXPO/MAC PRAHA/OSTATNÍ) every time, never encounter order, for a
 * deterministic legend regardless of stand iteration order.
 */
function resolveUsedRealizationGroups(underlineColors: ReadonlySet<string>): readonly TechnicalRealizationGroupInfo[] {
  return TECHNICAL_REALIZATION_GROUPS.filter((group) => underlineColors.has(group.color));
}

function realizationUnderlineColors(underlines: readonly Readonly<{ color: string }>[]): ReadonlySet<string> {
  return new Set(underlines.map((underline) => underline.color));
}

// ============================================================================
// Legend page (spec section 26/27) — a SEPARATE page, never resizing/rescaling the copied source
// page (spec: "neškáluj copied page") — the safer of the two options the spec offered, since it
// requires zero structural changes to the copied page's own MediaBox/CropBox/rotation. GENERATED
// LEGEND BATCH: every piece of generated text here (title, header line, "žádné značky" hint,
// descriptions, realization names) is now genuine vector-outline geometry via the SAME
// `drawVectorOutlineText`/shaping-font mechanism the real technical markers use — never
// `page.drawText()` (spec section 12: Corel-safe, no Type0/CIDFont text for ANY generated legend
// content). The realization swatch is now a short colored LINE (spec section 13: "represent
// realization using the same colored line language used under stand numbers, not filled squares"),
// reusing the exact same REALIZATION_UNDERLINE_THICKNESS_PT stroke real underlines use.
// ============================================================================

const LEGEND_PAGE_WIDTH_PT = 420;
const LEGEND_MARGIN_PT = 28;
const LEGEND_ROW_HEIGHT_PT = 18;
const LEGEND_TITLE_FONT_SIZE_PT = 12;
const LEGEND_SUBHEADING_FONT_SIZE_PT = 9;
const LEGEND_TEXT_FONT_SIZE_PT = 9;
const LEGEND_SYMBOL_COLUMN_WIDTH_PT = 16;
const LEGEND_SYMBOL_SIZES: LegendSymbolSizes = { textFontSizePt: 8, starFontSizePt: 9, waterDropHeightPt: 7, wifiWidthPt: 9 };
const LEGEND_REALIZATION_SWATCH_WIDTH_PT = 10;
/** Gap between the technical (left) and realization (right) columns — SIMPLIFIED LEGEND BATCH. */
const LEGEND_COLUMN_GAP_PT = 24;

/**
 * SIMPLIFIED LEGEND BATCH — shared side-by-side layout math for BOTH the separate-page legend and
 * the in-place legend below: technical categories in a LEFT column, realization groups in a RIGHT
 * column beside it (never stacked below any more) — the two sections are drawn independently
 * top-down from the SAME starting Y, so the whole block's height is the TALLER of the two sides,
 * never their sum. This is what keeps the legend compact (spec: "avoid unnecessary vertical
 * growth") now that the technical side is also capped at ~5 category rows (never one row per
 * subtype). No realization groups at all simply means no right column — the left column then owns
 * the full available width.
 */
function planLegendColumns(
  availableWidth: number,
  columnGap: number,
  hasRealizationColumn: boolean,
): Readonly<{ leftWidth: number; rightWidth: number }> {
  if (!hasRealizationColumn) return { leftWidth: availableWidth, rightWidth: 0 };
  const leftWidth = (availableWidth - columnGap) * 0.55;
  return { leftWidth, rightWidth: availableWidth - columnGap - leftWidth };
}

function drawLegendPage(
  newDoc: PDFDocument,
  headerLine: string,
  legend: readonly TechnicalRasterExportLegendEntry[],
  shapingFont: ShapingFont,
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
): void {
  const hasRealizationColumn = usedRealizationGroups.length > 0;
  const leftRows = Math.max(1, legend.length);
  const rightRows = hasRealizationColumn ? usedRealizationGroups.length : 0;
  const bodyRows = Math.max(leftRows, rightRows) + 1; // +1 for the LEGENDA:/REALIZACE: heading row
  const height = LEGEND_MARGIN_PT * 2 + 40 + bodyRows * LEGEND_ROW_HEIGHT_PT;
  const page = newDoc.addPage([LEGEND_PAGE_WIDTH_PT, height]);
  let y = height - LEGEND_MARGIN_PT;

  drawVectorOutlineText(page, LEGEND_MARGIN_PT, y, "TECHNICKÝ EXPORT — LEGENDA", shapingFont, LEGEND_TITLE_FONT_SIZE_PT, rgb(0.08, 0.08, 0.08));
  y -= 16;
  if (headerLine) drawVectorOutlineText(page, LEGEND_MARGIN_PT, y, headerLine, shapingFont, LEGEND_SUBHEADING_FONT_SIZE_PT, rgb(0.4, 0.42, 0.44));
  y -= 24;

  const { leftWidth } = planLegendColumns(LEGEND_PAGE_WIDTH_PT - LEGEND_MARGIN_PT * 2, LEGEND_COLUMN_GAP_PT, hasRealizationColumn);
  const leftX = LEGEND_MARGIN_PT;
  const rightX = leftX + leftWidth + LEGEND_COLUMN_GAP_PT;
  const bodyTopY = y;

  drawVectorOutlineText(page, leftX, y, "LEGENDA:", shapingFont, LEGEND_SUBHEADING_FONT_SIZE_PT, rgb(0.08, 0.08, 0.08));
  let leftY = y - LEGEND_ROW_HEIGHT_PT;
  if (legend.length === 0) {
    drawVectorOutlineText(page, leftX, leftY, "Žádné technické značky v tomto exportu.", shapingFont, LEGEND_TEXT_FONT_SIZE_PT, rgb(0.55, 0.57, 0.58));
  } else {
    for (const entry of legend) {
      drawLegendEntrySymbol(page, leftX + LEGEND_SYMBOL_COLUMN_WIDTH_PT / 2, leftY + LEGEND_TEXT_FONT_SIZE_PT * 0.35, entry, shapingFont, LEGEND_SYMBOL_SIZES);
      drawVectorOutlineText(page, leftX + LEGEND_SYMBOL_COLUMN_WIDTH_PT, leftY, entry.legendLabel, shapingFont, LEGEND_TEXT_FONT_SIZE_PT, rgb(0.1, 0.1, 0.1));
      leftY -= LEGEND_ROW_HEIGHT_PT;
    }
  }

  if (hasRealizationColumn) {
    let rightY = bodyTopY;
    drawVectorOutlineText(page, rightX, rightY, "REALIZACE:", shapingFont, LEGEND_SUBHEADING_FONT_SIZE_PT, rgb(0.08, 0.08, 0.08));
    rightY -= LEGEND_ROW_HEIGHT_PT;
    for (const group of usedRealizationGroups) {
      const lineY = rightY + LEGEND_TEXT_FONT_SIZE_PT * 0.3;
      page.drawLine({
        start: { x: rightX, y: lineY },
        end: { x: rightX + LEGEND_REALIZATION_SWATCH_WIDTH_PT, y: lineY },
        thickness: REALIZATION_UNDERLINE_THICKNESS_PT,
        color: hexToRgbFraction(group.color),
        lineCap: LineCapStyle.Round,
      });
      drawVectorOutlineText(page, rightX + LEGEND_SYMBOL_COLUMN_WIDTH_PT, rightY, group.label, shapingFont, LEGEND_TEXT_FONT_SIZE_PT, rgb(0.1, 0.1, 0.1));
      rightY -= LEGEND_ROW_HEIGHT_PT;
    }
  }
}

// ============================================================================
// In-place legend (corrective batch section 7, "source-legend-area") — covers a USER-DEFINED (or
// domain/technicalRasterLegendPlacement.ts's own hall-agnostic AUTOMATIC DEFAULT — never
// auto-detected/guessed from the source page's own content) region of the copied source page with a
// plain white VECTOR rectangle — solid fill, opacity always 1.0 (completely independent of "Krytí
// bílé"/white-mode opacity, spec section 4), NO stroke/border — and redraws a compact, category-
// level technical legend (left) + realization key (right) directly inside it. The source page's own
// size/MediaBox/CropBox is never touched.
//
// SIMPLIFIED LEGEND BATCH — OVERFLOW SAFETY: before drawing anything, `planInPlaceLegendLayout`
// below computes whether the (now much shorter, category-level) legend actually fits the configured
// region, trying progressively smaller (but never microscopic) scales. If none fit, this function
// draws NOTHING at all (never a partial/overlapping/clipped drawing, never a lonely white box with
// no content) and reports `"does_not_fit"` so the caller can fall back to the safe separate-page
// legend instead — the configured region and its underlying source content are left completely
// untouched in that case.
// ============================================================================

// SMALL POLISH BATCH — the whole block is now slightly smaller overall (was ROW_HEIGHT=9,
// FONT_SIZE=6, HEADING=7, SYMBOL=5.5, STAR=6.5, WATER_DROP=5, WIFI=5.5) so it visually fits better
// against the nearby printed source text, and SYMBOL_COLUMN_WIDTH is wider (was 11) so the
// symbol/sample never reads as glued directly onto its description (spec: "3 kW" must not feel
// stuck onto "ELEKTRIKA"). MARGIN/COLUMN_GAP/MIN_SCALE are unchanged — this is a size/spacing nudge,
// not a new layout.
//
// MICRO POLISH BATCH (2nd size pass) — one more small, uniform reduction on top of the above (was
// ROW_HEIGHT=8.5, FONT_SIZE=5.5, HEADING=6.5, SYMBOL=5, STAR=6, WATER_DROP=4.5, WIFI=5). The
// realization (right column) rows reuse these SAME shared rowHeight/textFontSize/headingFontSize
// values (see drawInPlaceLegend below), so they shrink together with the technical rows — no
// separate realization-only constant exists for the in-place legend. MARGIN/SYMBOL_COLUMN_WIDTH/
// COLUMN_GAP/MIN_SCALE stay exactly as-is — still a size nudge only, never a new layout.
const IN_PLACE_LEGEND_MARGIN_PT = 4;
const IN_PLACE_LEGEND_ROW_HEIGHT_PT = 8;
const IN_PLACE_LEGEND_FONT_SIZE_PT = 5;
const IN_PLACE_LEGEND_HEADING_FONT_SIZE_PT = 6;
const IN_PLACE_LEGEND_SYMBOL_FONT_SIZE_PT = 4.5;
const IN_PLACE_LEGEND_STAR_FONT_SIZE_PT = 5.5;
const IN_PLACE_LEGEND_WATER_DROP_HEIGHT_PT = 4;
const IN_PLACE_LEGEND_WIFI_WIDTH_PT = 4.5;
const IN_PLACE_LEGEND_SYMBOL_COLUMN_WIDTH_PT = 15;
const IN_PLACE_LEGEND_COLUMN_GAP_PT = 10;
/** Radius of the small colored category dot drawn next to each TECHNICAL row's own symbol/sample (SMALL POLISH BATCH) — never used for the realization column, which already has its own colored line swatch. Size unchanged by the MICRO POLISH BATCH — only its own offset (below) moved. */
const IN_PLACE_LEGEND_DOT_RADIUS_PT = 1.3;
/**
 * DOT POLISH BATCH — the dot's own CENTER offset from the row's left content edge (`leftX`), before
 * scale. Was an inline `plan.dotRadius + 0.5` (1.8pt at scale 1) — the dot's own right edge (at
 * dotRadius 1.3, i.e. ~3.1pt from leftX) could sit close enough to a wide symbol's own left edge to
 * read as touching it. Moved further left (0.5pt from leftX, i.e. 1.3pt further left than before) so
 * a small but clearly visible gap always remains before the symbol/sample — the symbol/text and
 * description positions themselves are completely untouched by this constant.
 *
 * MICRO POLISH BATCH — real manual review found 0.5pt still not quite enough breathing room, so
 * this moved a bit further left again (into the row's own left margin — still safely inside
 * IN_PLACE_LEGEND_MARGIN_PT, never clipped by the box edge). The dot stays the SAME size/color and
 * still sits at the very start of its own row, so it reads as clearly associated with that row.
 */
const IN_PLACE_LEGEND_DOT_LEFT_OFFSET_PT = -0.2;
/** The smallest scale a size reduction is allowed to shrink to (spec: "modest... within a sensible minimum", "no microscopic text") — a 30% reduction, never more. */
const IN_PLACE_LEGEND_MIN_SCALE = 0.7;
const IN_PLACE_LEGEND_SCALE_STEPS: readonly number[] = [1, 0.85, IN_PLACE_LEGEND_MIN_SCALE];

type InPlaceLegendPlan = Readonly<{
  rowHeight: number;
  headingFontSize: number;
  textFontSize: number;
  symbolSizes: LegendSymbolSizes;
  symbolColumnWidth: number;
  columnGap: number;
  leftWidth: number;
  rightWidth: number;
  hasRealizationColumn: boolean;
  dotRadius: number;
  dotOffsetFromLeftX: number;
}>;

function computeInPlaceLegendPlanAt(
  scale: number,
  box: Readonly<{ width: number; height: number }>,
  legend: readonly TechnicalRasterExportLegendEntry[],
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
  shapingFont: ShapingFont,
): InPlaceLegendPlan | undefined {
  const margin = IN_PLACE_LEGEND_MARGIN_PT;
  const rowHeight = IN_PLACE_LEGEND_ROW_HEIGHT_PT * scale;
  const headingFontSize = IN_PLACE_LEGEND_HEADING_FONT_SIZE_PT * scale;
  const textFontSize = IN_PLACE_LEGEND_FONT_SIZE_PT * scale;
  const symbolSizes: LegendSymbolSizes = {
    textFontSizePt: IN_PLACE_LEGEND_SYMBOL_FONT_SIZE_PT * scale,
    starFontSizePt: IN_PLACE_LEGEND_STAR_FONT_SIZE_PT * scale,
    waterDropHeightPt: IN_PLACE_LEGEND_WATER_DROP_HEIGHT_PT * scale,
    wifiWidthPt: IN_PLACE_LEGEND_WIFI_WIDTH_PT * scale,
  };
  const symbolColumnWidth = IN_PLACE_LEGEND_SYMBOL_COLUMN_WIDTH_PT * scale;
  const columnGap = IN_PLACE_LEGEND_COLUMN_GAP_PT * scale;
  const hasRealizationColumn = usedRealizationGroups.length > 0;
  const availableWidth = box.width - margin * 2;
  const { leftWidth, rightWidth } = planLegendColumns(availableWidth, columnGap, hasRealizationColumn);
  const leftDescriptionWidth = leftWidth - symbolColumnWidth;
  const rightDescriptionWidth = rightWidth - symbolColumnWidth;
  if (leftDescriptionWidth <= 0 || (hasRealizationColumn && rightDescriptionWidth <= 0)) return undefined;

  // Side by side, never stacked (spec: "move realization legend to the RIGHT... avoid unnecessary
  // vertical growth") — required height is the TALLER side's own row count, not their sum.
  const leftRows = 1 + legend.length;
  const rightRows = hasRealizationColumn ? 1 + usedRealizationGroups.length : 0;
  const requiredHeight = Math.max(leftRows, rightRows) * rowHeight + margin * 2;
  if (requiredHeight > box.height) return undefined;

  for (const entry of legend) {
    const width = (measureShapedTextWidthInDesignUnits(shapingFont, entry.legendLabel) / shapingFont.unitsPerEm) * textFontSize;
    if (width > leftDescriptionWidth) return undefined;
  }
  for (const group of usedRealizationGroups) {
    const width = (measureShapedTextWidthInDesignUnits(shapingFont, group.label) / shapingFont.unitsPerEm) * textFontSize;
    if (width > rightDescriptionWidth) return undefined;
  }

  return {
    rowHeight, headingFontSize, textFontSize, symbolSizes, symbolColumnWidth, columnGap, leftWidth, rightWidth, hasRealizationColumn,
    dotRadius: IN_PLACE_LEGEND_DOT_RADIUS_PT * scale,
    dotOffsetFromLeftX: IN_PLACE_LEGEND_DOT_LEFT_OFFSET_PT * scale,
  };
}

/**
 * Tries progressively smaller scales (never a column-count search any more — the two "columns" are
 * now the FIXED technical-left/realization-right roles, not an overflow strategy). `undefined` means
 * the configured region genuinely cannot hold this export's legend at any attempted scale — the
 * caller must fall back to the separate-page legend rather than draw a broken/overflowing box.
 */
function planInPlaceLegendLayout(
  box: Readonly<{ width: number; height: number }>,
  legend: readonly TechnicalRasterExportLegendEntry[],
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
  shapingFont: ShapingFont,
): InPlaceLegendPlan | undefined {
  for (const scale of IN_PLACE_LEGEND_SCALE_STEPS) {
    const plan = computeInPlaceLegendPlanAt(scale, box, legend, usedRealizationGroups, shapingFont);
    if (plan) return plan;
  }
  return undefined;
}

/** `"drawn"` on success; `"does_not_fit"` when NOTHING was drawn (not even the white cover) — see this section's own header doc for why the caller must treat that as "use the separate-page legend instead", never as "legend silently missing". */
function drawInPlaceLegend(
  page: PDFPage,
  box: Readonly<{ x: number; y: number; width: number; height: number }>,
  legend: readonly TechnicalRasterExportLegendEntry[],
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
  shapingFont: ShapingFont,
): "drawn" | "does_not_fit" {
  const plan = planInPlaceLegendLayout(box, legend, usedRealizationGroups, shapingFont);
  if (!plan) return "does_not_fit";

  // 1. Opaque white cover rectangle — vector, solid white, opacity ALWAYS 1.0 (never derived from
  // "Krytí bílé"/booth white-mode opacity, which this drawing call never even receives), NO stroke.
  // `opacity` is deliberately OMITTED rather than passed as `1` — pdf-lib wraps ANY explicit
  // `opacity` (even 1) in its own `/GS gs` ExtGState; omitting it keeps this the same simple,
  // ExtGState-free "rg ... f" fill every other plain vector shape in this pipeline already uses,
  // while still being unconditionally, exactly 1.0 opaque (pdf's own un-overridden default alpha).
  page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: box.height, color: rgb(1, 1, 1) });

  const margin = IN_PLACE_LEGEND_MARGIN_PT;
  const leftX = box.x + margin;
  const rightX = leftX + plan.leftWidth + plan.columnGap;
  const topY = box.y + box.height - margin - plan.headingFontSize;

  // 2/3/4. Technical categories — LEFT column: heading, then one row per category. Each row also
  // gets a small colored dot (SMALL POLISH BATCH) next to its symbol/sample, in that row's own
  // category color, purely so the category color reads at a glance — never replacing the real
  // symbol renderer already reused here, just a small additional visual cue beside it.
  drawVectorOutlineText(page, leftX, topY, "LEGENDA:", shapingFont, plan.headingFontSize, rgb(0.08, 0.08, 0.08));
  let leftY = topY - plan.rowHeight;
  for (const entry of legend) {
    const rowCenterY = leftY + plan.textFontSize * 0.35;
    page.drawCircle({ x: leftX + plan.dotOffsetFromLeftX, y: rowCenterY, size: plan.dotRadius, color: hexToRgbFraction(entry.color) });
    drawLegendEntrySymbol(page, leftX + plan.symbolColumnWidth / 2, rowCenterY, entry, shapingFont, plan.symbolSizes);
    drawVectorOutlineText(page, leftX + plan.symbolColumnWidth, leftY, entry.legendLabel, shapingFont, plan.textFontSize, rgb(0.1, 0.1, 0.1));
    leftY -= plan.rowHeight;
  }

  // 5. Realization — RIGHT column, beside the technical legend (never below it any more), starting
  // from the SAME top Y — a colored LINE swatch (never a filled square), matching the real
  // underline's own visual language. Only the groups actually used in this export.
  if (plan.hasRealizationColumn) {
    drawVectorOutlineText(page, rightX, topY, "REALIZACE:", shapingFont, plan.headingFontSize, rgb(0.08, 0.08, 0.08));
    let rightY = topY - plan.rowHeight;
    for (const group of usedRealizationGroups) {
      const lineY = rightY + plan.textFontSize * 0.3;
      page.drawLine({
        start: { x: rightX, y: lineY },
        end: { x: rightX + plan.symbolColumnWidth - 2, y: lineY },
        thickness: REALIZATION_UNDERLINE_THICKNESS_PT,
        color: hexToRgbFraction(group.color),
        lineCap: LineCapStyle.Round,
      });
      drawVectorOutlineText(page, rightX + plan.symbolColumnWidth, rightY, group.label, shapingFont, plan.textFontSize, rgb(0.1, 0.1, 0.1));
      rightY -= plan.rowHeight;
    }
  }

  return "drawn";
}

// ============================================================================
// Orchestration
// ============================================================================

export type TechnicalRasterVectorExportInput = Readonly<{
  sourcePdfBytes: Uint8Array;
  /** 1-based page number, matching this app's existing convention (RasterStandLabel.page, TechnicalServicePlacement.page). */
  page: number;
  placements: readonly TechnicalRasterExportPlacementItem[];
  legend: readonly TechnicalRasterExportLegendEntry[];
  showLegend: boolean;
  headerLine: string;
  /** "Pracovní — bílé" for the export (corrective batch section 4) — omitted (never `{opacity:0}` implicitly) exports with the source's ORIGINAL vector colors untouched, exactly like every export before this batch. When present, `opacity` is the same 0-1 "Krytí bílé" fraction as the live editor's own project setting (spec: "60 % v editoru = 60 % v exportu") — clamped defensively the same way effectiveWhiteFillOpacity already is upstream. */
  whiteMode?: Readonly<{ opacity: number }>;
  /** "Zahrnout realizačky do exportu" (corrective batch section 10) — every underline to draw on THIS page. Optional/defaults to none so every existing caller/test is unaffected. */
  realizationUnderlines?: readonly TechnicalRasterExportRealizationUnderlineItem[];
  /** Whether the legend page's own fixed "REALIZACE" key (all 4 canonical groups, always) is included — independent of whether `realizationUnderlines` is empty on this particular page, since a multi-page export's key reflects the WHOLE export, not just page 1. */
  includeRealizationKey?: boolean;
  /** Corrective batch section 7 — WHERE the legend is drawn. Omitted resolves to today's existing "separate-page" behavior via resolveEffectiveLegendPlacement. A "source-legend-area" region targeting a page OTHER than `input.page` has no effect in this single-page function (there IS no other page here) — the multi-page function below is what real multi-page exports use. */
  legendPlacement?: TechnicalLegendPlacement;
}>;

export type TechnicalRasterVectorExportResult = Readonly<{
  bytes: Uint8Array;
  ocgDiagnostic: OcgReconstructionResult;
  /** Placements skipped because their own xNormalized/yNormalized was outside [0,1] or non-finite (NaN/Infinity) — spec batch 13 section 6: never silently clamped (a clamp would draw a symbol at a plausible-looking but WRONG position) and never allowed to crash the export. Always 0 for data that ever went through the real UI; only ever non-zero for corrupted/hand-edited persisted data. */
  skippedInvalidPlacementCount: number;
  /** Whether/how "Pracovní — bílé" was actually applied (corrective batch section 4) — `"not_requested"` when `input.whiteMode` was omitted, `"unsupported"` when requested but the stand layer/content couldn't be safely rewritten (the export STILL succeeds, with the page's original vector colors — never a raster fallback), `"applied"` on success. */
  whiteModeDiagnostic: VectorWhiteModeDiagnostic;
}>;

/**
 * The ONE export entry point (spec batch 9). Source page copied 1:1 (no rasterization, no
 * resize/rescale) -> OCG catalog reconstructed on a best-effort basis (never blocking, always
 * honestly reported) -> "Pracovní — bílé" applied to the copied page's own content stream, if
 * requested and safe (corrective batch section 4) -> technical symbols drawn as real vector/text
 * directly onto the copied page, at rotation-correct raw PDF coordinates -> a separate legend page
 * appended (source page's own MediaBox/CropBox never touched) -> saved. Never mutates
 * `sourcePdfBytes` — pdf-lib's `load` is read-only, and this always returns a brand-new byte array.
 */
export async function buildTechnicalRasterVectorExportPdf(input: TechnicalRasterVectorExportInput): Promise<TechnicalRasterVectorExportResult> {
  const geometry = await resolveSourcePageGeometry(input.sourcePdfBytes, input.page);

  const srcDoc = await PDFDocument.load(input.sourcePdfBytes);
  const newDoc = await PDFDocument.create();
  newDoc.registerFontkit(fontkit);

  const [copiedPage] = await newDoc.copyPages(srcDoc, [input.page - 1]);
  newDoc.addPage(copiedPage);
  disableUnnecessaryAutoNormalizeCtm(copiedPage);

  const ocgDiagnostic = reconstructOcProperties(srcDoc, newDoc, copiedPage);

  // Content-stream rewriting happens BEFORE any overlay symbol is drawn (below) — pdf-lib's own
  // page.draw*() calls append fresh operators/streams on top of whatever Contents already holds,
  // so applying white mode first means the overlay symbols are never themselves re-tokenized by
  // computeVectorWhiteModeContentStream, and never accidentally whitened (they're plain, always-
  // visible vector content outside any Optional Content span to begin with — see this module's own
  // header doc on why the overlay itself carries no OCG).
  const whiteModeDiagnostic: VectorWhiteModeDiagnostic = input.whiteMode
    ? requireVectorWhiteModeApplied(applyVectorWhiteMode(srcDoc, newDoc, copiedPage, Math.min(1, Math.max(0, input.whiteMode.opacity))), input.page)
    : { status: "not_requested" };

  // GENERATED LEGEND BATCH — the legend's own generated text (heading/descriptions/realization
  // names) now shares this SAME fontkit-only shaping font instance, drawn via the SAME
  // drawVectorOutlineText vector-outline mechanism the real placement markers already use — never a
  // pdf-lib `embedFont`/`page.drawText()`/Type0 font resource of any kind for generator content
  // (spec section 12). The source PDF's own text is completely untouched either way.
  const markerShapingFont: ShapingFont = fontkit.create(base64ToBytes(NOTO_SANS_CZECH_BOLD_BASE64));

  // GENERÁTOR DATA OCG (corrective batch 3rd, sections 10/11) — every generator-added overlay piece
  // below (placement markers, realization underlines, the in-place legend when used) is bracketed in
  // a `/OC <name> BDC ... EMC` marked-content span so it can be toggled independently of the 12
  // original source layers. The white-mode rewrite above stays OUTSIDE this bracket on purpose — it
  // transforms EXISTING source content, it is never generator-added content.
  const generatorDataOcg = ensureGeneratorDataOcg(newDoc, copiedPage, undefined);
  appendRawContentChunk(newDoc.context, copiedPage, `/OC /${generatorDataOcg.propertyName} BDC`);

  let skippedInvalidPlacementCount = 0;
  for (const item of input.placements) {
    if (!isValidNormalizedCoordinate(item.xNormalized) || !isValidNormalizedCoordinate(item.yNormalized)) {
      skippedInvalidPlacementCount += 1;
      continue;
    }
    const raw = normalizedDisplayPointToRawPdfPoint(item.xNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
    drawPlacementSymbol(copiedPage, raw.x, raw.y, item, markerShapingFont);
  }

  for (const underline of input.realizationUnderlines ?? []) {
    if (!isValidNormalizedCoordinate(underline.xNormalized) || !isValidNormalizedCoordinate(underline.yNormalized)) continue;
    if (!isValidNormalizedCoordinate(underline.xNormalized + underline.widthNormalized)) continue;
    drawRealizationUnderline(copiedPage, underline, geometry);
  }

  const effectiveLegendPlacement = resolveEffectiveLegendPlacement(input.legendPlacement);
  const legendToShow = input.showLegend ? input.legend : [];
  // GENERATED LEGEND BATCH section 13 — only the realization groups with a REAL underline on this
  // page's own export contribute to the key; `includeRealizationKey` stays the user's own "Zahrnout
  // realizačky do exportu" opt-in gate, never a fixed always-show-all-4 list.
  const usedRealizationGroups = input.includeRealizationKey ? resolveUsedRealizationGroups(realizationUnderlineColors(input.realizationUnderlines ?? [])) : [];
  let usesInPlaceLegend = effectiveLegendPlacement.strategy === "source-legend-area" && effectiveLegendPlacement.sourceRegion!.page === input.page;
  if (usesInPlaceLegend) {
    const box = normalizedDisplayRectToRawPdfBoundingBox(effectiveLegendPlacement.sourceRegion!, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
    // GENERATED LEGEND BATCH section 15 — if the configured region genuinely cannot hold this
    // export's legend (at any attempted scale/column count), NOTHING is drawn here at all (no
    // partial cover, no clipped text) and the separate-page fallback below takes over instead.
    if (drawInPlaceLegend(copiedPage, box, legendToShow, usedRealizationGroups, markerShapingFont) === "does_not_fit") usesInPlaceLegend = false;
  }
  appendRawContentChunk(newDoc.context, copiedPage, "EMC");
  if (!usesInPlaceLegend) {
    // A separate, entirely new legend PAGE (never mixed with source content) is deliberately left
    // OUTSIDE the GENERÁTOR DATA span — there is no source raster content on that page for a viewer
    // to toggle back to, so nothing meaningful is gained by making the whole page OCG-controlled.
    drawLegendPage(newDoc, input.headerLine, legendToShow, markerShapingFont, usedRealizationGroups);
  }

  const bytes = await newDoc.save();
  return { bytes, ocgDiagnostic, skippedInvalidPlacementCount, whiteModeDiagnostic };
}

// ============================================================================
// Multi-page source export (manual acceptance batch, section 38/50) — a SEPARATE entry point,
// deliberately layered on top of the exact same building blocks buildTechnicalRasterVectorExportPdf
// above already uses (resolveSourcePageGeometry / reconstructOcProperties / drawPlacementSymbol /
// drawLegendPage), rather than changing that function's own signature — every one of its ~45
// existing single-page tests keeps exercising exactly the behavior it already pins. Only
// TechnicalRasterOutputsPanel.tsx's own multi-page source case calls this one.
// ============================================================================

export type TechnicalRasterVectorExportPageInput = Readonly<{
  /** 1-based source page number, same convention as TechnicalRasterVectorExportInput.page. */
  page: number;
  placements: readonly TechnicalRasterExportPlacementItem[];
  /** Corrective batch section 10 — every realization underline on THIS page. */
  realizationUnderlines?: readonly TechnicalRasterExportRealizationUnderlineItem[];
}>;

export type TechnicalRasterMultiPageVectorExportInput = Readonly<{
  sourcePdfBytes: Uint8Array;
  /** EVERY source page to include, in the order they should appear in the export (normally 1..N in order) — each copied 1:1, exactly like the single-page function's own `page`/`placements` pair, just once per source page instead of once total. */
  pages: readonly TechnicalRasterVectorExportPageInput[];
  legend: readonly TechnicalRasterExportLegendEntry[];
  showLegend: boolean;
  headerLine: string;
  /** Same "Pracovní — bílé" request as the single-page function's own `whiteMode` — applied independently to EVERY exported source page (each page has its own content stream/OCG resources, so "unsupported" on one page never affects another). */
  whiteMode?: Readonly<{ opacity: number }>;
  /** Whether the legend page's own fixed "REALIZACE" key is included — a whole-export flag, since the key always lists all 4 canonical groups regardless of which page(s) actually carry badges. */
  includeRealizationKey?: boolean;
  /** Corrective batch section 7 — WHERE the legend is drawn. Omitted resolves to today's existing "separate-page" behavior. */
  legendPlacement?: TechnicalLegendPlacement;
}>;

export type TechnicalRasterMultiPageVectorExportResult = Readonly<{
  bytes: Uint8Array;
  /** One OCG diagnostic per exported source page, in the same order as `input.pages` (spec section 40: OCG reconstruction must keep working per page, never just for a single page). */
  ocgDiagnosticsByPage: readonly OcgReconstructionResult[];
  skippedInvalidPlacementCount: number;
  /** 1-based export page number the legend landed on — `input.pages.length + 1` (spec section 38: "legendu přidej AŽ ZA POSLEDNÍ SOURCE PAGE") for the default "separate-page" placement, or whichever source page the "source-legend-area" region targeted (corrective batch section 7). */
  legendPageNumber: number;
  /** One "Pracovní — bílé" diagnostic per exported source page, same order/independence as `ocgDiagnosticsByPage`. */
  whiteModeDiagnosticsByPage: readonly VectorWhiteModeDiagnostic[];
}>;

/**
 * Multi-page counterpart of buildTechnicalRasterVectorExportPdf (spec section 38): every source
 * page in `input.pages` is copied 1:1 (own MediaBox/CropBox/rotation, own OCG reconstruction, own
 * overlay symbols — nothing here ever resizes/rescales a source page, exactly like the single-page
 * function), in order, and the legend is appended as ONE extra page after all of them — never
 * inserted in between, never sharing a page with source content. A single-page source
 * (`input.pages.length === 1`) produces byte-for-byte the same PAGE STRUCTURE the single-page
 * function would (page 1 = source+overlay, page 2 = legend); TechnicalRasterOutputsPanel.tsx uses
 * this ONE function for both cases so there is only one export code path to reason about.
 */
export async function buildTechnicalRasterMultiPageVectorExportPdf(input: TechnicalRasterMultiPageVectorExportInput): Promise<TechnicalRasterMultiPageVectorExportResult> {
  const srcDoc = await PDFDocument.load(input.sourcePdfBytes);
  const newDoc = await PDFDocument.create();
  newDoc.registerFontkit(fontkit);

  // See buildTechnicalRasterVectorExportPdf's own doc — loaded independently of any pdf-lib
  // embedFont, used to shape BOTH the generator's own placement-marker glyphs AND the generated
  // legend's own text into pure vector outlines (spec section 12) — never a page.drawText()/Type0
  // font resource for any generator content.
  const markerShapingFont: ShapingFont = fontkit.create(base64ToBytes(NOTO_SANS_CZECH_BOLD_BASE64));

  const ocgDiagnosticsByPage: OcgReconstructionResult[] = [];
  const whiteModeDiagnosticsByPage: VectorWhiteModeDiagnostic[] = [];
  let skippedInvalidPlacementCount = 0;
  const effectiveLegendPlacement = resolveEffectiveLegendPlacement(input.legendPlacement);
  // GENERATED LEGEND BATCH section 13/19 — computed ONCE across every exported page's own
  // underlines (never just the in-place legend's own target page) since the realization key
  // reflects the WHOLE export, matching this function's own pre-existing doc comment on
  // `includeRealizationKey` itself.
  const usedRealizationGroups = input.includeRealizationKey
    ? resolveUsedRealizationGroups(realizationUnderlineColors(input.pages.flatMap((pageInput) => pageInput.realizationUnderlines ?? [])))
    : [];
  let inPlaceLegendPageNumber: number | undefined;
  // GENERÁTOR DATA OCG (corrective batch 3rd, sections 10/11) — ONE shared ref threaded across
  // every exported page (`reconstructOcProperties` rebuilds `/OCProperties` from scratch on each
  // per-page call; `ensureGeneratorDataOcg` is deliberately idempotent/re-appending so this stays a
  // SINGLE object re-registered on every page, never duplicated).
  let generatorDataOcgRef: PDFRef | undefined;

  let exportPageNumber = 0;
  for (const pageInput of input.pages) {
    exportPageNumber += 1;
    const geometry = await resolveSourcePageGeometry(input.sourcePdfBytes, pageInput.page);
    const [copiedPage] = await newDoc.copyPages(srcDoc, [pageInput.page - 1]);
    newDoc.addPage(copiedPage);
    disableUnnecessaryAutoNormalizeCtm(copiedPage);
    ocgDiagnosticsByPage.push(reconstructOcProperties(srcDoc, newDoc, copiedPage));
    whiteModeDiagnosticsByPage.push(
      input.whiteMode
        ? requireVectorWhiteModeApplied(applyVectorWhiteMode(srcDoc, newDoc, copiedPage, Math.min(1, Math.max(0, input.whiteMode.opacity))), pageInput.page)
        : { status: "not_requested" },
    );

    const generatorDataOcg = ensureGeneratorDataOcg(newDoc, copiedPage, generatorDataOcgRef);
    generatorDataOcgRef = generatorDataOcg.ref;
    appendRawContentChunk(newDoc.context, copiedPage, `/OC /${generatorDataOcg.propertyName} BDC`);

    for (const item of pageInput.placements) {
      if (!isValidNormalizedCoordinate(item.xNormalized) || !isValidNormalizedCoordinate(item.yNormalized)) {
        skippedInvalidPlacementCount += 1;
        continue;
      }
      const raw = normalizedDisplayPointToRawPdfPoint(item.xNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
      drawPlacementSymbol(copiedPage, raw.x, raw.y, item, markerShapingFont);
    }

    for (const underline of pageInput.realizationUnderlines ?? []) {
      if (!isValidNormalizedCoordinate(underline.xNormalized) || !isValidNormalizedCoordinate(underline.yNormalized)) continue;
      if (!isValidNormalizedCoordinate(underline.xNormalized + underline.widthNormalized)) continue;
      drawRealizationUnderline(copiedPage, underline, geometry);
    }

    // In-place legend (corrective batch section 7) — CORRECTIVE BATCH 3rd, section 10: moved to
    // run AFTER white mode (previously drawn before it) so it lands inside the SAME GENERÁTOR DATA
    // bracket as the markers/underlines above, matching buildTechnicalRasterVectorExportPdf's own
    // (single-page) ordering. White mode's own content-stream merge (readPageContentBytes) already
    // concatenates whatever content existed at the time it ran — legend draws carry no `/OC` tag of
    // their own, so moving them to run after white mode changes neither their appearance nor
    // white mode's own recoloring, only which content-stream chunk they end up in.
    if (effectiveLegendPlacement.strategy === "source-legend-area" && effectiveLegendPlacement.sourceRegion!.page === pageInput.page) {
      const box = normalizedDisplayRectToRawPdfBoundingBox(effectiveLegendPlacement.sourceRegion!, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
      // GENERATED LEGEND BATCH section 15 — a "does_not_fit" result draws NOTHING on this page (no
      // partial cover/text) and simply never sets inPlaceLegendPageNumber, so the fallback below
      // appends a normal separate legend page instead — the safe behavior, never a broken drawing.
      if (drawInPlaceLegend(copiedPage, box, input.showLegend ? input.legend : [], usedRealizationGroups, markerShapingFont) === "drawn") {
        inPlaceLegendPageNumber = exportPageNumber;
      }
    }
    appendRawContentChunk(newDoc.context, copiedPage, "EMC");
  }

  let legendPageNumber: number;
  if (inPlaceLegendPageNumber !== undefined) {
    legendPageNumber = inPlaceLegendPageNumber;
  } else {
    drawLegendPage(newDoc, input.headerLine, input.showLegend ? input.legend : [], markerShapingFont, usedRealizationGroups);
    legendPageNumber = newDoc.getPageCount();
  }

  const bytes = await newDoc.save();
  return { bytes, ocgDiagnosticsByPage, skippedInvalidPlacementCount, legendPageNumber, whiteModeDiagnosticsByPage };
}
