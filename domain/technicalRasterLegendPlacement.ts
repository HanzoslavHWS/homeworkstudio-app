/**
 * Technické rastry — corrective batch section 7: WHERE the export's legend gets drawn. Kept
 * completely separate from the legend's own CONTENT (domain/technicalRasterExport.ts's
 * buildTechnicalRasterExportLegend) and from the placement/symbol rendering strategy — a future
 * third placement kind (spec's own "do budoucna page-overlay/user-positioned") only ever needs a
 * new case here, never touching how legend rows are computed or how technical symbols are drawn.
 *
 * "source-legend-area" (overlaying the source raster's OWN existing legend block with a white
 * rectangle and redrawing a compact technical legend inside it, spec section 7) requires a REAL,
 * EXPLICIT region — this module NEVER guesses one via a heuristic (spec: "Pokud nelze source
 * legend region spolehlivě najít automaticky, nedělej fake heuristiku, která může překrýt mapu").
 * `resolveEffectiveLegendPlacement` enforces this: a `"source-legend-area"` strategy with no
 * `sourceRegion` configured yet safely falls back to `"separate-page"` (today's existing, safe
 * behavior) rather than silently drawing nothing or guessing a box that could cover real map
 * content.
 */

export type TechnicalLegendPlacementStrategy = "separate-page" | "source-legend-area";

/** A user-defined (never auto-detected) rectangle on one specific source page, in the SAME normalized 0-1 page-coordinate space every other placement in this app already uses. */
export type TechnicalLegendSourceRegion = Readonly<{
  page: number;
  xNormalized: number;
  yNormalized: number;
  widthNormalized: number;
  heightNormalized: number;
}>;

export type TechnicalLegendPlacement = Readonly<{
  strategy: TechnicalLegendPlacementStrategy;
  /** Required for `"source-legend-area"` to actually take effect — see resolveEffectiveLegendPlacement. Meaningless/ignored for `"separate-page"`. */
  sourceRegion?: TechnicalLegendSourceRegion;
}>;

/** Today's existing, already-accepted behavior (spec section 7: "zachovat původní velikost stránky... source stránku nezvětšovat") — a brand-new project (or one saved before this field existed) gets exactly this, no migration needed. */
export const DEFAULT_LEGEND_PLACEMENT: TechnicalLegendPlacement = { strategy: "separate-page" };

/**
 * The ONE place export code (or a settings-panel preview) resolves "where does the legend actually
 * go" — never a raw `project.rasterSettings.legendPlacement` read elsewhere. A `"source-legend-
 * area"` strategy with no region configured yet is treated exactly like `"separate-page"` — never a
 * silent no-op (which would ship an export with NO legend at all) and never a guessed region.
 */
export function resolveEffectiveLegendPlacement(placement: TechnicalLegendPlacement | undefined): TechnicalLegendPlacement {
  const value = placement ?? DEFAULT_LEGEND_PLACEMENT;
  if (value.strategy === "source-legend-area" && !value.sourceRegion) return DEFAULT_LEGEND_PLACEMENT;
  return value;
}

/** A region normalized rectangle must stay within [0,1] and have a positive area — same discipline as isValidNormalizedCoordinate (domain/technicalRasterExportPlacementGeometry.ts), applied to a RECTANGLE instead of a point. Never clamped, never guessed — an invalid region is simply rejected by the caller (UI validation), this is the pure check both the UI and the export can share. */
export function isValidLegendSourceRegion(region: TechnicalLegendSourceRegion): boolean {
  const { xNormalized, yNormalized, widthNormalized, heightNormalized } = region;
  const finite = [xNormalized, yNormalized, widthNormalized, heightNormalized].every((value) => Number.isFinite(value));
  if (!finite) return false;
  if (widthNormalized <= 0 || heightNormalized <= 0) return false;
  return xNormalized >= 0 && yNormalized >= 0 && xNormalized + widthNormalized <= 1 && yNormalized + heightNormalized <= 1;
}
