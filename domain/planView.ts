import type { Point } from "./models.ts";

/** Pure 180° plan-view transform. Project/world coordinates stay unchanged. */
export function worldToPlanView180(
  point: Point,
  widthMm: number,
  depthMm: number,
): Point {
  return { x: widthMm - point.x, y: depthMm - point.y };
}

export function planView180ToWorld(
  point: Point,
  widthMm: number,
  depthMm: number,
): Point {
  return worldToPlanView180(point, widthMm, depthMm);
}

export function worldRotationToPlanView180(rotationDeg: number): number {
  return ((rotationDeg + 180) % 360 + 360) % 360;
}
