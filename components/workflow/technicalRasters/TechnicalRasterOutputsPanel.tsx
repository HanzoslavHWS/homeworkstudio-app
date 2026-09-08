"use client";

import { useState } from "react";
import { TECHNICAL_SERVICE_CATEGORIES } from "../../../domain/technicalServiceCatalog";
import { sortStandNumbersNatural } from "../../../domain/technicalStandNumber";
import type { TechnicalStand } from "../../../domain/technicalRaster";

/**
 * Výstupy (spec section 28) — deliberately just a foundation this phase: category filters + a
 * plain confirmation that assigned stands actually carry the filtered data. NO visual/PDF export
 * design here (spec: "vizuální pravidla těchto exportů nyní nevymýšlej") — that's a later phase
 * this filter state / stand data is meant to feed into.
 */
export function TechnicalRasterOutputsPanel({ stands }: { stands: readonly TechnicalStand[] }) {
  const [activeCategories, setActiveCategories] = useState<ReadonlySet<string>>(new Set(TECHNICAL_SERVICE_CATEGORIES.map((category) => category.id)));

  function toggleCategory(categoryId: string) {
    setActiveCategories((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId); else next.add(categoryId);
      return next;
    });
  }

  const assignedStands = sortStandNumbersNatural(
    stands.filter((stand) => stand.placement.status === "matched_auto" || stand.placement.status === "matched_manual"),
    (stand) => stand.standNumber,
  );

  return (
    <div className="workflowCard technicalRasterOutputsPanel">
      <div className="workflowCardHeader"><div><span>VÝSTUPY</span><strong>Základ pro další fázi</strong></div></div>
      <p className="fieldHint">
        Kompletní exportní PDF systém (ikony služeb, vrstvy, kombinace vrstev, tiskové výstupy pro jednotlivé profese) je předmětem další iterace.
        Zde je jen náhled, že přiřazené stánky mají dostupná filtrovaná data.
      </p>

      <div className="technicalRasterOutputsFilters">
        {TECHNICAL_SERVICE_CATEGORIES.map((category) => (
          <label key={category.id}>
            <input type="checkbox" checked={activeCategories.has(category.id)} onChange={() => toggleCategory(category.id)} />
            {category.labelCz}
          </label>
        ))}
      </div>

      <div className="technicalRasterOutputsPreviewTable">
        <div className="technicalRasterOutputsPreviewRow technicalRasterOutputsPreviewHeader">
          <span>Stánek</span>
          <span>Firma</span>
          <span>Služby (filtrováno)</span>
        </div>
        {assignedStands.length === 0 && <p className="workspaceEmpty">Zatím nejsou přiřazené žádné stánky.</p>}
        {assignedStands.map((stand) => {
          const filteredServices = stand.services.filter((service) => activeCategories.has(service.category));
          return (
            <div key={stand.id} className="technicalRasterOutputsPreviewRow">
              <span>{stand.standNumber}</span>
              <span>{stand.companyName ?? "—"}</span>
              <span>{filteredServices.length > 0 ? `${filteredServices.length} položek` : "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
