/**
 * HWS SEE camera framing. Pure (unit-tested for models from millimetres to hundreds of metres and
 * for portrait / landscape screens). Works on the model's bounding sphere, so it is independent of
 * the units a GLB was exported in and of where the model sits in its own coordinate system.
 */

export type SeeVec3Tuple = readonly [number, number, number];

export type SeeFitInput = Readonly<{
  center: SeeVec3Tuple;
  radius: number;
  /** vertical field of view in degrees */
  fov: number;
  /** width / height of the viewer */
  aspect: number;
  /** viewing direction from the target towards the camera (normalized internally) */
  direction?: SeeVec3Tuple;
  /** extra room around the model (1 = sphere touches the frame) */
  margin?: number;
}>;

export const DEFAULT_VIEW_DIRECTION: SeeVec3Tuple = [1, 0.65, 1.25];

export function safeRadius(radius: number): number {
  return Number.isFinite(radius) && radius > 1e-6 ? radius : 1;
}

/** Camera position/target so the whole bounding sphere fits the NARROWER view angle. */
export function fitView(input: SeeFitInput): Readonly<{ position: SeeVec3Tuple; target: SeeVec3Tuple; distance: number }> {
  const radius = safeRadius(input.radius);
  const aspect = Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 1;
  const verticalHalf = ((Number.isFinite(input.fov) ? input.fov : 45) * Math.PI) / 360;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * aspect);
  const distance = (radius / Math.sin(Math.min(verticalHalf, horizontalHalf))) * (input.margin ?? 1.1);
  const [dx, dy, dz] = input.direction ?? DEFAULT_VIEW_DIRECTION;
  const length = Math.hypot(dx, dy, dz) || 1;
  const [cx, cy, cz] = input.center;
  return {
    position: [cx + (dx / length) * distance, cy + (dy / length) * distance, cz + (dz / length) * distance],
    target: [cx, cy, cz],
    distance,
  };
}

/**
 * Near/far planes and zoom limits scaled to the model. A tight near/far ratio (~12 000) keeps the
 * depth buffer precise, so coplanar faces of exported CAD models do not flicker (z-fighting).
 */
export function clippingFor(radius: number): Readonly<{ near: number; far: number; minDistance: number; maxDistance: number }> {
  const r = safeRadius(radius);
  return { near: r / 200, far: r * 60, minDistance: r * 0.05, maxDistance: r * 20 };
}

/**
 * A view saved on a landscape screen would crop the model on a portrait phone: step back along the
 * same direction (never closer than saved).
 */
export function adaptSavedViewDistanceFactor(aspect: number): number {
  return aspect > 0 && aspect < 1 ? Math.min(2.2, 1 / aspect) : 1;
}
