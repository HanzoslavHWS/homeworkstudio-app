import type { CollisionRect, Point } from "../domain/models.ts";

const COLLISION_EPSILON = 1e-9;

export function getRotatedCorners(
  centerX: number,
  centerY: number,
  width: number,
  depth: number,
  rotationDeg: number,
): Point[] {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return [
    { x: -halfWidth, y: -halfDepth },
    { x: halfWidth, y: -halfDepth },
    { x: halfWidth, y: halfDepth },
    { x: -halfWidth, y: halfDepth },
  ].map((point) => ({
    x: centerX + point.x * cos - point.y * sin,
    y: centerY + point.x * sin + point.y * cos,
  }));
}

export function rectToPoints(rect: CollisionRect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function getAxes(points: readonly Point[]): Point[] {
  const axes: Point[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const normalX = -(next.y - current.y);
    const normalY = next.x - current.x;
    const length = Math.hypot(normalX, normalY);

    if (length > 0) {
      axes.push({ x: normalX / length, y: normalY / length });
    }
  }

  return axes;
}

function projectPoints(points: readonly Point[], axis: Point) {
  const projections = points.map((point) => point.x * axis.x + point.y * axis.y);
  return { min: Math.min(...projections), max: Math.max(...projections) };
}

/** SAT overlap where touching edges are explicitly not a collision. */
export function polygonsOverlap(
  polygonA: readonly Point[],
  polygonB: readonly Point[],
): boolean {
  for (const axis of [...getAxes(polygonA), ...getAxes(polygonB)]) {
    const projectionA = projectPoints(polygonA, axis);
    const projectionB = projectPoints(polygonB, axis);

    if (
      projectionA.max <= projectionB.min + COLLISION_EPSILON ||
      projectionB.max <= projectionA.min + COLLISION_EPSILON
    ) {
      return false;
    }
  }

  return true;
}

export function getBounds(points: readonly Point[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

// =========================================================================================
// GENERAL (possibly concave) simple-polygon geometry — for the Individual-mode booth plot,
// floor zones, and anything else that isn't a plain axis-aligned rectangle or a convex
// component footprint. `polygonsOverlap`/getAxes/projectPoints above are SAT-based and only
// correct for CONVEX polygons (fine for rotated rectangular component footprints); everything
// below is winding-order-agnostic and works for any simple (non-self-intersecting) polygon,
// convex or concave.
// =========================================================================================

const POLYGON_EPSILON = 1e-6;

/** Signed area via the shoelace formula. Sign depends only on vertex winding order — magnitude is the true area regardless of direction, which is why polygonAreaMm2 always takes the absolute value. */
export function signedPolygonAreaMm2(points: readonly Point[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

/** Winding-direction-independent area in mm² — never fabricates a value for a self-intersecting/degenerate polygon; callers should validate first (see isSimplePolygon). */
export function polygonAreaMm2(points: readonly Point[]): number {
  return Math.abs(signedPolygonAreaMm2(points));
}

/** Sum of edge lengths (the polygon is treated as closed — last vertex connects back to the first). */
export function polygonPerimeterMm(points: readonly Point[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    sum += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return sum;
}

/** True area magnitude of 0 (a degenerate line/point) is the one case signedPolygonAreaMm2 can't itself distinguish from "not yet validated" — expose the sign directly for callers (e.g. a future "normalize winding" step) that need it. */
export function isPolygonClockwise(points: readonly Point[]): boolean {
  return signedPolygonAreaMm2(points) < 0;
}

/** Standard ray-casting point-in-polygon test — correct for convex AND concave simple polygons. Boundary behavior is intentionally ambiguous (floating point); use isPointOnPolygonBoundary/isPointInOrOnPolygon when the boundary must count as "inside". */
export function isPointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index]!;
    const before = polygon[previous]!;
    const crosses = current.y > point.y !== before.y > point.y;
    if (!crosses) continue;
    const intersectX = ((before.x - current.x) * (point.y - current.y)) / (before.y - current.y) + current.x;
    if (point.x < intersectX) inside = !inside;
  }
  return inside;
}

function distancePointToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Whether `point` lies on (within toleranceMm of) any edge of `polygon`, treated as closed. */
export function isPointOnPolygonBoundary(point: Point, polygon: readonly Point[], toleranceMm = 1): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    if (distancePointToSegment(point, current, next) <= toleranceMm) return true;
  }
  return false;
}

/** Inside OR on the boundary — the semantics the Individual-mode plot/placement rules actually need (see domain/plot.ts). */
export function isPointInOrOnPolygon(point: Point, polygon: readonly Point[], boundaryToleranceMm = 1): boolean {
  return isPointInPolygon(point, polygon) || isPointOnPolygonBoundary(point, polygon, boundaryToleranceMm);
}

function orientation(a: Point, b: Point, c: Point): 0 | 1 | 2 {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < POLYGON_EPSILON) return 0;
  return value > 0 ? 1 : 2;
}

