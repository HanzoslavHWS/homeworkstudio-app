import type {
  BoothType,
  PlacedComponent,
  Placement,
} from "../domain/models.ts";
import { getBounds, getRotatedCorners, polygonsOverlap, rectToPoints } from "./polygons.ts";

export function isPlacementValid(
  booth: BoothType,
  component: Pick<PlacedComponent, "widthMm" | "depthMm">,
  placement: Placement,
): boolean {
  if (booth.widthMm === null || booth.depthMm === null) {
    return false;
  }

  const footprint = getRotatedCorners(
    placement.x,
    placement.y,
    component.widthMm,
    component.depthMm,
    placement.rotationDeg,
  );

  const isInsideFloor = footprint.every(
    (point) =>
      point.x >= 0 &&
      point.x <= booth.widthMm! &&
      point.y >= 0 &&
      point.y <= booth.depthMm!,
  );

  if (!isInsideFloor) {
    return false;
  }

  return booth.collisionObstacles.every(
    (obstacle) => !polygonsOverlap(footprint, rectToPoints(obstacle)),
  );
}

export function applySnap(
  booth: BoothType,
  component: Pick<PlacedComponent, "widthMm" | "depthMm">,
  centerX: number,
  centerY: number,
  rotationDeg: number,
): { x: number; y: number } {
  if (booth.widthMm === null || booth.depthMm === null) {
    return { x: centerX, y: centerY };
  }

  let x = centerX;
  let y = centerY;
  const snapDistance = 40;
  const currentBounds = () =>
    getBounds(
      getRotatedCorners(
        x,
        y,
        component.widthMm,
        component.depthMm,
        rotationDeg,
      ),
    );
  let bounds = currentBounds();

  // Exact Koje 2 × 2 inner construction edges.
  if (booth.id === "koje-2x2") {
    if (y >= 40 && bounds.minY < 80 + snapDistance) {
      y += 80 - bounds.minY;
      bounds = currentBounds();
    }

    const overlapsLeftWallDepth = bounds.maxY > 0 && bounds.minY < 1000;
    if (overlapsLeftWallDepth && x >= 40 && bounds.minX < 80 + snapDistance) {
      x += 80 - bounds.minX;
      bounds = currentBounds();
    }

    const overlapsRightWallDepth = bounds.maxY > 0 && bounds.minY < 1000;
    if (
      overlapsRightWallDepth &&
      x <= 1960 &&
      bounds.maxX > 1920 - snapDistance
    ) {
      x += 1920 - bounds.maxX;
      bounds = currentBounds();
    }
  }

  if (Math.abs(bounds.minX) <= snapDistance) {
    x -= bounds.minX;
    bounds = currentBounds();
  }

  if (Math.abs(booth.widthMm - bounds.maxX) <= snapDistance) {
    x += booth.widthMm - bounds.maxX;
    bounds = currentBounds();
  }

  if (Math.abs(booth.depthMm - bounds.maxY) <= snapDistance) {
    y += booth.depthMm - bounds.maxY;
  }

  return { x, y };
}
