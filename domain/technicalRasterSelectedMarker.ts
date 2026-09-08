/**
 * Technické rastry — pure geometry + zoom-invariant sizing for the "selected stand" marker (spec
 * batch 6, UI section 1-13, 50-51). Real manual browser testing at extreme zoom found the marker's
 * visual center drifting away from its intended anchor point as zoom increased — traced to the
 * PREVIOUS (batch 5) view-layer transform, which anchored the marker's DOM box by one of its own
 * EDGES (`translate(-100%, -100%)` for top-left, or no correction at all for bottom-right) and
 * baked the screen-space offset into that SAME transform, entangling three things that must stay
 * independent: WHERE the marker points (anchor), how far it's nudged away from a label bbox
 * (offset), and how big it visually is (size). A change to any one of those could shift what
 * looked like "the center" without the anchor coordinate itself ever changing.
 *
 * This batch's fix (spec section 2/4): the marker's CENTER is now the ONE thing every other
 * concern composes onto, never a corner —
 *
 *   center = anchor (page-space point) + centerOffset (screen-space nudge, AUTO only)
 *
 * — computed ENTIRELY separately from SIZE (computeSelectedMarkerScreenStyle, unchanged from batch
 * 5) and applied identically for AUTO and MANUAL: the view layer (TechnicalRasterCanvas.tsx)
 * always composes `translate(centerOffset) translate(-50%, -50%)`, where the FIRST translate moves
 * the anchor point to the intended CENTER (zero for MANUAL — the click point already IS the
 * center) and the SECOND, always identical `-50%` step centers the marker's own box (a function of
 * SIZE alone) around that point. Because translation composition is associative and each factor is
 * independently zoom-compensated (dividing by zoom here, multiplied back by the SAME zoom via
 * .technicalRasterStage's own `transform: scale(zoom)`), changing size can never move where the
 * center lands, and zoom can never drift it — see projectMarkerCenterToScreen's own doc for the
 * exact round-trip this guarantees, used both by tests here and by TechnicalRasterCanvas.tsx's
 * DEV-only diagnostic (spec section 13) to compare against a real getBoundingClientRect() reading.
 *
 * AUTO (a known label bbox — spec section 5/6/7): the marker's CENTER anchors diagonally OUTSIDE
 * the bbox, offset from one corner. Default is BOTTOM-RIGHT — falls back to TOP-LEFT only if the
 * bbox sits close enough to the page's own right/bottom edge that the marker (accounting for its
 * own radius/border/offset — spec section 7) would fall off-page. A plain deterministic yes/no
 * rule (spec section 7: "Nedělej AI ani komplikovaný collision engine"), never pixel-accurate
 * collision detection against the current zoom/viewport.
 *
 * MANUAL (a real clicked anchor point, no bbox — spec section 9/10): the SAME circle is drawn
 * directly ON the anchor point (centerOffset = 0,0), no offset, no invented bbox — never guessing
 * where a label "should" be. TechnicalRasterCanvas.tsx picks between these two purely based on
 * whether a bbox is present on the marker it's given (spec section 10: no new matching state).
 */

export type SelectedStandMarkerCorner = "top-left" | "bottom-right";

export type SelectedStandMarkerBbox = Readonly<{
  xNormalized: number;
  yNormalized: number;
  widthNormalized: number;
  heightNormalized: number;
}>;

export type SelectedStandMarkerGeometry = Readonly<{
  corner: SelectedStandMarkerCorner;
  /** The bbox corner point (normalized 0-1 page coordinates) the marker's center offsets from — bottom-right corner's own (x+width,y+height) for the default "bottom-right", top-left corner's own (x,y) for the "top-left" fallback. This is the ANCHOR, never itself the marker's center. */
  anchorXNormalized: number;
  anchorYNormalized: number;
}>;

/**
 * How close (in normalized page units) the bbox's own bottom-right corner may be to the page's
 * own right/bottom edge before a marker offset outside it would fall off-page. A plain constant
 * (not measured against the marker's actual on-screen pixel footprint — that's a separate,
 * zoom-dependent view-layer concern) — spec section 7 explicitly wants a simple deterministic rule
 * here. Sized generously enough to comfortably clear the marker's own radius+border+offset
 * footprint (~14px) at the zoom levels this app is actually used at.
 */
export const DEFAULT_OFF_PAGE_MARGIN_NORMALIZED = 0.03;

