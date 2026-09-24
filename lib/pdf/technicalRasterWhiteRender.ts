"use client";

/**
 * Technické rastry — "pracovní bílý režim" (spec batch 2, section 10-19). Real-PDF evidence
 * (Hala 1.pdf) proved the naive approach — hiding the whole "STÁNKY ***" Optional Content layer —
 * is unacceptable: every stand there is drawn with ONE combined path-paint operator
 * (`closeEOFillStroke`), so hiding the layer removes the outline along with the fill. This module
 * instead whitens ONLY the fill color feeding that same paint call, leaving the stroke (and all
 * geometry) untouched — see domain/technicalRasterWhiteModeOperators.ts for the pure algorithm
 * that decides WHICH operator to whiten.
 *
 * THIS IS THE ONE FILE in the app that goes slightly past pdf.js's officially published .d.ts
 * surface (spec section 14: "izoluj závislost do jednoho jasného adapteru/modulu"). What's used,
 * and why it's safe, in order of "how public is it":
 *
 *  1. `page.getOperatorList()` — fully public, documented, typed (pdfjs-dist's own
 *     `types/src/display/api.d.ts`). Used here PURELY for read-only analysis: which fill-color-
 *     setter operator indices need whitening. This app NEVER mutates what it returns.
 *  2. `page.render({..., operationsFilter})` — `operationsFilter` IS present, typed, and
 *     documented in pdfjs-dist's own `RenderParameters`/`OperationsFilter` types (verified by
 *     reading `types/src/display/api.d.ts` directly for this exact pinned version, 6.3.289) — it
 *     is NOT missing from the public contract, just easy to miss because the top-level `.d.mts`
 *     re-export file doesn't show individual members. This app uses it ONLY as a read-only
 *     "which operator index is about to run" signal (the callback always returns `true` — it
 *     never skips an operation), never to alter pdf.js's own execution.
 *  3. A plain JavaScript `Proxy` wrapping the ordinary `CanvasRenderingContext2D` passed to
 *     `render()` — standard browser API, not a pdf.js API at all. Its only custom behavior: when
 *     pdf.js's own `setFillRGBColor` handler (confirmed, by reading pdf.js's source for this
 *     pinned version, to assign `ctx.fillStyle` synchronously within its own operator's turn —
 *     see this file's tests) assigns a color while `operationsFilter` has just reported one of
 *     the pre-analyzed fill-setter indices, the color actually written is forced to white; every
 *     other property access/assignment passes through untouched.
 *
 * No internal pdf.js class (CanvasGraphics, InternalRenderTask, ...) is imported anywhere. If a
 * future pdfjs-dist upgrade changes `operationsFilter`'s behavior or removes it, THIS is the one
 * file to revisit — everything else in the app only ever calls `loadPdfDocument`/`listPdfLayers`/
 * `renderWhiteModePage`, never pdf.js itself.
 *
 * One assumption this relies on, stated plainly: the operator index `operationsFilter` reports
 * during `render()` corresponds 1:1, in the same order, to the `fnArray`/`argsArray` a separate
 * `getOperatorList()` call returns for the same page. Both ultimately parse the exact same static
 * PDF content stream, so this holds for any content-only difference; it has NOT been re-verified
 * against every possible `intent`/`annotationMode` combination — this app always requests the
 * same (`intent: "display"`, default annotationMode) for both calls, which is the only
 * combination exercised here. This part of the mechanism was NEVER the bug (confirmed empirically,
 * see the corrective batch below) — the index really is continuous and correct across Form-
 * flattened content.
 *
 * CORRECTIVE BATCH (editor-only white mode) — real manual acceptance found Hala 3 (a raster whose
 * every stand fill lives inside a Form XObject, see domain/technicalRasterVectorWhiteMode.ts's own
 * doc for the export-side story) stays FULLY COLORED in the editor even though the fill-color-
 * setter indices are computed correctly. Root cause, confirmed empirically (not guessed — see
 * scripts/technicalRasterEditorWhiteModeRealDiagnostic.ts, which runs the REAL production
 * mechanism against the REAL fixture and proves this directly): every one of Hala 3's Form
 * XObjects declares its own `/Group /S /Transparency`, and pdf.js's OWN CanvasGraphics#beginGroup
 * responds to that by creating a BRAND NEW, temporary OFFSCREEN canvas (via `canvasFactory.create()`)
 * and painting the Form's entire content onto THAT context instead of the one originally passed to
 * `page.render()` — only compositing the result back onto the real canvas afterward. The Proxy
 * this module builds (`createWhiteModeCanvasContextProxy`, now in ./pdfWhiteModeCanvasProxy.ts)
 * only ever wrapped that ONE top-level context — so every `ctx.fillStyle = ...` a Form's own fill
 * makes lands on the real, UNWRAPPED offscreen context and is never forced white at all. Hala 1 has
 * zero Form XObjects (confirmed by the same diagnostic: 0 `paintFormXObjectBegin`), so it never
 * exercises this path — matching the real symptom exactly (H1 fine, H3 stays colored).
 *
 * Fix: lib/pdf/pdfDocumentLoader.ts's `WhiteModeAwareCanvasFactory` wraps EVERY canvas pdf.js
 * creates internally (not just the one top-level canvas this module already wraps) with the SAME
 * fillStyle-forcing Proxy, driven by one shared "active session" (`patchedIndices`/`fillColor`/
 * `operatorIndexRef`) that `renderWhiteModePage` below installs on the OWNING `PdfJsDocument`
 * immediately before `page.render()` and clears immediately after. Since `operatorIndexRef` is a
 * single continuous index across the WHOLE flattened operator list regardless of which physical
 * canvas ends up painting it, wrapping every canvas this way can never whiten anything outside the
 * pre-computed `patchedIndices` — it only ever closes the gap between "the mutation was computed"
 * and "the mutation reached the context that actually paints it".
 */
