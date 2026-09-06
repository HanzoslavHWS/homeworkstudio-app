"use client";

import type { PrintSurfaceItem } from "../../../domain/printSurfaceProject";
import { printSurfaceTypeLabel } from "../../../domain/printSurfaceTypeCatalog";
import { findPreset, type PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import {
  resolvePrintSurfaceProductionDimension,
  type PrintSurfaceProductionDimension,
} from "../../../domain/printSurfaceProductionDimension";

export function PrintSurfaceList({
  items,
  selectedItemId,
  presets,
  productionDimensions,
  realizationCompanyId,
  onSelectItem,
  onDeleteItem,
}: {
  items: readonly PrintSurfaceItem[];
  selectedItemId: string | undefined;
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  realizationCompanyId: string | undefined;
  onSelectItem: (id: string) => void;
  onDeleteItem: (id: string) => void;
}) {
  return (
    <section className="workflowCard printSurfaceListCard">
      <div className="workflowCardHeader">
        <div>
          <span>SEZNAM</span>
          <strong>Tiskové plochy ({items.length})</strong>
        </div>
      </div>

      {items.length === 0 && (
        <p className="workspaceEmpty">Zatím žádné plochy — vyberte typ plochy a klikněte do obrázku.</p>
      )}

      {items.length > 0 && (
        <div className="printSurfaceTable">
          <div className="printSurfaceTableRow printSurfaceTableHeader">
            <span>Označení</span>
            <span>Typ</span>
            <span>Název plochy</span>
            <span>Výrobní rozměr</span>
            <span>Poznámka</span>
            <span>Akce</span>
          </div>
          {items.map((item) => {
            const preset = findPreset(presets, item.presetId);
            const resolution = resolvePrintSurfaceProductionDimension(
              { realizationCompanyId, presetId: item.presetId },
              productionDimensions,
            );
            return (
              <div
                key={item.id}
                className={item.id === selectedItemId ? "printSurfaceTableRow active" : "printSurfaceTableRow"}
                onClick={() => onSelectItem(item.id)}
              >
                <strong>{item.label}</strong>
                <span>{printSurfaceTypeLabel(item.typeId)}</span>
                <span>{preset?.name ?? "—"}</span>
                <span>{resolution.status === "found" ? `${resolution.dimension.widthMm} × ${resolution.dimension.heightMm} mm` : "—"}</span>
                <span className="printSurfaceTableNote">{item.note || "—"}</span>
                <button
                  type="button"
                  className="textButton"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteItem(item.id);
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
