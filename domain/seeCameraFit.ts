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

// ───────────────────────────── Quick camera views ─────────────────────────────

/**
 * Predefined views. Axis convention of glTF / three.js: +Y is up, the model "faces" +Z (front), so
 * "Levý" looks at the model's left side from −X and "Pravý" from +X. Top/bottom keep a tiny
 * forward offset so the orbit controls never hit the degenerate straight-up pole.
 */
export const SEE_VIEW_PRESETS = ["default", "front", "back", "left", "right", "top", "bottom"] as const;
export type SeeViewPreset = (typeof SEE_VIEW_PRESETS)[number];

export const SEE_VIEW_PRESET_LABELS_CS: Readonly<Record<SeeViewPreset, string>> = {
  default: "Výchozí / 3D",
  front: "Přední (čelo)",
  back: "Zadní",
  left: "Levý",
  right: "Pravý",
  top: "Horní",
  bottom: "Spodní",
};

export const SEE_VIEW_PRESET_SHORT_CS: Readonly<Record<SeeViewPreset, string>> = {
  default: "3D",
  front: "Před",
  back: "Zad",
  left: "Levý",
  right: "Pravý",
  top: "Shora",
  bottom: "Zdola",
};

const POLE_OFFSET = 1e-3;

export function presetDirection(preset: SeeViewPreset): SeeVec3Tuple {
  switch (preset) {
    case "front": return [0, 0, 1];
    case "back": return [0, 0, -1];
    case "left": return [-1, 0, 0];
    case "right": return [1, 0, 0];
    case "top": return [0, 1, POLE_OFFSET];
    case "bottom": return [0, -1, POLE_OFFSET];
    default: return DEFAULT_VIEW_DIRECTION;
  }
}

/** Camera for a quick view of the current model (any size, anywhere in space). */
export function presetView(preset: SeeViewPreset, input: Omit<SeeFitInput, "direction">) {
  return fitView({ ...input, direction: presetDirection(preset), margin: preset === "default" ? input.margin : (input.margin ?? 1.1) * 1.05 });
}

/** Smooth camera transition curve (0 → 1). */
export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}
