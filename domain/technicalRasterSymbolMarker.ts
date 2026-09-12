/**
 * Technické rastry — zoom-invariant EDITOR screen sizing for a placed technical service symbol.
 * Deliberately reuses zoomInvariantPx from domain/technicalRasterSelectedMarker.ts (a plain,
 * marker-shape-agnostic function despite that module's name — see its own doc) rather than
 * duplicating the "pre-transform px so .technicalRasterStage's own transform:scale(zoom) renders
 * back to a fixed on-screen size" math a second time.
 *
 * A placement's normalized (xNormalized, yNormalized) point IS the symbol's CENTER (spec: "bod
 * umístění = STŘED exportovaného symbolu" — same "anchor=center" philosophy already established
 * for the selected-stand marker, but with ZERO center offset here — never diagonally nudged like
 * the auto-matched stand marker is). The view layer (TechnicalRasterCanvas.tsx) only ever composes
 * a single `translate(-50%, -50%)` against this point, nothing else.
 *
 * Corrective batch section 2: this batch found TWO real, manually-confirmed bugs in the PREVIOUS
 * design, both from the same root cause — a CSS property that was never run through
 * zoomInvariantPx, on an element inside `.technicalRasterStage` (which the ancestor scales via
 * `transform: scale(zoom)`, so ANY unscaled pixel value on a descendant grows/shrinks right along
 * with real zoom, exactly as if it were geometry):
 *
 *   1. `.technicalRasterServiceSymbolDot`'s own `box-shadow: 0 0 0 1px rgba(0,0,0,.25)` was a
 *      literal, un-compensated CSS value — at 600%/3000% zoom this rendered as a 6px/30px solid
 *      gray/black ring around every symbol, exactly the "velké šedé kruhy" the manual report
 *      described.
 *   2. `.technicalRasterServiceSymbolLabel`/`Star`'s own `font-size: 6px`/`8px` were ALSO literal,
 *      un-compensated values — at high zoom the label text (or the refrigerated-circuit asterisk)
 *      rendered many times its intended size, overflowing the small dot as the "bílé wedge/asterisk
 *      artefakty" the manual report described, obscuring the raster underneath.
 *
 * On TOP of that zoom bug, the visual design itself is replaced per this batch's own spec: no
 * default renderer draws a filled circular "badge" anymore (spec: "NEpoužívej jako default velké
 * plné kruhové badge") — `powerLabel`/`textLabel`/`fallback` are now plain colored BOLD TEXT with no
 * backdrop at all; `refrigeratedStar`/`waterDrop`/`wifiIcon` keep a small vector glyph/icon, also
 * with no backdrop — every size number below (text font size AND icon glyph box) is run through
 * zoomInvariantPx so this can never regress the same way again.
 *
 * Corrective batch (post real-file acceptance test) section 3: manual review at the zoom level
 * actually used in practice (~1600%) found the visible symbols (correctly zoom-invariant, no
 * circles/badges, no runaway growth at 3571%+) a little small to read comfortably. Bumped the two
 * VISIBLE-size constants +~17% (within the requested +15–20%) — `SYMBOL_CLICK_DIAMETER_TARGET_PX`
 * (the invisible hit target) and every selection-ring/halo constant are deliberately UNCHANGED, per
 * spec: "neměnit transparent hit target".
 */
import { zoomInvariantPx } from "./technicalRasterSelectedMarker.ts";

/** Target ON-SCREEN font size for a text-based symbol ("2 kW", "IP", "INT", "EL", "?") — small and readable up close, never a filled badge. */
export const SYMBOL_TEXT_FONT_SIZE_TARGET_PX = 10.5;
/** Target ON-SCREEN bounding box for an icon-shaped symbol (refrigeratedStar/waterDrop/wifiIcon glyph). */
export const SYMBOL_GLYPH_SIZE_TARGET_PX = 15;
/** Target ON-SCREEN invisible click-target diameter — large enough to comfortably hit a short label or a small glyph without ever being drawn as a visible disc itself. */
export const SYMBOL_CLICK_DIAMETER_TARGET_PX = 26;
/** Target ON-SCREEN border thickness for the selection ring drawn around a selected/moving placement (spec: "subtle outline, never a big red block"). */
export const SYMBOL_SELECTION_RING_BORDER_TARGET_PX = 2;
/** How far outside the glyph/text's own footprint the selection ring sits. */
export const SYMBOL_SELECTION_RING_GAP_TARGET_PX = 4;
/** A small white halo blur behind the colored text/glyph (spec: readable over a busy raster) — deliberately NOT a filled shape of any kind, just enough contrast to read the color against varied backgrounds; zoom-compensated for the exact same reason every other value here is (an un-compensated text-shadow blur would reproduce the same "grows with zoom" bug this whole module exists to fix). */
export const SYMBOL_TEXT_HALO_BLUR_TARGET_PX = 2;

export type SymbolScreenStyle = Readonly<{
  fontSizePx: number;
  glyphSizePx: number;
  clickDiameterPx: number;
  selectionRingDiameterPx: number;
  selectionRingBorderPx: number;
  haloBlurPx: number;
}>;

export function computeSymbolScreenStyle(zoom: number): SymbolScreenStyle {
  return {
    fontSizePx: zoomInvariantPx(SYMBOL_TEXT_FONT_SIZE_TARGET_PX, zoom),
    glyphSizePx: zoomInvariantPx(SYMBOL_GLYPH_SIZE_TARGET_PX, zoom),
    clickDiameterPx: zoomInvariantPx(SYMBOL_CLICK_DIAMETER_TARGET_PX, zoom),
    selectionRingDiameterPx: zoomInvariantPx(SYMBOL_GLYPH_SIZE_TARGET_PX + 2 * SYMBOL_SELECTION_RING_GAP_TARGET_PX, zoom),
    selectionRingBorderPx: zoomInvariantPx(SYMBOL_SELECTION_RING_BORDER_TARGET_PX, zoom),
    haloBlurPx: zoomInvariantPx(SYMBOL_TEXT_HALO_BLUR_TARGET_PX, zoom),
  };
}