import { computeWhiteModeArgsArray, detectStandLayerId, type WhiteModeOpCodes } from "../../domain/technicalRasterWhiteModeOperators.ts";
import { computeTextScalePatchIndices, type TextScaleOpCodes } from "../../domain/technicalRasterTextScaleOperators.ts";
import type { RasterLayer } from "../../domain/technicalRaster.ts";
import type { PdfJsDocument, PdfJsOptionalContentConfig, PdfJsPage, PdfJsViewport } from "./pdfDocumentLoader.ts";
import { createWhiteModeCanvasContextProxy } from "./pdfWhiteModeCanvasProxy.ts";

// Re-exported so every existing import of `createWhiteModeCanvasContextProxy` from THIS module
// (production and tests/technicalRasterWhiteRender.test.ts alike) keeps working unchanged — the
// actual implementation now lives in pdfWhiteModeCanvasProxy.ts (see that module's own doc for why:
// pdfDocumentLoader.ts's WhiteModeAwareCanvasFactory needs it too, and importing it from here would
// create a circular dependency).
export { createWhiteModeCanvasContextProxy };

export type WhiteModeAvailability =
  | Readonly<{ status: "available"; standLayerId: string }>
  | Readonly<{ status: "unavailable"; reason: string }>;

/**
 * Whether white mode can be safely offered at all for this raster's own detected layers (spec
 * section 15/16/19). A missing OR ambiguous stand layer disables the feature with an explanatory
 * message — never a best-effort guess at which layer to repaint.
 */
export function resolveWhiteModeAvailability(layers: readonly RasterLayer[]): WhiteModeAvailability {
  const detection = detectStandLayerId(layers);
  if (detection.status === "found") return { status: "available", standLayerId: detection.layerId };
  if (detection.status === "ambiguous") {
    return { status: "unavailable", reason: "Ve zdrojovém PDF bylo nalezeno více vrstev, které by mohly odpovídat stánkům — nelze jednoznačně určit, kterou přebarvit." };
  }
  return { status: "unavailable", reason: "U tohoto PDF nelze bezpečně změnit pouze výplně stánků (vrstva stánků nebyla nalezena)." };
}

let opCodesPromise: Promise<WhiteModeOpCodes> | undefined;

