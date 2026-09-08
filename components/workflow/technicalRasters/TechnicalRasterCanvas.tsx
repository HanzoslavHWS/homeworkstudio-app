"use client";

import { useEffect, useRef, useState } from "react";
import { useBoothViewport } from "../../../hooks/useBoothViewport";
import { loadPdfDocument, type PdfJsDocument } from "../../../lib/pdf/pdfDocumentLoader";
import { buildOptionalContentConfigForRender } from "../../../lib/pdf/pdfLayers";
import { renderWhiteModePage } from "../../../lib/pdf/technicalRasterWhiteRender";
import { ViewportToolbar } from "../../configurator/ViewportToolbar";

/** Internal pdf.js render resolution multiplier (independent of on-screen zoom — see the module doc on why zoom is a pure CSS transform, never a pdf.js re-render). */
const RENDER_QUALITY_SCALE = 2.5;

export type RasterCanvasMarker = Readonly<{
  id: string;
  page: number;
  xNormalized: number;
  yNormalized: number;
  widthNormalized?: number;
  heightNormalized?: number;
  label?: string;
  /** "label" = a plain detected raster text occurrence (spec section 7); "selected" = the ABF-red highlight for the stand currently being worked on (spec section 21) — never a fabricated shape, just the marker/bbox we actually have. */
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
  onWhiteModeUnsupported,
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
  /** Called if a white-mode render this page/config actually attempted comes back "unsupported" (e.g. the layer uses a fill mechanism this can't safely rewrite) — spec section 16/19: the caller must fall back to showing the original and explain why. */
  onWhiteModeUnsupported?: (reason: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const documentRef = useRef<PdfJsDocument | undefined>(undefined);
  const [pageSizePt, setPageSizePt] = useState<Readonly<{ width: number; height: number }> | undefined>(undefined);
  const [error, setError] = useState("");
  const [isRendering, setIsRendering] = useState(false);

  const viewport = useBoothViewport({
    worldWidthMm: pageSizePt?.width ?? 1,
    worldHeightMm: pageSizePt?.height ?? 1,
    enabled: Boolean(pageSizePt),
    fitKey: pdfUrl ? `${pdfUrl}-${activePage}` : "no-raster",
  });

  // Load the document once per URL. Any previously-held document is destroyed on cleanup (URL
  // change or unmount) — pdf.js documents hold a worker/WASM resource that otherwise leaks every
  // time the raster PDF is replaced (spec batch 2.5 section 21).
  useEffect(() => {
    if (!pdfUrl) { documentRef.current = undefined; setPageSizePt(undefined); return; }
    let cancelled = false;
    setError("");
    loadPdfDocument(pdfUrl)
      .then((document) => {
        if (cancelled) { void document.destroy(); return; }
        documentRef.current = document;
        onPageCountChange(document.numPages);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Rastr se nepodařilo načíst.");
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

      const renderViewport = page.getViewport({ scale: RENDER_QUALITY_SCALE });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, renderKey, whiteModeStandLayerId]);

  function handleStageClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!assignMode || !onCanvasClick || !pageSizePt) return;
    const world = viewport.clientToWorld(event.clientX, event.clientY);
    if (!world) return;
    if (world.x < 0 || world.y < 0 || world.x > pageSizePt.width || world.y > pageSizePt.height) return;
    onCanvasClick(activePage, world.x / pageSizePt.width, world.y / pageSizePt.height);
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
          {markers.filter((marker) => marker.page === activePage).map((marker) => (
            <div
              key={marker.id}
              className={`technicalRasterMarker ${marker.kind}`}
              title={marker.label}
              style={
                marker.widthNormalized && marker.heightNormalized
                  ? {
                    left: `${marker.xNormalized * 100}%`,
                    top: `${marker.yNormalized * 100}%`,
                    width: `${marker.widthNormalized * 100}%`,
                    height: `${marker.heightNormalized * 100}%`,
                  }
                  : { left: `${marker.xNormalized * 100}%`, top: `${marker.yNormalized * 100}%` }
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
