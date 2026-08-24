/**
 * Individual-mode booth PLOT — the real, possibly non-rectangular footprint (L/U/triangle/cut-
 * corner/...) the user draws for their exhibition plot. A polygon, never a series of rectangular
 * patches, and never the bounding rectangle standing in for the real shape (area/perimeter/
 * point-containment all use the actual polygon geometry — see geometry/polygons.ts).
 *
 * Layering: this file is domain-level (project/business concepts — "the plot", "the workspace",
 * "which components fell outside the plot"); geometry/polygons.ts stays pure math with no
 * knowledge of ProjectRecord/PlacedComponent.
 */
import type { PlacedComponent, Point } from "./models.ts";
import { isObjectLocked } from "./locking.ts";
import {
  getBounds,
  isPointInOrOnPolygon,
  polygonAreaMm2,
  polygonPerimeterMm,
  validatePolygon,
  type PolygonValidationResult,
} from "../geometry/polygons.ts";
import { roundToGridMm, INDIVIDUAL_GRID_MM } from "../geometry/placement.ts";

/** A closed polygon boundary in world mm (see domain/planView.ts's world convention: X=width right, Y=depth, Y=0 front/open side). The array holds vertices only — the edge back to the first vertex is implicit, exactly like BoothType's other geometry. */
export type PlotPolygon = readonly Point[];

/** The drawing canvas the user works in — NEVER the booth footprint itself. A 10×10 m workspace is just room to draw in; the plot polygon (drawn inside it) is the real, generally smaller, footprint. */
export type IndividualWorkspace = Readonly<{
  widthMm: number;
  depthMm: number;
}>;

export const DEFAULT_INDIVIDUAL_WORKSPACE: IndividualWorkspace = {
  widthMm: 10_000,
  depthMm: 10_000,
};

/**
 * Section 1/2: EDIT vs CONFIRMED/LOCKED — the plot polygon's own workflow state, persisted on
 * ProjectRecord.individualPlotStatus (JSONB, no DB migration). Absent (a project saved by the
 * pre-lock foundation) resolves to "draft" via resolvePlotStatus below — an old saved plot never
 * silently counts as already-confirmed. Locking is never permanent: "Upravit plochu" always
 * returns it to "draft" (domain/floorZones.ts's FloorZoneStatus mirrors this exact pattern for
 * each individual floor zone).
 */
export const PLOT_STATUSES = ["draft", "confirmed"] as const;
export type PlotStatus = (typeof PLOT_STATUSES)[number];

export function resolvePlotStatus(status: PlotStatus | undefined): PlotStatus {
  return status ?? "draft";
}

export function isPlotConfirmed(status: PlotStatus | undefined): boolean {
  return resolvePlotStatus(status) === "confirmed";
}

/** Section 3/26: a plot can only be confirmed once it exists and is geometrically valid — the same hard-validation-at-confirm-time principle as floor zones (never "save now, warn later"). */
export function canConfirmPlot(polygon: PlotPolygon | undefined): boolean {
  return Boolean(polygon && validatePolygon(polygon).valid);
}

/** 0/45/90/135/180/225/270/315 — the 8 Octanorm-column connection directions (see domain/generatorBoothComponents.ts's DEFAULT_BOOTH_COMPONENT_ROTATION and the plot/floor-zone vertex angle snap). */
export const PLOT_ANGLE_SNAP_DEG = 45;

export function snapPlotVertexToGrid(point: Point, gridMm: number = INDIVIDUAL_GRID_MM): Point {
  return { x: roundToGridMm(point.x, gridMm), y: roundToGridMm(point.y, gridMm) };
}

/**
 * Snaps `candidate` so the edge FROM `anchor` TO `candidate` lands on one of the 8 permitted
 * angles (0/45/90/.../315°), preserving the drawn edge's length exactly — only its direction is
 * snapped. The grid-snapped candidate is used as the length reference so the result still lands
 * on a real grid point whenever the snapped angle is axis-aligned or diagonal at a grid-multiple
 * distance. Returns `candidate` unchanged if `anchor` and `candidate` coincide (zero-length edge
 * — nothing meaningful to snap).
 */
