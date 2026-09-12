"use client";

import { technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";
import { resolveTechnicalServicePresentation } from "../../../domain/technicalRasterServicePresentation";
import { computePlacementPointProgress } from "../../../domain/technicalRasterPlacementContext";
import type { TechnicalService, TechnicalStand } from "../../../domain/technicalRaster";

/**
 * "PRÁVĚ UMISŤUJI" (manual acceptance batch, section 6/7) — the TOP of the right panel while a
 * placement/move is active (spec section 5's own new priority order: this is priority #1). Replaces
 * the previous single-line ".technicalRasterPlacementBanner" — real manual testing found that line
 * didn't make clear WHAT was being placed or how many points remained, especially once
 * auto-advance (TechnicalRasterEditorPage.tsx's advancePlacementAfterCommit) moves on to the NEXT
 * service; this block is keyed on service/placementId so React remounts a fresh instance the
 * INSTANT the target service changes (spec section 7: "context block se musí okamžitě změnit").
 */
export function TechnicalRasterPlacementContextPanel({
  mode,
  stand,
  service,
  placementId,
  onCancel,
}: {
  mode: "place" | "move";
  stand: TechnicalStand;
  service: TechnicalService;
  /** Only set for mode === "move" — identifies which existing point is being repositioned (spec section 9). */
  placementId?: string;
  onCancel: () => void;
}) {
  const presentation = resolveTechnicalServicePresentation(service.category, service.externalLabel);
  const displayLabel = presentation.displayLabel ?? service.externalLabel;
  const categoryLabel = technicalServiceCategoryLabel(service.category);
  const progress = computePlacementPointProgress(service, mode, placementId);

  return (
    <div className="technicalRasterPlacementContext">
      <span className="technicalRasterPlacementContextHeader">{mode === "place" ? "PRÁVĚ UMISŤUJI" : "PRÁVĚ PŘEMISŤUJI"}</span>
      <strong className="technicalRasterPlacementContextLabel">{displayLabel}</strong>
      <span className="technicalRasterPlacementContextCategory">{categoryLabel}</span>
      <div className="technicalRasterPlacementContextRow">
        <span>Stánek:</span>
        <strong>{stand.standNumber}{stand.companyName ? ` — ${stand.companyName}` : ""}</strong>
      </div>
      <div className="technicalRasterPlacementContextRow">
        <span>Bod:</span>
        <strong>{progress.pointIndex} / {progress.pointTotal}</strong>
      </div>
      <p className="technicalRasterPlacementContextHint">Klikněte do rastru.</p>
      <button type="button" className="textButton" onClick={onCancel}>Zrušit</button>
    </div>
  );
}
