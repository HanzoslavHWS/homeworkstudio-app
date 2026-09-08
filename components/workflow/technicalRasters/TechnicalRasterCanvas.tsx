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
}: {
  pdfUrl: string | undefined;
  hiddenLayerIds: ReadonlySet<string>;
  activePage: number;
  onPageCountChange: (count: number) => void;
  markers: readonly RasterCanvasMarker[];
  assignMode: boolean;
  onCanvasClick?: (page: number, xNormalized: number, yNormalized: number) => void;
  renderKey?: string | number;
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
    if (!assignMode || !onCanvasClick || !pageSizePt) return;
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
        <ViewportToolbar zoomPercent={viewport.zoomPercent} onZoomOut={viewport.zoomOut} onZoomIn={viewport.zoomIn} onFit={viewport.fitToBooth} onReset={viewport.resetZoom} />
        {isRendering && <span className="fieldHint">Vykresluji…</span>}
      </div>
      {error && <p className="uploadError">{error}</p>}
      <div
        ref={viewport.viewportRef}
        className={assignMode ? "technicalRasterViewport assignMode" : "technicalRasterViewport"}
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
        </div>
      </div>
    </div>
  );
}