/** setFillColorN (pattern/shading fills) is deliberately EXCLUDED from fillColorSetters and placed in unsupportedFillOps instead — reading pdf.js's own source shows it resolves to a Pattern/TilingPattern object, not a plain CSS color string assigned synchronously like setFillRGBColor, so this app's "force ctx.fillStyle to white" trick would not reliably apply to it. */
async function getWhiteModeOpCodes(): Promise<WhiteModeOpCodes> {
  opCodesPromise ??= import("pdfjs-dist").then((pdfjsModule) => {
    const OPS = (pdfjsModule as unknown as { OPS: Record<string, number> }).OPS;
    return {
      beginMarkedContentProps: OPS.beginMarkedContentProps,
      beginMarkedContent: OPS.beginMarkedContent,
      endMarkedContent: OPS.endMarkedContent,
      constructPath: OPS.constructPath,
      rawFillPath: OPS.rawFillPath,
      fillPaintTypes: new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]),
      fillColorSetters: new Set([OPS.setFillRGBColor, OPS.setFillGray, OPS.setFillCMYKColor, OPS.setFillColor]),
      // CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill) — see
      // WhiteModeOpCodes.setGState's own doc for why this is needed at all.
      setGState: OPS.setGState,
      unsupportedFillOps: new Set([
        OPS.setFillColorN,
        OPS.shadingFill,
        OPS.paintImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintImageMaskXObjectRepeat,
        OPS.paintSolidColorImageMask,
      ]),
    } satisfies WhiteModeOpCodes;
  });
  return opCodesPromise;
}

type PatchPlanResult =
  | Readonly<{ status: "patched"; patchedIndices: ReadonlySet<number>; neutralizeAlphaIndices: ReadonlySet<number> }>
  | Readonly<{ status: "unsupported"; reason: string }>;

// ============================================================================
// PRODUCTION BATCH (per-source-OCG-layer text-size reduction, part A) — the LIVE EDITOR side of
// "text and export must match" (spec section 6). Mirrors the white-mode patch-plan machinery above
// exactly: one operator-list read per (pageKey, layerId), cached, never recomputed on every zoom/pan
// tick. Unlike white mode (a single target layer at a time), MULTIPLE text-scale layers can be
// active on the same page simultaneously — each is computed independently and merged into ONE
// `fontScaleByIndex` map, since two different OCGs' own marked-content spans never overlap.
// ============================================================================

let textScaleOpCodesPromise: Promise<TextScaleOpCodes> | undefined;

async function getTextScaleOpCodes(): Promise<TextScaleOpCodes> {
  textScaleOpCodesPromise ??= import("pdfjs-dist").then((pdfjsModule) => {
    const OPS = (pdfjsModule as unknown as { OPS: Record<string, number> }).OPS;
    return {
      beginMarkedContentProps: OPS.beginMarkedContentProps,
      beginMarkedContent: OPS.beginMarkedContent,
      endMarkedContent: OPS.endMarkedContent,
      setFont: OPS.setFont,
    } satisfies TextScaleOpCodes;
  });
  return textScaleOpCodesPromise;
}

export type TextScaleLayerConfig = Readonly<{ layerId: string; scale: number }>;

type TextScalePlanResult = Readonly<{
  fontScaleByIndex: ReadonlyMap<number, number>;
  /** Every configured layer whose own patch plan came back "unsupported" for this page (e.g. the layer's own text no longer matches, or a Do was reached inside its scope) — the caller surfaces this via `onTextScaleUnsupported`, never throws (spec section 6's own "editor degrades gracefully, export blocks" asymmetry, same as white mode's own established precedent). */
  unsupportedLayers: readonly Readonly<{ layerId: string; reason: string }>[];
}>;

const textScalePlanCache = new Map<string, Promise<TextScalePlanResult>>();

async function getOrComputeTextScalePlan(page: PdfJsPage, pageKey: string, layers: readonly TextScaleLayerConfig[]): Promise<TextScalePlanResult> {
  if (layers.length === 0) return { fontScaleByIndex: new Map(), unsupportedLayers: [] };
  const key = `${pageKey}::textscale::${[...layers].map((l) => `${l.layerId}=${l.scale}`).sort().join(",")}`;
  let cached = textScalePlanCache.get(key);
  if (!cached) {
    cached = (async (): Promise<TextScalePlanResult> => {
      const operatorList = await page.getOperatorList({ intent: "display" });
      const opCodes = await getTextScaleOpCodes();
      const fontScaleByIndex = new Map<number, number>();
      const unsupportedLayers: { layerId: string; reason: string }[] = [];
      for (const layer of layers) {
        const result = computeTextScalePatchIndices(operatorList, layer.layerId, opCodes);
        if (result.status === "unsupported") {
          unsupportedLayers.push({ layerId: layer.layerId, reason: result.reason });
          continue;
        }
        for (const index of result.patchedIndices) fontScaleByIndex.set(index, layer.scale);
      }
      return { fontScaleByIndex, unsupportedLayers };
    })();
    textScalePlanCache.set(key, cached);
  }
  return cached;
}

