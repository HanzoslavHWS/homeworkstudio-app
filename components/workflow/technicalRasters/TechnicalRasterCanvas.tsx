"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useBoothViewport } from "../../../hooks/useBoothViewport";
import { loadPdfDocument, type PdfJsDocument } from "../../../lib/pdf/pdfDocumentLoader";
import { logPdfLoadFailure, type PdfLoadFailureInfo } from "../../../lib/pdf/pdfLoadDiagnostics";
import { buildOptionalContentConfigForRender } from "../../../lib/pdf/pdfLayers";
import { renderWhiteModePage } from "../../../lib/pdf/technicalRasterWhiteRender";
import { computeEffectiveRenderScale, BASE_RENDER_SCALE } from "../../../domain/technicalRasterRenderScale";
import {
  calculateSelectedStandMarker,
  computeMarkerCenterOffset,
  computeSelectedMarkerScreenStyle,
  projectMarkerCenterToScreen,
  type SelectedMarkerAnchorKind,
} from "../../../domain/technicalRasterSelectedMarker";
import { computeSymbolScreenStyle } from "../../../domain/technicalRasterSymbolMarker";
import { computeRealizationUnderlineScreenStyle } from "../../../domain/technicalRasterRealizationUnderline";
import type { TechnicalServicePresentation } from "../../../domain/technicalRasterServicePresentation";
import { ViewportToolbar } from "../../configurator/ViewportToolbar";

const isDev = process.env.NODE_ENV !== "production";
/** How far (screen px) a measured marker center may differ from its computed expected center before the DEV-only diagnostic warns — a few px of tolerance for subpixel/antialiasing rounding, never for a real drift bug (spec batch 6, UI section 13). */
const MARKER_CENTER_DIAGNOSTIC_TOLERANCE_PX = 1.5;

/**
 * How long to wait, after the user stops changing zoom, before checking whether a sharper re-render
 * is warranted (spec batch 4, UI section 9/10) — deliberately NOT on every zoom tick, preserving
 * this module's own established rule ("pdf.js only re-renders when the PAGE or LAYER VISIBILITY
 * actually changes, never on every zoom/pan tick"). See computeEffectiveRenderScale's own module
 * doc for why a fixed render resolution goes soft as zoom increases, and RENDER_RESCALE_UP_RATIO
 * below for what "warranted" means.
 */
const RENDER_RESCALE_DEBOUNCE_MS = 250;
/** Only re-renders for MORE resolution, never re-renders DOWN when zooming back out (that would just be wasted work — keeping a higher-res canvas around costs memory, not correctness). 1.25 = only bother once at least 25% more sharpness is available, so tiny zoom jitter never triggers a re-render. */
const RENDER_RESCALE_UP_RATIO = 1.25;

export type RasterCanvasMarker = Readonly<{
  id: string;
  page: number;
  xNormalized: number;
  yNormalized: number;
  widthNormalized?: number;
  heightNormalized?: number;
  label?: string;
  /**
   * "label" = a plain detected raster text occurrence (spec section 7); "selected" = the single,
   * unified ABF-red circle marker for the stand currently being worked on (spec batch 5, UI
   * section 1-13) — AUTO (widthNormalized/heightNormalized present, a known label bbox) offsets
   * diagonally outside that bbox; MANUAL (no width/height, a real clicked anchor point) draws the
   * SAME circle centered directly on the point — never a fabricated shape, just the label bbox or
   * manual anchor already known. See domain/technicalRasterSelectedMarker.ts.
   */
  kind: "label" | "selected" | "anchor";
}>;

/**
 * One placed technical service symbol (spec batch 7 section 6-10/22-26) — deliberately a SEPARATE
 * prop/type from RasterCanvasMarker above rather than a new "kind": a service symbol's own visual
 * (colored dot + presentation-driven label/icon, click-to-move, selection ring) is meaningfully
 * different from the plain label/selected/anchor markers, and keeping it separate means this
 * addition never risks the existing marker-rendering code path. `id` is the placement's own id
 * (TechnicalServicePlacement.id) — stable across a move, never regenerated.
 */
