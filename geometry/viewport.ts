import type { Point } from "../domain/models.ts";

export const DEFAULT_PIXELS_PER_MM = 0.3;
export const MIN_VIEWPORT_ZOOM = 0.25;
export const MAX_VIEWPORT_ZOOM = 4;

export type ViewportTransform = Readonly<{
  zoom: number;
  pan: Point;
}>;

export type ViewportSize = Readonly<{
  width: number;
  height: number;
}>;

export type WorldSize = Readonly<{
  width: number;
  height: number;
}>;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_VIEWPORT_ZOOM, Math.max(MIN_VIEWPORT_ZOOM, zoom));
}

export function worldToScreen(
  point: Point,
  transform: ViewportTransform,
  pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): Point {
  const scale = pixelsPerMm * transform.zoom;
  return {
    x: point.x * scale + transform.pan.x,
    y: point.y * scale + transform.pan.y,
  };
}

export function screenToWorld(
  point: Point,
  transform: ViewportTransform,
  pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): Point {
  const scale = pixelsPerMm * transform.zoom;
  return {
    x: (point.x - transform.pan.x) / scale,
    y: (point.y - transform.pan.y) / scale,
  };
}

export function zoomAroundScreenPoint(
  transform: ViewportTransform,
  requestedZoom: number,
  anchor: Point,
  pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): ViewportTransform {
  const worldAnchor = screenToWorld(anchor, transform, pixelsPerMm);
  const zoom = clampZoom(requestedZoom);
  const scale = pixelsPerMm * zoom;

  return {
    zoom,
    pan: {
      x: anchor.x - worldAnchor.x * scale,
      y: anchor.y - worldAnchor.y * scale,
    },
  };
}

export function panViewport(
  transform: ViewportTransform,
  delta: Point,
): ViewportTransform {
  return {
    ...transform,
    pan: {
      x: transform.pan.x + delta.x,
      y: transform.pan.y + delta.y,
    },
  };
}

export function centerWorld(
  viewport: ViewportSize,
  world: WorldSize,
  zoom = 1,
  pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): ViewportTransform {
  const normalizedZoom = clampZoom(zoom);
  const scale = pixelsPerMm * normalizedZoom;
  return {
    zoom: normalizedZoom,
    pan: {
      x: (viewport.width - world.width * scale) / 2,
      y: (viewport.height - world.height * scale) / 2,
    },
  };
}

export function fitWorldToViewport(
  viewport: ViewportSize,
  world: WorldSize,
  padding = 70,
  pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): ViewportTransform {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { zoom: 1, pan: { x: 0, y: 0 } };
  }

  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = clampZoom(
    Math.min(
      availableWidth / (world.width * pixelsPerMm),
      availableHeight / (world.height * pixelsPerMm),
    ),
  );

  return centerWorld(viewport, world, zoom, pixelsPerMm);
}
