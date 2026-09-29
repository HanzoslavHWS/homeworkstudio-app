"use client";

import type { TechnicalImportServiceDiff, TechnicalServiceChange } from "../../../domain/technicalRaster";

/** Attention first: new and increased rows need placing, then decreases and removals. */
const KIND_ORDER: Readonly<Record<TechnicalServiceChange["kind"], number>> = { added: 0, quantityIncreased: 1, quantityDecreased: 2, removed: 3 };

function describeChange(change: TechnicalServiceChange): string {
  switch (change.kind) {
    case "added": return `nová (${change.quantity}×) — k umístění`;
    case "removed": return change.removedPlacementCount > 0 ? `odstraněno — zmizí ${change.removedPlacementCount} ${change.removedPlacementCount === 1 ? "bod" : "body"}` : "odstraněno";
    case "quantityIncreased": return `${change.previousQuantity}× → ${change.quantity}× — původní body zůstávají`;
    case "quantityDecreased": return change.removedPlacementCount > 0
      ? `${change.previousQuantity}× → ${change.quantity}× — odebráno ${change.removedPlacementCount} ${change.removedPlacementCount === 1 ? "přebytečný bod" : "přebytečné body"}`
      : `${change.previousQuantity}× → ${change.quantity}×`;
  }
}

/**
 * Change summary of an incremental report re-import ("Beze změny / Nové / Odstraněné / Změna
 * množství") + "Zobrazit změny". Clicking a stand opens it in Přiřazení (the existing K UMÍSTĚNÍ
 * queue then shows exactly what still needs a point).
 */
export function TechnicalImportDiffSummary({
  diff,
  onShowStand,
  compact = false,
}: {
  diff: TechnicalImportServiceDiff;
  onShowStand?: (standNumber: string) => void;
  compact?: boolean;
}) {
  const quantityChanged = diff.quantityIncreased + diff.quantityDecreased;
  const changes = [...diff.changes].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return (
    <div className={compact ? "technicalImportDiff compact" : "technicalImportDiff"}>
      <div className="technicalImportPreviewSummary">
        <span>Beze změny <strong>{diff.unchanged}</strong></span>
        <span className={diff.added > 0 ? "technicalImportPreviewSummaryWarn" : undefined}>Nové <strong>{diff.added}</strong></span>
        <span>Odstraněné <strong>{diff.removed}</strong></span>
        <span className={diff.quantityIncreased > 0 ? "technicalImportPreviewSummaryWarn" : undefined}>Změna množství <strong>{quantityChanged}</strong></span>
      </div>
      {changes.length > 0 && (
        <details className="technicalImportPreviewDetails">
          <summary>Zobrazit změny</summary>
          <ul className="technicalImportDiffList">
            {changes.map((change, index) => (
              <li key={`${change.standNumber}-${change.category}-${change.externalLabel}-${index}`} className={`kind-${change.kind}`}>
                {onShowStand && change.kind !== "removed"
                  ? <button type="button" className="textButton" onClick={() => onShowStand(change.standNumber)}>{change.standNumber}</button>
                  : <strong>{change.standNumber}</strong>}
                <span>{change.externalLabel}</span>
                <span>{describeChange(change)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
