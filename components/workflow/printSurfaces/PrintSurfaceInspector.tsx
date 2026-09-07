"use client";

import type { MarkerPlacement, PrintSurfaceItem, PrintSurfaceItemDimensionResolution } from "../../../domain/printSurfaceProject";
import { formatPrintSurfaceItemDimension } from "../../../domain/printSurfaceProject";
import { PRINT_SURFACE_TYPES, type PrintSurfaceTypeId } from "../../../domain/printSurfaceTypeCatalog";
import { presetsForType, printSurfacePresetDisplayName, type PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import { FASCIA_HEIGHT_MM } from "../../../domain/printSurfaceActiveTool";

export function PrintSurfaceInspector({
  item,
  placement,
  otherViewLabels,
  presets,
  dimensionResolution,
  onChangeLabel,
  onChangeType,
  onChangePreset,
  onChangeCustomWidth,
  onChangeCustomHeight,
  onChangeQuantity,
  onChangeNote,
  onDelete,
}: {
  item: PrintSurfaceItem | undefined;
  placement: MarkerPlacement | undefined;
  /** Labels of OTHER views this same physical item also has a placement on (spec section 9: one physical surface, possibly pinned on 2 views). */
  otherViewLabels: readonly string[];
  presets: readonly PrintSurfacePreset[];
  dimensionResolution: PrintSurfaceItemDimensionResolution;
  onChangeLabel: (label: string) => void;
  onChangeType: (typeId: PrintSurfaceTypeId) => void;
  onChangePreset: (presetId: string | undefined) => void;
  onChangeCustomWidth: (widthMm: number) => void;
  onChangeCustomHeight: (heightMm: number) => void;
  onChangeQuantity: (quantity: number) => void;
  onChangeNote: (note: string) => void;
  onDelete: () => void;
}) {
  const isFascia = item?.typeId === "fascia";
  const isCustom = item?.typeId === "custom";
  const isManual = isFascia || isCustom;

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

          {otherViewLabels.length > 0 && (
            <p className="fieldHint">Tato fyzická plocha je umístěná i na: {otherViewLabels.join(", ")} — úpravy zde platí pro všechna umístění.</p>
          )}

          {!isManual && (
            <>
              <label>
                <span>Typ plochy</span>
                <select value={item.typeId} onChange={(event) => onChangeType(event.target.value as PrintSurfaceTypeId)}>
                  {PRINT_SURFACE_TYPES.filter((type) => type.id !== "fascia" && type.id !== "custom").map((type) => (
                    <option key={type.id} value={type.id}>{type.labelCz}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Produkt / preset</span>
                <select value={item.presetId ?? ""} onChange={(event) => onChangePreset(event.target.value || undefined)}>
                  <option value="">— Bez presetu —</option>
                  {presetsForType(presets, item.typeId).map((preset) => (
                    <option key={preset.id} value={preset.id}>{printSurfacePresetDisplayName(preset)}</option>
                  ))}
                </select>
              </label>
              <div className={`printSurfaceDimensionField status-${dimensionResolution.status}`}>
                <span>Výrobní rozměr</span>
                <strong>{formatPrintSurfaceItemDimension(dimensionResolution)}</strong>
              </div>
            </>
          )}

          {isFascia && (
            <>
              <p className="fieldHint">Typ: Límec</p>
              <label>
                <span>Šířka</span>
                <input
                  type="number"
                  min={1}
                  value={item.customWidthMm ?? ""}
                  onChange={(event) => onChangeCustomWidth(Number(event.target.value))}
                />
              </label>
              <label>
                <span>Výška</span>
                <input value={`${FASCIA_HEIGHT_MM} mm`} readOnly disabled />
              </label>
            </>
          )}

          {isCustom && (
            <>
              <p className="fieldHint">Typ: Jiná plocha</p>
              <label>
                <span>Šířka</span>
                <input
                  type="number"
                  min={1}
                  value={item.customWidthMm ?? ""}
                  onChange={(event) => onChangeCustomWidth(Number(event.target.value))}
                />
              </label>
              <label>
                <span>Výška</span>
                <input
                  type="number"
                  min={1}
                  value={item.customHeightMm ?? ""}
                  onChange={(event) => onChangeCustomHeight(Number(event.target.value))}
                />
              </label>
            </>
          )}

          <label>
            <span>Počet</span>
            <input
              type="number"
              min={1}
              value={item.quantity ?? 1}
              onChange={(event) => onChangeQuantity(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>

          <label>
            <span>Poznámka</span>
            <textarea value={item.note} onChange={(event) => onChangeNote(event.target.value)} rows={4} />
          </label>
          {placement && <p className="fieldHint">X: {(placement.xNormalized * 100).toFixed(1)} % · Y: {(placement.yNormalized * 100).toFixed(1)} %</p>}
          {otherViewLabels.length === 0 && <p className="fieldHint">Toto je jediné umístění této plochy — smazáním zmizí celá plocha.</p>}
          <button type="button" className="textButton" onClick={onDelete}>Smazat</button>
        </>
      )}
    </aside>
  );
}
