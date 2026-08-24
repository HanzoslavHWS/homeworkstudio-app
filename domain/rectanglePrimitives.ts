/**
 * Individual-mode "Plocha" authoring helper (Turn 5 LIVE QA report sections 5-11): a quick,
 * purely-rectangular way to compose a booth polygon out of primitive rectangles (e.g. 5x5 + 2x3
 * -> an L), as an ALTERNATIVE authoring workflow next to point-by-point polygon drawing — never a
 * replacement for it (freehand/45°/triangle/trapezoid drawing in PlotPolygonEditor keeps working
 * exactly as before, untouched by this file).
 *
 * Primitives are authoring-only helpers, never the booth's own source of truth: "Sloučit do
 * plochy stánku" turns the CURRENT set into one real PlotPolygon via a robust polygon union
 * (geometry/polygonBoolean.ts, backed by the `polygon-clipping` library — never a hand-rolled
 * clipping engine) and THAT polygon becomes individualPlotPolygon. The primitive list itself may
 * still be persisted (ProjectRecord.individualPlotPrimitives) so authoring work survives a
 * reload, but it is never read as booth geometry by floor/construction/furniture logic — only
 * individualPlotPolygon is.
 */
import type { Point } from "./models.ts";
import type { PlotPolygon } from "./plot.ts";
import { unionPolygons } from "../geometry/polygonBoolean.ts";
import { roundToGridMm, INDIVIDUAL_GRID_MM } from "../geometry/placement.ts";

/** A rectangle's own outline is unaffected by 45° edges, so a coarser 90° step (report section 6: "rotate minimálně 90°") is intentional here — not an inconsistency with the polygon-vertex/booth_component 45° convention used elsewhere. */
export type PrimitiveRotationDeg = 0 | 90 | 180 | 270;

export type RectanglePrimitive = Readonly<{
  id: string;
  /** Center point in world mm — same anchor convention as PlacedComponent's xMm/yMm, never a corner. */
  xMm: number;
  yMm: number;
  widthMm: number;
  depthMm: number;
  rotationDeg: PrimitiveRotationDeg;
}>;

export function createRectanglePrimitive(input: { id: string; xMm: number; yMm: number; widthMm?: number; depthMm?: number }): RectanglePrimitive {
  return {
    id: input.id,
    xMm: roundToGridMm(input.xMm, INDIVIDUAL_GRID_MM),
    yMm: roundToGridMm(input.yMm, INDIVIDUAL_GRID_MM),
    widthMm: input.widthMm && input.widthMm > 0 ? input.widthMm : 1000,
    depthMm: input.depthMm && input.depthMm > 0 ? input.depthMm : 1000,
    rotationDeg: 0,
  };
}

export function rotatePrimitive90(primitive: RectanglePrimitive): RectanglePrimitive {
  return { ...primitive, rotationDeg: (((primitive.rotationDeg + 90) % 360) as PrimitiveRotationDeg) };
}

export function movePrimitive(primitive: RectanglePrimitive, dxMm: number, dyMm: number): RectanglePrimitive {
  return { ...primitive, xMm: primitive.xMm + dxMm, yMm: primitive.yMm + dyMm };
}

export function duplicatePrimitive(primitive: RectanglePrimitive, newId: string): RectanglePrimitive {
  // Offset by one grid step so the copy is never exactly stacked on the original (same "avoid an
  // invisible identical duplicate" concern as the floor-zone default-position fix — report section 12).
  return { ...primitive, id: newId, xMm: primitive.xMm + INDIVIDUAL_GRID_MM, yMm: primitive.yMm + INDIVIDUAL_GRID_MM };
}

/** The rectangle's own 4 corners in world mm, rotated about its center — never scaled, never a bounding-box approximation. */
export function rectanglePrimitivePolygon(primitive: RectanglePrimitive): PlotPolygon {
  const halfW = primitive.widthMm / 2;
  const halfD = primitive.depthMm / 2;
  const corners: Point[] = [
    { x: -halfW, y: -halfD },
    { x: halfW, y: -halfD },
    { x: halfW, y: halfD },
    { x: -halfW, y: halfD },
  ];
  const rad = (primitive.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return corners.map((corner) => ({
    x: primitive.xMm + corner.x * cos - corner.y * sin,
    y: primitive.yMm + corner.x * sin + corner.y * cos,
  }));
}

/** String discriminant (rather than a boolean `ok`) — narrows reliably across a 3-member union. */
export type MergePrimitivesResult =
  | Readonly<{ status: "merged"; polygon: PlotPolygon }>
  | Readonly<{ status: "no-primitives" }>
  | Readonly<{ status: "disconnected"; regionCount: number }>;

/**
 * Report section 9: primitives whose union has MORE THAN ONE disconnected region must never be
 * silently merged with a fake connecting edge — this is a hard failure (regionCount > 1),
 * surfaced to the caller to show as a clear error, never auto-fixed.
 */
export function mergePrimitivesToPolygon(primitives: readonly RectanglePrimitive[]): MergePrimitivesResult {
  if (primitives.length === 0) return { status: "no-primitives" };
  const regions = unionPolygons(primitives.map(rectanglePrimitivePolygon));
  if (regions.length !== 1) return { status: "disconnected", regionCount: regions.length };
  return { status: "merged", polygon: regions[0]!.map((point) => ({ x: roundToGridMm(point.x, INDIVIDUAL_GRID_MM), y: roundToGridMm(point.y, INDIVIDUAL_GRID_MM) })) };
}
