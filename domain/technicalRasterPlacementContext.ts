/**
 * Technické rastry — "PRÁVĚ UMISŤUJI" context block view model (manual acceptance batch, section
 * 6/7). Pure, framework-free: derives exactly what the right-panel context block needs to show
 * while a placement/move is active, from the stand/service the editor already resolved — never a
 * new persisted field, purely a VIEW computed fresh from `effectiveServicePlacements`, exactly
 * like domain/technicalRasterWorkQueue.ts's own "always recompute, never a stored status"
 * discipline.
 *
 * The editor found this genuinely ambiguous in manual testing (spec section 6: "není dost jasné,
 * CO PRÁVĚ UMISŤUJE") — a single-line "Umísťujete: X — Stánek Y" banner didn't surface the point
 * INDEX (1/1, 1/2, 2/2, ...), so a qty>1 service left the user guessing whether their next click
 * would be the first or the last remaining point. This module is the ONE place that "Bod X / Y"
 * number is computed, so TechnicalRasterEditorPage.tsx / the new placement-context panel component
 * never duplicate the logic.
 */
import { effectiveServicePlacements, requiredPlacementCount, type TechnicalService } from "./technicalRaster.ts";

export type TechnicalRasterPlacementPointProgress = Readonly<{
  /** 1-based index of the point this specific placement/move interaction is about ("Bod X / Y"). */
  pointIndex: number;
  pointTotal: number;
}>;

/**
 * "place" mode (spec section 6/7): the NEXT point about to be created is `existingPlacements + 1`
 * — the same "keep targeting the same service until it's full" rule
 * domain/technicalRasterWorkQueue.ts's resolveNextPlacementTarget already applies, just surfaced
 * here as a display number. Clamped to `pointTotal` so a stale/over-quantity read (should never
 * happen — placeTechnicalService itself refuses once full) never displays a number past the total.
 *
 * "move" mode (spec section 9, re-surfaced here): the point being repositioned is whichever
 * EXISTING placement's id matches `placementId`, at its own current 1-based position among the
 * service's own placements — never recomputed as "next new point" (a move never changes how many
 * points exist). `placementId` not found (should not happen for a real in-flight move) falls back
 * to `1` rather than 0/NaN, so the block never renders a broken "Bod 0 / N".
 */
export function computePlacementPointProgress(
  service: TechnicalService,
  mode: "place" | "move",
  placementId?: string,
): TechnicalRasterPlacementPointProgress {
  const placements = effectiveServicePlacements(service);
  // CORRECTIVE BATCH (real production, "quantity is not always number of placement points") —
  // "Bod X / Y" must read against the REQUIRED placement count, never raw service.quantity (a
  // onePerRecord cleaning record with qty=40 must show "Bod 1 / 1", never "Bod 1 / 40").
  const pointTotal = requiredPlacementCount(service);
  if (mode === "move" && placementId) {
    const index = placements.findIndex((placement) => placement.id === placementId);
    return { pointIndex: index >= 0 ? index + 1 : 1, pointTotal };
  }
  return { pointIndex: Math.min(placements.length + 1, Math.max(pointTotal, 1)), pointTotal };
}
