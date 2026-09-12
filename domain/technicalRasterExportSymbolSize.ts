/**
 * Technické rastry — corrective batch section 3: CENTRAL print-size constants for the vector PDF
 * export's technical symbols. Before this batch, `lib/technicalRasterVectorPdf.ts` drew every
 * point symbol as a filled circle (`EXPORT_SYMBOL_RADIUS_PT = 9.5`, i.e. a 19pt / ~6.7mm diameter
 * badge) with the short text/glyph centered on top of it — real manual review of the exported PDF
 * found this genuinely too large: "6 kW" in a solid red circle, repeated across a busy hall plan,
 * visually dominates and overlaps neighboring stands. This module is the ONE place that decides how
 * big a symbol's own text/glyph is allowed to be in the export — never a literal pt number inline
 * in the drawing code (spec's own "Zaveď centrální print-size konstanty, aby velikost byla
 * předvídatelná").
 *
 * The new visual language (spec section 2/3, shared with the editor's own on-screen redesign):
 * NO mandatory circular badge — a compact colored text/glyph directly at the placement point,
 * matching the target "malé barevné texty/glyfy, žádný povinný circle badge, velmi kompaktní".
 * `waterDrop`/`wifiIcon` keep their own small vector SHAPE (a drop/wifi arcs have no natural short
 * text form) but at a similarly compact physical size, also with no circular backdrop.
 *
 * Pure constants + unit conversion only — zero pdf-lib/font dependency, so the actual measured
 * bounding box (which needs a real font's glyph metrics) is computed in lib/technicalRasterVectorPdf.ts
 * itself and can be asserted against these limits directly in tests (see
 * tests/technicalRasterExportSymbolSize.test.ts and the "physical bounding box" tests in
 * tests/technicalRasterVectorPdf.test.ts) — never trusted as "obviously fine" from the constant
 * alone (spec's own "diagnostikuj skutečnou FYZICKOU velikost výsledku, ne jen náhodné CSS/PDF
 * číslo").
 */

const PT_PER_MM = 72 / 25.4;

export function ptToMm(pt: number): number {
  return pt / PT_PER_MM;
}

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

/**
 * Font size for short text labels — deliberately small; these are read up close by a technician
 * on-site, not from across the hall.
 *
 * CORRECTIVE BATCH (3rd, post real-file acceptance test) section 7: the previous 7pt size was still
 * "dramatically too large" in real exports — real feedback: "5 kW behaves visually like a large
 * heading inside the stand", "2 kW overlaps/dominates small stands." Cut to ~47% of the previous
 * value (spec: "roughly 45-50% of their current visible size, i.e. roughly a 50-55% reduction"),
 * preserving the SAME relative proportions between text/star/drop that already existed. This
 * constant is used ONLY for generator-added placement markers inside the raster — the legend has
 * its own, entirely separate `IN_PLACE_LEGEND_FONT_SIZE_PT` in lib/technicalRasterVectorPdf.ts and
 * is not affected by this change.
 *
 * CORRECTIVE BATCH (4th, export-polish-only): split OFF electricity's own power-label size (see
 * `EXPORT_POWER_LABEL_FONT_SIZE_PT` below) after real manual acceptance found exported power labels
 * ("2 kW"/"5 kW"/"6 kW"/"9 kW") still slightly too large. This constant now applies ONLY to the
 * `textLabel` renderer (internet "IP"/"INT") and the neutral `fallback` ("?") glyph — never touched
 * by this 4th batch, per its own explicit "do NOT change INT/IP" instruction.
 */
export const EXPORT_TEXT_SYMBOL_FONT_SIZE_PT = 3.3;
/**
 * CORRECTIVE BATCH (4th, export-polish-only) — electricity's own "N kW"/"EL" power-label size,
 * split off from the shared `EXPORT_TEXT_SYMBOL_FONT_SIZE_PT` above so it can be tuned
 * independently of INT/IP/fallback (spec: "do NOT change INT/IP... split the export constants so
 * power labels can be tuned independently"). Reduced ~16.7% from the previous shared 3.3pt value
 * (spec: "reduce by approximately 15-20%... target approximately 2.7-2.8pt, prefer ~2.75pt") — this
 * is an EXPORT-ONLY change; the editor's own on-screen power-label size is untouched.
 */
export const EXPORT_POWER_LABEL_FONT_SIZE_PT = 2.75;
/** The "refrigerated/non-stop" asterisk glyph gets its own, slightly larger size (a bare "*" reads smaller than a same-size digit at a glance). Reduced to ~47% alongside the text size above (section 7). */
export const EXPORT_STAR_SYMBOL_FONT_SIZE_PT = 4.1;
/** Target overall height (bounding box) for the vector water-drop shape. Reduced to ~47% alongside the text size above (section 7). */
export const EXPORT_WATER_DROP_HEIGHT_PT = 3.3;
/** Target overall width for the small vector WiFi-arcs shape (informational-only in V1 — see resolveTechnicalServicePresentation's own doc — but the export drawing code stays ready for it). Reduced to ~47% alongside the text size above (section 7). */
export const EXPORT_WIFI_SYMBOL_WIDTH_PT = 3.5;

/**
 * A hard ceiling this batch's own tests assert every point symbol's bounding box against (spec:
 * "velmi kompaktní... nepřekrývat stánek") — generous enough for the longest real label this app
 * produces ("9 kW" / "12 kW"-shaped strings) at `EXPORT_TEXT_SYMBOL_FONT_SIZE_PT`, but small enough
 * to catch a real regression back toward an oversized marker. Reduced proportionally alongside the
 * ~47% font-size reduction above (corrective batch section 7) so the ceiling still comfortably
 * (never tightly) covers the new size.
 */
export const EXPORT_SYMBOL_MAX_BOUNDING_WIDTH_PT = 9;
export const EXPORT_SYMBOL_MAX_BOUNDING_HEIGHT_PT = 5.5;

// ============================================================================
// Realization underline print sizing (corrective batch, post real-file acceptance test, section 5)
// — REPLACES the previous "realization badge" design entirely (a white box + dark outline +
// redrawn stand number FAILED manual acceptance: dominant black pill, duplicated info the source
// PDF already prints — see domain/technicalRasterRealizationUnderline.ts's own doc). Now just ONE
// physical thickness for a plain vector line/stroke — no fill, no transparency, nothing Corel would
// need any complex object structure for.
// ============================================================================

/**
 * Physical line thickness for the realization underline — a real, ordinary PDF stroke width,
 * central here so it's never a literal number inline in the drawing code. CORRECTIVE BATCH (3rd)
 * section 5: 1.2pt was "too dominant" in a real export; reduced ~29% to ~0.85pt (spec: "reduce by
 * ~25-30% to target ~0.8-0.9pt"). Still an ordinary vector stroke — no fill, no transparency, no
 * ExtGState — the same simple primitive that already imports correctly in Corel 2018.
 */
export const REALIZATION_UNDERLINE_THICKNESS_PT = 0.85;