/** Never guesses a stand polygon (spec section 13, carried over) — always anchors to the real, known label bbox corner or the real, known manual anchor point. */
export function calculateSelectedStandMarker(
  bbox: SelectedStandMarkerBbox,
  offPageMarginNormalized: number = DEFAULT_OFF_PAGE_MARGIN_NORMALIZED,
): SelectedStandMarkerGeometry {
  const bottomRightX = bbox.xNormalized + bbox.widthNormalized;
  const bottomRightY = bbox.yNormalized + bbox.heightNormalized;
  const bottomRightFits = bottomRightX <= 1 - offPageMarginNormalized && bottomRightY <= 1 - offPageMarginNormalized;
  if (bottomRightFits) {
    return { corner: "bottom-right", anchorXNormalized: bottomRightX, anchorYNormalized: bottomRightY };
  }
  return { corner: "top-left", anchorXNormalized: bbox.xNormalized, anchorYNormalized: bbox.yNormalized };
}

// ============================================================================
// Zoom-invariant on-screen sizing (spec batch 5/6, UI section 11/12/50)
// ============================================================================

export type SelectedMarkerScreenStyle = Readonly<{
  /** Pre-transform CSS px to set as the marker's own width/height — divided by zoom so the ANCESTOR .technicalRasterStage's `transform: scale(zoom)` renders it back to SELECTED_MARKER_DIAMETER_TARGET_PX on screen. */
  diameterPx: number;
  /** Pre-transform CSS px to set as border-width, same compensation. */
  borderPx: number;
  /** Pre-transform CSS px offset magnitude for an AUTO marker's centerOffset, same compensation. Unused for MANUAL. */
  offsetPx: number;
}>;

/** Target ON-SCREEN (already zoom-compensated, i.e. what getBoundingClientRect() should report) marker diameter — spec section 11: "cca 10-12 CSS px". */
export const SELECTED_MARKER_DIAMETER_TARGET_PX = 11;
/** Target ON-SCREEN border thickness — spec section 11: "cca 2-2.5 CSS px". */
export const SELECTED_MARKER_BORDER_TARGET_PX = 2.5;
/** Target ON-SCREEN gap between an AUTO marker's NEAR edge and the bbox corner it's anchored to — spec section 6: "6-8 CSS px" is the gap the spec asks for; this constant is the CENTER offset, chosen (radius + a real 6-8px gap) so the marker's solid edge, not just its center, clears the bbox — see SELECTED_MARKER_OFFSET_TARGET_PX's own relationship to the diameter above. */
export const SELECTED_MARKER_OFFSET_TARGET_PX = SELECTED_MARKER_DIAMETER_TARGET_PX / 2 + 7;

/**
 * `.technicalRasterStage` (TechnicalRasterCanvas.tsx) is the marker's ONLY scaling ancestor — its
 * own `transform: scale(viewport.transform.zoom)` is the SINGLE multiplicative factor between a
 * marker's pre-transform CSS px and what actually lands on screen (verified directly against that
 * component: canvas/markers are siblings inside .technicalRasterStage, .technicalRasterViewport
 * itself carries no transform, and no marker applies any zoom-independent scale to itself beyond
 * this division). So dividing a target screen px by zoom here, then having the browser multiply
 * that back by the SAME zoom via the ancestor's CSS transform, is an EXACT round trip — this
 * function computes the pre-transform values to actually set inline.
 */
export function computeSelectedMarkerScreenStyle(zoom: number): SelectedMarkerScreenStyle {
  return {
    diameterPx: zoomInvariantPx(SELECTED_MARKER_DIAMETER_TARGET_PX, zoom),
    borderPx: zoomInvariantPx(SELECTED_MARKER_BORDER_TARGET_PX, zoom),
    offsetPx: zoomInvariantPx(SELECTED_MARKER_OFFSET_TARGET_PX, zoom),
  };
}

export function zoomInvariantPx(desiredScreenPx: number, zoom: number): number {
  // A defensive clamp (spec section 12: "Použij clamp", carried over) on top of the exact
  // mathematical compensation below — zoom itself is already clamped to [MIN_VIEWPORT_ZOOM,
  // MAX_VIEWPORT_ZOOM] in geometry/viewport.ts (0.02 to 40, i.e. 2% to 4000%), so this never
  // actually triggers in practice; it exists purely so a pathological zoom value could never
  // produce a degenerate (zero/huge/NaN) CSS px string.
  const raw = desiredScreenPx / zoom;
  return Math.min(2000, Math.max(0.05, raw));
}

