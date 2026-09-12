/**
 * Technické rastry — VECTOR PDF export geometry (spec batch 9, "TRUE VECTOR PDF EXPORT"). Pure,
 * framework-free affine math only: converts a stored placement's normalized DISPLAY-space point
 * (this app's established convention — origin top-left, y-down, relative to
 * `page.getViewport({scale:1})`'s width/height, exactly like RasterStandLabel and
 * TechnicalServicePlacement already are, see lib/pdf/rasterStandLabelDetection.ts's own doc) back
 * into RAW PDF content-stream coordinates (origin bottom-left, y-up, UNROTATED) — the coordinate
 * system pdf-lib's `page.draw*()` calls actually use when drawing onto a page copied straight from
 * the source document (spec batch 9 section 15: "skutečně použít původní PDF page/content", never
 * a redrawn lookalike).
 *
 * Rotation (spec section 30/36-H, 0/90/180/270): deliberately NOT re-derived by hand from PDF's
 * /Rotate spec — that's exactly the kind of hand-rolled transform math this app's own established
 * precedent (rasterStandLabelDetection.ts) already avoids for the FORWARD (raw->display)
 * direction, instead trusting pdf.js's own `PageViewport.transform` (a standard 6-value affine
 * matrix, already correctly rotation-aware, already the ONE source of truth this app's normalized
 * coordinates are defined against). This module only adds the INVERSE of that same matrix — plain,
 * textbook 2x2 affine inversion, independent of which specific rotation produced it, so it's
 * correct for 0/90/180/270 without needing a real rotated fixture to hand-verify each case
 * separately (verified instead via round-trip tests: forward-transform a point, invert, recover
 * the original — see tests/technicalRasterExportPlacementGeometry.test.ts).
 */

export type AffineTransform6 = readonly [number, number, number, number, number, number];

/** Applies a standard 6-value PDF affine matrix [a,b,c,d,e,f] to a point: (a*x+c*y+e, b*x+d*y+f) — the same generic formula lib/pdf/rasterStandLabelDetection.ts's applyPdfAffineTransform already uses for the forward direction, duplicated here (not imported) so this module stays framework/pdf.js-import-free and independently testable. */
export function applyAffineTransform(transform: AffineTransform6, x: number, y: number): Readonly<{ x: number; y: number }> {
  const [a, b, c, d, e, f] = transform;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Inverts a 2D affine transform. Throws only if the matrix is genuinely singular (determinant 0) — never happens for a real PDF viewport transform (always a rotation+scale, always invertible), but this is a defensive, honest failure rather than silently returning garbage coordinates. */
export function invertAffineTransform(transform: AffineTransform6): AffineTransform6 {
  const [a, b, c, d, e, f] = transform;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) {
    throw new Error("Cannot invert a singular (non-invertible) PDF affine transform.");
  }
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const ie = -(ia * e + ic * f);
  const ifValue = -(ib * e + id * f);
  return [ia, ib, ic, id, ie, ifValue];
}

/**
 * Converts a normalized (0-1) DISPLAY-space point into raw PDF content-stream coordinates, ready
 * to pass directly to pdf-lib's `page.draw*({x, y, ...})` on a page copied 1:1 from the source PDF.
 * `displayWidthPt`/`displayHeightPt` are `page.getViewport({scale:1}).width/height` (rotation-
 * aware — swapped from the page's own raw MediaBox for a 90/270-rotated page); `viewportTransform`
 * is that SAME viewport's own `.transform` — the authoritative forward (raw->display) mapping this
 * function inverts.
 */
/**
 * Whether a value is safe to treat as a normalized (0-1) page coordinate (spec batch 13 section
 * 6). The live UI never produces anything else (`TechnicalRasterCanvas.tsx`'s `handleStageClick`
 * refuses any out-of-bounds click before ever calling `placeTechnicalService`), but the export
 * pipeline must never trust that unconditionally — corrupted/hand-edited persisted data, or a
 * future caller that bypasses the UI, must be rejected deterministically rather than silently
 * clamped (a clamp would draw a symbol at a plausible-looking but WRONG position) or left to
 * produce NaN/Infinity coordinates deep inside a PDF content stream.
 */
export function isValidNormalizedCoordinate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function normalizedDisplayPointToRawPdfPoint(
  xNormalized: number,
  yNormalized: number,
  displayWidthPt: number,
  displayHeightPt: number,
  viewportTransform: AffineTransform6,
): Readonly<{ x: number; y: number }> {
  const displayX = xNormalized * displayWidthPt;
  const displayY = yNormalized * displayHeightPt;
  const inverse = invertAffineTransform(viewportTransform);
  return applyAffineTransform(inverse, displayX, displayY);
}

/**
 * Converts a normalized (0-1) DISPLAY-space RECTANGLE (corrective batch section 7 — the legend's
 * own "source-legend-area" placement) into an axis-aligned raw-PDF-space bounding box, by
 * transforming all 4 corners individually and taking their min/max — never assuming the rectangle
 * stays axis-aligned in raw space (a 90°/270° rotation swaps which raw axis the display width/
 * height map to), the same "trust the real viewport transform, never hand-derive rotation" spirit
 * as normalizedDisplayPointToRawPdfPoint above.
 */
export function normalizedDisplayRectToRawPdfBoundingBox(
  region: Readonly<{ xNormalized: number; yNormalized: number; widthNormalized: number; heightNormalized: number }>,
  displayWidthPt: number,
  displayHeightPt: number,
  viewportTransform: AffineTransform6,
): Readonly<{ x: number; y: number; width: number; height: number }> {
  const corners = [
    [region.xNormalized, region.yNormalized],
    [region.xNormalized + region.widthNormalized, region.yNormalized],
    [region.xNormalized, region.yNormalized + region.heightNormalized],
    [region.xNormalized + region.widthNormalized, region.yNormalized + region.heightNormalized],
  ].map(([x, y]) => normalizedDisplayPointToRawPdfPoint(x!, y!, displayWidthPt, displayHeightPt, viewportTransform));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}
