import type { Point } from "../domain/models.ts";

export const DEFAULT_PIXELS_PER_MM = 0.3;
/**
 * Wide enough that Fit is never wrong for realistic geometry: a 0.25 floor previously forced
 * anything needing to fit MORE than ~4x wider than the viewport (e.g. a 10m Individual workspace
 * in a ~650px-tall panel, which needs ≈0.17) to render OVERSIZED and clipped, because
 * fitWorldToViewport/fitBoundsToViewport both clamp their computed "ideal" zoom through
 * clampZoom(). 0.02 leaves headroom for a workspace/plot an order of magnitude larger than any
 * realistic booth before Fit itself would ever be wrong. 40 (up from 4) is generous enough to
 * inspect a ~40mm Octanorm profile at real working size (40mm × 0.3 px/mm × 40 zoom ≈ 480px).
 */
export const MIN_VIEWPORT_ZOOM = 0.02;
export const MAX_VIEWPORT_ZOOM = 40;

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

export type WorldBounds = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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

/** ~8% of the smaller viewport dimension on each side — "rozumný padding" (report section 4), never a fixed pixel value that reads as huge on a small panel and negligible on a large one. */
export function defaultFitPaddingPx(viewport: ViewportSize): number {
  return Math.min(viewport.width, viewport.height) * 0.08;
}

export function fitWorldToViewport(
  viewport: ViewportSize,
  world: WorldSize,
  padding?: number,
  pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): ViewportTransform {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { zoom: 1, pan: { x: 0, y: 0 } };
  }

  const resolvedPadding = padding ?? defaultFitPaddingPx(viewport);
  const availableWidth = Math.max(1, viewport.width - resolvedPadding * 2);
  const availableHeight = Math.max(1, viewport.height - resolvedPadding * 2);
  const zoom = clampZoom(
    Math.min(
      availableWidth / (world.width * pixelsPerMm),
      availableHeight / (world.height * pixelsPerMm),
    ),
  );

  return centerWorld(viewport, world, zoom, pixelsPerMm);
}

export function fitBoundsToViewport(
  viewport: ViewportSize,
  bounds: WorldBounds,
  padding?: number,
  pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): ViewportTransform {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const base = fitWorldToViewport(viewport, { width, height }, padding, pixelsPerMm);
  const scale = pixelsPerMm * base.zoom;
  return {
    zoom: base.zoom,
    pan: {
      x: (viewport.width - width * scale) / 2 - bounds.minX * scale,
      y: (viewport.height - height * scale) / 2 - bounds.minY * scale,
    },
  };
}

/**
 * One-shot initial-fit gate used by the client viewport lifecycle. It deliberately accepts only
 * canonical world dimensions/bounds: renderer/GLB physical bounds are not part of this contract.
 */
export function resolveInitialViewportFit(input: Readonly<{
  initialized: boolean;
  visualReady: boolean;
  viewport: ViewportSize;
  world: WorldSize;
  fitBounds?: WorldBounds;
}>): ViewportTransform | null {
  if (
    input.initialized ||
    !input.visualReady ||
    input.viewport.width <= 0 ||
    input.viewport.height <= 0
  ) {
    return null;
  }

  return input.fitBounds
    ? fitBoundsToViewport(input.viewport, input.fitBounds)
    : fitWorldToViewport(input.viewport, input.world);
}
