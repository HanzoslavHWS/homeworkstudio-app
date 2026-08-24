"use client";

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Point } from "../../domain/models";
import {
  createCenteredRectanglePlotPolygon,
  plotAreaSquareMeters,
  plotPerimeterMeters,
  snapEdgeAngle,
  snapPlotVertexToGrid,
  validatePlotPolygon,
  type IndividualWorkspace,
  type PlotPolygon,
} from "../../domain/plot";
import { getBounds, isPointInOrOnPolygon } from "../../geometry/polygons";
import { planViewToWorld, worldToPlanView } from "../../domain/planView";
import { useBoothViewport } from "../../hooks/useBoothViewport";
import { PlotSizeInput } from "./PlotSizeInput";
import { ViewportToolbar } from "./ViewportToolbar";

const VERTEX_CLOSE_THRESHOLD_MM = 200;

/** Below this on-screen pixel spacing between adjacent grid lines, that tier is skipped rather than rendered as illegible gray mush (report section 14). Snap itself always stays 250 mm regardless of what's drawn. */
const MIN_GRID_LINE_SPACING_PX = 6;

const VALIDATION_ISSUE_LABELS_CS: Record<string, string> = {
  too_few_points: "Potřeba alespoň 3 body.",
  duplicate_points: "Dva body mají stejnou pozici.",
  zero_length_edge: "Hrana s nulovou délkou.",
  self_intersecting: "Hranice se sama protíná.",
};

type ReferenceShape = Readonly<{ id: string; polygon: PlotPolygon; className?: string }>;

type PlotPolygonEditorProps = {
  workspace: IndividualWorkspace;
  polygon: PlotPolygon | undefined;
  onPolygonChange: (polygon: PlotPolygon) => void;
  referenceShapes?: readonly ReferenceShape[];
  shapeClassName?: string;
  quickRectangleDefaultWidthMm?: number;
  quickRectangleDefaultDepthMm?: number;
  /** Distinguishes this editor instance's fit/remount identity from a sibling instance editing a DIFFERENT polygon (e.g. switching which floor zone is being edited) — see useBoothViewport's fitKey. */
  fitKey?: string;
  /**
   * Report section 2: the Podlaha tab must show the booth polygon as boundary/background even
   * BEFORE the user has created (or selected) a floor zone to draw — never an empty panel with
   * no canvas at all. In this mode the grid/referenceShapes/Fit/wheel-zoom all stay fully live,
   * but there is no polygon to draw/edit yet, so the drawing toolbar and canvas click/drag
   * interactions are disabled.
   */
  readOnly?: boolean;
  /**
   * Report section 4/5: a HARD interaction boundary (Podlaha's confirmed booth plot) — grid
   * outside it stays visible for orientation but is visually masked/dimmed, and no vertex can be
   * placed or dragged outside it. Distinct from `referenceShapes` (which are purely visual,
   * e.g. showing OTHER floor zones for context) — this one actually constrains drawing. Never
   * used for Plocha itself (which draws the plot boundary and has none to constrain against).
   */
  boundaryPolygon?: PlotPolygon;
};

/**
 * Reusable polygon drawing/editing canvas — used for BOTH the plot ("Plocha") and floor zones
 * ("Podlaha"), parameterized by which polygon it edits. Click = new vertex, click-near-first-
 * point = close, vertices are draggable once closed, 250mm grid + 45° edge-angle snap. Renders
 * through the SAME worldToPlanView/planViewToWorld transform the rest of the app already uses —
 * never a second/different 2D orientation convention.
 *
 * Uses its OWN dedicated CSS classes (plotEditorViewport*, never boothViewport/canvasArea) —
 * those shared class names carry a global override elsewhere (app/globals.css's "WORKFLOW
 * DENSITY" section sets `.boothViewport { height: 100% }`) that only resolves correctly inside
 * the typovka configurator's CSS-grid ancestor; reusing them here collapsed this editor to 0
 * height. See the foundation report for the full root-cause writeup.
 */
