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
 * combination exercised here.
 */
import { computeWhiteModeArgsArray, detectStandLayerId, type WhiteModeOpCodes } from "../../domain/technicalRasterWhiteModeOperators.ts";
import type { RasterLayer } from "../../domain/technicalRaster.ts";
import type { PdfJsOptionalContentConfig, PdfJsPage, PdfJsViewport } from "./pdfDocumentLoader.ts";

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

type PatchPlanResult = Readonly<{ status: "patched"; patchedIndices: ReadonlySet<number> }> | Readonly<{ status: "unsupported"; reason: string }>;

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
      return { status: "patched", patchedIndices: new Set(result.patchedIndices) };
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
 * Builds the Proxy that forces `ctx.fillStyle` to `fillColor` for exactly the patched operator
 * indices — extracted from renderWhiteModePage below (spec batch 6, UI section 33) specifically so
 * tests/technicalRasterWhiteRender.test.ts can exercise the fill/stroke isolation directly, without
 * needing a full fake pdf.js render loop: `operatorIndexRef` is a plain mutable box a caller
 * (production code's own `operationsFilter`, or a test driving the proxy by hand) updates to say
 * "this is the operator about to run" — mirrors the exact real wiring, just given a name instead of
 * being a closure-private variable.
 */
export function createWhiteModeCanvasContextProxy(
  canvasContext: CanvasRenderingContext2D,
  patchedIndices: ReadonlySet<number>,
  fillColor: string,
  operatorIndexRef: Readonly<{ current: number }>,
): CanvasRenderingContext2D {
  return new Proxy(canvasContext, {
    // Both traps force `target` as the receiver (never the default, which would be the proxy
    // itself) — the real CanvasRenderingContext2D's accessors are native-backed and throw if
    // invoked with `this` bound to anything other than the real context (verified against
    // node-canvas; the same defensive binding is kept for the browser for the same reason).
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      // Deliberately checks property === "fillStyle" ONLY — never touches strokeStyle, never sets
      // ctx.globalAlpha (spec batch 6, UI section 24/25: a real closeEOFillStroke paint call uses
      // ONE combined fill+stroke operator, so globalAlpha would transparentize the stroke too,
      // which is forbidden). The opacity lives entirely inside this one rgba() fill string.
      if (property === "fillStyle" && patchedIndices.has(operatorIndexRef.current)) {
        return Reflect.set(target, property, fillColor, target);
      }
      return Reflect.set(target, property, value, target);
    },
  });
}

/**
 * Renders `page` into `canvasContext` with the target stand layer's fill whitened (at
 * `whiteFillOpacity`, spec batch 6) and its stroke/geometry/dash/line-width completely untouched
 * (spec section 11/17/26). `pageKey` must uniquely identify this page for caching purposes (e.g.
 * `${rasterUrl}#${pageNumber}`) — see module doc for the mechanism and its one stated assumption.
 */
export async function renderWhiteModePage(params: Readonly<{
  page: PdfJsPage;
  pageKey: string;
  standLayerId: string;
  canvasContext: CanvasRenderingContext2D;
  viewport: PdfJsViewport;
  /** Threaded straight through to pdf.js's render() — lets the layer-visibility panel (an unrelated feature, spec section 28) keep hiding/showing OTHER layers while white mode handles the stand layer's own fill. */
  optionalContentConfigPromise?: Promise<PdfJsOptionalContentConfig>;
  /** "Krytí bílé" 0-1 (spec batch 6). Defaults to DEFAULT_WHITE_FILL_OPACITY (1 = today's fully-opaque white) when omitted — never required, so no existing caller/test needs to change. */
  whiteFillOpacity?: number;
}>): Promise<WhiteModeRenderResult> {
  const { page, pageKey, standLayerId, canvasContext, viewport, optionalContentConfigPromise, whiteFillOpacity } = params;
  const plan = await getOrComputePatchPlan(page, pageKey, standLayerId);
  if (plan.status === "unsupported") return plan;

  const fillColor = resolveWhiteFillColor(whiteFillOpacity);
  const operatorIndexRef = { current: -1 };
  const proxiedContext = createWhiteModeCanvasContextProxy(canvasContext, plan.patchedIndices, fillColor, operatorIndexRef);

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

  return { status: "rendered" };
}

/** Drops cached patch plans for a page — call when the raster's own source PDF is replaced by a new upload, never on an ordinary Original/White toggle or zoom/pan (those must stay cheap, spec section 22). */
export function clearWhiteModePatchPlanCache(pageKey: string): void {
  for (const key of [...patchPlanCache.keys()]) {
    if (key.startsWith(`${pageKey}::`)) patchPlanCache.delete(key);
  }
}
