/**
 * Print Surfaces V5 (marker-overlay follow-up) — pure geometry, no jsPDF/DOM dependency, so it's
 * directly unit-testable and reusable by any future PDF/canvas layout that needs to place a
 * normalized (0–1) point onto a "contain"-fitted image rectangle. Mirrors the exact contain math
 * lib/presentationPdf.ts and the old inline version of this logic in lib/printSurfacePdf.ts
 * already used — extracted here so marker placement can be computed against the SAME rectangle
 * the image was actually drawn into, never the outer layout box.
 */

export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * The rectangle an image of `imageWidthPx`×`imageHeightPx` actually occupies once "contain"-fitted
 * into `box`, preserving aspect ratio — horizontally centered, top-aligned (matches this app's
 * existing print-preview/PDF visual convention: images never vertically center within their box).
 * Never distorts/crops — the returned rect is always <= box in both dimensions.
 */
export function resolveContainRect(box: Rect, imageWidthPx: number, imageHeightPx: number): Rect {
  if (imageWidthPx <= 0 || imageHeightPx <= 0 || box.width <= 0 || box.height <= 0) {
    return { x: box.x, y: box.y, width: 0, height: 0 };
  }
  const imageAspect = imageWidthPx / imageHeightPx;
  const boxAspect = box.width / box.height;
  const { width, height } = imageAspect > boxAspect
    ? { width: box.width, height: box.width / imageAspect }
    : { width: box.height * imageAspect, height: box.height };
  return { x: box.x + (box.width - width) / 2, y: box.y, width, height };
}

/**
 * Maps a MarkerPlacement's normalized (0–1) xNormalized/yNormalized onto the ACTUAL rendered
 * image rectangle (from resolveContainRect above, or any other already-resolved rect) — never
 * onto the outer layout box. 0/0 is the rect's top-left corner, 1/1 its bottom-right, 0.5/0.5 its
 * center — matches exactly how the same normalized coordinates are interpreted everywhere else in
 * this app (PrintSurfaceCanvas.tsx, the print-preview HTML's %-based CSS positioning).
 */
export function mapNormalizedPointToRect(xNormalized: number, yNormalized: number, rect: Rect): Readonly<{ x: number; y: number }> {
  return { x: rect.x + xNormalized * rect.width, y: rect.y + yNormalized * rect.height };
}
