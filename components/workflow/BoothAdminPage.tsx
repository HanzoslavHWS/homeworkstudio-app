"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildCatalogItemListEntry,
  filterCatalogItemsAdmin,
  type CatalogItemAdmin,
  type CatalogItemAdminEdit,
  type CatalogItemAdminFilters,
} from "../../domain/catalogItemsAdmin";
import type { CatalogItemKind } from "../../domain/models";
import type { RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import { ComponentAdminDetail, ComponentAdminList } from "./ComponentAdminPage";

const BOOTH_ADMIN_TABS: readonly Readonly<{ kind: CatalogItemKind; label: string; hint: string }>[] = [
  { kind: "booth", label: "Typové stánky", hint: "Kompletní typové stánky (P86 a další) — vlastní master 2D/3D model, vlastní rozměry." },
  { kind: "booth_component", label: "Komponenty stánku", hint: "Jednotlivé stavební prvky (sloupek, panel 950, panel 455, dveře, límec, rastr, koberec, ...) evidované pro budoucí sestavování stánků na míru. Zatím se nenabízí v živém generátoru." },
];

/**
 * "Stánky" admin — extends the type-booth catalog with a clearly-separated "Komponenty stánku"
 * tab. Reuses the exact same DB-backed repository, readiness rules and detail UI as
 * "Administrace → Komponenty" (ComponentAdminPage.tsx's exported ComponentAdminList/
 * ComponentAdminDetail) — never a parallel model or a second detail view. Deliberately never
 * touches ComponentLibrary.tsx (the live generator's component picker): this page is evidence/
 * readiness/activation only, same "staging area, not yet live" pattern ComponentAdminPage.tsx
 * already established for imported furniture.
 */
export function BoothAdminPage({
  repository,
  onOpenPricing,
}: {
  repository: RemoteApiCatalogItemsAdminRepository;
  /** Section 17 precedent — hands off to the existing Pricing Administration matrix, preselected for one item. */
  onOpenPricing: (catalogItemId: string) => void;
}) {
  const [items, setItems] = useState<readonly CatalogItemAdmin[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeKind, setActiveKind] = useState<CatalogItemKind>("booth");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    repository
      .list()
      .then((loaded) => {
        if (cancelled) return;
        setItems(loaded);
        setLoadError("");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Katalogové položky se nepodařilo načíst z databáze.");
      });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const tabItems = useMemo(() => (items ?? []).filter((item) => item.kind === activeKind), [items, activeKind]);
  const listEntries = useMemo(() => tabItems.map(buildCatalogItemListEntry), [tabItems]);
  const filters: CatalogItemAdminFilters = { query };
  const filteredEntries = useMemo(() => filterCatalogItemsAdmin(listEntries, filters), [listEntries, query]);
  const selected = items?.find((item) => item.id === selectedId && item.kind === activeKind);

  async function handleSave(edit: CatalogItemAdminEdit): Promise<void> {
    if (!selected) return;
    const saved = await repository.save(selected.id, edit, selected.updatedAt);
    setItems((current) => (current ?? []).map((item) => (item.id === saved.id ? saved : item)));
  }

  function selectTab(kind: CatalogItemKind) {
    setActiveKind(kind);
    setSelectedId(undefined);
  }

  const activeTab = BOOTH_ADMIN_TABS.find((tab) => tab.kind === activeKind) ?? BOOTH_ADMIN_TABS[0]!;

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">ADMINISTRACE</span>
          <h1>Stánky</h1>
        </div>
        {items && <span className="catalogAdminCount">{filteredEntries.length} / {tabItems.length} položek</span>}
      </div>

      <div className="adminCategoryTabs">
        {BOOTH_ADMIN_TABS.map((tab) => (
          <button key={tab.kind} type="button" className={tab.kind === activeKind ? "active" : ""} onClick={() => selectTab(tab.kind)}>
            {tab.label}
          </button>
        ))}
      </div>
      <p className="fieldHint">{activeTab.hint}</p>

      {loadError && <p className="uploadError persistenceBanner">Katalog se nepodařilo načíst z databáze: {loadError}</p>}
      {!items && !loadError && <p className="workspaceEmpty">Načítám katalog z databáze…</p>}

      {items && (
        <>
          <div className="adminFilters">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat interní kód nebo název…" />
          </div>
          <div className="adminSplit">
            <ComponentAdminList entries={filteredEntries} selectedId={selectedId} onSelect={setSelectedId} />
            {selected && (
              <ComponentAdminDetail
                key={selected.id}
                item={selected}
                onSave={handleSave}
                onOpenPricing={() => onOpenPricing(selected.id)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
