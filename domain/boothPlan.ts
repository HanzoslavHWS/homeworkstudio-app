import { resolveBoothAssetDefinition } from "./boothAssets.ts";
import { isBoothConstructionPartVisible } from "./construction.ts";
import {
  collisionObstacleToPlanRect,
  get2DCollisionObstacles,
} from "../geometry/construction.ts";
import type {
  BoothType,
  CadModelAsset,
  PlanRect,
  PlanRenderStyle2D,
  PlanViewType,
} from "./models.ts";

export type BoothPlanVisualMode = "glb-top-view" | "canonical-fallback";
export type BoothPlanGlbLoadState = "loading" | "ready" | "failed";
export type BoothCollisionOverlaySurface =
  | "editor"
  | "visualization"
  | "export";

export function shouldRenderBoothCollisionOverlay(
  _surface: BoothCollisionOverlaySurface,
  _options: Readonly<{
    editorEnabled?: boolean;
    includeInExport?: boolean;
  }> = {},
): boolean {
  // Collision remains part of placement validation, but technical obstacle geometry is not a
  // presentation layer in the normal editor, Visualization, or export surfaces.
  return false;
}

export function resolveBoothPlanVisualMode(
  booth: Pick<BoothType, "id" | "code" | "internalCode" | "boothAsset">,
  asset: CadModelAsset | undefined,
): BoothPlanVisualMode {
  return resolveBoothAssetDefinition(booth) && asset
    ? "glb-top-view"
    : "canonical-fallback";
}

/** Canonical construction is a fallback, never a loading-time layer beneath a GLB canvas. */
export function shouldRenderCanonicalBoothConstruction(
  visualMode: BoothPlanVisualMode,
  glbLoadState: BoothPlanGlbLoadState,
): boolean {
  return visualMode === "canonical-fallback" || glbLoadState === "failed";
}

export type BoothPlanGeometry = Readonly<{
  id: string;
  constructionPartId: string;
  rect: PlanRect;
  viewType: PlanViewType;
  renderStyle: PlanRenderStyle2D;
  collision2D: boolean;
}>;

export type BoothPlanLine = Readonly<{
  id: string;
  constructionPartId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}>;

export type BoothPlanArea = Readonly<{
  id: string;
  constructionPartId: string;
  rect: PlanRect;
}>;

export type BoothPlanProfile = Readonly<{
  id: string;
  constructionPartId: string;
  rect: PlanRect;
}>;

export type BoothPlanPresentation = Readonly<{
  constructionAreas: readonly BoothPlanArea[];
  constructionProfiles: readonly BoothPlanProfile[];
  collisionLines: readonly BoothPlanLine[];
}>;

/**
 * Canonical 2D booth construction. It deliberately reads authored nominal-mm plan/collision
 * metadata and never a GLB projection or GLB bounding box.
 */
export function resolveBoothPlanGeometry(
  booth: Pick<
    BoothType,
    | "id"
    | "code"
    | "internalCode"
    | "boothAsset"
    | "constructionParts"
    | "collisionObstacles"
    | "visible"
    | "depthMm"
  >,
  constructionVisibility: Readonly<Record<string, boolean>> = {},
): readonly BoothPlanGeometry[] {
  if (!(constructionVisibility.assembly ?? booth.visible)) return [];

  const boothAsset = resolveBoothAssetDefinition(booth);
  const depthMm = booth.depthMm ?? boothAsset?.nominalDimensions.depthMm ?? 0;
  const obstaclesById = new Map(
    get2DCollisionObstacles(booth, constructionVisibility).map((obstacle) => [
      obstacle.id,
      collisionObstacleToPlanRect(obstacle, depthMm),
    ]),
  );

  return booth.constructionParts.flatMap((part) => {
    if (!isBoothConstructionPartVisible(booth, part, constructionVisibility)) {
      return [];
    }

    const obstacle = part.collisionObstacleId
      ? obstaclesById.get(part.collisionObstacleId)
      : undefined;
    const rects = part.planRects ?? (obstacle ? [obstacle] : []);
    return rects.map((rect) => ({
      id: `${part.id}:${rect.id}`,
      constructionPartId: part.id,
      rect,
      viewType: part.planViewType,
      renderStyle: part.renderStyle2D,
      collision2D: part.collision2D,
    }));
  });
}

/**
 * Clean plan symbol derived from the canonical geometry above. Construction and collision stay
 * separate: construction restores the filled wall-footprint/profile language used by the last
 * pre-WebGL plan, while collision remains a lightweight inside/no-placement boundary. Overhead
 * parts intentionally have no ground footprint.
 */
