"use client";

import { technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";
import type { TechnicalRasterImport, TechnicalService, TechnicalStand } from "../../../domain/technicalRaster";

/**
 * Detail stánku (spec section 23) — services grouped by category, notes, and the ZDROJE list so
 * every value is traceable back to its source PDF (spec section 32) — never just a number with no
 * provenance.
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

  const placementLabel: Record<string, string> = {
    unassigned: "Nepřiřazeno",
    matched_auto: "Přiřazeno automaticky",
    matched_manual: "Přiřazeno ručně",
    ambiguous: "Problematické (více shod v rastru)",
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
              <span>{service.externalLabel}</span>
              <strong>{service.quantity}×</strong>
              {service.status === "unresolved_product" && <span className="fieldHint technicalStandUnresolvedBadge">produkt nepřiřazen</span>}
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
          <button type="button" className="textButton" onClick={() => onAssign(stand.id)}>Přiřadit kliknutím do rastru</button>
        )}
        {onClearAssignment && stand.placement.status !== "unassigned" && (
          <button type="button" className="textButton" onClick={() => onClearAssignment(stand.id)}>Zrušit přiřazení</button>
        )}
      </div>
    </aside>
  );
}
