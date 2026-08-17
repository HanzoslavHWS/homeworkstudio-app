import type {
  AssetReference,
  CadModelAsset,
  PlacedComponent,
} from "./models.ts";

/**
 * The viewer uses meters as scene units while all project and CAD data remain mm.
 * Keep this conversion at the CAD boundary; editor state must never use scene units.
 */
export const SCENE_UNITS_PER_MILLIMETER = 0.001;

/** CAD is X-right, Y-depth, Z-up. Three.js is X-right, Y-up, Z-depth. */
export const CAD_TO_VIEWER_ROTATION_X_RAD = -Math.PI / 2;

export type Point3 = Readonly<{ x: number; y: number; z: number }>;

export function mmToSceneUnits(millimeters: number): number {
  return millimeters * SCENE_UNITS_PER_MILLIMETER;
}

export function sceneUnitsToMm(sceneUnits: number): number {
  return sceneUnits / SCENE_UNITS_PER_MILLIMETER;
}

/** Maps a CAD point (X, Y-depth, Z-up) to Three.js (X, Y-up, Z-back). */
export function cadPointToViewer(pointMm: Point3): Point3 {
  return {
    x: mmToSceneUnits(pointMm.x),
    y: mmToSceneUnits(pointMm.z),
    z: -mmToSceneUnits(pointMm.y),
  };
}

/**
 * Exact inverse of cadPointToViewer — converts a Three.js scene point back to CAD/project mm
 * coordinates. The 3D viewer's `content`/`editorOverlays` groups carry no render-time
 * rotation, so this is a direct inverse with no further undo step needed (see
 * BoothCadViewer.tsx's raycast click handler).
 */
export function viewerPointToCad(pointSceneUnits: Point3): Point3 {
  return {
    x: sceneUnitsToMm(pointSceneUnits.x),
    y: -sceneUnitsToMm(pointSceneUnits.z),
    z: sceneUnitsToMm(pointSceneUnits.y),
  };
}

export function getMasterReferenceModel(
  assets?: AssetReference,
): CadModelAsset | undefined {
  return assets?.models3d?.find((asset) => asset.role === "master-reference");
}

export function getComponentModel(
  assets?: AssetReference,
): CadModelAsset | undefined {
  return assets?.models3d?.find((asset) => asset.role === "component");
}

export function placedComponentToViewerTransform(
  component: Pick<PlacedComponent, "xMm" | "yMm" | "rotationDeg">,
) {
  return {
    position: cadPointToViewer({
      x: component.xMm,
      y: component.yMm,
      z: 0,
    }),
    rotationYRad: (component.rotationDeg * Math.PI) / 180,
  } as const;
}
