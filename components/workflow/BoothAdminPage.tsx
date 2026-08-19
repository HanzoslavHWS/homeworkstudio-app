"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildCatalogItemListEntry,
  filterCatalogItemsAdmin,
  sortCatalogItemsAdminByCode,
  sortCatalogItemsAdminByName,
  CATALOG_ITEM_CATEGORY_OPTIONS,
  type CatalogItemAdmin,
  type CatalogItemAdminCreateInput,
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
  const [showCreateForm, setShowCreateForm] = useState(false);

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
  // Filter first, then sort — never the DB/API return order. "Typové stánky" reads more
  // naturally sorted by internalCode (P86, P87, T04, T06, ...) than by displayName; "Komponenty
  // stánku" uses the same displayName A-Z rule as the generic Admin → Komponenty list. Both keep
  // active items first within their own ordering (domain/catalogItemsAdmin.ts).
  const sortEntries = activeKind === "booth" ? sortCatalogItemsAdminByCode : sortCatalogItemsAdminByName;
  const filteredEntries = useMemo(() => sortEntries(filterCatalogItemsAdmin(listEntries, filters)), [listEntries, query, sortEntries]);
  const selected = items?.find((item) => item.id === selectedId && item.kind === activeKind);

  async function handleSave(edit: CatalogItemAdminEdit): Promise<void> {
    if (!selected) return;
    const saved = await repository.save(selected.id, edit, selected.updatedAt);
    setItems((current) => (current ?? []).map((item) => (item.id === saved.id ? saved : item)));
  }

  function selectTab(kind: CatalogItemKind) {
    setActiveKind(kind);
    setSelectedId(undefined);
    setShowCreateForm(false);
  }

  function handleCreated(created: CatalogItemAdmin) {
    setItems((current) => [...(current ?? []), created]);
    setSelectedId(created.id);
    setShowCreateForm(false);
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
            {activeKind === "booth_component" && (
              <button type="button" className="primaryButton" onClick={() => { setShowCreateForm(true); setSelectedId(undefined); }}>
                + Nová komponenta stánku
              </button>
            )}
          </div>
          {showCreateForm && activeKind === "booth_component" && (
            <BoothComponentCreateForm
              repository={repository}
              onCancel={() => setShowCreateForm(false)}
              onCreated={handleCreated}
            />
          )}
          <div className="adminSplit">
            <ComponentAdminList entries={filteredEntries} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setShowCreateForm(false); }} />
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

/**
 * Minimal founding form for a brand-new booth_component — kind is always "booth_component" here,
 * never user-editable (that's decided by which admin tab this form is rendered in). On success,
 * hands the new CatalogItemAdmin to the parent so it can immediately open the SAME
 * ComponentAdminDetail used everywhere else — this form never touches assets/readiness itself.
 */
function BoothComponentCreateForm({
  repository,
  onCancel,
  onCreated,
}: {
  repository: RemoteApiCatalogItemsAdminRepository;
  onCancel: () => void;
  onCreated: (created: CatalogItemAdmin) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [internalCode, setInternalCode] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [depthMm, setDepthMm] = useState("");
  const [heightMm, setHeightMm] = useState("");
  const [showIn2D, setShowIn2D] = useState(false);
  const [showIn3D, setShowIn3D] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = displayName.trim().length > 0 && category.trim().length > 0 && !busy;

  async function handleSubmit() {
    setBusy(true);
    setError("");
    try {
      const input: { -readonly [K in keyof CatalogItemAdminCreateInput]?: CatalogItemAdminCreateInput[K] } = {
        kind: "booth_component",
        displayName: displayName.trim(),
        category,
      };
      if (internalCode.trim()) input.internalCode = internalCode.trim();
      if (unit.trim()) input.unit = unit.trim();
      const width = Number(widthMm);
      if (widthMm.trim() && Number.isFinite(width)) input.widthMm = width;
      const depth = Number(depthMm);
      if (depthMm.trim() && Number.isFinite(depth)) input.depthMm = depth;
      const height = Number(heightMm);
      if (heightMm.trim() && Number.isFinite(height)) input.heightMm = height;
      if (showIn2D) input.showIn2D = true;
      if (showIn3D) input.showIn3D = true;

      const created = await repository.create(input as CatalogItemAdminCreateInput);
      onCreated(created);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Vytvoření komponenty selhalo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="catalogDetailSection adminDetail">
      <h3>Nová komponenta stánku</h3>
      <dl>
        <div className="catalogAdminEditRow">
          <dt>Název *</dt>
          <dd><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Např. Sloupek" /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Interní kód</dt>
          <dd><input value={internalCode} onChange={(event) => setInternalCode(event.target.value)} placeholder="Ponechte prázdné, pokud kód neznáte" /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Kategorie *</dt>
          <dd>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">— vyberte —</option>
              {CATALOG_ITEM_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Jednotka</dt>
          <dd><input value={unit} onChange={(event) => setUnit(event.target.value)} /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Šířka (mm)</dt>
          <dd><input type="number" value={widthMm} onChange={(event) => setWidthMm(event.target.value)} placeholder="Neznámo" /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Hloubka (mm)</dt>
          <dd><input type="number" value={depthMm} onChange={(event) => setDepthMm(event.target.value)} placeholder="Neznámo" /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Výška (mm)</dt>
          <dd><input type="number" value={heightMm} onChange={(event) => setHeightMm(event.target.value)} placeholder="Neznámo" /></dd>
        </div>
      </dl>
      <p className="fieldHint">Použití:</p>
      <label className="checkboxRow">
        <input type="checkbox" checked={showIn2D} onChange={(event) => setShowIn2D(event.target.checked)} />
        2D
      </label>
      <label className="checkboxRow">
        <input type="checkbox" checked={showIn3D} onChange={(event) => setShowIn3D(event.target.checked)} />
        3D
      </label>
      <div className="catalogAdminReviewActions">
        <button type="button" className="secondaryButton" onClick={onCancel} disabled={busy}>Zrušit</button>
        <button type="button" className="primaryButton" onClick={handleSubmit} disabled={!canSubmit}>
          {busy ? "Vytvářím…" : "Vytvořit"}
        </button>
      </div>
      {error && <small className="uploadError">{error}</small>}
    </div>
  );
}
