"use client";

import { technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";
import type { TechnicalRasterImport, TechnicalService, TechnicalStand } from "../../../domain/technicalRaster";

/**
 * Detail stánku (spec section 23) — services grouped by category, notes, and the ZDROJE list so
 * every value is traceable back to its source PDF (spec section 32) — never just a number with no
 * provenance.
 *
 * Terminology (spec batch 3, UI section 1/3/4): the top status badge is SPÁROVÁNÍ — whether this
 * TechnicalStand is matched to a position in the raster PDF. Each service row below shows its OWN,
 * separate "Stav: Neumístěno" line — UMÍSTĚNÍ, a technical service's physical placement point
 * within the stand's own floor plan. The current data model has no real per-service placement
 * field yet (TechnicalService never tracks a position) — this always reads "Neumístěno" for every
 * service, which is the honest, currently-known state, NOT a hint that per-service placement UI
 * exists yet. This is deliberate: never reuse "(ne)přiřazeno" for both concepts (see the
 * placementLabel dictionary below vs. the fixed "Stav: Neumístěno" caption further down).
 */
export function TechnicalStandDetailPanel({
  stand,
  imports,
  onAssign,
  onClearAssignment,
}: {
  stand: TechnicalStand | undefined;
  imports: readonly TechnicalRasterImport[];
  onAssign?: (standId: string) => void;
  onClearAssignment?: (standId: string) => void;
}) {
  if (!stand) {
    return (
      <aside className="workflowCard technicalStandDetailPanel">
        <div className="workflowCardHeader"><div><span>DETAIL</span></div></div>
        <p className="workspaceEmpty">Vyberte stánek v zásobníku nebo v rastru.</p>
      </aside>
    );
  }

  const servicesByCategory = new Map<string, TechnicalService[]>();
  for (const service of stand.services) {
    if (!servicesByCategory.has(service.category)) servicesByCategory.set(service.category, []);
    servicesByCategory.get(service.category)!.push(service);
  }

  const sourceFilenames = [...new Set(stand.sourceImportIds
    .map((importId) => imports.find((entry) => entry.id === importId)?.filename)
    .filter((filename): filename is string => Boolean(filename)))];

  const ambiguousLabel = stand.placement.candidateCount !== undefined
    ? `Nejednoznačné — nalezeno ${stand.placement.candidateCount}×`
    : "Nejednoznačné (více shod v rastru)";
  const placementLabel: Record<string, string> = {
    unassigned: "Nespárováno",
    matched_auto: "✓ Spárováno automaticky",
    matched_manual: "✓ Spárováno ručně",
    ambiguous: ambiguousLabel,
  };

  return (
    <aside className="workflowCard technicalStandDetailPanel">
      <div className="workflowCardHeader">
        <div>
          <span>STÁNEK</span>
          <strong>{stand.standNumber}</strong>
        </div>
      </div>
      {stand.companyName && <p className="fieldHint">{stand.companyName}</p>}
      <p className={`stageBadge technicalStandPlacementBadge ${stand.placement.status}`}>{placementLabel[stand.placement.status] ?? stand.placement.status}</p>

      {[...servicesByCategory.entries()].map(([category, services]) => (
        <div key={category} className="technicalStandDetailSection">
          <h4>{technicalServiceCategoryLabel(category).toLocaleUpperCase("cs")}</h4>
          {services.map((service) => (
            <div key={service.id} className="technicalStandServiceRow">
              <div className="technicalStandServiceRowMain">
                <span>{service.externalLabel}</span>
                <strong>{service.quantity}×</strong>
              </div>
              <p className="fieldHint technicalStandServicePlacementStatus">Stav: Neumístěno</p>
              {service.status === "unresolved_product" && <p className="fieldHint technicalStandUnresolvedBadge">Neznámý produkt</p>}
            </div>
          ))}
        </div>
      ))}

      {stand.notes.length > 0 && (
        <div className="technicalStandDetailSection">
          <h4>POZNÁMKA</h4>
          {stand.notes.map((note) => <p key={note.id} className="fieldHint">{note.text}</p>)}
        </div>
      )}

      {sourceFilenames.length > 0 && (
        <div className="technicalStandDetailSection">
          <h4>ZDROJE</h4>
          {sourceFilenames.map((filename) => <p key={filename} className="fieldHint">{filename}</p>)}
        </div>
      )}

      <div className="technicalStandDetailActions">
        {onAssign && stand.placement.status !== "matched_manual" && (
          <button type="button" className="textButton" onClick={() => onAssign(stand.id)}>Spárovat kliknutím do rastru</button>
        )}
        {onClearAssignment && stand.placement.status !== "unassigned" && (
          <button type="button" className="textButton" onClick={() => onClearAssignment(stand.id)}>Zrušit spárování</button>
        )}
      </div>
    </aside>
  );
}
