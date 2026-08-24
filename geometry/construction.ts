import {
  isBoothConstructionPartVisible,
  type ConstructionVisibility,
} from "../domain/construction.ts";
import type { BoothType, CollisionRect, PlanRect } from "../domain/models.ts";

export type BoothCollisionSource = Pick<
  BoothType,
  | "id"
  | "code"
  | "internalCode"
  | "boothAsset"
  | "visible"
  | "constructionParts"
  | "collisionObstacles"
>;

/**
 * Resolves the canonical floor obstacles shared by placement and plan presentation.
 * Overhead parts never become hard collisions, and hidden wall assemblies disappear
 * from both consumers through the same visibility filter.
 */
export function get2DCollisionObstacles(
  booth: BoothCollisionSource,
  constructionVisibility: ConstructionVisibility = {},
): readonly CollisionRect[] {
  const assemblyVisible = constructionVisibility.assembly ?? booth.visible;
  if (!assemblyVisible) return [];

  const partsByObstacleId = new Map(
    booth.constructionParts.flatMap((part) =>
      part.collisionObstacleId
        ? [[part.collisionObstacleId, part] as const]
        : [],
    ),
  );

  return booth.collisionObstacles.filter((obstacle) => {
    const part = partsByObstacleId.get(obstacle.id);

    return part
      ? part.collision2D &&
          isBoothConstructionPartVisible(
            booth,
            part,
            constructionVisibility,
            assemblyVisible,
          )
      : true;
  });
}

/** Converts canonical world coordinates to the SVG plan's Y-down coordinate frame. */
export function collisionObstacleToPlanRect(
  obstacle: CollisionRect,
  boothDepthMm: number,
): PlanRect {
  return {
    ...obstacle,
    y: boothDepthMm - obstacle.y - obstacle.height,
  };
}
