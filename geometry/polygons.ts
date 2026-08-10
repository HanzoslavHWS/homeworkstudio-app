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
