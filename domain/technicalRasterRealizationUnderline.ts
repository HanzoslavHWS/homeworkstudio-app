/**
 * Technické rastry — corrective batch (post real-file acceptance test) section 4/5: the realization
 * indicator, REDESIGNED from scratch. Manual acceptance of the previous "badge" design (a white box
 * with a dark outline and the stand number redrawn inside it) FAILED: it duplicated a number the
 * source PDF already prints, read as a large black pill/bubble, and dominated the raster at
 * practical working zoom. That entire design is gone — see domain/technicalRasterRealizationBadge.ts
 * (deleted) for the old approach; nothing here reuses any of its geometry or sizing.
 *
 * NEW design: a single colored horizontal underline, drawn just below the source PDF's own
 * (never redrawn, never covered) stand-number text — the SAME real, already-known label
 * bbox/anchor this app's own "selected stand" marker already anchors to (see
 * domain/technicalRasterSelectedMarker.ts), so this needs no new stand-position detection of any
 * kind. Color comes from the ALREADY-WORKING, unchanged realization group resolver
 * (domain/technicalRasterRealization.ts) — this module only ever decides GEOMETRY (where the line
 * goes, how thick it is), never color/grouping logic.
 *
 * Two independent concerns, same separation the rest of this app's marker geometry already uses:
 *   - `computeRealizationUnderlineGeometry` — pure PAGE-SPACE (normalized 0-1) rectangle geometry,
 *     shared verbatim by the editor (renders it as a CSS div) and the export (converts the same two
 *     endpoints through the rotation-aware raw-PDF-point transform and draws a real vector line).
 *   - `computeRealizationUnderlineScreenStyle` — EDITOR-ONLY, zoom-invariant on-screen thickness,
 *     same `zoomInvariantPx` mechanism (and same real bug this whole module's sibling,
 *     technicalRasterSymbolMarker.ts, documents) — a stroke that is not compensated would grow with
 *     the raster's own zoom transform, exactly the "extremely dominant at zoom" failure this
 *     redesign is meant to avoid a second time.
 */
import { zoomInvariantPx } from "./technicalRasterSelectedMarker.ts";

// ============================================================================
// Geometry (shared by editor + export — pure, framework-free, page-space normalized 0-1)
// ============================================================================

/**
 * How much extra width the underline gets beyond the label's own bbox width, split evenly on both
 * sides, as a fraction of that width — spec (corrective batch, section 4): "Length: use the
 * detected source stand-label bbox; should be approximately the width of the source stand number
 * with only a very small optional overhang (current is too long)." Reduced from the original 0.08
 * (an 8%-per-side overhang read as visibly longer than the number itself, especially once the
 * heavier 3px thickness was also stacked on top of it) down to a genuinely small overhang.
 */
const HORIZONTAL_PADDING_RATIO = 0.03;
/** Vertical gap between the label bbox's own bottom edge and the underline's top edge, as a fraction of the label's own height — ensures the line sits BELOW the number, never overlapping it. */
const VERTICAL_GAP_RATIO = 0.18;
/** Fallback geometry for a MANUALLY-matched stand, which has a real clicked anchor point but no OCR-detected label bbox (spec: "využij existující detected stand-label bbox/anchor" — anchor is the explicit fallback for exactly this case). A small, fixed normalized width/gap — deliberately conservative since there's no real label size to derive from. */
export const REALIZATION_UNDERLINE_FALLBACK_WIDTH_NORMALIZED = 0.018;
const REALIZATION_UNDERLINE_FALLBACK_GAP_NORMALIZED = 0.004;

export type RealizationUnderlineGeometry = Readonly<{
  xNormalized: number;
  yNormalized: number;
  widthNormalized: number;
}>;

/**
 * `bbox` present (AUTO-matched stand, a real OCR-detected label) -> the line spans the label's own
 * width plus a small padding, positioned just under its bottom edge. `bbox` absent (MANUAL match,
 * anchor point only) -> a small fixed-size line centered on the anchor, since no real label extent
 * is known. Never guesses a bbox that doesn't exist (spec's own "never guess" discipline, same as
 * calculateSelectedStandMarker's own doc).
 */
export function computeRealizationUnderlineGeometry(
  anchor: Readonly<{ xNormalized: number; yNormalized: number }>,
  bbox?: Readonly<{ widthNormalized: number; heightNormalized: number }>,
): RealizationUnderlineGeometry {
  if (bbox) {
    const padding = bbox.widthNormalized * HORIZONTAL_PADDING_RATIO;
    const gap = bbox.heightNormalized * VERTICAL_GAP_RATIO;
    return {
      xNormalized: anchor.xNormalized - padding,
      yNormalized: anchor.yNormalized + bbox.heightNormalized + gap,
      widthNormalized: bbox.widthNormalized + 2 * padding,
    };
  }
  return {
    xNormalized: anchor.xNormalized - REALIZATION_UNDERLINE_FALLBACK_WIDTH_NORMALIZED / 2,
    yNormalized: anchor.yNormalized + REALIZATION_UNDERLINE_FALLBACK_GAP_NORMALIZED,
    widthNormalized: REALIZATION_UNDERLINE_FALLBACK_WIDTH_NORMALIZED,
  };
}

// ============================================================================
// Editor screen sizing (zoom-invariant thickness only — position/length come from the geometry
// above, expressed directly as CSS left/top/width percentages, no translate/anchor math needed).
// ============================================================================

/**
 * Target ON-SCREEN line thickness — visible at the ~1600% working zoom the spec calls out, never
 * dominant (spec: "ne dominantní"). Reduced from 3px to 2px (corrective batch section 4: "Current
 * line is TOO THICK... Thickness target: ~2px SCREEN-SPACE"). Still safely above `zoomInvariantPx`'s
 * own 0.05 raw-px floor at the highest supported zoom (40x/4000%: 2/40 = 0.05 exactly), so it stays
 * genuinely zoom-invariant all the way up rather than clamping into a thicker-than-intended line.
 */
export const REALIZATION_UNDERLINE_THICKNESS_TARGET_PX = 2;

export type RealizationUnderlineScreenStyle = Readonly<{ thicknessPx: number }>;

export function computeRealizationUnderlineScreenStyle(zoom: number): RealizationUnderlineScreenStyle {
  return { thicknessPx: zoomInvariantPx(REALIZATION_UNDERLINE_THICKNESS_TARGET_PX, zoom) };
}