function onSegmentBetween(a: Point, point: Point, b: Point): boolean {
  return (
    point.x <= Math.max(a.x, b.x) + POLYGON_EPSILON &&
    point.x >= Math.min(a.x, b.x) - POLYGON_EPSILON &&
    point.y <= Math.max(a.y, b.y) + POLYGON_EPSILON &&
    point.y >= Math.min(a.y, b.y) - POLYGON_EPSILON
  );
}

/** Proper-crossing segment intersection test (Bentley–Ottmann-style orientation test), including collinear-overlap cases. Two segments that only share an endpoint are NOT considered crossing (o=0 with the shared point itself always satisfies onSegmentBetween trivially) — callers doing polygon self-intersection must skip adjacent edges themselves; see isSimplePolygon. */
export function segmentsIntersect(p1: Point, q1: Point, p2: Point, q2: Point): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegmentBetween(p1, p2, q1)) return true;
  if (o2 === 0 && onSegmentBetween(p1, q2, q1)) return true;
  if (o3 === 0 && onSegmentBetween(p2, p1, q2)) return true;
  if (o4 === 0 && onSegmentBetween(p2, q1, q2)) return true;
  return false;
}

function pointsEqual(a: Point, b: Point, toleranceMm = POLYGON_EPSILON): boolean {
  return Math.abs(a.x - b.x) <= toleranceMm && Math.abs(a.y - b.y) <= toleranceMm;
}

/**
 * Whether `polygon` (treated as closed) has any pair of non-adjacent edges that cross. Adjacent
 * edges (sharing a vertex) are always skipped — they meet at that vertex by construction, which
 * is never itself a self-intersection. A polygon with fewer than 4 vertices can never
 * self-intersect (a triangle's edges only ever share vertices) and is trivially simple here.
 */
export function isSimplePolygon(polygon: readonly Point[]): boolean {
  if (polygon.length < 4) return true; // a triangle's edges only ever share vertices
  return !hasCrossing(polygon);
}

function hasCrossing(polygon: readonly Point[]): boolean {
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a1 = polygon[i]!;
    const a2 = polygon[(i + 1) % n]!;
    for (let j = i + 1; j < n; j += 1) {
      const isSameEdge = j === i;
      const isAdjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (isSameEdge || isAdjacent) continue;
      const b1 = polygon[j]!;
      const b2 = polygon[(j + 1) % n]!;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * Strictly TRANSVERSAL crossing only (all four orientations non-zero) — unlike segmentsIntersect
 * above, this deliberately does NOT count a shared/collinear-overlapping edge or a touching
 * endpoint as a crossing. Two floor zones (or any two polygons) that merely butt up against each
 * other along a shared boundary are NOT overlapping (zero shared area) — only a genuine
 * area-overlap should ever be flagged as a conflict. Kept separate from segmentsIntersect, whose
 * broader touching-counts-too semantics are exactly right for ONE polygon's own
 * self-intersection check (isSimplePolygon) but wrong here.
 */
function properlyCrosses(p1: Point, q1: Point, p2: Point, q2: Point): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/**
 * Two simple polygons (convex or concave) overlap if any pair of edges properly (transversally)
 * crosses, OR one polygon is fully/partially contained in the other with no crossing edges at
 * all (e.g. one entirely inside the other) — checked via STRICT interior containment
 * (isPointInPolygon already excludes the boundary), so two polygons that only touch along a
 * shared edge/vertex are never flagged. Sufficient for flagging a validation conflict (see
 * domain/floorZones.ts) — not a full Boolean/clipping intersection, deliberately: we only ever
 * need yes/no here, never the intersection shape itself.
 */
/** Every vertex PLUS every edge midpoint — vertices alone are the exact points most likely to land precisely on a shared/touching boundary (a T-junction, a shared corner), which is what makes vertex-only containment checks unreliable for this purpose; a midpoint is only ever on the other polygon's boundary when the two edges genuinely run along the same line (i.e. still just touching, correctly excluded). */
function polygonSamplePoints(polygon: readonly Point[]): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    points.push(current, { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 });
  }
  // Turn 5 LIVE QA section 13: vertex/edge-midpoint sampling alone misses the EXACT-DUPLICATE
  // (and more generally near-duplicate) polygon case — every sample point of an identical
  // polygon B lands precisely ON A's own boundary (not strictly inside it), since they're the
  // same edges, so the vertex/midpoint checks below all correctly-but-uselessly report "boundary,
  // not interior". The arithmetic-mean centroid is genuinely INTERIOR for any convex polygon (and
  // for most everyday concave L/U shapes) even when the polygon is identical to the other one —
  // it never coincides with either polygon's boundary the way a vertex/midpoint can. Not a
  // universal fix for pathological concave/star shapes (where the mean can fall outside), which
  // is exactly why it's an ADDITIONAL sample point alongside the existing ones, never a
  // replacement for them.
  const centroid = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  points.push({ x: centroid.x / points.length, y: centroid.y / points.length });
  return points;
}

