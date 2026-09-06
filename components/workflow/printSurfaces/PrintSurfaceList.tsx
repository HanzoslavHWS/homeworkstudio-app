"use client";

import {
  formatPrintSurfaceItemDimension,
  itemForPlacement,
  placementsForItem,
  printSurfaceItemSurfaceName,
  resolvePrintSurfaceItemDimension,
  type MarkerPlacement,
  type PrintSurfaceItem,
} from "../../../domain/printSurfaceProject";
import { formatPrintSurfacePriceStatus, type PrintSurfacePriceResolution } from "../../../domain/printSurfacePricing";
import { printSurfaceTypeLabel } from "../../../domain/printSurfaceTypeCatalog";
import type { PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimension } from "../../../domain/printSurfaceProductionDimension";

export function PrintSurfaceList({
  items,
  placements,
  allPlacements,
  selectedPlacementId,
  presets,
  productionDimensions,
  realizationCompanyId,
  priceResolutions,
  onSelectPlacement,
  onDeletePlacement,
}: {
  /** All physical items in the project — used to resolve each placement's item (label/type/etc). */
  items: readonly PrintSurfaceItem[];
  /** Placements belonging to the currently active view only — one row per placement, matching what's pinned on the canvas right now. */
  placements: readonly MarkerPlacement[];
  /** Every placement in the project (all views) — used only to detect an item pinned on more than one view, for the "2 pohledy" badge. */
  allPlacements: readonly MarkerPlacement[];
  selectedPlacementId: string | undefined;
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  realizationCompanyId: string | undefined;
  priceResolutions: ReadonlyMap<string, PrintSurfacePriceResolution>;
  onSelectPlacement: (id: string) => void;
  onDeletePlacement: (id: string) => void;
}) {
  return (
    <section className="workflowCard printSurfaceListCard">
      <div className="workflowCardHeader">
        <div>
          <span>SEZNAM</span>
          <strong>Tiskové plochy ({placements.length})</strong>
        </div>
      </div>

      {placements.length === 0 && (
        <p className="workspaceEmpty">Zatím žádné plochy — vyberte nástroj v toolbaru a klikněte do obrázku.</p>
      )}

      {placements.length > 0 && (
        <div className="printSurfaceTable">
          <div className="printSurfaceTableRow printSurfaceTableHeader">
            <span>Označení</span>
            <span>Typ</span>
            <span>Název plochy</span>
            <span>Výrobní rozměr</span>
            <span>Cena</span>
            <span>Poznámka</span>
            <span>Akce</span>
          </div>
          {placements.map((placement) => {
            const item = itemForPlacement(items, placement);
            if (!item) return null;
            const resolution = resolvePrintSurfaceItemDimension(item, realizationCompanyId, productionDimensions);
            const priceResolution = priceResolutions.get(item.id);
            const placementCount = placementsForItem(allPlacements, item.id).length;
            return (
              <div
                key={placement.id}
                className={placement.id === selectedPlacementId ? "printSurfaceTableRow active" : "printSurfaceTableRow"}
                onClick={() => onSelectPlacement(placement.id)}
              >
                <strong>{item.label}{placementCount > 1 && <span className="printSurfaceMultiViewBadge" title="Umístěno na více pohledech"> · {placementCount} pohledy</span>}</strong>
                <span>{printSurfaceTypeLabel(item.typeId)}</span>
                <span>{printSurfaceItemSurfaceName(item, presets)}</span>
                <span className={resolution.status === "unavailable" ? "printSurfaceDimensionUnavailable" : ""}>
                  {formatPrintSurfaceItemDimension(resolution)}
                </span>
                <span className={priceResolution ? `status-${priceResolution.status}` : ""}>
                  {item.includeInCalculation && priceResolution ? formatPrintSurfacePriceStatus(priceResolution) : "—"}
                </span>
                <span className="printSurfaceTableNote">{item.note || "—"}</span>
                <button
                  type="button"
                  className="textButton"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeletePlacement(placement.id);
                  }}
                >
                  Smazat
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
