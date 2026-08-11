import type { Point } from "./models.ts";

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