export type TechnicalRasterServiceSymbolMarker = Readonly<{
  id: string;
  standId: string;
  serviceId: string;
  page: number;
  xNormalized: number;
  yNormalized: number;
  presentation: TechnicalServicePresentation;
  /** True for the ONE placement currently in "move" mode (spec section 9: "Přemístit") — draws the subtle selection ring, never a big red block. */
  isSelected?: boolean;
}>;

/**
 * One "realizace" underline (corrective batch, post real-file acceptance test, section 4/5 —
 * REPLACES the earlier "badge" design, which FAILED manual acceptance: a dominant black pill that
 * duplicated the stand number the source PDF already prints). Deliberately separate from BOTH
 * RasterCanvasMarker and TechnicalRasterServiceSymbolMarker above: this highlights WHO is building
 * a matched stand, never WHAT technical service sits where, and is anchored to the stand's OWN
 * number position (never a service placement's point), so it structurally cannot collide with a
 * technical symbol. `id` is the stand's own id — stable, never regenerated. Geometry
 * (x/y/width, all normalized page-space) is fully pre-computed by
 * domain/technicalRasterRealizationUnderline.ts's own `computeRealizationUnderlineGeometry` — this
 * component only ever converts it to CSS left/top/width percentages, no anchor/translate math.
 */
export type TechnicalRasterRealizationUnderlineMarker = Readonly<{
  id: string;
  page: number;
  xNormalized: number;
  yNormalized: number;
  widthNormalized: number;
  /** The resolved realization group's own central color (domain/technicalRasterRealization.ts) — this component draws whatever color it's given, it never resolves the group itself. */
  color: string;
}>;

/**
 * Renders one page of the raster PDF via pdf.js (spec section 4: PDF.js for preview/zoom/pan —
 * the source PDF itself is never rasterized as ITS OWN storage format, only this ONE visible
 * canvas is a raster preview of it). Zoom/pan reuse useBoothViewport exactly like
 * PrintSurfaceCanvas.tsx does for a completely different image type — same "CSS transform: scale
 * + translate on a fixed-resolution stage" technique, so pdf.js only re-renders when the PAGE or
 * LAYER VISIBILITY actually changes, never on every zoom/pan tick.
 */
