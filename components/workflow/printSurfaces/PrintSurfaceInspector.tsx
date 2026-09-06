"use client";

import type { PrintSurfaceItem } from "../../../domain/printSurfaceProject";
import { PRINT_SURFACE_TYPES, type PrintSurfaceTypeId } from "../../../domain/printSurfaceTypeCatalog";
import { presetsForType, type PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import type { ProductionDimensionResolution } from "../../../domain/printSurfaceProductionDimension";

function formatResolution(resolution: ProductionDimensionResolution): string {
  return resolution.status === "found"
    ? `${resolution.dimension.widthMm} × ${resolution.dimension.heightMm} mm`
    : "Rozměr není definován";
}

export function PrintSurfaceInspector({
  item,
  presets,
  productionDimensionResolution,
  onChangeLabel,
  onChangeType,
  onChangePreset,
  onChangeNote,
  onDelete,
}: {
  item: PrintSurfaceItem | undefined;
  presets: readonly PrintSurfacePreset[];
  productionDimensionResolution: ProductionDimensionResolution;
  onChangeLabel: (label: string) => void;
  onChangeType: (typeId: PrintSurfaceTypeId) => void;
  onChangePreset: (presetId: string | undefined) => void;
  onChangeNote: (note: string) => void;
  onDelete: () => void;
}) {
  return (
    <aside className="workflowCard printSurfaceMarkerInspector">
      <div className="workflowCardHeader">
        <div>
          <span>PLOCHA</span>
          <strong>{item ? `Označení ${item.label}` : "Inspektor"}</strong>
        </div>
      </div>

      {!item && <p className="workspaceEmpty">Vyberte plochu na obrázku nebo v seznamu.</p>}

      {item && (
        <>
          <label>
            <span>Označení</span>
            <input value={item.label} onChange={(event) => onChangeLabel(event.target.value)} />
          </label>
          <label>
            <span>Typ plochy</span>
            <select value={item.typeId} onChange={(event) => onChangeType(event.target.value as PrintSurfaceTypeId)}>
              {PRINT_SURFACE_TYPES.map((type) => (
                <option key={type.id} value={type.id}>{type.labelCz}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Preset / Název tiskové plochy</span>
            <select value={item.presetId ?? ""} onChange={(event) => onChangePreset(event.target.value || undefined)}>
              <option value="">— Bez presetu —</option>
              {presetsForType(presets, item.typeId).map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
          </label>
          <div className="printSurfaceDimensionField">
            <span>Výrobní rozměr</span>
            <strong className={productionDimensionResolution.status === "found" ? "" : "unresolved"}>
              {formatResolution(productionDimensionResolution)}
            </strong>
          </div>
          <label>
            <span>Poznámka</span>
            <textarea value={item.note} onChange={(event) => onChangeNote(event.target.value)} rows={4} />
          </label>
          <p className="fieldHint">X: {(item.xNormalized * 100).toFixed(1)} % · Y: {(item.yNormalized * 100).toFixed(1)} %</p>
          <button type="button" className="textButton" onClick={onDelete}>Smazat</button>
        </>
      )}
    </aside>
  );
}
