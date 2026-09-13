"use client";

import { TECHNICAL_SERVICE_CATEGORIES } from "../../../domain/technicalServiceCatalog";
import { resolveTechnicalServicePresentation, TECHNICAL_RASTER_COLORS } from "../../../domain/technicalRasterServicePresentation";

/**
 * One representative color swatch per category — purely a visual hint in this panel, resolved from
 * a representative label so it never invents a one-off color (spec section 56: colors always come
 * from TECHNICAL_RASTER_COLORS). Categories with no dedicated color (waste/other) fall back to the
 * same neutral gray their own presentation already uses.
 *
 * UI/CSS POLISH BATCH section 6 — "cleaning" is now included here too: it DOES have its own real
 * color (TECHNICAL_RASTER_COLORS.cleaning, purple), same as the actual ÚKL marker drawn on the
 * raster/export — this swatch was previously falling through to the neutral fallback gray purely
 * because no sample label was listed for it, which was an inconsistency, not an intentional
 * "cleaning is gray" decision. "waste" is deliberately NOT added here yet (spec: "keep neutral gray
 * for now, do not invent a new color for waste") — it still resolves via the fallback branch below.
 */
function representativeColor(categoryId: string): string {
  const sampleLabelByCategory: Record<string, string> = { electricity: "Do 3kW 230V", internet: "Pevná IP", water: "x", cleaning: "Denní úklid" };
  const sampleLabel = sampleLabelByCategory[categoryId];
  return sampleLabel ? resolveTechnicalServicePresentation(categoryId, sampleLabel).color : TECHNICAL_RASTER_COLORS.fallback;
}

/**
 * "TECHNICKÉ ZNAČKY" (spec batch 7 section 34-37) — per-CATEGORY visibility for this app's OWN
 * drawn technical symbols. Deliberately a completely separate component/section from
 * TechnicalRasterLayerPanel.tsx (the source PDF's real Optional Content Groups) — toggling a
 * category here only ever hides/shows already-placed symbols on screen and in export, it NEVER
 * touches the source PDF, its layers, or a placement's own stored data (spec section 36: "hidden
 * neztrácí placement data").
 */
export function TechnicalRasterSymbolLayerPanel({
  hiddenCategories,
  onToggleCategory,
  showRealizations,
  onToggleShowRealizations,
}: {
  hiddenCategories: ReadonlySet<string>;
  onToggleCategory: (categoryId: string, hidden: boolean) => void;
  /** Corrective batch section 10 — "Zobrazit realizačky" (editor canvas only, independent of the export-only "Zahrnout realizačky do exportu" toggle in TechnicalRasterOutputsPanel.tsx). Optional so any OTHER caller of this panel (there are none today, but the component itself stays a plain, self-contained view-filter bar) never needs to wire a realization toggle it doesn't use. */
  showRealizations?: boolean;
  onToggleShowRealizations?: (show: boolean) => void;
}) {
  return (
    <div className="workflowCard technicalRasterSymbolLayerPanel">
      <div className="workflowCardHeader"><div><span>TECHNICKÉ ZNAČKY</span></div></div>
      <ul className="technicalRasterLayerList">
        {TECHNICAL_SERVICE_CATEGORIES.filter((category) => category.id !== "other").map((category) => (
          <li key={category.id}>
            <label>
              <input
                type="checkbox"
                checked={!hiddenCategories.has(category.id)}
                onChange={(event) => onToggleCategory(category.id, !event.target.checked)}
              />
              <span className="technicalRasterSymbolLayerSwatch" style={{ background: representativeColor(category.id) }} />
              {category.labelCz}
            </label>
          </li>
        ))}
        {onToggleShowRealizations && (
          <li>
            <label>
              <input type="checkbox" checked={Boolean(showRealizations)} onChange={(event) => onToggleShowRealizations(event.target.checked)} />
              <span className="technicalRasterSymbolLayerSwatch technicalRasterSymbolLayerSwatchRealizace" aria-hidden="true" />
              Realizačky
            </label>
          </li>
        )}
      </ul>
    </div>
  );
}
