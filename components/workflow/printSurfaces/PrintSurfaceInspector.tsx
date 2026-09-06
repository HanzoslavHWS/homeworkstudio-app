"use client";

import type { PrintSurfaceItem } from "../../../domain/printSurfaceProject";
import { PRINT_SURFACE_TYPES, type PrintSurfaceTypeId } from "../../../domain/printSurfaceTypeCatalog";

export function PrintSurfaceInspector({
  item,
  onChangeLabel,
  onChangeType,
  onChangeNote,
  onDelete,
}: {
  item: PrintSurfaceItem | undefined;
  onChangeLabel: (label: string) => void;
  onChangeType: (typeId: PrintSurfaceTypeId) => void;
  onChangeNote: (note: string) => void;
  onDelete: () => void;
}) {
  return (
    <aside className="workflowCard printSurfaceInspector">
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