export function TechnicalRasterCanvas({
  pdfUrl,
  hiddenLayerIds,
  activePage,
  onPageCountChange,
  markers,
  assignMode,
  onCanvasClick,
  renderKey,
  whiteModeStandLayerId,
  whiteFillOpacity,
  onWhiteModeUnsupported,
  assetReference,
  onLoadFailed,
  servicePlacementMarkers,
  placementModeActive,
  onServiceSymbolClick,
  realizationUnderlineMarkers,
}: {
  pdfUrl: string | undefined;
  hiddenLayerIds: ReadonlySet<string>;
  activePage: number;
  onPageCountChange: (count: number) => void;
  markers: readonly RasterCanvasMarker[];
  assignMode: boolean;
  onCanvasClick?: (page: number, xNormalized: number, yNormalized: number) => void;
  renderKey?: string | number;
  /** Placed technical service symbols to draw on top of the raster (spec batch 7) — independent of `markers` above, see TechnicalRasterServiceSymbolMarker's own doc. Defaults to an empty list when omitted, so every existing caller (the "raster" step, which never passes this prop) is unaffected. */
  servicePlacementMarkers?: readonly TechnicalRasterServiceSymbolMarker[];
  /** True while the user is actively placing/moving ONE technical service point (spec section 7: crosshair cursor + click-to-place, mutually exclusive with `assignMode` in practice but composed the same way here — a click is routed to `onCanvasClick` whenever EITHER this or `assignMode` is true). Existing service symbols stop being individually clickable while this is true, so a placement click can never be misread as "start moving a different symbol". */
  placementModeActive?: boolean;
  /** Fired when the user clicks an EXISTING service symbol while not already placing/moving one (spec section 9: click a symbol to start "Přemístit"). Never fired while placementModeActive is true. */
  onServiceSymbolClick?: (marker: TechnicalRasterServiceSymbolMarker) => void;
  /** "Realizačky" underlines (corrective batch, post real-file acceptance test, section 4/5) — independent of every other marker prop, defaults to an empty list when omitted so every existing caller is unaffected. */
  realizationUnderlineMarkers?: readonly TechnicalRasterRealizationUnderlineMarker[];
  /** Set only when the caller wants "pracovní bílý režim" AND a stand layer was unambiguously detected (see resolveWhiteModeAvailability) — undefined always renders the page normally (spec section 16: never guess). */
  whiteModeStandLayerId?: string;
  /** "Krytí bílé" 0-1 (spec batch 6) — only meaningful together with whiteModeStandLayerId; ignored entirely for a plain/original render. The caller is expected to already have applied effectiveWhiteFillOpacity's own default (domain/technicalRaster.ts), so this component never needs its own fallback. */
  whiteFillOpacity?: number;
  /** Called if a white-mode render this page/config actually attempted comes back "unsupported" (e.g. the layer uses a fill mechanism this can't safely rewrite) — spec section 16/19: the caller must fall back to showing the original and explain why. */
  onWhiteModeUnsupported?: (reason: string) => void;
  /** Whatever the caller has on hand to identify the raster asset (e.g. StoredAsset.id) — purely for diagnostic logging on a load failure (spec batch 5, UI section 18), never used for anything functional. */
  assetReference?: string;
  /** Called when loadPdfDocument(pdfUrl) itself fails (spec batch 5, UI section 17-23) — this component ALWAYS shows a fixed, friendly Czech message to the user regardless (never the raw error), and always logs full technical details itself; this callback exists so the OWNER (which knows about the asset and can resolve a fresh download URL) can drive a single retry. Never called for anything other than the document-loading fetch itself — page-render failures are a separate, existing error path. */
  onLoadFailed?: (info: PdfLoadFailureInfo) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const documentRef = useRef<PdfJsDocument | undefined>(undefined);
  const [pageSizePt, setPageSizePt] = useState<Readonly<{ width: number; height: number }> | undefined>(undefined);
  const [error, setError] = useState("");
  const [isRendering, setIsRendering] = useState(false);
  // Bumped once loadPdfDocument's promise actually resolves (see the loading effect below). The
  // render effect keeps documentRef as a REF (not state) so a slow document load never forces
  // extra re-renders while it's pending — but that means React has no way to know "the document
  // just became available" unless something IN THE RENDER EFFECT'S OWN DEPENDENCY ARRAY changes
  // at that exact moment. Without this counter, the very first upload reliably rendered a blank
  // canvas: the loading effect (keyed on pdfUrl) and the render effect (keyed on
  // activePage/renderKey/whiteModeStandLayerId) fire on different renders, and by the time the
  // async document load resolves, none of the render effect's OWN deps have changed since its
  // last run — so it never reruns, even though documentRef.current and canvasRef.current are both
  // now ready. Once this counter is a dependency, document-load completion is itself a trigger.
  const [documentVersion, setDocumentVersion] = useState(0);
  // The render scale actually used for the LAST completed page.render() call — compared against
  // computeEffectiveRenderScale's current recommendation by the debounced watcher below to decide
  // whether a sharper re-render is actually warranted (never on every zoom tick — see
  // RENDER_RESCALE_DEBOUNCE_MS's own doc).
  const lastRenderedScaleRef = useRef(BASE_RENDER_SCALE);
  const [renderScaleTrigger, setRenderScaleTrigger] = useState(0);

  const viewport = useBoothViewport({
    worldWidthMm: pageSizePt?.width ?? 1,
    worldHeightMm: pageSizePt?.height ?? 1,
    enabled: Boolean(pageSizePt),
    fitKey: pdfUrl ? `${pdfUrl}-${activePage}` : "no-raster",
  });

  // Debounced "is the current canvas resolution still good enough for this zoom" check (spec
  // batch 4, UI section 9/10). Deliberately does NOT touch the canvas itself — it only decides
  // whether the MAIN render effect below should run again, by bumping renderScaleTrigger, which
  // reads viewport.transform.zoom fresh (via closure) when it actually re-runs.
  useEffect(() => {
    if (!pageSizePt) return;
    const timeout = window.setTimeout(() => {
      const target = computeEffectiveRenderScale(pageSizePt.width, pageSizePt.height, viewport.transform.zoom);
      if (target > lastRenderedScaleRef.current * RENDER_RESCALE_UP_RATIO) {
        setRenderScaleTrigger((version) => version + 1);
      }
    }, RENDER_RESCALE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [viewport.transform.zoom, pageSizePt]);

  // Load the document once per URL. Any previously-held document is destroyed on cleanup (URL
  // change or unmount) — pdf.js documents hold a worker/WASM resource that otherwise leaks every
  // time the raster PDF is replaced (spec batch 2.5 section 21). Deliberately keyed ONLY on
  // [pdfUrl] — a zoom-driven high-resolution re-render (renderScaleTrigger, below) NEVER appears
  // in this dependency array, so it can never re-run this effect / re-fetch the PDF (spec batch 5,
  // UI section 21): a sharper render only ever calls document.getPage() again on the SAME already-
  // loaded document, in the separate render effect further down.
  useEffect(() => {
    if (!pdfUrl) { documentRef.current = undefined; setPageSizePt(undefined); return; }
    let cancelled = false;
    setError("");
    loadPdfDocument(pdfUrl)
      .then((document) => {
        if (cancelled) { void document.destroy(); return; }
        documentRef.current = document;
        onPageCountChange(document.numPages);
        setDocumentVersion((version) => version + 1);
      })
      .catch((loadError) => {
        if (cancelled) return;
        // NEVER the raw error.message here (spec batch 5, UI section 23) — a real network/fetch
        // failure's own message ("Failed to fetch") is not a fit user-facing string. Full
        // technical detail goes to the console via logPdfLoadFailure/onLoadFailed instead.
        logPdfLoadFailure({ phase: "canvas_load", assetReference, url: pdfUrl, error: loadError });
        onLoadFailed?.({ url: pdfUrl, errorName: loadError instanceof Error ? loadError.name : typeof loadError, errorMessage: loadError instanceof Error ? loadError.message : String(loadError) });
        setError("Rastr se nepodařilo načíst.");
      });
    return () => {
      cancelled = true;
      const current = documentRef.current;
      documentRef.current = undefined;
      void current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl]);

  // Render the active page whenever the page number, layer visibility, or the document itself changes.
  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (!document || !canvas) return;
    let cancelled = false;
    setIsRendering(true);
    setError("");
    (async () => {
      const page = await document.getPage(activePage);
      const baseViewport = page.getViewport({ scale: 1 });
      if (cancelled) return;
      setPageSizePt({ width: baseViewport.width, height: baseViewport.height });

      const effectiveRenderScale = computeEffectiveRenderScale(baseViewport.width, baseViewport.height, viewport.transform.zoom);
      lastRenderedScaleRef.current = effectiveRenderScale;
      const renderViewport = page.getViewport({ scale: effectiveRenderScale });
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const optionalContentConfigPromise = buildOptionalContentConfigForRender(document, hiddenLayerIds).then((config) => config as never);

      if (whiteModeStandLayerId) {
        const result = await renderWhiteModePage({
          page,
          pageKey: `${pdfUrl}#${activePage}`,
          standLayerId: whiteModeStandLayerId,
          canvasContext: ctx,
          viewport: renderViewport,
          optionalContentConfigPromise,
          whiteFillOpacity,
        });
        if (result.status === "unsupported") {
          onWhiteModeUnsupported?.(result.reason);
          if (!cancelled) await page.render({ canvasContext: ctx, viewport: renderViewport, optionalContentConfigPromise }).promise;
        }
        return;
      }

      await page.render({ canvasContext: ctx, viewport: renderViewport, optionalContentConfigPromise }).promise;
    })()
      .catch((renderError) => {
        if (!cancelled) setError(renderError instanceof Error ? renderError.message : "Stránku rastru se nepodařilo vykreslit.");
      })
      .finally(() => {
        if (!cancelled) setIsRendering(false);
      });
    return () => { cancelled = true; };
    // hiddenLayerIds is a Set (new identity each parent render) — renderKey is the caller's own
    // explicit "please redraw" signal (bumped only when visibility/work-mode ACTUALLY changed).
    // documentVersion is required too: it's the ONLY dependency here that changes exactly when the
    // async document load (a separate effect, keyed on pdfUrl) actually finishes — see its own
    // comment for why omitting it left the very first upload with a blank canvas. renderScaleTrigger
    // is the debounced watcher's own signal that a sharper re-render is now warranted — the effect
    // itself reads viewport.transform.zoom fresh (via closure, deliberately NOT in this array) so
    // it always uses the CURRENT zoom, not whatever zoom was current when the debounce timer fired.
    // whiteFillOpacity (spec batch 6) is listed directly — the caller (TechnicalRasterLayerPanel's
    // "Krytí bílé" slider, already debounced on ITS OWN side) can change it independently of
    // renderKey, and a redraw must follow; this never touches pdfUrl, so it never re-fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, renderKey, whiteModeStandLayerId, whiteFillOpacity, documentVersion, renderScaleTrigger]);

  function handleStageClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!(assignMode || placementModeActive) || !onCanvasClick || !pageSizePt) return;
    const world = viewport.clientToWorld(event.clientX, event.clientY);
    if (!world) return;
    if (world.x < 0 || world.y < 0 || world.x > pageSizePt.width || world.y > pageSizePt.height) return;
    onCanvasClick(activePage, world.x / pageSizePt.width, world.y / pageSizePt.height);
  }

  /**
   * DEV-only (spec batch 6, UI section 13): compares the ACTUAL rendered marker center
   * (getBoundingClientRect(), relative to .technicalRasterViewport's own top-left) against the
   * EXPECTED center this file computed for it (projectMarkerCenterToScreen) — never a production
   * UI panel, just a console.warn if they ever disagree by more than a rounding-sized tolerance.
   * This is what lets a future regression in the transform chain be caught by hand-testing in dev,
   * without needing a browser-automation test suite this repo doesn't have.
   */
  function checkMarkerCenterDiagnostic(node: HTMLDivElement | null, expected: { x: number; y: number }, label: string | undefined) {
    if (!isDev || !node) return;
    const viewportEl = viewport.viewportRef.current;
    if (!viewportEl) return;
    const viewportRect = viewportEl.getBoundingClientRect();
    const markerRect = node.getBoundingClientRect();
    const actualX = markerRect.left + markerRect.width / 2 - viewportRect.left;
    const actualY = markerRect.top + markerRect.height / 2 - viewportRect.top;
    const deltaX = actualX - expected.x;
    const deltaY = actualY - expected.y;
    if (Math.abs(deltaX) > MARKER_CENTER_DIAGNOSTIC_TOLERANCE_PX || Math.abs(deltaY) > MARKER_CENTER_DIAGNOSTIC_TOLERANCE_PX) {
      // eslint-disable-next-line no-console
      console.warn(
        `[technicalRaster] selected marker center drift for "${label ?? "?"}": expected (${expected.x.toFixed(1)}, ${expected.y.toFixed(1)}), measured (${actualX.toFixed(1)}, ${actualY.toFixed(1)}), delta (${deltaX.toFixed(2)}px, ${deltaY.toFixed(2)}px)`,
      );
    }
  }

  /**
   * Renders one marker (spec batch 6, UI section 1-13). "selected" is now the ONLY selected-stand
   * indicator (the batch-5 bbox outline is gone entirely — re-verified this batch, see the report).
   * A single circle (ABF-red ring, near-transparent interior — never a solid fill) is used for BOTH
   * AUTO (center offset diagonally outside a known label bbox — calculateSelectedStandMarker +
   * computeMarkerCenterOffset) and MANUAL (center = the real clicked anchor point, zero offset) —
   * the branch below is chosen purely by whether a bbox is present, the same pre-existing signal as
   * before (spec section 10: no new matching state). Both paths compose the SAME two-step
   * transform — `translate(centerOffset) translate(-50%, -50%)` — so ANCHOR (page-space point),
   * OFFSET (screen-space nudge), and SIZE (diameter-based centering) stay structurally independent
   * (spec section 4/2): a size change only ever affects the `-50%` step, never the offset step, and
   * the offset step is a fixed screen-constant regardless of zoom. "label"/"anchor" markers are
   * unaffected.
   */
  function renderMarker(marker: RasterCanvasMarker) {
    const zoom = viewport.transform.zoom;
    const hasBox = Boolean(marker.widthNormalized && marker.heightNormalized);

    if (marker.kind === "selected") {
      const style = computeSelectedMarkerScreenStyle(zoom);
      const anchorGeometry = hasBox
        ? calculateSelectedStandMarker({
          xNormalized: marker.xNormalized,
          yNormalized: marker.yNormalized,
          widthNormalized: marker.widthNormalized!,
          heightNormalized: marker.heightNormalized!,
        })
        : { corner: "bottom-right" as const, anchorXNormalized: marker.xNormalized, anchorYNormalized: marker.yNormalized };
      const kind: SelectedMarkerAnchorKind = !hasBox ? "manual" : anchorGeometry.corner === "top-left" ? "auto-top-left" : "auto-bottom-right";
      const centerOffset = computeMarkerCenterOffset(kind, style);
      // ANCHOR (left/top, %) is the page-space point alone — OFFSET (first translate, px, zero for
      // manual) and SIZE-centering (second translate, -50%, identical always) are two fully
      // separate steps composed after it. Changing diameterPx only ever changes the SECOND step.
      const markerStyle: CSSProperties = {
        left: `${anchorGeometry.anchorXNormalized * 100}%`,
        top: `${anchorGeometry.anchorYNormalized * 100}%`,
        width: `${style.diameterPx}px`,
        height: `${style.diameterPx}px`,
        borderWidth: `${style.borderPx}px`,
        transform: `translate(${centerOffset.dxPx}px, ${centerOffset.dyPx}px) translate(-50%, -50%)`,
      };
      const className = hasBox ? `technicalRasterSelectedMarker ${anchorGeometry.corner}` : "technicalRasterSelectedMarker manual";
      if (isDev && pageSizePt) {
        const expectedCenter = projectMarkerCenterToScreen({
          anchorXNormalized: anchorGeometry.anchorXNormalized,
          anchorYNormalized: anchorGeometry.anchorYNormalized,
          stageWidthPx: pageSizePt.width * viewport.pixelsPerMm,
          stageHeightPx: pageSizePt.height * viewport.pixelsPerMm,
          panX: viewport.transform.pan.x,
          panY: viewport.transform.pan.y,
          zoom,
          centerOffset,
        });
        return (
          <div
            key={marker.id}
            ref={(node) => checkMarkerCenterDiagnostic(node, expectedCenter, marker.label)}
            className={className}
            title={marker.label}
            style={markerStyle}
          />
        );
      }
      return <div key={marker.id} className={className} title={marker.label} style={markerStyle} />;
    }

    return (
      <div
        key={marker.id}
        className={`technicalRasterMarker ${marker.kind}`}
        title={marker.label}
        style={
          hasBox
            ? {
              left: `${marker.xNormalized * 100}%`,
              top: `${marker.yNormalized * 100}%`,
              width: `${marker.widthNormalized! * 100}%`,
              height: `${marker.heightNormalized! * 100}%`,
            }
            : { left: `${marker.xNormalized * 100}%`, top: `${marker.yNormalized * 100}%` }
        }
      />
    );
  }

  /**
   * A placed technical service symbol (corrective batch section 2, redesigned): the placement
   * point IS the symbol's CENTER (zero offset, unlike the diagonally-offset AUTO selected-stand
   * marker above) — a single `translate(-50%, -50%)` against `left/top` is the whole positioning
   * story. The OUTER element is sized to the (larger) CLICK target and centers its children via
   * flex; the INNER glyph/text is the actual visible mark — kept as separate elements specifically
   * so the invisible click target can never affect the visual size. Only clickable when NOT
   * currently placing/moving another point.
   *
   * NO circular badge for ANY renderer (spec: "NEpoužívej jako default velké plné kruhové badge"):
   * `powerLabel`/`textLabel`/`fallback` draw plain colored bold TEXT directly in the presentation's
   * own color; `refrigeratedStar`/`waterDrop`/`wifiIcon` draw a small colored vector glyph — both
   * get a subtle white text-shadow halo (never a filled shape) purely for legibility over a busy
   * raster. Every size is set INLINE from computeSymbolScreenStyle so it stays zoom-invariant.
   */
  function renderServicePlacementMarker(marker: TechnicalRasterServiceSymbolMarker) {
    const style = computeSymbolScreenStyle(viewport.transform.zoom);
    const clickable = Boolean(onServiceSymbolClick) && !placementModeActive;
    const { renderer, displayLabel, color } = marker.presentation;
    const halo = `0 0 ${style.haloBlurPx}px #fff, 0 0 ${style.haloBlurPx}px #fff, 0 0 ${style.haloBlurPx}px #fff`;
    return (
      <div
        key={marker.id}
        className={marker.isSelected ? "technicalRasterServiceSymbol selected" : "technicalRasterServiceSymbol"}
        title={marker.presentation.legendLabel}
        style={{
          left: `${marker.xNormalized * 100}%`,
          top: `${marker.yNormalized * 100}%`,
          width: `${style.clickDiameterPx}px`,
          height: `${style.clickDiameterPx}px`,
          transform: "translate(-50%, -50%)",
          pointerEvents: clickable ? "auto" : "none",
          cursor: clickable ? "pointer" : "default",
        }}
        onClick={clickable ? (event) => { event.stopPropagation(); onServiceSymbolClick!(marker); } : undefined}
      >
        {marker.isSelected && (
          <span
            className="technicalRasterServiceSymbolRing"
            style={{ width: `${style.selectionRingDiameterPx}px`, height: `${style.selectionRingDiameterPx}px`, borderWidth: `${style.selectionRingBorderPx}px` }}
          />
        )}
        {renderer === "refrigeratedStar" && (
          <span className="technicalRasterServiceSymbolStar" aria-hidden="true" style={{ fontSize: `${style.glyphSizePx}px`, color, textShadow: halo }}>✱</span>
        )}
        {renderer === "waterDrop" && (
          <span className="technicalRasterServiceSymbolGlyph" style={{ width: `${style.glyphSizePx}px`, height: `${style.glyphSizePx}px`, filter: `drop-shadow(${halo.split(",")[0]})` }}>
            <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
              <path d="M12 2C12 2 5 11 5 15.5A7 7 0 0019 15.5C19 11 12 2 12 2Z" fill={color} stroke="#fff" strokeWidth="1" />
            </svg>
          </span>
        )}
        {renderer === "wifiIcon" && (
          <span className="technicalRasterServiceSymbolGlyph" style={{ width: `${style.glyphSizePx}px`, height: `${style.glyphSizePx}px` }}>
            <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
              <path d="M2 8.5C7.5 3.5 16.5 3.5 22 8.5M5.5 12.5C9.5 9 14.5 9 18.5 12.5M9 16.5C10.5 15 13.5 15 15 16.5M12 20.2v.1" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" style={{ filter: `drop-shadow(${halo.split(",")[0]})` }} />
            </svg>
          </span>
        )}
        {(renderer === "powerLabel" || renderer === "textLabel" || renderer === "fallback") && (
          <span className="technicalRasterServiceSymbolLabel" style={{ fontSize: `${style.fontSizePx}px`, color, textShadow: halo }}>{displayLabel ?? "?"}</span>
        )}
      </div>
    );
  }

  /**
   * A "realizace" underline (corrective batch, post real-file acceptance test, section 4/5): a
   * single colored horizontal line, positioned via plain `left/top/width` percentages from
   * ALREADY-COMPUTED normalized page-space geometry (domain/technicalRasterRealizationUnderline.ts)
   * — no anchor/translate math here, unlike the point-shaped markers above, since this marker's own
   * geometry already IS a rectangle in the same page-space every other bbox-based marker in this
   * file uses (compare `.technicalRasterMarker` with `hasBox` above). The source PDF's own stand
   * number is NEVER redrawn/covered — this draws ONLY the line, strictly below it.
   */
  function renderRealizationUnderline(marker: TechnicalRasterRealizationUnderlineMarker) {
    const style = computeRealizationUnderlineScreenStyle(viewport.transform.zoom);
    return (
      <div
        key={`realization-${marker.id}`}
        className="technicalRasterRealizationUnderline"
        style={{
          left: `${marker.xNormalized * 100}%`,
          top: `${marker.yNormalized * 100}%`,
          width: `${marker.widthNormalized * 100}%`,
          height: `${style.thicknessPx}px`,
          background: marker.color,
        }}
      />
    );
  }

  if (!pdfUrl) {
    return (
      <div className="workflowCard technicalRasterCanvasPanel">
        <p className="workspaceEmpty">Nahrajte PDF vyměřovacího rastru haly.</p>
      </div>
    );
  }

  const stageWidth = (pageSizePt?.width ?? 0) * viewport.pixelsPerMm;
  const stageHeight = (pageSizePt?.height ?? 0) * viewport.pixelsPerMm;

  return (
    <div className="workflowCard technicalRasterCanvasPanel">
      <div className="technicalRasterCanvasToolbar">
        {/*
          Manual acceptance batch, section 14-17: real testing found "100 %" (viewport.resetZoom,
          a literal mathematical 1:1 scale) leaving most of a real large-format raster page
          scrolled off-screen — confusingly different from "Fit", which already shows the whole
          page. This module's own "100 %" is redefined to mean "standard full-page view" (spec
          section 16: "100% = baseline odpovídající full-page view v tomto modulu"), i.e. the SAME
          fit-to-viewport calculation as Fit — never the shared useBoothViewport hook's own
          generic 1:1 resetZoom, which stays completely unchanged for every OTHER caller of this
          hook/ViewportToolbar (BoothGenerator/PrintSurfaceCanvas/PlotPolygonEditor). The
          on-screen "%" readout (viewport.zoomPercent) still reports the REAL internal scale this
          produces (e.g. "43 %" for a page that needs shrinking to fit) — only the BUTTON's own
          fixed "100 %" label is the redefined, module-local semantic, exactly as spec section 16
          allows ("můžeš oddělit displayed percentage a internal PDF scale").
        */}
        <ViewportToolbar zoomPercent={viewport.zoomPercent} onZoomOut={viewport.zoomOut} onZoomIn={viewport.zoomIn} onFit={viewport.fitToBooth} onReset={viewport.fitToBooth} />
        {isRendering && <span className="fieldHint">Vykresluji…</span>}
      </div>
      {error && <p className="uploadError">{error}</p>}
      <div
        ref={viewport.viewportRef}
        className={[
          "technicalRasterViewport",
          assignMode ? "assignMode" : "",
          placementModeActive ? "placementMode" : "",
        ].filter(Boolean).join(" ")}
        onPointerDown={(event) => { if (viewport.startPan(event)) return; }}
        onPointerMove={viewport.movePan}
        onPointerUp={viewport.endPan}
        onPointerCancel={viewport.endPan}
        onClick={handleStageClick}
      >
        <div
          className="technicalRasterStage"
          style={{
            width: `${stageWidth}px`,
            height: `${stageHeight}px`,
            transform: `translate(${viewport.transform.pan.x}px, ${viewport.transform.pan.y}px) scale(${viewport.transform.zoom})`,
          }}
        >
          <canvas ref={canvasRef} className="technicalRasterCanvasElement" style={{ width: `${stageWidth}px`, height: `${stageHeight}px` }} />
          {markers.filter((marker) => marker.page === activePage).map((marker) => renderMarker(marker))}
          {(servicePlacementMarkers ?? []).filter((marker) => marker.page === activePage).map((marker) => renderServicePlacementMarker(marker))}
          {(realizationUnderlineMarkers ?? []).filter((marker) => marker.page === activePage).map((marker) => renderRealizationUnderline(marker))}
        </div>
      </div>
    </div>
  );
}
