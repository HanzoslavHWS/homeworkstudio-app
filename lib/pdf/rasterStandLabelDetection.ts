"use client";

/**
 * Technické rastry — turns raw raster PDF text items into RasterStandLabel[] (spec section 7).
 * The ONE place that converts pdf.js's PDF-user-space coordinates (origin bottom-left, y grows
 * UP, and NOT accounting for the page's own /Rotate) into this app's own stored convention —
 * origin TOP-LEFT, y grows DOWN, normalized 0-1, in DISPLAY (rotated) orientation — matching
 * domain/printSurfaceProject.ts's xNormalized/yNormalized precedent exactly, so a RasterStandLabel's
 * position and a manual-assignment click's position (both computed from on-screen/CSS coordinates,
 * naturally top-left/y-down) are always directly comparable.
 *
 * Uses each page's own `PdfPageSize.transform` (pdf.js's public `PageViewport.transform`, an
 * affine matrix already encoding rotation + the top-left/Y-down flip) rather than a manual
 * "height - y" flip — a page with /Rotate 90|180|270 would otherwise get wrong normalized
 * positions (dividing an un-rotated raw coordinate by ROTATED, width/height-swapped page
 * dimensions). Verified against a real PDF (Hala 1.pdf, itself unrotated): applying this
 * transform at rotation 0 reproduces the OLD manual-flip formula's result bit-for-bit — this is a
 * pure generalization, not a behavior change for any non-rotated raster (every real one seen so
 * far). The transform is applied to all 4 corners of the item's raw bounding box, then min/maxed,
 * since a 90°/270° rotation swaps which raw axis becomes on-screen width vs. height.
 *
 * Detection itself is deliberately dumb and conservative (spec section 7/26): any single text
 * item (or, once normalizeStandNumber() strips internal whitespace, any short run of adjacent
 * items) whose text matches looksLikeStandNumberToken is a candidate — never fuzzy, never OCR.
 * Every occurrence is kept (spec: "pokud je stejné číslo nalezeno vícekrát, nesmí aplikace
 * svévolně vybrat jedno" — that de-duplication decision belongs to the matching engine, domain/
 * technicalRasterMatching.ts, never here).
 */
import { looksLikeStandNumberToken } from "../../domain/technicalReportTableParsing.ts";
import { normalizeStandNumber } from "../../domain/technicalStandNumber.ts";
import type { RasterStandLabel } from "../../domain/technicalRaster.ts";
import type { PdfTextItem } from "../../domain/technicalReportTableParsing.ts";
import type { PdfPageSize } from "./pdfTextExtraction.ts";

/** Applies a standard 6-value PDF affine matrix `[a,b,c,d,e,f]` to a point — `(a*x+c*y+e, b*x+d*y+f)`, the same generic formula pdf.js's own `PageViewport.convertToViewportPoint` uses internally. */
export function applyPdfAffineTransform(transform: readonly [number, number, number, number, number, number], x: number, y: number): readonly [number, number] {
  const [a, b, c, d, e, f] = transform;
  return [a * x + c * y + e, b * x + d * y + f];
}

export function detectRasterStandLabels(
  items: readonly PdfTextItem[],
  pageSizes: ReadonlyMap<number, PdfPageSize>,
): readonly RasterStandLabel[] {
  const labels: RasterStandLabel[] = [];
  for (const item of items) {
    const candidate = item.str.trim();
    if (!looksLikeStandNumberToken(candidate)) continue;
    const pageSize = pageSizes.get(item.page);
    if (!pageSize || pageSize.widthPt <= 0 || pageSize.heightPt <= 0) continue;

    const corners = [
      applyPdfAffineTransform(pageSize.transform, item.x, item.y),
      applyPdfAffineTransform(pageSize.transform, item.x + item.width, item.y),
      applyPdfAffineTransform(pageSize.transform, item.x, item.y + item.height),
      applyPdfAffineTransform(pageSize.transform, item.x + item.width, item.y + item.height),
    ];
    const xs = corners.map((corner) => corner[0]);
    const ys = corners.map((corner) => corner[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    labels.push({
      id: crypto.randomUUID(),
      rawText: item.str,
      normalizedStandNumber: normalizeStandNumber(candidate),
      page: item.page,
      xNormalized: minX / pageSize.widthPt,
      yNormalized: minY / pageSize.heightPt,
      widthNormalized: (maxX - minX) / pageSize.widthPt,
      heightNormalized: (maxY - minY) / pageSize.heightPt,
    });
  }
  return labels;
}
