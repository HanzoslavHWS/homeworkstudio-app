import type { BoothAssetDefinition, CameraViewDefinition } from "./models.ts";
import type { VisualizationView } from "./project.ts";

export type VisualizationCameraPresetId = "main" | "left" | "right" | "top";

/**
 * Visualization camera presets derived only from canonical booth axes and nominal dimensions.
 * CAD/world +Y is the booth rear and maps to Three.js -Z, so every perspective preset stays on
 * +Z (the open-front side) while left/right are determined exclusively by canonical X.
 */
export function createVisualizationCameraPresets(input: Readonly<{
  widthMm: number;
  depthMm: number;
  heightMm: number;
  originConvention?: BoothAssetDefinition["originConvention"];
}>): readonly CameraViewDefinition[] {
  const centered =
    input.originConvention === "completed-physical-footprint-center-floor";
  const scale = Math.max(input.widthMm, input.depthMm, input.heightMm) / 1000;
  const target = {
    x: centered ? 0 : input.widthMm / 2000,
    y: input.heightMm / 1000 * 0.44,
    z: centered ? 0 : -input.depthMm / 2000,
  };
  const view = (
    id: VisualizationCameraPresetId,
    name: string,
    offset: readonly [number, number, number],
  ): CameraViewDefinition => ({
    id: `visualization-${id}`,
    name,
    position: [
      target.x + offset[0] * scale,
      target.y + offset[1] * scale,
      target.z + offset[2] * scale,
    ],
    target: [target.x, target.y, target.z],
    fov: 38,
  });

  return [
    view("main", "Hlavní", [0, 0.72, 2.15]),
    view("left", "Levý", [-1.75, 0.62, 1.65]),
    view("right", "Pravý", [1.75, 0.62, 1.65]),
    view("top", "Nadhled", [0, 2.6, 0.001]),
  ];
}

export function renameVisualizationView(
  view: VisualizationView,
  name: string,
): VisualizationView {
  const trimmed = name.trim();
  return trimmed && trimmed !== view.name ? { ...view, name: trimmed } : view;
}

export function moveVisualizationView(
  views: readonly VisualizationView[],
  viewId: string,
  direction: -1 | 1,
): readonly VisualizationView[] {
  const ordered = [...views].sort((left, right) => left.order - right.order);
  const from = ordered.findIndex((view) => view.id === viewId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ordered.length) return views;
  [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
  return ordered.map((view, order) => ({ ...view, order }));
}