export function resolveBoothPlanPresentation(
  booth: Pick<
    BoothType,
    | "id"
    | "code"
    | "internalCode"
    | "boothAsset"
    | "constructionParts"
    | "collisionObstacles"
    | "visible"
    | "widthMm"
    | "depthMm"
    | "profileWidthMm"
  >,
  constructionVisibility: Readonly<Record<string, boolean>> = {},
): BoothPlanPresentation {
  const widthMm = booth.widthMm ?? 0;
  const depthMm = booth.depthMm ?? 0;
  if (widthMm <= 0 || depthMm <= 0) {
    return {
      constructionAreas: [],
      constructionProfiles: [],
      collisionLines: [],
    };
  }

  const constructionAreas: BoothPlanArea[] = [];
  const collisionLines: BoothPlanLine[] = [];

  for (const geometry of resolveBoothPlanGeometry(
    booth,
    constructionVisibility,
  )) {
    if (geometry.viewType !== "ground") continue;

    constructionAreas.push({
      id: `${geometry.id}:area`,
      constructionPartId: geometry.constructionPartId,
      rect: geometry.rect,
    });
    const collision = resolveCollisionPresentationLine(
      geometry,
      widthMm,
      depthMm,
    );
    if (geometry.collision2D) collisionLines.push(collision);
  }

  return {
    constructionAreas,
    constructionProfiles: resolveConstructionProfiles(
      constructionAreas,
      booth.profileWidthMm,
      widthMm,
      depthMm,
    ),
    collisionLines,
  };
}

function resolveCollisionPresentationLine(
  geometry: BoothPlanGeometry,
  boothWidthMm: number,
  boothDepthMm: number,
): BoothPlanLine {
  const { rect } = geometry;
  const horizontal = rect.width >= rect.height;

  if (horizontal) {
    const nearTop = rect.y <= boothDepthMm - (rect.y + rect.height);
    return {
      id: `${geometry.id}:collision`,
      constructionPartId: geometry.constructionPartId,
      x1: rect.x,
      y1: nearTop ? rect.y + rect.height : rect.y,
      x2: rect.x + rect.width,
      y2: nearTop ? rect.y + rect.height : rect.y,
    };
  }

  const nearLeft = rect.x <= boothWidthMm - (rect.x + rect.width);
  return {
    id: `${geometry.id}:collision`,
    constructionPartId: geometry.constructionPartId,
    x1: nearLeft ? rect.x + rect.width : rect.x,
    y1: rect.y,
    x2: nearLeft ? rect.x + rect.width : rect.x,
    y2: rect.y + rect.height,
  };
}

function resolveConstructionProfiles(
  areas: readonly BoothPlanArea[],
  authoredProfileWidthMm: number | null,
  boothWidthMm: number,
  boothDepthMm: number,
): readonly BoothPlanProfile[] {
  const derivedProfileWidthMm = Math.min(
    ...areas.map(({ rect }) => Math.min(rect.width, rect.height)),
  );
  const size = authoredProfileWidthMm ?? derivedProfileWidthMm;
  if (!Number.isFinite(size) || size <= 0) return [];

  const profiles = new Map<string, BoothPlanProfile>();
  const addProfile = (
    area: BoothPlanArea,
    x: number,
    y: number,
    suffix: string,
  ) => {
    const key = `${x}:${y}:${size}`;
    if (profiles.has(key)) return;
    profiles.set(key, {
      id: `${area.id}:profile:${suffix}`,
      constructionPartId: area.constructionPartId,
      rect: {
        id: `${area.rect.id}:profile:${suffix}`,
        x,
        y,
        width: size,
        height: size,
      },
    });
  };

  for (const area of areas) {
    const { rect } = area;
    if (rect.width >= rect.height) {
      const nearTop = rect.y <= boothDepthMm - (rect.y + rect.height);
      const y = nearTop ? rect.y : rect.y + rect.height - size;
      addProfile(area, rect.x, y, "start");
      if (rect.width >= boothWidthMm) {
        addProfile(area, rect.x + (rect.width - size) / 2, y, "middle");
      }
      addProfile(area, rect.x + rect.width - size, y, "end");
      continue;
    }

    const nearLeft = rect.x <= boothWidthMm - (rect.x + rect.width);
    const x = nearLeft ? rect.x : rect.x + rect.width - size;
    addProfile(area, x, rect.y, "start");
    addProfile(area, x, rect.y + rect.height - size / 2, "end");
  }

  return [...profiles.values()];
}
