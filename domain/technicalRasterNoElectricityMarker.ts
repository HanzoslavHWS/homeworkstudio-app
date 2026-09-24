/**
 * Technické rastry — PRODUCTION BATCH ("BEZ elektriky" automatic red X). Pure geometry for the
 * automatic red "×" placed next to a matched stand's own number whenever
 * `TechnicalStand.hasNoElectricityAssignment` is true (domain/technicalRaster.ts's own doc has the
 * full source-of-truth story). Mirrors domain/technicalRasterRealizationUnderline.ts's own
 * discipline exactly (same reason): ONE normalized page-space geometry function, shared verbatim by
 * the editor (rendered as CSS left/top %) and the export (converted through the SAME rotation-aware
 * raw-PDF-point transform every other generator overlay uses) — never a screen-pixel-based offset
 * (that would make the two diverge, unlike the "selected stand" marker's own screen-px offset system,
 * which is a live-editor-only concern with no export equivalent).
 *
 * `bbox` present (the stand resolved via a real OCR-detected raster label) -> the marker's CENTER
 * sits just past the label bbox's own right edge, vertically centered on it — close enough to
 * obviously belong to that stand number, never overlapping the source PDF's own printed digits.
 * `bbox` absent (a MANUALLY-matched stand, anchor point only) -> a small fixed normalized offset
 * from the anchor, the same conservative fallback shape computeRealizationUnderlineGeometry uses for
 * the identical situation.
 */
import { zoomInvariantPx } from "./technicalRasterSelectedMarker.ts";

export type NoElectricityMarkerGeometry = Readonly<{ xNormalized: number; yNormalized: number }>;

/** How far past the label bbox's own right edge the marker's center sits, as a fraction of the bbox's own width — small enough to read as "belonging to" the number, never floating far away. */
const BBOX_RIGHT_OFFSET_RATIO = 0.35;
/** Fallback offset (normalized page units) for a MANUAL match with no known label bbox — same order of magnitude as REALIZATION_UNDERLINE_FALLBACK_WIDTH_NORMALIZED's own conservative fallback. */
export const NO_ELECTRICITY_MARKER_FALLBACK_OFFSET_NORMALIZED = 0.012;

export function computeNoElectricityMarkerGeometry(
  anchor: Readonly<{ xNormalized: number; yNormalized: number }>,
  bbox?: Readonly<{ widthNormalized: number; heightNormalized: number }>,
): NoElectricityMarkerGeometry {
  if (bbox) {
    return {
      xNormalized: anchor.xNormalized + bbox.widthNormalized + bbox.widthNormalized * BBOX_RIGHT_OFFSET_RATIO,
      yNormalized: anchor.yNormalized + bbox.heightNormalized / 2,
    };
  }
  return {
    xNormalized: anchor.xNormalized + NO_ELECTRICITY_MARKER_FALLBACK_OFFSET_NORMALIZED,
    yNormalized: anchor.yNormalized,
  };
}

// ============================================================================
// Editor screen sizing (zoom-invariant, editor-only — the export uses its own fixed pt size, see
// domain/technicalRasterExportSymbolSize.ts, exactly like every other generator marker already does).
// ============================================================================

/** Target ON-SCREEN size — small and readable, deliberately smaller than a technical-service symbol glyph (this is a diagnostic annotation, never a primary marker). */
export const NO_ELECTRICITY_MARKER_SIZE_TARGET_PX = 11;

export type NoElectricityMarkerScreenStyle = Readonly<{ fontSizePx: number }>;

export function computeNoElectricityMarkerScreenStyle(zoom: number): NoElectricityMarkerScreenStyle {
  return { fontSizePx: zoomInvariantPx(NO_ELECTRICITY_MARKER_SIZE_TARGET_PX, zoom) };
}
