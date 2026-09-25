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
 *
 * Production-workflow batch: the cancel button reads "Zrušit umisťování" (the same
 * handleCancelPlacement Escape runs), and a subtle text line says when automatic continuation is on
 * — text, never color alone.
 */
export function TechnicalRasterPlacementContextPanel({
  mode,
  stand,
  service,
  placementId,
  autoContinue = false,
  sequential = false,
  onCancel,
}: {
  mode: "place" | "move";
  stand: TechnicalStand;
  service: TechnicalService;
  /** Only set for mode === "move" — identifies which existing point is being repositioned (spec section 9). */
  placementId?: string;
  /** "Automaticky pokračovat v umisťování" is on — only relevant to mode === "place" (a move never continues). */
  autoContinue?: boolean;
  /** This session was started by "Umístit chybějící postupně" — it continues regardless of autoContinue. */
  sequential?: boolean;
  onCancel: () => void;
}) {
  const presentation = resolveTechnicalServicePresentation(service.category, service.externalLabel);
  const displayLabel = presentation.displayLabel ?? service.externalLabel;
  const categoryLabel = technicalServiceCategoryLabel(service.category);
  const progress = computePlacementPointProgress(service, mode, placementId);

  return (
    <div className="technicalRasterPlacementContext" role="status" aria-live="polite">
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
      {mode === "place" && sequential && (
        <p className="technicalRasterPlacementContextAuto">Postupné umisťování chybějících</p>
      )}
      {mode === "place" && !sequential && autoContinue && (
        <p className="technicalRasterPlacementContextAuto">Automatické pokračování: zapnuto</p>
      )}
      <button type="button" className="technicalActionButton secondary compact" onClick={onCancel}>{mode === "place" ? "Zrušit umisťování" : "Zrušit přemisťování"}</button>
    </div>
  );
}
