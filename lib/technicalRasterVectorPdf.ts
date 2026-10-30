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
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFString, PDFRawStream, PDFRef, decodePDFRawStream, rgb, type PDFPage, type PDFContext } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { NOTO_SANS_CZECH_BOLD_BASE64 } from "./fonts/graphicsProductionFont.ts";
import { isValidNormalizedCoordinate, normalizedDisplayPointToRawPdfPoint, normalizedDisplayRectToRawPdfBoundingBox, type AffineTransform6 } from "../domain/technicalRasterExportPlacementGeometry.ts";
import type { TechnicalRasterExportLegendEntry, TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";
import { resolveEffectiveLegendPlacement, type TechnicalLegendPlacement } from "../domain/technicalRasterLegendPlacement.ts";
import { detectStandLayerId } from "../domain/technicalRasterWhiteModeOperators.ts";
import { computeVectorWhiteModeContentStream } from "../domain/technicalRasterVectorWhiteMode.ts";
import { computeTextScaleContentStream } from "../domain/technicalRasterTextScale.ts";
import { appendRawContentChunk, replacePageContentsWithSingleStream, resolvePageContentsShape } from "./pdf/pdfPageContentAppend.ts";
import {
  EXPORT_POWER_LABEL_FONT_SIZE_PT,
  EXPORT_STAR_SYMBOL_FONT_SIZE_PT,
  EXPORT_TEXT_SYMBOL_FONT_SIZE_PT,
  EXPORT_WATER_DROP_HEIGHT_PT,
  EXPORT_WIFI_SYMBOL_WIDTH_PT,
  REALIZATION_UNDERLINE_THICKNESS_PT,
  NO_ELECTRICITY_MARKER_HALF_SIZE_PT,
  NO_ELECTRICITY_MARKER_THICKNESS_PT,
} from "../domain/technicalRasterExportSymbolSize.ts";
import { TECHNICAL_REALIZATION_GROUPS, type TechnicalRealizationGroupInfo } from "../domain/technicalRasterRealization.ts";
import { buildVectorGlyphPathOperators, type GlyphOutlineCommand, type PositionedGlyphOutline } from "../domain/technicalRasterVectorGlyphOutline.ts";
import { ensurePdfJsWorkerConfigured } from "./pdf/pdfJsWorkerConfig.ts";
import { createSimpleTrueTypeTextFont, type PdfRgb } from "./pdf/pdfSimpleTrueTypeText.ts";
import type { TechnicalRasterExportDrawingItem } from "../domain/technicalRasterDrawings.ts";

/**
 * A small set of typed failure codes for this pipeline's own genuinely distinct, anticipated
 * failure modes (spec batch 13 section 33 — added only where it improves testability, never a
 * wholesale error-architecture rewrite). Every OTHER failure — a malformed source PDF, an
 * embedFont failure, pdf-lib's own internal errors — still surfaces as whatever error pdf.js/
 * pdf-lib themselves throw; this class is not a universal wrapper.
 */
export class TechnicalRasterVectorExportError extends Error {
  readonly code: "INVALID_PAGE" | "WHITE_MODE_UNSUPPORTED" | "TEXT_SCALE_UNSUPPORTED";
  /** Only set for `WHITE_MODE_UNSUPPORTED`/`TEXT_SCALE_UNSUPPORTED` — the 1-based SOURCE page number the transform failed on, so a caller/UI can say exactly where the problem is. */
  readonly page?: number;
  constructor(code: "INVALID_PAGE" | "WHITE_MODE_UNSUPPORTED" | "TEXT_SCALE_UNSUPPORTED", message: string, page?: number) {
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

/**
 * One source OCG's DEFAULT state for the export, by real OCG name (see
 * domain/technicalRaster.ts resolveExportSourceLayerVisibility — the project's actual layer ON/OFF,
 * never the working-view-only hide).
 */
export type TechnicalRasterExportSourceLayerVisibility = Readonly<{ ocgName: string; visible: boolean }>;

/**
 * `sourceLayerVisibility` (optional) sets each source OCG's default ON/OFF to the project's own
 * layer state. A layer not listed keeps the source PDF's own default. Only /D/ON and /D/OFF change —
 * the OCG objects, their content, /OCGs order, /Order, /Locked and /RBGroups are preserved as before.
 */
export function reconstructOcProperties(
  srcDoc: PDFDocument,
  newDoc: PDFDocument,
  copiedPage: PDFPage,
  sourceLayerVisibility: readonly TechnicalRasterExportSourceLayerVisibility[] = [],
): OcgReconstructionResult {
  const visibilityByName = new Map(sourceLayerVisibility.map((entry) => [entry.ocgName, entry.visible]));
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
    const projectVisible = name !== undefined ? visibilityByName.get(name) : undefined;
    const visible = projectVisible ?? !(name && offNames.has(name));
    (visible ? onArr : offArr).push(ref);
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
  return ensureOverlayOcg(newDoc, copiedPage, existingRef, GENERATOR_DATA_OCG_NAME, "GenData");
}

/** Same mechanics as ensureGeneratorDataOcg, for any named overlay layer (GENERÁTOR DATA, ABF – TECHNICKÉ ZNAČKY). */
function ensureOverlayOcg(newDoc: PDFDocument, copiedPage: PDFPage, existingRef: PDFRef | undefined, ocgName: string, propertyKeyPrefix: string): Readonly<{ ref: PDFRef; propertyName: string }> {
  const ctx = newDoc.context;
  // PDFString only carries PDFDocEncoding: "Á" in "GENERÁTOR DATA" survives, but "–"/"Č" in
  // "ABF – TECHNICKÉ ZNAČKY" would be silently dropped. Names outside Latin-1 are therefore
  // written as a UTF-16 hex string; GENERÁTOR DATA keeps its existing, byte-identical encoding.
  const nameObject = /^[ -~ -ÿ]*$/u.test(ocgName) ? PDFString.of(ocgName) : PDFHexString.fromText(ocgName);
  const ref = existingRef ?? ctx.register(ctx.obj({ Type: "OCG", Name: nameObject }));
  appendGeneratorDataOcgToCatalog(newDoc, ref);

  const resources = ensureDictChild(copiedPage.node, ctx, "Resources");
  const properties = ensureDictChild(resources, ctx, "Properties");
  const existingKey = properties.keys().find((key) => properties.get(key)?.toString() === ref.toString());
  const propertyKey = existingKey ?? properties.uniqueKey(propertyKeyPrefix);
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

// ============================================================================
// Per-source-OCG-layer text scale for the EXPORT (PRODUCTION BATCH, part A) — see
// domain/technicalRasterTextScale.ts's own module doc for the actual tokenizer/rewriter algorithm.
// Everything HERE is pdf-lib plumbing, mirroring the white-mode plumbing immediately above: resolve
// which resource-dictionary property NAME(s) the copied page's own content stream would use to tag
// the CHOSEN source layer (by its real OCG NAME — never pdf.js's own internal group id, which has no
// meaning to pdf-lib), read/decode/concatenate the page's real content stream(s), run the pure
// rewriter, and (only on success) replace Contents with the patched bytes.
// ============================================================================

/** Every resource-dictionary key (no leading "/") in the copied page's own `/Resources/Properties` that resolves to the OCG object named `ocgName` — the same contract as findVectorWhiteModeTargetPropertyNames, just matched against an EXPLICIT, user-chosen layer name instead of the alias-detected "stand layer". Unlike that function, this needs no `srcDoc` at all: `buildOcgNameToCopiedRefMap` already resolves straight from the COPIED page's own Properties dict. */
function findTargetPropertyNamesForOcgName(newDoc: PDFDocument, copiedPage: PDFPage, ocgName: string): ReadonlySet<string> {
  const nameToCopiedRef = buildOcgNameToCopiedRefMap(newDoc, copiedPage);
  const targetRef = nameToCopiedRef.get(ocgName);
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

export type TechnicalRasterExportTextScaleItem = Readonly<{
  /** The real OCG NAME (RasterLayer.name, e.g. "NÁZVY + ROZMĚRY ***") — the caller resolves this from the project's own `sourceLayerTextScales` (keyed by RasterLayer.id) before calling the export, exactly like the editor resolves an id to a name for its own on-screen preview. */
  ocgName: string;
  /** Already clamped by the caller to [MIN_SOURCE_LAYER_TEXT_SCALE, MAX_SOURCE_LAYER_TEXT_SCALE] (domain/technicalRaster.ts). A scale of exactly 1 is never passed in (harmless no-op the caller already filters out before building this list). */
  scale: number;
}>;

export type TechnicalRasterTextScaleDiagnostic = Readonly<{
  ocgName: string;
  page: number;
  status: "applied" | "unsupported";
  scaledFontSizeCount?: number;
  reason?: string;
}>;

/**
 * Applies EVERY configured layer's own text scale to `copiedPage`'s content stream, one layer at a
 * time (each iteration reads the page's CURRENT content — already reflecting any earlier layer's own
 * patch — and, on success, replaces it again; the layers' own OCG spans never overlap by
 * construction, since a real Optional Content span belongs to exactly one OCG). Never mutates
 * anything for a layer that resolves to "unsupported" for THIS page — that layer's own diagnostic is
 * still reported, but the page's content stream is left exactly as it was before that one attempt
 * (never a partial rewrite). White mode, when also requested, has ALWAYS already run by the time this
 * is called (see call sites below) — text scaling only ever touches `Tf` operators, which white mode
 * never reads or writes, so the two transforms can never disagree about the same bytes.
 */
function applyTextScalesToPage(newDoc: PDFDocument, copiedPage: PDFPage, textScales: readonly TechnicalRasterExportTextScaleItem[], page: number): readonly TechnicalRasterTextScaleDiagnostic[] {
  const diagnostics: TechnicalRasterTextScaleDiagnostic[] = [];
  for (const item of textScales) {
    const targetPropertyNames = findTargetPropertyNamesForOcgName(newDoc, copiedPage, item.ocgName);
    if (targetPropertyNames.size === 0) {
      diagnostics.push({ ocgName: item.ocgName, page, status: "unsupported", reason: `Vrstva "${item.ocgName}" nebyla na stránce ${page} nalezena.` });
      continue;
    }
    const contentBytes = readPageContentBytes(newDoc, copiedPage);
    const result = computeTextScaleContentStream(contentBytes, { targetOcPropertyNames: targetPropertyNames, scale: item.scale });
    if (result.status === "unsupported") {
      diagnostics.push({ ocgName: item.ocgName, page, status: "unsupported", reason: result.reason });
      continue;
    }
    const newStreamRef = newDoc.context.register(newDoc.context.stream(result.content, {}));
    replacePageContentsWithSingleStream(newDoc.context, copiedPage, newStreamRef);
    diagnostics.push({ ocgName: item.ocgName, page, status: "applied", scaledFontSizeCount: result.scaledFontSizeCount });
  }
  return diagnostics;
}

/**
 * Enforces the SAME policy `requireVectorWhiteModeApplied` already enforces for white mode (spec
 * section 6: "editor and export must match" — an export must never silently produce a different
 * visual result than what the user configured): if ANY requested layer's text scale could not be
 * safely applied on ANY page, the WHOLE export throws rather than completing with that layer's text
 * left unscaled.
 */
function requireTextScalesApplied(diagnostics: readonly TechnicalRasterTextScaleDiagnostic[]): readonly TechnicalRasterTextScaleDiagnostic[] {
  const failure = diagnostics.find((diagnostic) => diagnostic.status === "unsupported");
  if (failure) {
    throw new TechnicalRasterVectorExportError(
      "TEXT_SCALE_UNSUPPORTED",
      `Zmenšení textu vrstvy "${failure.ocgName}" na stránce ${failure.page} nelze bezpečně použít (${failure.reason}). Export byl zastaven — vypněte zmenšení textu pro tuto vrstvu nebo opravte zdrojové PDF.`,
      failure.page,
    );
  }
  return diagnostics;
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
// Overlay text — HOTFIX-02 (phase 5). Every generator-added label (technical markers, visible notes
// of manual drawings, legend text) goes through ONE ExportTextRenderer:
//
//   - "text" (DEFAULT): real, editable PDF text objects in a SIMPLE embedded TrueType font
//     (lib/pdf/pdfSimpleTrueTypeText.ts) — Czech diacritics and "³" included, selectable/searchable,
//     editable in CorelDRAW ("5 kW" -> "9 kW"). Deliberately NOT pdf-lib's `page.drawText()`: that is
//     always a Type0/CIDFont (`/Identity-H`), the exact font shape CorelDRAW 2018 was found to DROP on
//     import (CORRECTIVE BATCH 3rd, sections 8/9) — the reason the labels had been converted to
//     outlines before;
//   - "outlines": the previous behavior — every glyph as a filled vector path (no font at all).
//     Kept as the safe fallback ("Texty jako křivky") in case a particular importer still mishandles
//     the text; position, size and color are identical in both modes.
//
// Both measure text the same way they draw it, so centering and legend fitting never disagree with
// the result. The SOURCE PDF's own text is untouched either way.
// ============================================================================

export type TechnicalRasterExportTextMode = "text" | "outlines";

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

/** Shapes `text` through fontkit into the pure `PositionedGlyphOutline` shape domain/technicalRasterVectorGlyphOutline.ts's own converter expects ("outlines" mode). */
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

type Rgb = ReturnType<typeof rgb>;

function rgbOf(color: Rgb): PdfRgb {
  return color as unknown as PdfRgb;
}

function formatOperand(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Text color — 3 decimals, byte-identical to the previous outline labels' own color operator. */
function colorOperands(color: Rgb): string {
  const { red, green, blue } = rgbOf(color);
  return `${formatOperand(red)} ${formatOperand(green)} ${formatOperand(blue)}`;
}

/** Stroke/fill color of plain shapes — full precision, as pdf-lib's own drawLine/drawCircle wrote it before. */
function shapeColorOperands(color: Rgb): string {
  const { red, green, blue } = rgbOf(color);
  return [red, green, blue].map((component) => String(Math.round(component * 1e6) / 1e6)).join(" ");
}

type ExportTextRenderer = Readonly<{
  mode: TechnicalRasterExportTextMode;
  /** Width in points of `text` at `fontSizePt` — exactly what `operators` draws. */
  measure(text: string, fontSizePt: number): number;
  /** Content-stream operators drawing `text` with its baseline-left origin at (x, y). */
  operators(page: PDFPage, originX: number, originY: number, text: string, fontSizePt: number, color: Rgb): string;
  /** Completes font resources (text mode). Call once, before save. */
  finalize(): void;
}>;

function createOutlineTextRenderer(shapingFont: ShapingFont): ExportTextRenderer {
  return {
    mode: "outlines",
    measure: (text, fontSizePt) => (shapingFont.layout(text).positions.reduce((sum, position) => sum + position.xAdvance, 0) / shapingFont.unitsPerEm) * fontSizePt,
    operators: (_page, originX, originY, text, fontSizePt, color) => {
      const pathOperators = buildVectorGlyphPathOperators(shapeTextToPositionedGlyphOutlines(shapingFont, text), originX, originY, shapingFont.unitsPerEm, fontSizePt);
      return pathOperators ? `q ${colorOperands(color)} rg\n${pathOperators}\nQ` : "";
    },
    finalize: () => undefined,
  };
}

function createRealTextRenderer(newDoc: PDFDocument, fontBytes: Uint8Array, shapingFont: ShapingFont): ExportTextRenderer {
  const font = createSimpleTrueTypeTextFont(newDoc, fontBytes, shapingFont);
  return {
    mode: "text",
    measure: (text, fontSizePt) => font.measure(text, fontSizePt),
    operators: (page, originX, originY, text, fontSizePt, color) => font.textOperators(page, originX, originY, text, fontSizePt, rgbOf(color)),
    finalize: () => font.finalize(),
  };
}

function createExportTextRenderer(newDoc: PDFDocument, mode: TechnicalRasterExportTextMode | undefined): ExportTextRenderer {
  const fontBytes = base64ToBytes(NOTO_SANS_CZECH_BOLD_BASE64);
  const shapingFont: ShapingFont = fontkit.create(fontBytes);
  return mode === "outlines" ? createOutlineTextRenderer(shapingFont) : createRealTextRenderer(newDoc, fontBytes, shapingFont);
}

// ============================================================================
// Overlay primitives — HOTFIX-02 (phase 6): every overlay piece is written as raw operators into ONE
// buffer per page, flushed as ONE content stream. pdf-lib's own `page.drawLine()`/`drawRectangle()`
// write into a single lazily created page stream that sits wherever it was FIRST used, so content
// drawn later through them could silently land inside (or outside) the wrong `/OC … BDC … EMC`
// layer bracket. With one buffer the layer brackets always enclose exactly what they should.
// ============================================================================

class OverlayBuffer {
  private readonly parts: string[] = [];
  push(operators: string): void {
    if (operators) this.parts.push(operators);
  }
  get isEmpty(): boolean {
    return this.parts.length === 0;
  }
  flush(page: PDFPage): void {
    if (this.parts.length === 0) return;
    appendRawContentChunk(page.doc.context, page, this.parts.join("\n"));
    this.parts.length = 0;
  }
}

function strokeLineOperators(x1: number, y1: number, x2: number, y2: number, thicknessPt: number, color: Rgb): string {
  return `q ${shapeColorOperands(color)} RG ${formatOperand(thicknessPt)} w 1 J ${formatOperand(x1)} ${formatOperand(y1)} m ${formatOperand(x2)} ${formatOperand(y2)} l S Q`;
}

/** Circle as four cubic Béziers (the standard 0.5523 approximation). */
function circlePathOperators(cx: number, cy: number, r: number): string {
  const k = 0.5522847498 * r;
  const f = formatOperand;
  return [
    `${f(cx + r)} ${f(cy)} m`,
    `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
    `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
    `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
    `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`,
  ].join(" ");
}

function fillCircleOperators(cx: number, cy: number, r: number, color: Rgb): string {
  return `q ${shapeColorOperands(color)} rg ${circlePathOperators(cx, cy, r)} f Q`;
}

function fillRectOperators(x: number, y: number, width: number, height: number, color: Rgb): string {
  return `q ${shapeColorOperands(color)} rg ${formatOperand(x)} ${formatOperand(y)} ${formatOperand(width)} ${formatOperand(height)} re f Q`;
}

// ============================================================================
// Technical marker symbols — real vector/text, never emoji/bitmap (spec section 17), no badge, sized
// from domain/technicalRasterExportSymbolSize.ts. HOTFIX-02: every central default renderer is TEXT
// ("powerLabel"/"textLabel"/"fallback" — the same displayLabel the editor shows). The icon renderers
// below stay drawable for a TechnicalRasterComponentConfig override only.
// ============================================================================

/** Centered short colored text — powerLabel (kW), textLabel (IP/INT/El.rozvaděč/3 m³/…), fallback. */
function textSymbolOperators(page: PDFPage, x: number, y: number, color: Rgb, text: string, renderer: ExportTextRenderer, fontSizePt: number): string {
  const width = renderer.measure(text, fontSizePt);
  return renderer.operators(page, x - width / 2, y - fontSizePt * 0.35, text, fontSizePt, color);
}

/** SVG path data (24×24, y-down) -> PDF operators centered on (x, y), y flipped — the same placement drawSvgPath used (origin at x-12·s, y+12·s). */
function svgPathOperators(commands: readonly (readonly [string, ...number[]])[], x: number, y: number, scale: number): string {
  const px = (sx: number) => formatOperand(x - 12 * scale + sx * scale);
  const py = (sy: number) => formatOperand(y + 12 * scale - sy * scale);
  return commands.map(([op, ...a]) => {
    if (op === "m" || op === "l") return `${px(a[0]!)} ${py(a[1]!)} ${op}`;
    if (op === "c") return `${px(a[0]!)} ${py(a[1]!)} ${px(a[2]!)} ${py(a[3]!)} ${px(a[4]!)} ${py(a[5]!)} c`;
    return "h";
  }).join(" ");
}

/** The editor's teardrop (M12 2C12 2 5 11 5 15.5 A7 7 0 0019 15.5 C19 11 12 2 12 2Z) — its lower half-circle as two quarter Béziers. */
const WATER_DROP_PATH: readonly (readonly [string, ...number[]])[] = [
  ["m", 12, 2], ["c", 12, 2, 5, 11, 5, 15.5], ["c", 5, 19.366, 8.134, 22.5, 12, 22.5], ["c", 15.866, 22.5, 19, 19.366, 19, 15.5], ["c", 19, 11, 12, 2, 12, 2], ["h"],
];
const WIFI_PATH: readonly (readonly [string, ...number[]])[] = [
  ["m", 2, 8.5], ["c", 7.5, 3.5, 16.5, 3.5, 22, 8.5], ["m", 5.5, 12.5], ["c", 9.5, 9, 14.5, 9, 18.5, 12.5], ["m", 9, 16.5], ["c", 10.5, 15, 13.5, 15, 15, 16.5], ["m", 12, 20.2], ["l", 12, 20.3],
];

function placementSymbolOperators(page: PDFPage, x: number, y: number, item: TechnicalRasterExportPlacementItem, renderer: ExportTextRenderer): string {
  const color = hexToRgbFraction(item.presentation.color);
  switch (item.presentation.renderer) {
    case "refrigeratedStar":
      return textSymbolOperators(page, x, y - EXPORT_STAR_SYMBOL_FONT_SIZE_PT * 0.05, color, "*", renderer, EXPORT_STAR_SYMBOL_FONT_SIZE_PT);
    case "waterDrop": {
      const scale = EXPORT_WATER_DROP_HEIGHT_PT / 13.5;
      return `q ${shapeColorOperands(color)} rg ${svgPathOperators(WATER_DROP_PATH, x, y, scale)} f Q`;
    }
    case "wifiIcon": {
      const scale = EXPORT_WIFI_SYMBOL_WIDTH_PT / 20;
      return `q ${shapeColorOperands(color)} RG ${formatOperand(2.5 * scale)} w 1 J ${svgPathOperators(WIFI_PATH, x, y, scale)} S Q`;
    }
    case "powerLabel":
      // Electricity power labels ("2 kW" … "40 kW") keep their own, independently tuned size.
      return textSymbolOperators(page, x, y, color, item.presentation.displayLabel ?? "?", renderer, EXPORT_POWER_LABEL_FONT_SIZE_PT);
    case "textLabel":
    case "fallback":
    default:
      return textSymbolOperators(page, x, y, color, item.presentation.displayLabel ?? "?", renderer, EXPORT_TEXT_SYMBOL_FONT_SIZE_PT);
  }
}

// ============================================================================
// Realization underline (corrective batch, post real-file acceptance test, section 4/5/14) — a single
// ordinary vector stroke, anchored below the stand number (geometry from
// domain/technicalRasterRealizationUnderline.ts, shared with the editor). Not a technical service —
// stays in the GENERÁTOR DATA layer.
// ============================================================================

export type TechnicalRasterExportRealizationUnderlineItem = Readonly<{
  standId: string;
  /** Normalized page-space geometry — the SAME rectangle domain/technicalRasterRealizationUnderline.ts's computeRealizationUnderlineGeometry produces for the editor. */
  xNormalized: number;
  yNormalized: number;
  widthNormalized: number;
  /** The resolved realization group's own central color (domain/technicalRasterRealization.ts). */
  color: string;
}>;

function realizationUnderlineOperators(item: TechnicalRasterExportRealizationUnderlineItem, geometry: SourcePageGeometry): string {
  const start = normalizedDisplayPointToRawPdfPoint(item.xNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  const end = normalizedDisplayPointToRawPdfPoint(item.xNormalized + item.widthNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  return strokeLineOperators(start.x, start.y, end.x, end.y, REALIZATION_UNDERLINE_THICKNESS_PT, hexToRgbFraction(item.color));
}

// ============================================================================
// "BEZ elektriky" automatic red X (PRODUCTION BATCH, part B) — two plain vector strokes centered on
// domain/technicalRasterNoElectricityMarker.ts's geometry. An automatic technical marker, so it
// lives in the ABF – TECHNICKÉ ZNAČKY layer (HOTFIX-02).
// ============================================================================

export type TechnicalRasterExportNoElectricityMarkerItem = Readonly<{
  standId: string;
  /** Normalized page-space CENTER point (domain/technicalRasterNoElectricityMarker.ts's computeNoElectricityMarkerGeometry). */
  xNormalized: number;
  yNormalized: number;
}>;

const NO_ELECTRICITY_MARKER_COLOR = hexToRgbFraction("#c1121f");

function noElectricityMarkerOperators(item: TechnicalRasterExportNoElectricityMarkerItem, geometry: SourcePageGeometry): string {
  const center = normalizedDisplayPointToRawPdfPoint(item.xNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  const half = NO_ELECTRICITY_MARKER_HALF_SIZE_PT;
  return [
    strokeLineOperators(center.x - half, center.y - half, center.x + half, center.y + half, NO_ELECTRICITY_MARKER_THICKNESS_PT, NO_ELECTRICITY_MARKER_COLOR),
    strokeLineOperators(center.x - half, center.y + half, center.x + half, center.y - half, NO_ELECTRICITY_MARKER_THICKNESS_PT, NO_ELECTRICITY_MARKER_COLOR),
  ].join("\n");
}

// ============================================================================
// Manual drawings ("Bod" / "Čára", domain/technicalRasterDrawings.ts) — plain vector shapes in the
// drawing's category color, positioned through the SAME rotation-aware normalized -> raw PDF
// transform as every placement: a dot (filled circle), a cross × (two diagonal strokes), the original
// "+" of an older point, or a line A–B. A VISIBLE note is real text right of a point / above a
// line's midpoint (internal notes never reach this code). All inside ABF – TECHNICKÉ ZNAČKY (HOTFIX-02).
// ============================================================================

function manualDrawingOperators(page: PDFPage, item: TechnicalRasterExportDrawingItem, geometry: SourcePageGeometry, renderer: ExportTextRenderer): string {
  const toRaw = (x: number, y: number) => normalizedDisplayPointToRawPdfPoint(x, y, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  const color = hexToRgbFraction(item.color);
  const parts: string[] = [];
  if (item.kind === "text") {
    // A free text: real (editable) text starting at its point, vertically centered on it — like the editor.
    const origin = toRaw(item.x, item.y);
    return renderer.operators(page, origin.x, origin.y - item.fontSizePt * 0.35, item.text, item.fontSizePt, color);
  }
  if (item.kind === "point") {
    const center = toRaw(item.x, item.y);
    const half = item.crossHalfPt;
    let extent = half;
    if (item.shape === "dot") {
      extent = item.dotRadiusPt;
      parts.push(fillCircleOperators(center.x, center.y, item.dotRadiusPt, color));
    } else if (item.shape === "cross") {
      const d = half * Math.SQRT1_2;
      parts.push(strokeLineOperators(center.x - d, center.y - d, center.x + d, center.y + d, item.strokePt, color));
      parts.push(strokeLineOperators(center.x - d, center.y + d, center.x + d, center.y - d, item.strokePt, color));
    } else {
      parts.push(strokeLineOperators(center.x - half, center.y, center.x + half, center.y, item.strokePt, color));
      parts.push(strokeLineOperators(center.x, center.y - half, center.x, center.y + half, item.strokePt, color));
    }
    if (item.note) parts.push(renderer.operators(page, center.x + extent + item.note.gapPt, center.y - item.note.fontSizePt * 0.35, item.note.text, item.note.fontSizePt, color));
    return parts.join("\n");
  }
  const a = toRaw(item.x1, item.y1);
  const b = toRaw(item.x2, item.y2);
  parts.push(strokeLineOperators(a.x, a.y, b.x, b.y, item.strokePt, color));
  if (item.note) {
    const width = renderer.measure(item.note.text, item.note.fontSizePt);
    parts.push(renderer.operators(page, (a.x + b.x) / 2 - width / 2, (a.y + b.y) / 2 + item.strokePt / 2 + item.note.gapPt, item.note.text, item.note.fontSizePt, color));
  }
  return parts.join("\n");
}

function isValidDrawingItem(item: TechnicalRasterExportDrawingItem): boolean {
  return item.kind === "point" || item.kind === "text"
    ? isValidNormalizedCoordinate(item.x) && isValidNormalizedCoordinate(item.y)
    : [item.x1, item.y1, item.x2, item.y2].every(isValidNormalizedCoordinate);
}

// ============================================================================
// Legend (HOTFIX-02, phase 7) — explains the category COLORS only ("● ELEKTŘINA", "● INTERNET /
// WiFi", …), never what an individual label means. Only categories used in this export are listed
// (domain/technicalRasterExport.ts buildTechnicalRasterExportLegend); the realization key stays its
// own column. Every legend text goes through the same ExportTextRenderer as the markers.
// ============================================================================

function resolveUsedRealizationGroups(underlineColors: ReadonlySet<string>): readonly TechnicalRealizationGroupInfo[] {
  return TECHNICAL_REALIZATION_GROUPS.filter((group) => underlineColors.has(group.color));
}

function realizationUnderlineColors(underlines: readonly Readonly<{ color: string }>[]): ReadonlySet<string> {
  return new Set(underlines.map((underline) => underline.color));
}

// Legend page (spec section 26/27) — a SEPARATE page, never resizing/rescaling the copied source page.

const LEGEND_PAGE_WIDTH_PT = 420;
const LEGEND_MARGIN_PT = 28;
const LEGEND_ROW_HEIGHT_PT = 18;
const LEGEND_TITLE_FONT_SIZE_PT = 12;
const LEGEND_SUBHEADING_FONT_SIZE_PT = 9;
const LEGEND_TEXT_FONT_SIZE_PT = 9;
const LEGEND_SYMBOL_COLUMN_WIDTH_PT = 16;
const LEGEND_SWATCH_RADIUS_PT = 3.2;
const LEGEND_REALIZATION_SWATCH_WIDTH_PT = 10;
/** Gap between the technical (left) and realization (right) columns. */
const LEGEND_COLUMN_GAP_PT = 24;
/** The embedded font has no em dash — an en dash keeps the title readable in both text modes. */
const LEGEND_PAGE_TITLE = "TECHNICKÝ EXPORT – LEGENDA";

/** Technical categories in a LEFT column, realization groups in a RIGHT column beside it (never stacked) — shared by both legend strategies. */
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
  renderer: ExportTextRenderer,
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
): void {
  const hasRealizationColumn = usedRealizationGroups.length > 0;
  const leftRows = Math.max(1, legend.length);
  const rightRows = hasRealizationColumn ? usedRealizationGroups.length : 0;
  const bodyRows = Math.max(leftRows, rightRows) + 1; // +1 for the LEGENDA:/REALIZACE: heading row
  const height = LEGEND_MARGIN_PT * 2 + 40 + bodyRows * LEGEND_ROW_HEIGHT_PT;
  const page = newDoc.addPage([LEGEND_PAGE_WIDTH_PT, height]);
  const ops = new OverlayBuffer();
  let y = height - LEGEND_MARGIN_PT;

  ops.push(renderer.operators(page, LEGEND_MARGIN_PT, y, LEGEND_PAGE_TITLE, LEGEND_TITLE_FONT_SIZE_PT, rgb(0.08, 0.08, 0.08)));
  y -= 16;
  if (headerLine) ops.push(renderer.operators(page, LEGEND_MARGIN_PT, y, headerLine, LEGEND_SUBHEADING_FONT_SIZE_PT, rgb(0.4, 0.42, 0.44)));
  y -= 24;

  const { leftWidth } = planLegendColumns(LEGEND_PAGE_WIDTH_PT - LEGEND_MARGIN_PT * 2, LEGEND_COLUMN_GAP_PT, hasRealizationColumn);
  const leftX = LEGEND_MARGIN_PT;
  const rightX = leftX + leftWidth + LEGEND_COLUMN_GAP_PT;
  const bodyTopY = y;

  ops.push(renderer.operators(page, leftX, y, "LEGENDA:", LEGEND_SUBHEADING_FONT_SIZE_PT, rgb(0.08, 0.08, 0.08)));
  let leftY = y - LEGEND_ROW_HEIGHT_PT;
  if (legend.length === 0) {
    ops.push(renderer.operators(page, leftX, leftY, "Žádné technické značky v tomto exportu.", LEGEND_TEXT_FONT_SIZE_PT, rgb(0.55, 0.57, 0.58)));
  } else {
    for (const entry of legend) {
      ops.push(fillCircleOperators(leftX + LEGEND_SYMBOL_COLUMN_WIDTH_PT / 2 - 2, leftY + LEGEND_TEXT_FONT_SIZE_PT * 0.35, LEGEND_SWATCH_RADIUS_PT, hexToRgbFraction(entry.color)));
      ops.push(renderer.operators(page, leftX + LEGEND_SYMBOL_COLUMN_WIDTH_PT, leftY, entry.legendLabel, LEGEND_TEXT_FONT_SIZE_PT, rgb(0.1, 0.1, 0.1)));
      leftY -= LEGEND_ROW_HEIGHT_PT;
    }
  }

  if (hasRealizationColumn) {
    let rightY = bodyTopY;
    ops.push(renderer.operators(page, rightX, rightY, "REALIZACE:", LEGEND_SUBHEADING_FONT_SIZE_PT, rgb(0.08, 0.08, 0.08)));
    rightY -= LEGEND_ROW_HEIGHT_PT;
    for (const group of usedRealizationGroups) {
      const lineY = rightY + LEGEND_TEXT_FONT_SIZE_PT * 0.3;
      ops.push(strokeLineOperators(rightX, lineY, rightX + LEGEND_REALIZATION_SWATCH_WIDTH_PT, lineY, REALIZATION_UNDERLINE_THICKNESS_PT, hexToRgbFraction(group.color)));
      ops.push(renderer.operators(page, rightX + LEGEND_SYMBOL_COLUMN_WIDTH_PT, rightY, group.label, LEGEND_TEXT_FONT_SIZE_PT, rgb(0.1, 0.1, 0.1)));
      rightY -= LEGEND_ROW_HEIGHT_PT;
    }
  }
  ops.flush(page);
}

// ============================================================================
// In-place legend (corrective batch section 7, "source-legend-area") — covers a user-defined (or the
// hall-agnostic automatic default) region of the copied source page with a plain white vector
// rectangle (opacity 1.0, no stroke) and draws a compact category legend (left) + realization key
// (right) inside it. The source page's own size/MediaBox/CropBox is never touched.
//
// OVERFLOW SAFETY: `planInPlaceLegendLayout` decides BEFORE anything is drawn whether the legend fits
// the region at one of a few modest scales. If none fits, nothing is drawn (no white box, no partial
// text) and the caller falls back to the separate legend page.
// ============================================================================

const IN_PLACE_LEGEND_MARGIN_PT = 4;
const IN_PLACE_LEGEND_ROW_HEIGHT_PT = 8;
const IN_PLACE_LEGEND_FONT_SIZE_PT = 5;
const IN_PLACE_LEGEND_HEADING_FONT_SIZE_PT = 6;
/** Width of the color-swatch column before each description. */
const IN_PLACE_LEGEND_SYMBOL_COLUMN_WIDTH_PT = 8;
const IN_PLACE_LEGEND_COLUMN_GAP_PT = 10;
const IN_PLACE_LEGEND_SWATCH_RADIUS_PT = 1.6;
/** The smallest scale a size reduction is allowed to shrink to (spec: "no microscopic text") — a 30% reduction, never more. */
const IN_PLACE_LEGEND_MIN_SCALE = 0.7;
const IN_PLACE_LEGEND_SCALE_STEPS: readonly number[] = [1, 0.85, IN_PLACE_LEGEND_MIN_SCALE];

type InPlaceLegendPlan = Readonly<{
  rowHeight: number;
  headingFontSize: number;
  textFontSize: number;
  swatchRadius: number;
  symbolColumnWidth: number;
  columnGap: number;
  leftWidth: number;
  rightWidth: number;
  hasRealizationColumn: boolean;
}>;

function computeInPlaceLegendPlanAt(
  scale: number,
  box: Readonly<{ width: number; height: number }>,
  legend: readonly TechnicalRasterExportLegendEntry[],
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
  renderer: ExportTextRenderer,
): InPlaceLegendPlan | undefined {
  const margin = IN_PLACE_LEGEND_MARGIN_PT;
  const rowHeight = IN_PLACE_LEGEND_ROW_HEIGHT_PT * scale;
  const headingFontSize = IN_PLACE_LEGEND_HEADING_FONT_SIZE_PT * scale;
  const textFontSize = IN_PLACE_LEGEND_FONT_SIZE_PT * scale;
  const symbolColumnWidth = IN_PLACE_LEGEND_SYMBOL_COLUMN_WIDTH_PT * scale;
  const columnGap = IN_PLACE_LEGEND_COLUMN_GAP_PT * scale;
  const hasRealizationColumn = usedRealizationGroups.length > 0;
  const availableWidth = box.width - margin * 2;
  const { leftWidth, rightWidth } = planLegendColumns(availableWidth, columnGap, hasRealizationColumn);
  const leftDescriptionWidth = leftWidth - symbolColumnWidth;
  const rightDescriptionWidth = rightWidth - symbolColumnWidth;
  if (leftDescriptionWidth <= 0 || (hasRealizationColumn && rightDescriptionWidth <= 0)) return undefined;

  // Side by side, never stacked — required height is the TALLER side's own row count.
  const leftRows = 1 + legend.length;
  const rightRows = hasRealizationColumn ? 1 + usedRealizationGroups.length : 0;
  const requiredHeight = Math.max(leftRows, rightRows) * rowHeight + margin * 2;
  if (requiredHeight > box.height) return undefined;

  for (const entry of legend) {
    if (renderer.measure(entry.legendLabel, textFontSize) > leftDescriptionWidth) return undefined;
  }
  for (const group of usedRealizationGroups) {
    if (renderer.measure(group.label, textFontSize) > rightDescriptionWidth) return undefined;
  }

  return { rowHeight, headingFontSize, textFontSize, swatchRadius: IN_PLACE_LEGEND_SWATCH_RADIUS_PT * scale, symbolColumnWidth, columnGap, leftWidth, rightWidth, hasRealizationColumn };
}

/** `undefined` = the region cannot hold this legend at any attempted scale — the caller must use the separate legend page instead. */
function planInPlaceLegendLayout(
  box: Readonly<{ width: number; height: number }>,
  legend: readonly TechnicalRasterExportLegendEntry[],
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
  renderer: ExportTextRenderer,
): InPlaceLegendPlan | undefined {
  for (const scale of IN_PLACE_LEGEND_SCALE_STEPS) {
    const plan = computeInPlaceLegendPlanAt(scale, box, legend, usedRealizationGroups, renderer);
    if (plan) return plan;
  }
  return undefined;
}

function inPlaceLegendOperators(
  page: PDFPage,
  box: Readonly<{ x: number; y: number; width: number; height: number }>,
  plan: InPlaceLegendPlan,
  legend: readonly TechnicalRasterExportLegendEntry[],
  usedRealizationGroups: readonly TechnicalRealizationGroupInfo[],
  renderer: ExportTextRenderer,
): string {
  const parts: string[] = [];
  // 1. Opaque white cover — solid fill, no stroke, no ExtGState (independent of "Krytí bílé").
  parts.push(fillRectOperators(box.x, box.y, box.width, box.height, rgb(1, 1, 1)));
  const margin = IN_PLACE_LEGEND_MARGIN_PT;
  const leftX = box.x + margin;
  const rightX = leftX + plan.leftWidth + plan.columnGap;
  const topY = box.y + box.height - margin - plan.headingFontSize;

  // 2. Technical categories — LEFT column: heading, then "● CATEGORY" rows.
  parts.push(renderer.operators(page, leftX, topY, "LEGENDA:", plan.headingFontSize, rgb(0.08, 0.08, 0.08)));
  let leftY = topY - plan.rowHeight;
  for (const entry of legend) {
    parts.push(fillCircleOperators(leftX + plan.swatchRadius, leftY + plan.textFontSize * 0.35, plan.swatchRadius, hexToRgbFraction(entry.color)));
    parts.push(renderer.operators(page, leftX + plan.symbolColumnWidth, leftY, entry.legendLabel, plan.textFontSize, rgb(0.1, 0.1, 0.1)));
    leftY -= plan.rowHeight;
  }

  // 3. Realization — RIGHT column, a colored LINE swatch (the underline's own visual language).
  if (plan.hasRealizationColumn) {
    parts.push(renderer.operators(page, rightX, topY, "REALIZACE:", plan.headingFontSize, rgb(0.08, 0.08, 0.08)));
    let rightY = topY - plan.rowHeight;
    for (const group of usedRealizationGroups) {
      const lineY = rightY + plan.textFontSize * 0.3;
      parts.push(strokeLineOperators(rightX, lineY, rightX + plan.symbolColumnWidth - 2, lineY, REALIZATION_UNDERLINE_THICKNESS_PT, hexToRgbFraction(group.color)));
      parts.push(renderer.operators(page, rightX + plan.symbolColumnWidth, rightY, group.label, plan.textFontSize, rgb(0.1, 0.1, 0.1)));
      rightY -= plan.rowHeight;
    }
  }
  return parts.join("\n");
}

// ============================================================================
// One source page's overlay (HOTFIX-02, phase 6) — the two generator layers:
//
//   ABF – TECHNICKÉ ZNAČKY — the generator's OWN layer for EVERY automatic and manual technical
//     element: service labels, "BEZ elektriky", manual dots/crosses/lines and their VISIBLE notes.
//     Created once per export, shared by every page, registered ON and appended LAST to /Order.
//     The source raster's own "TECHNICKÉ SLUŽBY" layer is never used, re-registered or switched:
//     CorelDRAW 2018 showed the source layer and our content as two layers with the SAME name, so
//     our layer has its own, distinct name (HOTFIX-02 follow-up, 30. 10. 2026).
//   GENERÁTOR DATA — the rest of the generator's additions (realization underlines, the in-place
//     legend with its white cover) — created only when there is something to put in it.
//
// Both are drawn AFTER the copied source content, so they are always on top of the raster; the
// source page's own content and layers are never modified here.
// ============================================================================

export const TECHNICAL_MARKERS_OCG_NAME = "ABF – TECHNICKÉ ZNAČKY";

/** Whether the export needed (and therefore created) its own technical layer. */
export type TechnicalServicesLayerStatus = "created" | "not_needed";

type SourcePageOverlayInput = Readonly<{
  newDoc: PDFDocument;
  page: PDFPage;
  geometry: SourcePageGeometry;
  placements: readonly TechnicalRasterExportPlacementItem[];
  realizationUnderlines: readonly TechnicalRasterExportRealizationUnderlineItem[];
  noElectricityMarkers: readonly TechnicalRasterExportNoElectricityMarkerItem[];
  manualDrawings: readonly TechnicalRasterExportDrawingItem[];
  /** Set only when the in-place legend targets THIS page. */
  inPlaceLegend?: Readonly<{ box: Readonly<{ x: number; y: number; width: number; height: number }>; legend: readonly TechnicalRasterExportLegendEntry[]; usedRealizationGroups: readonly TechnicalRealizationGroupInfo[] }>;
  renderer: ExportTextRenderer;
  /** Our own technical layer, once an earlier page created it (shared across the whole export). */
  technicalLayerRef: PDFRef | undefined;
  generatorDataRef: PDFRef | undefined;
}>;

type SourcePageOverlayResult = Readonly<{
  technicalLayerRef: PDFRef | undefined;
  generatorDataRef: PDFRef | undefined;
  skippedInvalidPlacementCount: number;
  inPlaceLegendDrawn: boolean;
}>;

function drawSourcePageOverlay(input: SourcePageOverlayInput): SourcePageOverlayResult {
  const { newDoc, page, geometry, renderer } = input;
  const technical = new OverlayBuffer();
  let skippedInvalidPlacementCount = 0;
  for (const item of input.placements) {
    if (!isValidNormalizedCoordinate(item.xNormalized) || !isValidNormalizedCoordinate(item.yNormalized)) {
      skippedInvalidPlacementCount += 1;
      continue;
    }
    const raw = normalizedDisplayPointToRawPdfPoint(item.xNormalized, item.yNormalized, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
    technical.push(placementSymbolOperators(page, raw.x, raw.y, item, renderer));
  }
  for (const marker of input.noElectricityMarkers) {
    if (!isValidNormalizedCoordinate(marker.xNormalized) || !isValidNormalizedCoordinate(marker.yNormalized)) continue;
    technical.push(noElectricityMarkerOperators(marker, geometry));
  }
  for (const drawing of input.manualDrawings) {
    if (!isValidDrawingItem(drawing)) continue;
    technical.push(manualDrawingOperators(page, drawing, geometry, renderer));
  }

  const generator = new OverlayBuffer();
  for (const underline of input.realizationUnderlines) {
    if (!isValidNormalizedCoordinate(underline.xNormalized) || !isValidNormalizedCoordinate(underline.yNormalized)) continue;
    if (!isValidNormalizedCoordinate(underline.xNormalized + underline.widthNormalized)) continue;
    generator.push(realizationUnderlineOperators(underline, geometry));
  }
  let inPlaceLegendDrawn = false;
  if (input.inPlaceLegend) {
    const plan = planInPlaceLegendLayout(input.inPlaceLegend.box, input.inPlaceLegend.legend, input.inPlaceLegend.usedRealizationGroups, renderer);
    if (plan) {
      generator.push(inPlaceLegendOperators(page, input.inPlaceLegend.box, plan, input.inPlaceLegend.legend, input.inPlaceLegend.usedRealizationGroups, renderer));
      inPlaceLegendDrawn = true;
    }
  }

  // Our technical layer first, GENERÁTOR DATA on top (the in-place legend's white cover must stay
  // readable even where a marker happens to sit inside its region — same stacking as before).
  // ensureOverlayOcg creates the layer once (reusing the shared ref on later pages) and registers it
  // in /OCGs, /D/ON and at the END of /D/Order — never touching any source layer.
  let technicalLayerRef = input.technicalLayerRef;
  if (!technical.isEmpty) {
    const layer = ensureOverlayOcg(newDoc, page, technicalLayerRef, TECHNICAL_MARKERS_OCG_NAME, "AbfTechnicalMarkers");
    technicalLayerRef = layer.ref;
    appendRawContentChunk(newDoc.context, page, `/OC /${layer.propertyName} BDC`);
    technical.flush(page);
    appendRawContentChunk(newDoc.context, page, "EMC");
  } else if (technicalLayerRef) {
    // Re-register after this page's own OCProperties rebuild (see reconstructOcProperties).
    appendGeneratorDataOcgToCatalog(newDoc, technicalLayerRef);
  }

  let generatorDataRef = input.generatorDataRef;
  if (!generator.isEmpty) {
    const generatorDataOcg = ensureGeneratorDataOcg(newDoc, page, generatorDataRef);
    generatorDataRef = generatorDataOcg.ref;
    appendRawContentChunk(newDoc.context, page, `/OC /${generatorDataOcg.propertyName} BDC`);
    generator.flush(page);
    appendRawContentChunk(newDoc.context, page, "EMC");
  } else if (generatorDataRef) {
    appendGeneratorDataOcgToCatalog(newDoc, generatorDataRef);
  }

  return { technicalLayerRef, generatorDataRef, skippedInvalidPlacementCount, inPlaceLegendDrawn };
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
  /** "Pracovní — bílé" for the export (corrective batch section 4) — omitted exports with the source's ORIGINAL vector colors untouched. `opacity` is the same 0-1 "Krytí bílé" fraction as the live editor's own project setting. */
  whiteMode?: Readonly<{ opacity: number }>;
  /** "Zahrnout realizačky do exportu" (corrective batch section 10) — every underline to draw on THIS page. */
  realizationUnderlines?: readonly TechnicalRasterExportRealizationUnderlineItem[];
  /** Whether the legend's "REALIZACE" key is included (only the groups actually used). */
  includeRealizationKey?: boolean;
  /** "Exportovat označení „BEZ elektriky“" (PRODUCTION BATCH, part B section 17/18) — every red-X marker to draw on THIS page. */
  noElectricityMarkers?: readonly TechnicalRasterExportNoElectricityMarkerItem[];
  /** PRODUCTION BATCH, part A — every source-OCG layer's own configured text scale, resolved to real OCG names. */
  textScales?: readonly TechnicalRasterExportTextScaleItem[];
  /** Corrective batch section 7 — WHERE the legend is drawn. Omitted resolves to "separate-page". */
  legendPlacement?: TechnicalLegendPlacement;
  /** The project's actual source-layer ON/OFF state -> the exported PDF's default OCG state (see reconstructOcProperties). Omitted keeps the source PDF's own defaults. */
  sourceLayerVisibility?: readonly TechnicalRasterExportSourceLayerVisibility[];
  /** Manual points/lines on THIS page (domain/technicalRasterDrawings.ts buildManualDrawingExportItems) — drawn in ABF – TECHNICKÉ ZNAČKY. */
  manualDrawings?: readonly TechnicalRasterExportDrawingItem[];
  /** HOTFIX-02 — "text" (default): real editable text; "outlines": the previous vector-outline labels (fallback). */
  textMode?: TechnicalRasterExportTextMode;
}>;

export type TechnicalRasterVectorExportResult = Readonly<{
  bytes: Uint8Array;
  ocgDiagnostic: OcgReconstructionResult;
  /** Placements skipped because their own xNormalized/yNormalized was outside [0,1] or non-finite — never silently clamped, never allowed to crash the export. */
  skippedInvalidPlacementCount: number;
  /** Whether/how "Pracovní — bílé" was actually applied (corrective batch section 4). */
  whiteModeDiagnostic: VectorWhiteModeDiagnostic;
  /** PRODUCTION BATCH, part A — one diagnostic per requested `input.textScales` entry. */
  textScaleDiagnostics: readonly TechnicalRasterTextScaleDiagnostic[];
  /** HOTFIX-02 — whether the export created its own "ABF – TECHNICKÉ ZNAČKY" layer ("not_needed" = nothing technical was drawn). */
  technicalLayerStatus: TechnicalServicesLayerStatus;
  textMode: TechnicalRasterExportTextMode;
}>;

/**
 * The single-page export entry point (spec batch 9). Source page copied 1:1 (no rasterization, no
 * resize/rescale) -> OCG catalog reconstructed -> "Pracovní — bílé" / text scale applied to the copied
 * page's own content stream if requested -> technical overlay in ABF – TECHNICKÉ ZNAČKY (+ GENERÁTOR DATA)
 * -> a separate legend page unless the in-place legend fits -> saved. Never mutates `sourcePdfBytes`.
 */
export async function buildTechnicalRasterVectorExportPdf(input: TechnicalRasterVectorExportInput): Promise<TechnicalRasterVectorExportResult> {
  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: input.sourcePdfBytes,
    pages: [{ page: input.page, placements: input.placements, realizationUnderlines: input.realizationUnderlines, noElectricityMarkers: input.noElectricityMarkers, manualDrawings: input.manualDrawings }],
    legend: input.legend,
    showLegend: input.showLegend,
    headerLine: input.headerLine,
    whiteMode: input.whiteMode,
    includeRealizationKey: input.includeRealizationKey,
    textScales: input.textScales,
    legendPlacement: input.legendPlacement,
    sourceLayerVisibility: input.sourceLayerVisibility,
    textMode: input.textMode,
  });
  return {
    bytes: result.bytes,
    ocgDiagnostic: result.ocgDiagnosticsByPage[0]!,
    skippedInvalidPlacementCount: result.skippedInvalidPlacementCount,
    whiteModeDiagnostic: result.whiteModeDiagnosticsByPage[0]!,
    textScaleDiagnostics: result.textScaleDiagnostics,
    technicalLayerStatus: result.technicalLayerStatus,
    textMode: result.textMode,
  };
}

// ============================================================================
// Multi-page source export (manual acceptance batch, section 38/50) — every source page copied 1:1
// in order, ONE legend page appended after the last one (or the in-place legend on its target page).
// The single-page function above is this one with one page.
// ============================================================================

export type TechnicalRasterVectorExportPageInput = Readonly<{
  /** 1-based source page number, same convention as TechnicalRasterVectorExportInput.page. */
  page: number;
  placements: readonly TechnicalRasterExportPlacementItem[];
  /** Corrective batch section 10 — every realization underline on THIS page. */
  realizationUnderlines?: readonly TechnicalRasterExportRealizationUnderlineItem[];
  /** PRODUCTION BATCH, part B section 17/18 — every "BEZ elektriky" red-X marker on THIS page. */
  noElectricityMarkers?: readonly TechnicalRasterExportNoElectricityMarkerItem[];
  /** Manual points/lines on THIS page — drawn in ABF – TECHNICKÉ ZNAČKY. */
  manualDrawings?: readonly TechnicalRasterExportDrawingItem[];
}>;

export type TechnicalRasterMultiPageVectorExportInput = Readonly<{
  sourcePdfBytes: Uint8Array;
  /** EVERY source page to include, in the order they should appear in the export. */
  pages: readonly TechnicalRasterVectorExportPageInput[];
  legend: readonly TechnicalRasterExportLegendEntry[];
  showLegend: boolean;
  headerLine: string;
  /** Same "Pracovní — bílé" request as the single-page function's own `whiteMode` — applied independently to EVERY exported source page. */
  whiteMode?: Readonly<{ opacity: number }>;
  /** Whether the legend's "REALIZACE" key is included — computed over the WHOLE export. */
  includeRealizationKey?: boolean;
  /** PRODUCTION BATCH, part A — applied independently to EVERY exported source page. */
  textScales?: readonly TechnicalRasterExportTextScaleItem[];
  /** Corrective batch section 7 — WHERE the legend is drawn. Omitted resolves to "separate-page". */
  legendPlacement?: TechnicalLegendPlacement;
  /** Same as the single-page input's `sourceLayerVisibility` — applied to every exported page's OCG reconstruction. */
  sourceLayerVisibility?: readonly TechnicalRasterExportSourceLayerVisibility[];
  /** HOTFIX-02 — "text" (default) or "outlines" (fallback), see TechnicalRasterExportTextMode. */
  textMode?: TechnicalRasterExportTextMode;
}>;

export type TechnicalRasterMultiPageVectorExportResult = Readonly<{
  bytes: Uint8Array;
  /** One OCG diagnostic per exported source page, in the same order as `input.pages`. */
  ocgDiagnosticsByPage: readonly OcgReconstructionResult[];
  skippedInvalidPlacementCount: number;
  /** 1-based export page number the legend landed on. */
  legendPageNumber: number;
  /** One "Pracovní — bílé" diagnostic per exported source page. */
  whiteModeDiagnosticsByPage: readonly VectorWhiteModeDiagnostic[];
  /** PRODUCTION BATCH, part A — every requested layer's own diagnostic, for every exported page. */
  textScaleDiagnostics: readonly TechnicalRasterTextScaleDiagnostic[];
  /** HOTFIX-02 — see TechnicalRasterVectorExportResult. */
  technicalLayerStatus: TechnicalServicesLayerStatus;
  textMode: TechnicalRasterExportTextMode;
}>;

export async function buildTechnicalRasterMultiPageVectorExportPdf(input: TechnicalRasterMultiPageVectorExportInput): Promise<TechnicalRasterMultiPageVectorExportResult> {
  const srcDoc = await PDFDocument.load(input.sourcePdfBytes);
  const newDoc = await PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const renderer = createExportTextRenderer(newDoc, input.textMode);

  const ocgDiagnosticsByPage: OcgReconstructionResult[] = [];
  const whiteModeDiagnosticsByPage: VectorWhiteModeDiagnostic[] = [];
  let skippedInvalidPlacementCount = 0;
  const effectiveLegendPlacement = resolveEffectiveLegendPlacement(input.legendPlacement);
  const legendToShow = input.showLegend ? input.legend : [];
  // Computed ONCE across every exported page — the realization key reflects the WHOLE export.
  const usedRealizationGroups = input.includeRealizationKey
    ? resolveUsedRealizationGroups(realizationUnderlineColors(input.pages.flatMap((pageInput) => pageInput.realizationUnderlines ?? [])))
    : [];
  let inPlaceLegendPageNumber: number | undefined;
  // ONE shared ref per generator layer across every exported page (reconstructOcProperties rebuilds
  // /OCProperties per page; the overlay re-registers both layers after each rebuild).
  let technicalLayerRef: PDFRef | undefined;
  let generatorDataRef: PDFRef | undefined;
  const textScaleDiagnostics: TechnicalRasterTextScaleDiagnostic[] = [];

  let exportPageNumber = 0;
  for (const pageInput of input.pages) {
    exportPageNumber += 1;
    const geometry = await resolveSourcePageGeometry(input.sourcePdfBytes, pageInput.page);
    const [copiedPage] = await newDoc.copyPages(srcDoc, [pageInput.page - 1]);
    newDoc.addPage(copiedPage);
    disableUnnecessaryAutoNormalizeCtm(copiedPage);
    ocgDiagnosticsByPage.push(reconstructOcProperties(srcDoc, newDoc, copiedPage, input.sourceLayerVisibility));
    // Content-stream rewriting happens BEFORE any overlay is appended, so the overlay itself is
    // never re-tokenized/whitened by these transforms.
    whiteModeDiagnosticsByPage.push(
      input.whiteMode
        ? requireVectorWhiteModeApplied(applyVectorWhiteMode(srcDoc, newDoc, copiedPage, Math.min(1, Math.max(0, input.whiteMode.opacity))), pageInput.page)
        : { status: "not_requested" },
    );
    textScaleDiagnostics.push(...requireTextScalesApplied(applyTextScalesToPage(newDoc, copiedPage, input.textScales ?? [], pageInput.page)));

    const wantsInPlaceLegend = effectiveLegendPlacement.strategy === "source-legend-area" && effectiveLegendPlacement.sourceRegion!.page === pageInput.page;
    const overlay = drawSourcePageOverlay({
      newDoc,
      page: copiedPage,
      geometry,
      placements: pageInput.placements,
      realizationUnderlines: pageInput.realizationUnderlines ?? [],
      noElectricityMarkers: pageInput.noElectricityMarkers ?? [],
      manualDrawings: pageInput.manualDrawings ?? [],
      inPlaceLegend: wantsInPlaceLegend
        ? { box: normalizedDisplayRectToRawPdfBoundingBox(effectiveLegendPlacement.sourceRegion!, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform), legend: legendToShow, usedRealizationGroups }
        : undefined,
      renderer,
      technicalLayerRef,
      generatorDataRef,
    });
    technicalLayerRef = overlay.technicalLayerRef;
    generatorDataRef = overlay.generatorDataRef;
    skippedInvalidPlacementCount += overlay.skippedInvalidPlacementCount;
    // A region that cannot hold the legend draws NOTHING here; the separate page below takes over.
    if (overlay.inPlaceLegendDrawn) inPlaceLegendPageNumber = exportPageNumber;
  }

  let legendPageNumber: number;
  if (inPlaceLegendPageNumber !== undefined) {
    legendPageNumber = inPlaceLegendPageNumber;
  } else {
    // A separate, entirely new legend PAGE — outside every layer (no source content to toggle there).
    drawLegendPage(newDoc, input.headerLine, legendToShow, renderer, usedRealizationGroups);
    legendPageNumber = newDoc.getPageCount();
  }

  renderer.finalize();
  const bytes = await newDoc.save();
  const technicalLayerStatus: TechnicalServicesLayerStatus = technicalLayerRef ? "created" : "not_needed";
  return { bytes, ocgDiagnosticsByPage, skippedInvalidPlacementCount, legendPageNumber, whiteModeDiagnosticsByPage, textScaleDiagnostics, technicalLayerStatus, textMode: renderer.mode };
}
