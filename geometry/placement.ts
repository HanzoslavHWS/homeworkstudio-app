import type {
  BoothType,
  Point,
  PlacedComponent,
  Placement,
} from "../domain/models.ts";
import type { ConstructionVisibility } from "../domain/construction.ts";
import { isObjectLocked } from "../domain/locking.ts";
import { getBounds, getRotatedCorners, polygonsOverlap, rectToPoints } from "./polygons.ts";
import { get2DCollisionObstacles } from "./construction.ts";

export type ComponentMoveResult = Readonly<{
  accepted: boolean;
  component: PlacedComponent;
  reason?: "locked" | "invalid-position";
}>;

export type ComponentDragOffset = Readonly<{
  x: number;
  y: number;
}>;

/** Keeps the component center under the same grabbed point for the whole direct-placement drag. */
export function createComponentDragOffset(
  component: Pick<PlacedComponent, "xMm" | "yMm">,
  pointerWorld: Point,
): ComponentDragOffset {
  return {
    x: component.xMm - pointerWorld.x,
    y: component.yMm - pointerWorld.y,
  };
}

export function resolveDraggedComponentCenter(
  pointerWorld: Point,
  offset: ComponentDragOffset,
): Point {
  return {
    x: pointerWorld.x + offset.x,
    y: pointerWorld.y + offset.y,
  };
}

export function isPlacementValid(
  booth: BoothType,
  component: Pick<PlacedComponent, "widthMm" | "depthMm">,
  placement: Placement,
  constructionVisibility: ConstructionVisibility = {},
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

  return get2DCollisionObstacles(booth, constructionVisibility).every(
    (obstacle) => !polygonsOverlap(footprint, rectToPoints(obstacle)),
  );
}

export function tryMoveComponent(
  booth: BoothType,
  component: PlacedComponent,
  xMm: number,
  yMm: number,
  constructionVisibility: ConstructionVisibility = {},
): ComponentMoveResult {
  if (isObjectLocked(component)) {
    return { accepted: false, component, reason: "locked" };
  }

  if (
    !Number.isFinite(xMm) ||
    !Number.isFinite(yMm) ||
    !isPlacementValid(
      booth,
      component,
      {
        x: xMm,
        y: yMm,
        rotationDeg: component.rotationDeg,
      },
      constructionVisibility,
    )
  ) {
    return { accepted: false, component, reason: "invalid-position" };
  }

  if (component.xMm === xMm && component.yMm === yMm) {
    return { accepted: true, component };
  }

  return {
    accepted: true,
    component: { ...component, xMm, yMm },
  };
}

/** Individual-booth placement/move grid — see the Individual-mode foundation report. */
export const INDIVIDUAL_GRID_MM = 250;

/** Rounds to the nearest grid multiple; never clamps to a minimum on its own (see applyGridSnap for floor-bounds clamping, clampToGridMm for a minimum-one-step clamp). */
export function roundToGridMm(value: number, gridMm: number = INDIVIDUAL_GRID_MM): number {
  return Math.round(value / gridMm) * gridMm;
}

/** Rounds to the nearest grid multiple, never below one grid step — used for user-entered plot width/depth (see components/configurator/PlotSizeInput.tsx). */
export function clampToGridMm(value: number, gridMm: number = INDIVIDUAL_GRID_MM): number {
  return Math.max(gridMm, roundToGridMm(value, gridMm));
}

/**
 * Individual-mode placement/move snap: rounds the component's CENTER to the nearest grid point,
 * then clamps the resulting footprint back inside the floor if the rounded center pushed it out
 * of bounds. Deliberately simpler than applySnap below (no construction-edge special cases,
 * no obstacle awareness) — collision itself is still enforced separately by tryMoveComponent.
 */
export function applyGridSnap(
  booth: BoothType,
  component: Pick<PlacedComponent, "widthMm" | "depthMm">,
  centerX: number,
  centerY: number,
  rotationDeg: number,
  gridMm: number = INDIVIDUAL_GRID_MM,
): { x: number; y: number } {
  if (booth.widthMm === null || booth.depthMm === null) {
    return { x: centerX, y: centerY };
  }

  let x = roundToGridMm(centerX, gridMm);
  let y = roundToGridMm(centerY, gridMm);
  const bounds = getBounds(getRotatedCorners(x, y, component.widthMm, component.depthMm, rotationDeg));

  if (bounds.minX < 0) x -= bounds.minX;
  if (bounds.maxX > booth.widthMm) x -= bounds.maxX - booth.widthMm;
  if (bounds.minY < 0) y -= bounds.minY;
  if (bounds.maxY > booth.depthMm) y -= bounds.maxY - booth.depthMm;

  return { x, y };
}

export function applySnap(
  booth: BoothType,
  component: Pick<PlacedComponent, "widthMm" | "depthMm">,
  centerX: number,
  centerY: number,
  rotationDeg: number,
  constructionVisibility: ConstructionVisibility = {},
): { x: number; y: number } {
  if (booth.widthMm === null || booth.depthMm === null) {
    return { x: centerX, y: centerY };
  }

  let x = centerX;
  let y = centerY;
  let snappedToLeftConstruction = false;
  let snappedToRightConstruction = false;
  let snappedToBackConstruction = false;
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
    const obstacles = new Map(
      get2DCollisionObstacles(booth, constructionVisibility).map((obstacle) => [
        obstacle.id,
        obstacle,
      ]),
    );
    const backWall = obstacles.get("back-wall");
    const leftWall = obstacles.get("left-wall");
    const rightWall = obstacles.get("right-wall");

    if (
      backWall &&
      bounds.maxX > backWall.x &&
      bounds.minX < backWall.x + backWall.width &&
      y <= backWall.y + backWall.height / 2 &&
      bounds.maxY > backWall.y - snapDistance
    ) {
      y += backWall.y - bounds.maxY;
      snappedToBackConstruction = true;
      bounds = currentBounds();
    }

    const overlapsLeftWallDepth =
      leftWall &&
      bounds.maxY > leftWall.y &&
      bounds.minY < leftWall.y + leftWall.height;
    if (
      leftWall &&
      overlapsLeftWallDepth &&
      x >= leftWall.x + leftWall.width / 2 &&
      bounds.minX < leftWall.x + leftWall.width + snapDistance
    ) {
      x += leftWall.x + leftWall.width - bounds.minX;
      snappedToLeftConstruction = true;
      bounds = currentBounds();
    }

    const overlapsRightWallDepth =
      rightWall &&
      bounds.maxY > rightWall.y &&
      bounds.minY < rightWall.y + rightWall.height;
    if (
      rightWall &&
      overlapsRightWallDepth &&
      x <= rightWall.x + rightWall.width / 2 &&
      bounds.maxX > rightWall.x - snapDistance
    ) {
      x += rightWall.x - bounds.maxX;
      snappedToRightConstruction = true;
      bounds = currentBounds();
    }
  }

  if (!snappedToLeftConstruction && Math.abs(bounds.minX) <= snapDistance) {
    x -= bounds.minX;
    bounds = currentBounds();
  }

  if (
    !snappedToRightConstruction &&
    Math.abs(booth.widthMm - bounds.maxX) <= snapDistance
  ) {
    x += booth.widthMm - bounds.maxX;
    bounds = currentBounds();
  }

  if (
    !snappedToBackConstruction &&
    Math.abs(booth.depthMm - bounds.maxY) <= snapDistance
  ) {
    y += booth.depthMm - bounds.maxY;
  }

  return { x, y };
}