export function snapEdgeAngle(anchor: Point, candidate: Point, angleStepDeg: number = PLOT_ANGLE_SNAP_DEG): Point {
  const gridSnapped = snapPlotVertexToGrid(candidate);
  const dx = gridSnapped.x - anchor.x;
  const dy = gridSnapped.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return gridSnapped;
  const angleRad = Math.atan2(dy, dx);
  const stepRad = (angleStepDeg * Math.PI) / 180;
  const snappedAngleRad = Math.round(angleRad / stepRad) * stepRad;
  return snapPlotVertexToGrid({
    x: anchor.x + Math.cos(snappedAngleRad) * distance,
    y: anchor.y + Math.sin(snappedAngleRad) * distance,
  });
}

/** Quick-rectangle convenience (see the report's "Quick rectangle" section) — the RESULT is a plain polygon, never a second rectangle data model. */
export function createRectanglePlotPolygon(widthMm: number, depthMm: number): PlotPolygon {
  return [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: depthMm },
    { x: 0, y: depthMm },
  ];
}

/**
 * Same rectangle as createRectanglePlotPolygon, but translated to sit CENTERED within the
 * workspace canvas rather than anchored at its (0,0) corner — used only for the "Vytvořit
 * obdélník" quick-start convenience (report section 3/6): a corner-anchored default plot fits
 * mathematically correctly but visually wastes half the viewport on empty workspace the user
 * never asked to see, since Fit centers on the shape's own bounds regardless of where in the
 * workspace it sits. Never used for a user-DRAWN polygon (those keep whatever position the user
 * actually clicked).
 */
export function createCenteredRectanglePlotPolygon(
  workspace: IndividualWorkspace,
  widthMm: number,
  depthMm: number,
): PlotPolygon {
  const offsetX = Math.max(0, (workspace.widthMm - widthMm) / 2);
  const offsetY = Math.max(0, (workspace.depthMm - depthMm) / 2);
  return createRectanglePlotPolygon(widthMm, depthMm).map((vertex) => ({
    x: vertex.x + offsetX,
    y: vertex.y + offsetY,
  }));
}

export function validatePlotPolygon(polygon: PlotPolygon): PolygonValidationResult {
  return validatePolygon(polygon);
}

export function isPolygonWithinWorkspace(polygon: PlotPolygon, workspace: IndividualWorkspace): boolean {
  return polygon.every(
    (vertex) => vertex.x >= 0 && vertex.x <= workspace.widthMm && vertex.y >= 0 && vertex.y <= workspace.depthMm,
  );
}

export function plotAreaSquareMeters(polygon: PlotPolygon): number {
  return polygonAreaMm2(polygon) / 1_000_000;
}

export function plotPerimeterMeters(polygon: PlotPolygon): number {
  return polygonPerimeterMm(polygon) / 1000;
}

export function plotBoundsMm(polygon: PlotPolygon) {
  return getBounds(polygon);
}

/** Arithmetic mean of the vertices — a cheap, adequate "roughly the middle" point; NOT a true area centroid, and not guaranteed to lie inside a concave (L/U) polygon on its own (see resolveDefaultAnchorOnPlot, which falls back to a vertex when it doesn't). */
export function polygonCentroid(polygon: PlotPolygon): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };
  const sum = polygon.reduce((acc, vertex) => ({ x: acc.x + vertex.x, y: acc.y + vertex.y }), { x: 0, y: 0 });
  return { x: sum.x / polygon.length, y: sum.y / polygon.length };
}

/**
 * Turn 5 LIVE QA bug (report section 28/31): a booth_component/furniture insert used to always
 * land at a HARDCODED world point (1000, 1500) regardless of where the real plot polygon actually
 * sits inside a (possibly much larger, possibly relocated) workspace — Fit/pan is scoped tightly
 * to the plot, so an insert 5-10m away from it landed real DOM/scene content far outside the
 * currently-visible viewport: not actually invisible, just effectively unreachable without a
 * manual pan/zoom-out. This resolves a default anchor that is ALWAYS valid-on-the-current-plot:
 * the grid-snapped polygon centroid when it happens to land inside/on the plot (true for convex
 * shapes and most everyday L/U shapes), otherwise the polygon's own first vertex — which is by
 * definition always ON the boundary, so isAnchorInsidePlot always accepts it (same boundary-
 * inclusive rule as section 32's "anchor may be inside OR on the boundary"). Never a bounding-box
 * center (not guaranteed inside a concave plot) and never a random offset.
 */
export function resolveDefaultAnchorOnPlot(polygon: PlotPolygon): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };
  const centroid = snapPlotVertexToGrid(polygonCentroid(polygon));
  if (isAnchorInsidePlot(centroid, polygon)) return centroid;
  return snapPlotVertexToGrid(polygon[0]!);
}

