import type { BoothType, CollisionRect } from "../domain/models.ts";

/**
 * Resolves floor-plan obstacles independently from visual visibility.
 * Parts marked as overhead can therefore have plan geometry without ever
 * becoming a hard collision for furniture placed on the floor.
 */
export function get2DCollisionObstacles(
  booth: BoothType,
): readonly CollisionRect[] {
  const partsByObstacleId = new Map(
    booth.constructionParts.flatMap((part) =>
      part.collisionObstacleId
        ? [[part.collisionObstacleId, part] as const]
        : [],
    ),
  );

  return booth.collisionObstacles.filter((obstacle) => {
    const part = partsByObstacleId.get(obstacle.id);

    return part ? part.collision2D : true;
  });
}
