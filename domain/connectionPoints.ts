/**
 * Pure read-path for ComponentDefinition.connectionPoints (see domain/models.ts's ConnectionPoint
 * doc comment for why this is separate from the GLB pivot/anchor). No auto-snapping/matching
 * engine here — just resolving a socket's LOCAL position/direction into WORLD mm/degrees for a
 * given PlacedComponent instance, the minimum needed for a future assembly engine (or, for now,
 * simply drawing a socket marker) to work with real numbers.
 */
import type { ConnectionPoint, PlacedComponent, Point } from "./models.ts";

/**
 * Same rotation convention as geometry/polygons.ts's getRotatedCorners and
 * PlacedComponent.rotationDeg itself: a local offset is rotated by the component's own
 * rotationDeg about its anchor (xMm/yMm), then translated to world position.
 */
export function resolveConnectionPointWorldPosition(
  component: Pick<PlacedComponent, "xMm" | "yMm" | "rotationDeg">,
  socket: Pick<ConnectionPoint, "localPosition">,
): Point {
  const radians = (component.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: component.xMm + socket.localPosition.x * cos - socket.localPosition.y * sin,
    y: component.yMm + socket.localPosition.x * sin + socket.localPosition.y * cos,
  };
}

/** The socket's own facing direction, rotated by the component's current world rotation — normalized to [0, 360). */
export function resolveConnectionPointWorldDirectionDeg(
  component: Pick<PlacedComponent, "rotationDeg">,
  socket: Pick<ConnectionPoint, "directionDeg">,
): number {
  return ((socket.directionDeg + component.rotationDeg) % 360 + 360) % 360;
}

/** Every connectionPoints entry on a definition, resolved to world position/direction for one placed instance — convenience wrapper, never itself a matching/snapping decision. */
export function resolvePlacedConnectionPoints(
  component: Pick<PlacedComponent, "xMm" | "yMm" | "rotationDeg">,
  connectionPoints: readonly ConnectionPoint[],
): readonly (ConnectionPoint & { worldPosition: Point; worldDirectionDeg: number })[] {
  return connectionPoints.map((socket) => ({
    ...socket,
    worldPosition: resolveConnectionPointWorldPosition(component, socket),
    worldDirectionDeg: resolveConnectionPointWorldDirectionDeg(component, socket),
  }));
}