/**
 * Section 19 ("KONSTRUKČNÍ BOUNDARY"): a booth_component's PLACEMENT ANCHOR (its xMm/yMm center)
 * must be inside or on the plot boundary — never a full-footprint-bounding-box-inside-polygon
 * rule. A real Octanorm part's actual geometry legitimately extends past its own nominal
 * connection axis (e.g. a 40 mm sloupek centered exactly ON the plot's boundary line), and
 * clamping/rejecting based on the full physical footprint would be exactly the kind of
 * arbitrary auto-clamp hack this phase must NOT introduce. Actual-geometry overshoot past the
 * boundary is a separate, later concern (see the foundation report) — not validated here.
 */
export function isAnchorInsidePlot(anchor: Point, polygon: PlotPolygon, boundaryToleranceMm = 1): boolean {
  return isPointInOrOnPolygon(anchor, polygon, boundaryToleranceMm);
}

/** Section 30: components whose anchor fell outside the CURRENT plot polygon — e.g. after the user edited the polygon smaller. Returns ids only; the caller decides how to present/resolve the conflict (never auto-deleted/auto-moved). */
export function findComponentAnchorsOutsidePlot<T extends Pick<Point, "x" | "y"> & { id: string }>(
  anchors: readonly T[],
  polygon: PlotPolygon,
): readonly string[] {
  return anchors.filter((anchor) => !isAnchorInsidePlot(anchor, polygon)).map((anchor) => anchor.id);
}

export type PlotComponentMoveResult = Readonly<{
  accepted: boolean;
  component: PlacedComponent;
  reason?: "locked" | "invalid-position";
}>;

/** Same anchor-in-plot semantics as isAnchorInsidePlot, exposed with the (booth, x, y) shape geometry/placement.ts's own isPlacementValid uses, for call-site symmetry with the typovka rectangle path. */
export function isPlacementValidOnPlot(polygon: PlotPolygon, xMm: number, yMm: number): boolean {
  return isAnchorInsidePlot({ x: xMm, y: yMm }, polygon);
}

/**
 * Polygon-aware sibling of geometry/placement.ts's tryMoveComponent (same accept/reject
 * contract, same locked-check-first order) — used ONLY for Individual mode's Konstrukce step.
 * Deliberately simpler than tryMoveComponent: no X-only/Y-only obstacle-slide fallback (that
 * behavior exists for typovka's rigid wall obstacles; a plot boundary is a soft layout boundary,
 * not a collision obstacle to slide along) — an out-of-plot move is just rejected outright, the
 * component stays at its last valid position. Typovka's own tryMoveComponent is completely
 * untouched.
 */
export function tryMoveComponentOnPlot(
  polygon: PlotPolygon,
  component: PlacedComponent,
  xMm: number,
  yMm: number,
): PlotComponentMoveResult {
  if (isObjectLocked(component)) {
    return { accepted: false, component, reason: "locked" };
  }
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm) || !isPlacementValidOnPlot(polygon, xMm, yMm)) {
    return { accepted: false, component, reason: "invalid-position" };
  }
  if (component.xMm === xMm && component.yMm === yMm) {
    return { accepted: true, component };
  }
  return { accepted: true, component: { ...component, xMm, yMm } };
}

/**
 * Section 11 (legacy foundation compatibility): a project saved by the pre-polygon Individual
 * foundation has only individualWidthMm/individualDepthMm, no individualPlotPolygon. Derives the
 * equivalent rectangle polygon so every polygon-based reader has a real PlotPolygon to work with
 * — the derivation is NEVER written back to the project document by this function (no silent/
 * destructive migration); it only happens again, in-memory, every time an old record loads,
 * until the user actually edits/saves the plot (at which point the real field is persisted).
 * The new individualPlotPolygon field is always preferred when present — it is the source of
 * truth for every project saved after this phase.
 */
export function resolveIndividualPlotPolygon(
  project: Readonly<{
    individualPlotPolygon?: PlotPolygon;
    individualWidthMm?: number;
    individualDepthMm?: number;
  }>,
): PlotPolygon | undefined {
  if (project.individualPlotPolygon && project.individualPlotPolygon.length > 0) {
    return project.individualPlotPolygon;
  }
  if (project.individualWidthMm && project.individualDepthMm) {
    return createRectanglePlotPolygon(project.individualWidthMm, project.individualDepthMm);
  }
  return undefined;
}
