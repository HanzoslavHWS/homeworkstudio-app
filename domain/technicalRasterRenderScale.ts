/**
 * Technické rastry — dynamic pdf.js render resolution (spec batch 4, UI section 9/10/11).
 *
 * ROOT CAUSE of softness at high zoom: TechnicalRasterCanvas.tsx renders the PDF page to a canvas
 * ONCE (at page/layer-visibility change), at a FIXED internal resolution — everything past that is
 * pure CSS `transform: scale(viewport.transform.zoom)` on `.technicalRasterStage` (see that file's
 * own module doc: "pdf.js only re-renders when the PAGE or LAYER VISIBILITY actually changes,
 * never on every zoom/pan tick"). The on-screen sharpness of that one fixed bitmap is therefore
 * `renderScale / (0.3 * zoom)` backing-pixels-per-CSS-pixel (0.3 = DEFAULT_PIXELS_PER_MM from
 * geometry/viewport.ts, reused here as this app's px-per-PDF-point display constant) — a FIXED
 * renderScale means that ratio decays as 1/zoom, so the same bitmap looks progressively softer the
 * more the user zooms in. This was never a bug in pdf.js or a missing devicePixelRatio tweak — it
 * is the direct, expected consequence of "render once, scale via CSS forever after."
 *
 * FIX: make renderScale track zoom directly (`BASE_RENDER_SCALE * zoom`), which keeps that
 * backing-pixel-density ratio CONSTANT at the same value it already had at zoom=1 today (i.e. the
 * quality this app already shipped with, extended to every zoom level instead of only the
 * lowest), capped by a hard pixel-dimension/area budget so a user at the UI's max zoom
 * (MAX_VIEWPORT_ZOOM=40 in geometry/viewport.ts, i.e. 4000%) never allocates a runaway canvas
 * (spec section 11: "Nesmí vzniknout canvas 30000×20000").
 */

/** Unchanged from before this batch — the floor for low/typical zoom, so nothing gets SOFTER than it already was. */
export const BASE_RENDER_SCALE = 2.5;
/** Independent ceiling on how far resolution is allowed to chase zoom before even the pixel-budget caps below apply — mostly relevant for small pages, where the budget caps alone would otherwise allow a pointlessly large multiplier. */
export const MAX_RENDER_SCALE = 10;
/** A single canvas side never exceeds this many device pixels. */
export const MAX_CANVAS_DIMENSION_PX = 6000;
/** ~24 effective megapixels — comfortably inside every real browser's actual canvas limits, with headroom. */
export const MAX_CANVAS_AREA_PX = 24_000_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * `pageWidthPt`/`pageHeightPt` are the PDF page's own point dimensions at scale 1
 * (`page.getViewport({ scale: 1 })`). Result is never above whichever is smaller of
 * MAX_RENDER_SCALE or what the pixel-dimension/area budget allows for THIS page's own size — the
 * budget is a HARD ceiling, applied last, never overridden back up by the BASE_RENDER_SCALE floor
 * below it. For any realistic hall-plan page BASE_RENDER_SCALE stays well under the budget (a
 * ~1x1m plan at typical PDF point density is nowhere near the pixel caps), so the floor holds in
 * practice — but if a page were ever large enough that even BASE_RENDER_SCALE would blow the
 * budget, spec section 11 is explicit that the safety limit wins: "Pokud by vyšší kvalita
 * vyžadovala velký zásah: NEIMPLEMENTUJ ji" — never a runaway canvas, even at the cost of
 * dropping below the usual baseline quality for that one oversized page.
 */
export function computeEffectiveRenderScale(pageWidthPt: number, pageHeightPt: number, zoom: number): number {
  const zoomDrivenScale = clamp(BASE_RENDER_SCALE * zoom, BASE_RENDER_SCALE, MAX_RENDER_SCALE);
  if (!(pageWidthPt > 0) || !(pageHeightPt > 0)) return zoomDrivenScale;
  const dimensionCap = Math.min(MAX_CANVAS_DIMENSION_PX / pageWidthPt, MAX_CANVAS_DIMENSION_PX / pageHeightPt);
  const areaCap = Math.sqrt(MAX_CANVAS_AREA_PX / (pageWidthPt * pageHeightPt));
  return Math.min(zoomDrivenScale, dimensionCap, areaCap);
}

/** True when the resulting canvas backing store (at the given scale) is within the pixel-dimension AND area budget — used by tests to pin the "never a runaway canvas" guarantee independently of the specific cap values above. */
export function isWithinCanvasPixelBudget(pageWidthPt: number, pageHeightPt: number, scale: number): boolean {
  // A small relative (not fixed +1) tolerance: computeEffectiveRenderScale derives its area cap
  // via Math.sqrt(), and squaring that back to check area can land a hair over the exact budget
  // purely from floating-point rounding — never a real, meaningfully-oversized canvas.
  const tolerance = 1.0001;
  const width = pageWidthPt * scale;
  const height = pageHeightPt * scale;
  return width <= MAX_CANVAS_DIMENSION_PX * tolerance && height <= MAX_CANVAS_DIMENSION_PX * tolerance && width * height <= MAX_CANVAS_AREA_PX * tolerance;
}