/** Drops cached text-scale plans for a page — same "call only when the source PDF changes" discipline as clearWhiteModePatchPlanCache. */
export function clearTextScalePlanCache(pageKey: string): void {
  for (const key of [...textScalePlanCache.keys()]) {
    if (key.startsWith(`${pageKey}::textscale::`)) textScalePlanCache.delete(key);
  }
}

/** Cached per (pageKey, standLayerId) — computing the plan means one getOperatorList() read plus one linear scan, never repeated on every toggle/zoom/pan (spec section 22). */
const patchPlanCache = new Map<string, Promise<PatchPlanResult>>();

async function getOrComputePatchPlan(page: PdfJsPage, pageKey: string, standLayerId: string): Promise<PatchPlanResult> {
  const key = `${pageKey}::${standLayerId}`;
  let cached = patchPlanCache.get(key);
  if (!cached) {
    cached = (async (): Promise<PatchPlanResult> => {
      const operatorList = await page.getOperatorList({ intent: "display" });
      const opCodes = await getWhiteModeOpCodes();
      const result = computeWhiteModeArgsArray(operatorList, standLayerId, opCodes);
      if (result.status === "unsupported") return { status: "unsupported", reason: result.reason };
      return {
        status: "patched",
        patchedIndices: new Set(result.patchedIndices),
        neutralizeAlphaIndices: new Set(result.sourceGsIndicesInsideTarget),
      };
    })();
    patchPlanCache.set(key, cached);
  }
  return cached;
}

export type WhiteModeRenderResult = Readonly<{ status: "rendered" }> | Readonly<{ status: "unsupported"; reason: string }>;

/** "Pracovní – bílé" defaults to fully-opaque white for any project whose settings predate this field (spec batch 6, UI section 19/23: "Necrashnout... nemusí se dělat datová migrace"). */
export const DEFAULT_WHITE_FILL_OPACITY = 1;

/**
 * The ONLY place white-mode's fill color string is computed (spec batch 6, UI section 17-28) —
 * pure and framework-free specifically so it's directly unit-testable without pdf.js/canvas at
 * all. `opacity` is "Krytí bílé" as a 0-1 fraction (1 = today's original fully-opaque white, 0 =
 * fully transparent fill); clamped defensively since it ultimately comes from project-settings
 * JSON that could in principle hold an out-of-range or missing value. This is used ONLY for the
 * fill color the Proxy below assigns to `ctx.fillStyle` — `ctx.strokeStyle` is never touched by
 * this function or anything derived from it (see the module doc's own "stroke stays original,
 * spec 11/17/26" guarantee, which this deliberately does not change).
 */
export function resolveWhiteFillColor(opacity: number = DEFAULT_WHITE_FILL_OPACITY): string {
  const clamped = Math.min(1, Math.max(0, opacity));
  return `rgba(255, 255, 255, ${clamped})`;
}

/**
 * Renders `page` into `canvasContext` with the target stand layer's fill whitened (at
 * `whiteFillOpacity`, spec batch 6) and its stroke/geometry/dash/line-width completely untouched
 * (spec section 11/17/26). `pageKey` must uniquely identify this page for caching purposes (e.g.
 * `${rasterUrl}#${pageNumber}`) — see module doc for the mechanism and its one stated assumption.
 *
 * CORRECTIVE BATCH (editor-only white mode) — `document` (the OWNING `PdfJsDocument`, optional
 * only so existing tests/fakes that predate this batch keep compiling) is used to install the
 * SAME `patchedIndices`/`fillColor`/`operatorIndexRef` this function already builds onto that
 * document's own canvas factory (`setWhiteModeCanvasSession`, see pdfDocumentLoader.ts) for the
 * duration of this ONE `page.render()` call — so a Form XObject's own transparency-group offscreen
 * canvas gets the identical fillStyle-forcing treatment the top-level canvas already got, closing
 * the gap that left Hala 3 fully colored (see this module's own doc for the full root-cause). The
 * session is always cleared in `finally`, so a later ordinary (non-white-mode) render on the same
 * document is never affected by a stale session.
 */