export function PlotPolygonEditor({
  workspace,
  polygon,
  onPolygonChange,
  referenceShapes = [],
  shapeClassName,
  quickRectangleDefaultWidthMm = 3000,
  quickRectangleDefaultDepthMm = 2000,
  fitKey,
  readOnly = false,
  boundaryPolygon,
}: PlotPolygonEditorProps) {
  const [draftVertices, setDraftVertices] = useState<Point[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hoverWorldPoint, setHoverWorldPoint] = useState<Point | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [quickWidthMm, setQuickWidthMm] = useState(quickRectangleDefaultWidthMm);
  const [quickDepthMm, setQuickDepthMm] = useState(quickRectangleDefaultDepthMm);

  const activeVertices = isDrawing ? draftVertices : polygon ? [...polygon] : [];
  const validation = activeVertices.length >= 3 ? validatePlotPolygon(activeVertices) : null;

  function toDisplay(point: Point): Point {
    return worldToPlanView(point, workspace.widthMm, workspace.depthMm);
  }

  // Section 5/22: what should be framed by default — the real drawn shape (plus any reference
  // shapes, e.g. the plot boundary while editing a floor zone) when one exists, never the whole
  // workspace canvas once there's something smaller and more relevant to look at.
  //
  // MUST be computed in DISPLAY space (post worldToPlanView), not raw world coordinates — the
  // SVG itself is drawn entirely in display space (every <polygon>/<circle> below goes through
  // toDisplay first), so a fit computed from unflipped world Y would frame the wrong region
  // whenever the shape isn't near world Y=0 (worldToPlanView flips Y across the WORKSPACE's own
  // depth, not the shape's own bounds).
  const allRelevantPoints = [...activeVertices, ...referenceShapes.flatMap((shape) => shape.polygon)].map(toDisplay);
  const fitBoundsForViewport =
    allRelevantPoints.length > 0
      ? getBounds(allRelevantPoints)
      : { minX: 0, minY: 0, maxX: workspace.widthMm, maxY: workspace.depthMm };

  const viewport = useBoothViewport({
    worldWidthMm: workspace.widthMm,
    worldHeightMm: workspace.depthMm,
    enabled: true,
    fitBounds: fitBoundsForViewport,
    fitKey: fitKey ?? "plot",
  });

  function worldPointFromClient(clientX: number, clientY: number): Point | null {
    const displayPoint = viewport.clientToWorld(clientX, clientY);
    if (!displayPoint) return null;
    return planViewToWorld(displayPoint, workspace.widthMm, workspace.depthMm);
  }

  function snappedNextVertex(raw: Point): Point {
    const previous = draftVertices[draftVertices.length - 1];
    return previous ? snapEdgeAngle(previous, raw) : snapPlotVertexToGrid(raw);
  }

  /** Report section 4/5: the hard interaction boundary — a vertex can never be placed/dragged outside it, even mid-draw (not just checked at confirm time). Always true when there is no boundary (Plocha itself). */
  function isWithinBoundary(point: Point): boolean {
    return !boundaryPolygon || isPointInOrOnPolygon(point, boundaryPolygon);
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (readOnly || event.button !== 0 || viewport.isSpacePressed || draggingIndex !== null) return;
    const worldPoint = worldPointFromClient(event.clientX, event.clientY);
    if (!worldPoint || !isWithinBoundary(worldPoint)) return;

    if (!isDrawing) {
      setIsDrawing(true);
      setDraftVertices([snapPlotVertexToGrid(worldPoint)]);
      return;
    }

    const first = draftVertices[0];
    if (first && draftVertices.length >= 3 && Math.hypot(worldPoint.x - first.x, worldPoint.y - first.y) <= VERTEX_CLOSE_THRESHOLD_MM) {
      closeDraft();
      return;
    }

    setDraftVertices((current) => [...current, snappedNextVertex(worldPoint)]);
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (draggingIndex !== null) {
      const worldPoint = worldPointFromClient(event.clientX, event.clientY);
      if (!worldPoint || !polygon || !isWithinBoundary(worldPoint)) return;
      const snapped = snapPlotVertexToGrid(worldPoint);
      const next = polygon.map((vertex, index) => (index === draggingIndex ? snapped : vertex));
      onPolygonChange(next);
      return;
    }
    if (!isDrawing) return;
    const worldPoint = worldPointFromClient(event.clientX, event.clientY);
    setHoverWorldPoint(worldPoint);
  }

  function closeDraft() {
    const result = validatePlotPolygon(draftVertices);
    if (!result.valid) return;
    onPolygonChange(draftVertices);
    setIsDrawing(false);
    setDraftVertices([]);
    setHoverWorldPoint(null);
  }

  function undoLastVertex() {
    setDraftVertices((current) => current.slice(0, -1));
  }

  function resetDraft() {
    setIsDrawing(false);
    setDraftVertices([]);
    setHoverWorldPoint(null);
  }

  function startRedraw() {
    setIsDrawing(true);
    setDraftVertices([]);
    setHoverWorldPoint(null);
  }

  function createQuickRectangle() {
    onPolygonChange(createCenteredRectanglePlotPolygon(workspace, quickWidthMm, quickDepthMm));
    setIsDrawing(false);
    setDraftVertices([]);
  }

  function pointsAttr(points: readonly Point[]): string {
    return points.map((point) => { const display = toDisplay(point); return `${display.x},${display.y}`; }).join(" ");
  }

  /** SVG path `d` for a closed polygon subpath, display-space. Used by the boundary mask below (evenodd: outer workspace rect minus this subpath = everything OUTSIDE the boundary). */
  function polygonPathData(points: readonly Point[]): string {
    return points.map((point, index) => { const display = toDisplay(point); return `${index === 0 ? "M" : "L"}${display.x},${display.y}`; }).join(" ") + " Z";
  }

  // Grid LOD (report section 14): a tier only renders once its on-screen spacing clears a
  // legibility floor — snap stays 250mm regardless of what's visually drawn.
  const pxPerMm = viewport.pixelsPerMm * viewport.transform.zoom;
  const showThinGrid = 250 * pxPerMm >= MIN_GRID_LINE_SPACING_PX;
  const showMediumGrid = 500 * pxPerMm >= MIN_GRID_LINE_SPACING_PX;

  const gridLines: { key: string; x1: number; y1: number; x2: number; y2: number; weight: "strong" | "medium" | "thin" }[] = [];
  for (let x = 0; x <= workspace.widthMm; x += 250) {
    const weight = x % 1000 === 0 ? "strong" : x % 500 === 0 ? "medium" : "thin";
    if (weight === "thin" && !showThinGrid) continue;
    if (weight === "medium" && !showMediumGrid) continue;
    gridLines.push({ key: `v${x}`, x1: x, y1: 0, x2: x, y2: workspace.depthMm, weight });
  }
  for (let y = 0; y <= workspace.depthMm; y += 250) {
    const weight = y % 1000 === 0 ? "strong" : y % 500 === 0 ? "medium" : "thin";
    if (weight === "thin" && !showThinGrid) continue;
    if (weight === "medium" && !showMediumGrid) continue;
    gridLines.push({ key: `h${y}`, x1: 0, y1: y, x2: workspace.widthMm, y2: y, weight });
  }

  useEffect(() => {
    // Escape cancels an in-progress draw without discarding an already-confirmed polygon.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && isDrawing) resetDraft();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDrawing]);

  const previewSegment = isDrawing && hoverWorldPoint && draftVertices.length > 0
    ? { from: toDisplay(draftVertices[draftVertices.length - 1]!), to: toDisplay(snappedNextVertex(hoverWorldPoint)) }
    : null;

  return (
    <div className="plotPolygonEditor">
      {readOnly ? (
        <p className="libraryHint">Vyber nebo vytvoř zónu vlevo — plocha stánku je zobrazená jako podklad.</p>
      ) : (
      <div className="plotEditorToolbar">
        <button type="button" className="lightButton" onClick={isDrawing ? resetDraft : startRedraw}>
          {isDrawing ? "Zrušit kreslení" : polygon ? "Kreslit nový tvar" : "Kreslit plochu"}
        </button>
        {isDrawing && draftVertices.length > 0 && (
          <button type="button" className="lightButton" onClick={undoLastVertex}>Zpět (Undo)</button>
        )}
        {isDrawing && draftVertices.length >= 3 && (
          <button type="button" className="primaryButton" onClick={closeDraft} disabled={validation !== null && !validation.valid}>
            Zavřít polygon
          </button>
        )}
        <div className="plotQuickRectangle">
          <PlotSizeInput label="ŠÍŘKA" value={quickWidthMm} onCommit={setQuickWidthMm} />
          <PlotSizeInput label="HLOUBKA" value={quickDepthMm} onCommit={setQuickDepthMm} />
          <button type="button" className="lightButton" onClick={createQuickRectangle}>Vytvořit obdélník</button>
        </div>
      </div>
      )}

      {validation && !validation.valid && (
        <p className="uploadError persistenceBanner">
          {validation.issues.map((issue) => VALIDATION_ISSUE_LABELS_CS[issue] ?? issue).join(" ")}
        </p>
      )}

      <div className="plotEditorSecondaryBar">
        {activeVertices.length >= 3 && (!validation || validation.valid) && (
          <div className="plotAreaSummary">
            <span>Plocha: <strong>{plotAreaSquareMeters(activeVertices).toFixed(2)} m²</strong></span>
            <span>Obvod: <strong>{plotPerimeterMeters(activeVertices).toFixed(2)} m</strong></span>
          </div>
        )}
        <ViewportToolbar
          zoomPercent={viewport.zoomPercent}
          onZoomOut={viewport.zoomOut}
          onZoomIn={viewport.zoomIn}
          onFit={() => viewport.fitToContent(fitBoundsForViewport)}
          onReset={viewport.resetZoom}
        />
      </div>

      <div className="plotEditorViewportArea">
        <div
          ref={viewport.viewportRef}
          className={viewport.isPanning ? "plotEditorViewport panning" : viewport.isSpacePressed ? "plotEditorViewport panReady" : "plotEditorViewport"}
          onPointerDown={(event) => { if (!viewport.startPan(event)) return; }}
          onPointerMove={viewport.movePan}
          onPointerUp={viewport.endPan}
          onPointerCancel={viewport.endPan}
        >
          <div
            className="plotEditorViewportStage"
            style={{
              width: `${workspace.widthMm * viewport.pixelsPerMm}px`,
              height: `${workspace.depthMm * viewport.pixelsPerMm}px`,
              transform: `translate(${viewport.transform.pan.x}px, ${viewport.transform.pan.y}px) scale(${viewport.transform.zoom})`,
            }}
          >
            <svg
              className="plotEditorCanvas"
              viewBox={`0 0 ${workspace.widthMm} ${workspace.depthMm}`}
              preserveAspectRatio="none"
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
            >
              {gridLines.map((line) => (
                <line key={line.key} className={`plotGridLine plotGridLine-${line.weight}`} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
              ))}

              {boundaryPolygon && boundaryPolygon.length >= 3 && (
                <path
                  className="plotOutsideMask"
                  fillRule="evenodd"
                  d={`M0,0 L${workspace.widthMm},0 L${workspace.widthMm},${workspace.depthMm} L0,${workspace.depthMm} Z ${polygonPathData(boundaryPolygon)}`}
                />
              )}

              {referenceShapes.map((shape) => (
                <polygon key={shape.id} className={shape.className ?? "plotReferenceShape"} points={pointsAttr(shape.polygon)} />
              ))}

              {activeVertices.length >= 2 && (
                <polygon
                  className={[shapeClassName ?? "plotShape", isDrawing ? "drawing" : "", validation && !validation.valid ? "invalid" : ""].filter(Boolean).join(" ")}
                  points={pointsAttr(activeVertices)}
                />
              )}

              {previewSegment && (
                <line className="plotPreviewEdge" x1={previewSegment.from.x} y1={previewSegment.from.y} x2={previewSegment.to.x} y2={previewSegment.to.y} />
              )}

              {activeVertices.map((vertex, index) => {
                const display = toDisplay(vertex);
                const isFirst = index === 0;
                return (
                  <circle
                    key={index}
                    className={["plotVertex", isFirst && isDrawing && draftVertices.length >= 3 ? "closable" : ""].filter(Boolean).join(" ")}
                    cx={display.x}
                    cy={display.y}
                    r={Math.max(90, 25 / viewport.transform.zoom)}
                    onPointerDown={(event) => {
                      if (readOnly || isDrawing) return;
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDraggingIndex(index);
                    }}
                    onPointerUp={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      setDraggingIndex(null);
                    }}
                  />
                );
              })}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
