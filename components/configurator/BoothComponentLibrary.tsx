"use client";

import { useState } from "react";
import type { ComponentDefinition } from "../../domain/models";
import { matchesCatalogSearch } from "../../domain/search";
import { catalogDisplayName } from "../../domain/catalog";

type Props = {
  items: readonly ComponentDefinition[] | null;
  error?: string;
  onAddComponent: (definition: ComponentDefinition) => void;
};

/**
 * Individual-mode Phase 1 picker — booth_component ONLY (sloupky/panely/dveře/límce/...), never
 * furniture/technical services/the general catalog. A dedicated component (rather than a mode
 * branch inside ComponentLibrary) so the typovka furniture/technical picker stays untouched.
 */
export function BoothComponentLibrary({ items, error, onAddComponent }: Props) {
  const [query, setQuery] = useState("");
  const loading = items === null;
  const filtered = (items ?? []).filter((item) => matchesCatalogSearch(item, query));

  return (
    <aside className="componentLibrary">
      <div className="panelHeader">
        <span>KOMPONENTY STÁNKU</span>
        <strong>Knihovna konstrukce</strong>
      </div>
      <div className="librarySection collapsibleLibrarySection">
        <input
          className="librarySearch"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Hledat komponentu…"
        />
        {loading && <p className="libraryHint">Načítám komponenty stánku…</p>}
        {!loading && error && <p className="uploadError persistenceBanner">{error}</p>}
        {!loading && !error && filtered.length === 0 && (
          <p className="libraryHint">Zatím nejsou dostupné žádné aktivní komponenty stánku.</p>
        )}
        {!loading &&
          !error &&
          filtered.map((definition) => (
            <button key={definition.id} className="libraryItem" onClick={() => onAddComponent(definition)}>
              <span className="libraryItemIcon cabinetIcon">{definition.footprint2D?.symbol ?? "▭"}</span>
              <span className="libraryItemText">
                <strong>{catalogDisplayName(definition)}</strong>
                <small>
                  {definition.internalCode ? `Kód: ${definition.internalCode} · ` : ""}
                  {definition.widthMm} × {definition.depthMm} mm
                </small>
                <em>{definition.showIn3D ? "CAD model 1:1" : "2D prvek"}</em>
              </span>
              <span className="libraryAdd">+</span>
            </button>
          ))}
      </div>
    </aside>
  );
}
