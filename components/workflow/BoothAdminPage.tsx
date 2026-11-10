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
import type { CatalogPackageItemInput } from "../../domain/catalogPackages";
import type { CatalogVariantSet } from "../../domain/catalogVariants";
import type { RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import { ComponentAdminDetail, ComponentAdminList, type SavedKitContents } from "./ComponentAdminPage";
import type { PriceVersionsPreselect } from "./priceVersions/PriceVersionsPage";
import { categoriesForGroup } from "../../domain/catalogClassification";
import { useCatalogCategories } from "../../lib/db/catalogCategories.remoteApi.client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/workspace";

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
  onOpenPriceVersion,
}: {
  repository: RemoteApiCatalogItemsAdminRepository;
  /** Section 17 precedent — hands off to the existing Pricing Administration matrix, preselected for one item. */
  onOpenPricing: (catalogItemId: string) => void;
  onOpenPriceVersion?: (preselect: PriceVersionsPreselect) => void;
}) {
  const [items, setItems] = useState<readonly CatalogItemAdmin[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeKind, setActiveKind] = useState<CatalogItemKind>("booth");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [variantSets, setVariantSets] = useState<readonly CatalogVariantSet[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Swatch books only feed the kit editor's variant pickers; without them the editor still works.
    repository.loadVariantSets().then((sets) => { if (!cancelled) setVariantSets(sets); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [repository]);

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
  const filters: CatalogItemAdminFilters = { query, showArchived };
  // Filter first, then sort — never the DB/API return order. "Typové stánky" reads more
  // naturally sorted by internalCode (P86, P87, T04, T06, ...) than by displayName; "Komponenty
  // stánku" uses the same displayName A-Z rule as the generic Admin → Komponenty list. Both keep
  // active items first within their own ordering (domain/catalogItemsAdmin.ts).
  const sortEntries = activeKind === "booth" ? sortCatalogItemsAdminByCode : sortCatalogItemsAdminByName;
  const filteredEntries = useMemo(() => sortEntries(filterCatalogItemsAdmin(listEntries, filters)), [listEntries, query, showArchived, sortEntries]);
  const selected = items?.find((item) => item.id === selectedId && item.kind === activeKind);

  async function handleSave(edit: CatalogItemAdminEdit): Promise<void> {
    if (!selected) return;
    const saved = await repository.save(selected.id, edit, selected.updatedAt);
    setItems((current) => (current ?? []).map((item) => (item.id === saved.id ? saved : item)));
  }

  async function handleSavePackage(lines: readonly CatalogPackageItemInput[]): Promise<SavedKitContents> {
    if (!selected) return { packageItems: [], warnings: [] };
    const saved = await repository.savePackage(selected.id, lines);
    setItems((current) => (current ?? []).map((item) => (item.id === selected.id ? { ...item, packageItems: saved.packageItems } : item)));
    return saved;
  }

  async function handleDuplicate(): Promise<void> {
    if (!selected) return;
    const created = await repository.duplicate(selected.id);
    setItems((current) => [...(current ?? []), created]);
    setSelectedId(created.id);
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
    <div className="adminPage">
      <PageHeader title="Stánky" description={items ? `Zobrazeno ${filteredEntries.length} z ${tabItems.length} položek` : undefined} />

      <div className="adminCategoryTabs mb-3 flex flex-wrap gap-2" role="group" aria-label="Druh stánků">
        {BOOTH_ADMIN_TABS.map((tab) => (
          <Button key={tab.kind} type="button" variant={tab.kind === activeKind ? "default" : "outline"} aria-pressed={tab.kind === activeKind} onClick={() => selectTab(tab.kind)}>
            {tab.label}
          </Button>
        ))}
      </div>
      <p className="fieldHint">{activeTab.hint}</p>

      {loadError && <p className="uploadError persistenceBanner">Katalog se nepodařilo načíst z databáze: {loadError}</p>}
      {!items && !loadError && <p className="workspaceEmpty">Načítám katalog z databáze…</p>}

      {items && (
        <>
          <div className="adminFilters">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat interní kód nebo název…" />
            <label className="checkboxRow adminFiltersArchivedToggle">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              Zobrazit archivované
            </label>
            {activeKind === "booth_component" && (
              <Button variant="default" type="button" onClick={() => { setShowCreateForm(true); setSelectedId(undefined); }}>
                + Nová komponenta stánku
              </Button>
            )}
          </div>
          {showCreateForm && activeKind === "booth_component" && (
            <BoothComponentCreateForm
              repository={repository}
              onCancel={() => setShowCreateForm(false)}
              onCreated={handleCreated}
            />
          )}
          {!selected && <ComponentAdminList entries={filteredEntries} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setShowCreateForm(false); }} />}
          {selected && (
            <div className="catalogDetailView">
              <Button variant="ghost" className="catalogBackButton -ml-2 justify-self-start" type="button" onClick={() => setSelectedId(undefined)}>← Zpět na seznam</Button>
              <ComponentAdminDetail
                key={selected.id}
                item={selected}
                allItems={items}
                onSave={handleSave}
                onSavePackage={handleSavePackage}
                variantSets={variantSets}
                onDuplicate={handleDuplicate}
                onOpenPricing={() => onOpenPricing(selected.id)}
                onOpenPriceVersion={onOpenPriceVersion}
              />
            </div>
          )}
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
  // Booth components are internal components — only categories of that group allowing kind booth_component.
  const categoryRegister = useCatalogCategories();
  const componentCategories = categoriesForGroup(categoryRegister.categories, "internal_component").filter((option) => option.kinds.includes("booth_component"));
  const [unit, setUnit] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [depthMm, setDepthMm] = useState("");
  const [heightMm, setHeightMm] = useState("");
  const [showIn2D, setShowIn2D] = useState(false);
  const [showIn3D, setShowIn3D] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Interní komponenta: the generator code is required (no ABF code to fall back on) — same rule the server enforces.
  const canSubmit = displayName.trim().length > 0 && category.trim().length > 0 && internalCode.trim().length > 0 && !busy;

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
          <dd><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Např. Sloupek" /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Interní / generátorový kód *</dt>
          <dd>
            <Input value={internalCode} onChange={(event) => setInternalCode(event.target.value)} placeholder="Vlastní unikátní kód komponenty" />
            {!internalCode.trim() && <small className="fieldWarning">Interní komponenta musí mít vlastní generátorový kód (ABF kód nemá).</small>}
          </dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Kategorie *</dt>
          <dd>
            <NativeSelect value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">— vyberte —</option>
              {componentCategories.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </NativeSelect>
          </dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Jednotka</dt>
          <dd><Input value={unit} onChange={(event) => setUnit(event.target.value)} /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Šířka (mm)</dt>
          <dd><Input type="number" value={widthMm} onChange={(event) => setWidthMm(event.target.value)} placeholder="Neznámo" /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Hloubka (mm)</dt>
          <dd><Input type="number" value={depthMm} onChange={(event) => setDepthMm(event.target.value)} placeholder="Neznámo" /></dd>
        </div>
        <div className="catalogAdminEditRow">
          <dt>Výška (mm)</dt>
          <dd><Input type="number" value={heightMm} onChange={(event) => setHeightMm(event.target.value)} placeholder="Neznámo" /></dd>
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
        <Button variant="outline" type="button" onClick={onCancel} disabled={busy}>Zrušit</Button>
        <Button variant="default" type="button" onClick={handleSubmit} disabled={!canSubmit}>
          {busy ? "Vytvářím…" : "Vytvořit"}
        </Button>
      </div>
      {error && <small className="uploadError">{error}</small>}
    </div>
  );
}
