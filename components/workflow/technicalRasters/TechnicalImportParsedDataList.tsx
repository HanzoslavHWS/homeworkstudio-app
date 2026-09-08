"use client";

import { useState } from "react";
import { matchesTechnicalImportPreviewSearch, type TechnicalImportPreviewStandGroup } from "../../../domain/technicalRasterImportPreview";

/**
 * Compact per-stand list of parsed technical-service data (spec batch 3, UI section 11/15) — the
 * SAME presentation for two different sources: the pre-import "Zobrazit nalezená data" preview and
 * a historical import's expanded accordion detail (see domain/technicalRasterImportPreview.ts for
 * how each builds the shared TechnicalImportPreviewStandGroup[] shape this component just renders).
 * Deliberately no spreadsheet/table — one small block per stand, matching the rest of this
 * feature's compact/technical visual language.
 */
export function TechnicalImportParsedDataList({ groups }: { groups: readonly TechnicalImportPreviewStandGroup[] }) {
  const [query, setQuery] = useState("");
  if (groups.length === 0) return <p className="workspaceEmpty">Žádná data k zobrazení.</p>;

  const filtered = groups.filter((group) => matchesTechnicalImportPreviewSearch(group, query));

  return (
    <div className="technicalImportParsedDataList">
      {groups.length > 5 && (
        <input
          className="technicalImportParsedDataSearch"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Hledat stánek / firmu…"
        />
      )}
      {filtered.length === 0 && <p className="workspaceEmpty">Hledání neodpovídá žádný stánek.</p>}
      {filtered.map((group) => (
        <div key={group.standNumber} className="technicalImportParsedDataGroup">
          <div className="technicalImportParsedDataGroupHeader">
            <strong>{group.standNumber}</strong>
            {group.companyName && <span className="fieldHint">{group.companyName}</span>}
          </div>
          {group.services.map((service, index) => (
            <div key={index} className="technicalImportParsedDataServiceRow">
              <span>{service.externalLabel}</span>
              <span className="technicalImportParsedDataServiceQty">{service.quantity}×</span>
              {service.isUnknownProduct && <span className="fieldHint technicalStandUnresolvedBadge">Neznámý produkt</span>}
            </div>
          ))}
          {group.notes.map((note, index) => (
            <p key={index} className="fieldHint technicalImportParsedDataNote">{note}</p>
          ))}
        </div>
      ))}
    </div>
  );
}
