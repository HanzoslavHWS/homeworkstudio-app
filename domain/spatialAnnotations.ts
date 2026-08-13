import type { Point } from "./models.ts";
import type { Measurement3D } from "./project.ts";

export type ProjectAnnotation = Readonly<{
  id: string;
  text: string;
  position: Point;
  visible: boolean;
  createdAt: string;
  /** Missing only on legacy records; UI treats it as readable medium. */
  textSize?: "small" | "medium" | "large";
}>;

export type CustomDimension = Readonly<{
  id: string;
  start: Point;
  end: Point;
  measuredValueMm: number;
  displayLabel?: string;
  visible: boolean;
  createdAt: string;
}>;

export function measuredDistanceMm(start: Point, end: Point): number {
  return Math.round(Math.hypot(end.x - start.x, end.y - start.y));
}

export function createCustomDimension(
  id: string,
  start: Point,
  end: Point,
  now = new Date().toISOString(),
): CustomDimension {
  return {
    id,
    start,
    end,
    measuredValueMm: measuredDistanceMm(start, end),
    visible: true,
    createdAt: now,
  };
}

export function dimensionDisplayLabel(dimension: CustomDimension): string {
  return dimension.displayLabel?.trim() || `${dimension.measuredValueMm} mm`;
}

export function moveAnnotation(
  annotation: ProjectAnnotation,
  position: Point,
): ProjectAnnotation {
  return { ...annotation, position };
}

export type MeasurementState = Readonly<{
  active: boolean;
  start?: Point;
  hover?: Point;
}>;

export function startMeasurement(): MeasurementState {
  return { active: true };
}

export function updateMeasurementHover(
  state: MeasurementState,
  hover: Point,
): MeasurementState {
  return state.active ? { ...state, hover } : state;
}

export function measurementClick(
  state: MeasurementState,
  point: Point,
  id = `dimension-${Date.now()}`,
): Readonly<{ state: MeasurementState; dimension?: CustomDimension }> {
  if (!state.active) return { state };
  if (!state.start) return { state: { active: true, start: point, hover: point } };
  return {
    state: { active: false },
    dimension: createCustomDimension(id, state.start, point),
  };
}

export function cancelMeasurement(): MeasurementState {
  return { active: false };
}

export function measuredDistance3DMm(
  pointA: readonly [number, number, number],
  pointB: readonly [number, number, number],
): number {
  return Math.round(Math.hypot(
    pointB[0] - pointA[0],
    pointB[1] - pointA[1],
    pointB[2] - pointA[2],
  ));
}

export function createMeasurement3D(
  id: string,
  pointA: readonly [number, number, number],
  pointB: readonly [number, number, number],
  snapA: Measurement3D["snapA"] = "surface",
  snapB: Measurement3D["snapB"] = "surface",
): Measurement3D {
  return {
    id,
    pointA,
    pointB,
    measuredValueMm: measuredDistance3DMm(pointA, pointB),
    snapA,
    snapB,
  };
}

export function moveMeasurement3DLabel(
  measurement: Measurement3D,
  displayOffset: readonly [number, number, number],
): Measurement3D {
  return { ...measurement, displayOffset };
}

export type NominalDimensionAxis = "width" | "depth" | "height";

export function nominalDimensionAnchors(
  dimensions: Readonly<{ widthMm: number; depthMm: number; heightMm: number }>,
  axis: NominalDimensionAxis,
): Readonly<{
  pointA: readonly [number, number, number];
  pointB: readonly [number, number, number];
  measuredValueMm: number;
}> {
  if (axis === "width") return { pointA: [0, 0, 0], pointB: [dimensions.widthMm, 0, 0], measuredValueMm: dimensions.widthMm };
  if (axis === "depth") return { pointA: [dimensions.widthMm, 0, 0], pointB: [dimensions.widthMm, dimensions.depthMm, 0], measuredValueMm: dimensions.depthMm };
  return { pointA: [0, 0, 0], pointB: [0, 0, dimensions.heightMm], measuredValueMm: dimensions.heightMm };
}