/**
 * Simulates what the browser ACTUALLY renders once the ancestor's `transform: scale(zoom)` is
 * applied on top of a pre-transform px value — i.e. the full round trip, not just
 * `zoomInvariantPx`'s own division in isolation (spec section 12: "NEPŘEDPOKLÁDEJ, že unit test
 * helperu automaticky znamená správný skutečný CSS výsledek"). Tests use this to assert the ACTUAL
 * on-screen size/offset a real getBoundingClientRect() would report, for real zoom values, rather
 * than trusting the division alone.
 */
export function simulateRenderedPx(preTransformPx: number, zoom: number): number {
  return preTransformPx * zoom;
}

// ============================================================================
// Center anchoring (spec batch 6, UI section 2/4/9/10) — the actual fix.
// ============================================================================

export type SelectedMarkerAnchorKind = "auto-bottom-right" | "auto-top-left" | "manual";

export type SelectedMarkerCenterOffset = Readonly<{ dxPx: number; dyPx: number }>;

/**
 * The marker's CENTER is ALWAYS `anchor + this offset` (spec section 2: "ANCHOR POINT MUSÍ VŽDY
 * ZNAMENAT STŘED KRUHU"). For "manual", the offset is exactly (0,0) — the clicked point already IS
 * the center (spec section 9: "žádný offset"). For the two AUTO kinds, the offset pushes the
 * center diagonally OUTSIDE the bbox corner by `style.offsetPx` in both axes, sign per corner. This
 * is the ONLY place that decision is made, entirely independent of `style.diameterPx`/`borderPx` —
 * the view layer combines this with a plain, always-identical `translate(-50%, -50%)` (the
 * marker's own SIZE-based centering) and nothing else, so a SIZE change can never move where this
 * function says the center should be (spec section 4).
 */
export function computeMarkerCenterOffset(kind: SelectedMarkerAnchorKind, style: SelectedMarkerScreenStyle): SelectedMarkerCenterOffset {
  if (kind === "manual") return { dxPx: 0, dyPx: 0 };
  const sign = kind === "auto-top-left" ? -1 : 1;
  return { dxPx: sign * style.offsetPx, dyPx: sign * style.offsetPx };
}

export type MarkerScreenProjectionInput = Readonly<{
  anchorXNormalized: number;
  anchorYNormalized: number;
  /** .technicalRasterStage's own CSS layout width/height in px, BEFORE the ancestor's `scale(zoom)` — i.e. pageSizePt.width * viewport.pixelsPerMm (TechnicalRasterCanvas.tsx's `stageWidth`/`stageHeight`). */
  stageWidthPx: number;
  stageHeightPx: number;
  /** viewport.transform.pan.{x,y} — .technicalRasterStage's own translate(), applied AFTER scale in on-screen terms (CSS transform functions read right-to-left as nested transforms; pan here is in already-scaled screen px, matching how useBoothViewport computes it). */
  panX: number;
  panY: number;
  zoom: number;
  /** A PRE-transform (already zoom-divided) local offset — pass computeMarkerCenterOffset's own result directly. */
  centerOffset: SelectedMarkerCenterOffset;
}>;

/**
 * Projects a marker's normalized page-space anchor (plus its screen-space center offset) into
 * ABSOLUTE px relative to `.technicalRasterViewport`'s own top-left corner — matching EXACTLY what
 * the real CSS transform chain produces (spec batch 6, UI section 3/13). Reused by
 * TechnicalRasterCanvas.tsx's DEV-only diagnostic to compare this EXPECTED center against a real
 * `getBoundingClientRect()` reading of the actual rendered marker, and directly unit-testable here
 * without any DOM at all.
 */
export function projectMarkerCenterToScreen(input: MarkerScreenProjectionInput): Readonly<{ x: number; y: number }> {
  const localX = input.anchorXNormalized * input.stageWidthPx + input.centerOffset.dxPx;
  const localY = input.anchorYNormalized * input.stageHeightPx + input.centerOffset.dyPx;
  return {
    x: input.panX + localX * input.zoom,
    y: input.panY + localY * input.zoom,
  };
}