export async function renderWhiteModePage(params: Readonly<{
  page: PdfJsPage;
  pageKey: string;
  /** Omitted entirely means "white mode not requested for this render" (PRODUCTION BATCH, part A) — this function can then still be used purely to drive `textScaleLayers` below, with zero fillStyle/globalAlpha interception. */
  standLayerId?: string;
  canvasContext: CanvasRenderingContext2D;
  viewport: PdfJsViewport;
  /** Threaded straight through to pdf.js's render() — lets the layer-visibility panel (an unrelated feature, spec section 28) keep hiding/showing OTHER layers while white mode handles the stand layer's own fill. */
  optionalContentConfigPromise?: Promise<PdfJsOptionalContentConfig>;
  /** "Krytí bílé" 0-1 (spec batch 6). Defaults to DEFAULT_WHITE_FILL_OPACITY (1 = today's fully-opaque white) when omitted — never required, so no existing caller/test needs to change. */
  whiteFillOpacity?: number;
  /** The `PdfJsDocument` `page` was obtained from — needed to reach its own canvas factory's `setWhiteModeCanvasSession` (see this function's own doc). Optional so every pre-existing test/fake that only ever exercised the top-level-canvas mechanism keeps working unchanged; a real production call site always passes it. */
  document?: PdfJsDocument;
  /** PRODUCTION BATCH, part A — every source layer configured with a text scale != 100% (spec section 2/6: "editor and export must match"). Independent of `standLayerId`/white mode — both can be active on the same render. */
  textScaleLayers?: readonly TextScaleLayerConfig[];
  /** Called once per configured `textScaleLayers` entry that couldn't be safely scaled on this page (spec section 6's own editor/export asymmetry — the editor degrades gracefully with an explanation, never blocks the whole render; a real EXPORT for the same layer instead throws, see lib/technicalRasterVectorPdf.ts). Never called for white mode's own unsupported case, which already has its own return-value contract below. */
  onTextScaleUnsupported?: (layerId: string, reason: string) => void;
}>): Promise<WhiteModeRenderResult> {
  const { page, pageKey, standLayerId, canvasContext, viewport, optionalContentConfigPromise, whiteFillOpacity, document, textScaleLayers, onTextScaleUnsupported } = params;
  const plan = standLayerId
    ? await getOrComputePatchPlan(page, pageKey, standLayerId)
    : ({ status: "patched", patchedIndices: new Set<number>(), neutralizeAlphaIndices: new Set<number>() } as const);
  if (plan.status === "unsupported") return plan;

  const textScalePlan = await getOrComputeTextScalePlan(page, pageKey, textScaleLayers ?? []);
  for (const failure of textScalePlan.unsupportedLayers) onTextScaleUnsupported?.(failure.layerId, failure.reason);

  const fillColor = resolveWhiteFillColor(whiteFillOpacity);
  const operatorIndexRef = { current: -1 };
  const proxiedContext = createWhiteModeCanvasContextProxy(canvasContext, plan.patchedIndices, fillColor, operatorIndexRef, plan.neutralizeAlphaIndices, textScalePlan.fontScaleByIndex);

  document?.setWhiteModeCanvasSession?.({
    patchedIndices: plan.patchedIndices,
    fillColor,
    operatorIndexRef,
    neutralizeAlphaIndices: plan.neutralizeAlphaIndices,
    fontScaleByIndex: textScalePlan.fontScaleByIndex,
  });
  try {
    await page.render({
      canvasContext: proxiedContext,
      // pdf.js's own render() defaults `canvas = canvasContext.canvas` and, when `canvas` is
      // truthy, DISCARDS the passed canvasContext entirely in favor of re-deriving a fresh, UNWRAPPED
      // 2D context from that canvas (verified by reading pdfjs-dist's source for this pinned
      // version) — silently defeating this whole mechanism. Explicitly passing `canvas: null` (not
      // `undefined`, which would still trigger that default) keeps our proxied context in use.
      canvas: null,
      viewport,
      intent: "display",
      optionalContentConfigPromise,
      operationsFilter: (index) => {
        operatorIndexRef.current = index;
        return true;
      },
    }).promise;
  } finally {
    document?.setWhiteModeCanvasSession?.(undefined);
  }

  return { status: "rendered" };
}

/** Drops cached patch plans for a page — call when the raster's own source PDF is replaced by a new upload, never on an ordinary Original/White toggle or zoom/pan (those must stay cheap, spec section 22). */
export function clearWhiteModePatchPlanCache(pageKey: string): void {
  for (const key of [...patchPlanCache.keys()]) {
    if (key.startsWith(`${pageKey}::`)) patchPlanCache.delete(key);
  }
}