/**
 * Two simple polygons (convex or concave) overlap if any pair of edges properly (transversally)
 * crosses, OR either polygon has a sample point (a vertex or edge midpoint) STRICTLY inside the
 * other (never merely on its boundary — see isPointOnPolygonBoundary). Sample points rather than
 * vertices alone: two zones that only share a boundary/corner would otherwise misfire, because a
 * shared VERTEX is exactly the point most likely to land ambiguously on the other polygon's edge
 * (a known ray-casting corner case) — an edge MIDPOINT only ever coincides with the other
 * polygon's boundary when the edges are genuinely collinear (i.e. still just touching, correctly
 * excluded by the boundary check either way). Sufficient for flagging a validation conflict (see
 * domain/floorZones.ts) — not a full Boolean/clipping intersection, deliberately: we only ever
 * need yes/no here, never the intersection shape itself.
 */
export function polygonsIntersectGeneral(a: readonly Point[], b: readonly Point[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i]!;
    const a2 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j]!;
      const b2 = b[(j + 1) % b.length]!;
      if (properlyCrosses(a1, a2, b1, b2)) return true;
    }
  }
  const isStrictlyInside = (point: Point, polygon: readonly Point[]) =>
    isPointInPolygon(point, polygon) && !isPointOnPolygonBoundary(point, polygon);
  return (
    polygonSamplePoints(a).some((point) => isStrictlyInside(point, b)) ||
    polygonSamplePoints(b).some((point) => isStrictlyInside(point, a))
  );
}

/**
 * Whether `inner` (convex or concave) lies ENTIRELY inside-or-on-the-boundary-of `outer` — used
 * for the individual-mode floor-zone hard "must be fully inside the confirmed plot" rule
 * (domain/floorZones.ts's validateFloorZoneForConfirm). Two checks, both necessary for a
 * concave `outer`: every vertex of `inner` must be inside-or-on `outer` (rules out an inner
 * vertex poking out), AND no edge of `inner` may properly cross any edge of `outer` (rules out
 * an edge bulging outside through a concave notch even when every VERTEX happens to land back
 * inside — vertex-only containment is not sufficient for a concave outer boundary).
 */
export function isPolygonFullyContainedIn(inner: readonly Point[], outer: readonly Point[]): boolean {
  if (!inner.every((vertex) => isPointInOrOnPolygon(vertex, outer))) return false;
  for (let i = 0; i < inner.length; i += 1) {
    const a1 = inner[i]!;
    const a2 = inner[(i + 1) % inner.length]!;
    for (let j = 0; j < outer.length; j += 1) {
      const b1 = outer[j]!;
      const b2 = outer[(j + 1) % outer.length]!;
      if (properlyCrosses(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

export type PolygonValidationIssue =
  | "too_few_points"
  | "duplicate_points"
  | "zero_length_edge"
  | "self_intersecting";

export type PolygonValidationResult = Readonly<{
  valid: boolean;
  issues: readonly PolygonValidationIssue[];
}>;

/**
 * Minimal, honest polygon validity — never uses the bounding rectangle as a stand-in for real
 * shape validity (an L/U/triangle/cut-corner shape must validate on its OWN geometry). Does not
 * check winding direction — every function above is winding-agnostic by construction, so a
 * clockwise or counter-clockwise polygon are equally valid.
 */
export function validatePolygon(points: readonly Point[]): PolygonValidationResult {
  const issues: PolygonValidationIssue[] = [];
  if (points.length < 3) {
    issues.push("too_few_points");
    return { valid: false, issues };
  }

  const n = points.length;
  let hasZeroLengthEdge = false;
  for (let index = 0; index < n; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % n]!;
    if (pointsEqual(current, next)) hasZeroLengthEdge = true;
  }
  if (hasZeroLengthEdge) issues.push("zero_length_edge");

  let hasDuplicatePoint = false;
  for (let i = 0; i < n && !hasDuplicatePoint; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const isAdjacentZeroLength = j === i + 1 || (i === 0 && j === n - 1);
      if (isAdjacentZeroLength) continue; // already reported as zero_length_edge above
      if (pointsEqual(points[i]!, points[j]!)) {
        hasDuplicatePoint = true;
        break;
      }
    }
  }
  if (hasDuplicatePoint) issues.push("duplicate_points");

  if (!hasZeroLengthEdge && !hasDuplicatePoint && hasCrossing(points)) {
    issues.push("self_intersecting");
  }

  return { valid: issues.length === 0, issues };
}
