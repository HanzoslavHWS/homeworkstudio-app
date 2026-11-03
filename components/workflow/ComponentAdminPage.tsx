"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  buildCatalogItemListEntry,
  categoryLabelCs,
  computeGeneratorEligibleLive,
  computeReadiness,
  documentAttributes,
  documentBasePricing,
  documentDimensions,
  documentFootprint2D,
  documentEffectiveModelReference,
  documentModelAsset,
  documentGalleryPhotoAssets,
  documentPhotoAsset,
  documentServiceTechnical,
  documentPhotoUrl,
  documentReviewedAt,
  documentSourceAssets,
  documentSourceTraceability,
  documentTechnicalRaster,
  documentVariants,
  documentAbfImport,
  documentItemTypeNeedsReview,
  documentNote,
  itemTypeOf,
  variantHas3DAsset,
  variantHasSketchupSource,
  filterCatalogItemsAdmin,
  sortCatalogItemsAdminByName,
  CATALOG_ITEM_CATEGORY_OPTIONS,
  CATALOG_ITEM_KIND_LABELS_CS,
  type CatalogItemAdmin,
  type CatalogItemAdminEdit,
  type CatalogItemAdminFilters,
  type CatalogItemAdminListEntry,
  type BulkLifecycleAction,
} from "../../domain/catalogItemsAdmin";
import { CATALOG_ITEM_KINDS_BY_TYPE, CATALOG_ITEM_TYPE_HINTS_CS, CATALOG_ITEM_TYPE_LABELS_CS, itemTypeExpectsAbfCode } from "../../domain/catalogItemTypes";
import type { CatalogPackageItem, CatalogPackageItemInput } from "../../domain/catalogPackages";
import { AbfImportPanel, CatalogItemCreateForm, CatalogPublicationSection } from "./CatalogAdminPanels";
import { KitContentsSection, VariantSetsPanel } from "./CatalogKitPanels";
import type { CatalogVariantSet, CatalogVariantSetInput } from "../../domain/catalogVariants";

export type SavedKitContents = Readonly<{ packageItems: readonly CatalogPackageItem[]; warnings: readonly string[] }>;
import { CATALOG_ITEM_STATUS_LABELS_CS, READINESS_ISSUE_LABELS_CS } from "../../domain/catalogReadiness";
import { CATALOG_ITEM_KINDS, CATALOG_ITEM_STATUSES, CATALOG_ITEM_TYPES, type BoothVariant, type CatalogItemKind, type CatalogItemStatus, type CatalogItemType } from "../../domain/models";
import { SOURCE_ASSET_KINDS, SOURCE_ASSET_KIND_EXTENSIONS, SOURCE_ASSET_KIND_LABELS_CS, type SourceAssetEntry, type SourceAssetKind, type StoredAsset } from "../../domain/assets";
import type { TechnicalRasterComponentConfig } from "../../domain/technicalRasterComponentPresentation";
import type { TechnicalServicePlacementBehavior } from "../../domain/technicalRasterServicePresentation";
import { ConcurrencyConflictError } from "../../lib/db/concurrency";
import type { CatalogAliasRegister, RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import type { CatalogItemAlias, CatalogItemAliasInput } from "../../domain/catalogItemAliases";
import { CATALOG_UNITS, normalizeCatalogUnit } from "../../domain/catalogUnits";
import { catalogTypeHasField } from "../../domain/catalogItemFields";
import { CatalogAliasesSection } from "./CatalogAliasesSection";
import { uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { CatalogCardPrices } from "./CatalogCardPrices";
import { categoriesForGroup, classificationIssue, classificationTarget, COMPONENT_GROUP_HINTS_CS, COMPONENT_GROUP_LABELS_CS, COMPONENT_GROUP_TARGETS, COMPONENT_GROUPS, derivedPriceCategory, findCategory, groupOfCard, isComponentGroup, type CardGroup, type ComponentGroup } from "../../domain/catalogClassification";
import { useCatalogCategories } from "../../lib/db/catalogCategories.remoteApi.client";
import { CatalogBatchUpload } from "./CatalogBatchUpload";
import { CatalogCategoriesPanel } from "./CatalogCategoriesPanel";
import { activeRecommendedParameters, parameterProblem, recommendedParameterKey, setParameterValue } from "../../domain/catalogParameters";
import { CatalogDocumentsSection, CatalogHiddenAttachments } from "./CatalogDocumentsSection";
import type { PriceVersionsPreselect } from "./priceVersions/PriceVersionsPage";

const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const MODEL_EXTENSIONS = ["glb"];
const TECHNICAL_ICON_ACCEPT = "image/svg+xml,image/png";
const TECHNICAL_ICON_EXTENSIONS = ["svg", "png"];

const FOOTPRINT_SHAPE_LABELS_CS: Readonly<Record<"rectangle" | "circle" | "symbol", string>> = {
  rectangle: "Obdélník",
  circle: "Kruh",
  symbol: "Symbol",
};

/**
 * Kinds where showIn2D/showIn3D actually affect evaluateCatalogReadiness() (see
 * domain/catalogReadiness.ts's furniture/technical_point cases — required; construction/other
 * — conditional if declared). booth never reads these fields (always implicitly placed) and
 * service/graphics_service/floor_finish never read them either — showing the checkboxes there
 * would be meaningless UI with zero effect on readiness, so the section is hidden for those.
 */
const SCENE_CAPABILITY_KINDS: readonly CatalogItemKind[] = ["furniture", "technical_point", "construction", "other", "booth_component"];

/**
 * Kinds where source/manufacturing files (SKP/DWG/DXF/PDF/other) make sense — physical or
 * scene-placeable catalog items. Pure services (service/graphics_service — e.g. L02 elektřina,
 * internet, úklid) never get this section: they have no authoring/CAD source to evidence.
 * Dispatched by kind/capability, never by name/category heuristic.
 */
const SOURCE_ASSET_APPLICABLE_KINDS: readonly CatalogItemKind[] = ["furniture", "booth", "booth_component", "construction", "technical_point", "floor_finish", "other"];

/**
 * Kinds whose "Použití v generátoru" 2D/3D checkboxes are shown. Services are included so a service
 * that ever legitimately has a 3D model can switch 3D on explicitly; for them the flags only decide
 * which attachments the card offers (service readiness never reads them).
 */
const CAPABILITY_TOGGLE_KINDS: readonly CatalogItemKind[] = [...SCENE_CAPABILITY_KINDS, "service", "graphics_service"];
/** Kinds that always carry a 3D model (readiness requires it), whatever the 3D checkbox says. */
const ALWAYS_3D_KINDS: readonly CatalogItemKind[] = ["booth", "booth_component"];
/** Kinds where CAD sources (SKP/DWG/DXF) are relevant only together with 3D — a technical point is a 2D placement. */
const CAD_ONLY_WITH_3D_KINDS: readonly CatalogItemKind[] = ["technical_point"];

function hasAllowedExtension(fileName: string, allowed: readonly string[]): boolean {
  const extension = fileName.toLowerCase().split(".").pop();
  return Boolean(extension) && allowed.includes(extension!);
}

/**
 * Catalog administration ("Administrace → Komponenty" = Katalog komponent) over the real remote
 * catalog_items table — all four card types (Produkt / Služba / Stánek / Interní komponenta).
 * Type-booths are also still managed from "Knihovna stánků" (BoothAdminPage.tsx), which reuses
 * the same list/detail components. Deliberately does NOT touch ComponentLibrary.tsx (the
 * generator's furniture picker) — that stays on the static seed until each imported item is
 * individually reviewed and made generator-eligible.
 */
export function ComponentAdminPage({
  repository,
  onOpenPricing,
  onOpenPriceVersion,
}: {
  repository: RemoteApiCatalogItemsAdminRepository;
  /** Section 17 — hands off to the existing Pricing Administration matrix, preselected for one item. Never a second/duplicate price editor. */
  onOpenPricing: (catalogItemId: string) => void;
  /** Opens Ceníky (verze) on the list/version/item viewed in the card's price section — navigation only. */
  onOpenPriceVersion?: (preselect: PriceVersionsPreselect) => void;
}) {
  const [items, setItems] = useState<readonly CatalogItemAdmin[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<CatalogItemAdminFilters>({});
  const [panel, setPanel] = useState<"none" | "create" | "import" | "variants" | "categories">("none");
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState("");
  const [aliasRegister, setAliasRegister] = useState<CatalogAliasRegister | null>(null);
  const [aliasLoadError, setAliasLoadError] = useState("");
  const [variantSets, setVariantSets] = useState<readonly CatalogVariantSet[]>([]);
  const [variantSetsError, setVariantSetsError] = useState("");

  useEffect(() => {
    let cancelled = false;
    repository
      .loadVariantSets()
      .then((sets) => { if (!cancelled) setVariantSets(sets); })
      .catch((error) => { if (!cancelled) setVariantSetsError(error instanceof Error ? error.message : "Vzorníky se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [repository]);

  useEffect(() => {
    let cancelled = false;
    repository
      .loadAliases()
      .then((register) => { if (!cancelled) setAliasRegister(register); })
      .catch((error) => { if (!cancelled) setAliasLoadError(error instanceof Error ? error.message : "Aliasy se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [repository]);

  const reload = useCallback(async () => {
    try {
      const loaded = await repository.list();
      setItems(loaded);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Katalogové položky se nepodařilo načíst z databáze.");
    }
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

  const allItems = items ?? [];
  const listEntries = useMemo(() => allItems.map(buildCatalogItemListEntry), [allItems]);
  // Filter first, then sort the (smaller) result — never the DB/API return order. See
  // domain/catalogItemsAdmin.ts's sortCatalogItemsAdminByName: active items first, then A-Z
  // (cs locale) within each lifecycle group.
  const filteredEntries = useMemo(
    () => sortCatalogItemsAdminByName(filterCatalogItemsAdmin(listEntries, filters)),
    [listEntries, filters],
  );
  const selected = allItems.find((item) => item.id === selectedId);
  const visibleCheckedIds = filteredEntries.filter((entry) => checkedIds.has(entry.id)).map((entry) => entry.id);
  const needsTypeReviewCount = listEntries.filter((entry) => entry.itemTypeNeedsReview && entry.lifecycleStatus !== "archived").length;

  function replaceItem(saved: CatalogItemAdmin) {
    setItems((current) => (current ?? []).map((item) => (item.id === saved.id ? saved : item)));
  }

  async function handleSave(edit: CatalogItemAdminEdit): Promise<void> {
    if (!selected) return;
    replaceItem(await repository.save(selected.id, edit, selected.updatedAt));
  }

  async function handleSaveAliases(inputs: readonly CatalogItemAliasInput[]): Promise<readonly CatalogItemAlias[]> {
    if (!selected) return [];
    const stored = await repository.saveAliases(selected.id, inputs);
    setAliasRegister((current) => current ? { ...current, aliases: [...current.aliases.filter((alias) => alias.catalogItemId !== selected.id), ...stored] } : current);
    return stored;
  }

  async function handleSavePackage(lines: readonly CatalogPackageItemInput[]): Promise<SavedKitContents> {
    if (!selected) return { packageItems: [], warnings: [] };
    const saved = await repository.savePackage(selected.id, lines);
    setItems((current) => (current ?? []).map((item) => (item.id === selected.id ? { ...item, packageItems: saved.packageItems } : item)));
    return saved;
  }

  async function handleSaveVariantSet(input: CatalogVariantSetInput): Promise<CatalogVariantSet> {
    const saved = await repository.saveVariantSet(input);
    setVariantSets((current) => [...current.filter((set) => set.id !== saved.id), saved].sort((a, b) => a.code.localeCompare(b.code)));
    return saved;
  }

  async function handleDuplicate(): Promise<void> {
    if (!selected) return;
    const created = await repository.duplicate(selected.id);
    setItems((current) => [...(current ?? []), created]);
    setSelectedId(created.id);
  }

  function handleCreated(created: CatalogItemAdmin) {
    setItems((current) => [...(current ?? []), created]);
    setSelectedId(created.id);
    setPanel("none");
  }

  function toggleChecked(id: string) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible(checked: boolean) {
    setCheckedIds((current) => {
      const next = new Set(current);
      for (const entry of filteredEntries) {
        if (checked) next.add(entry.id);
        else next.delete(entry.id);
      }
      return next;
    });
  }

  async function handleBulk(action: BulkLifecycleAction) {
    if (visibleCheckedIds.length === 0) return;
    const activeChecked = filteredEntries.filter((entry) => checkedIds.has(entry.id) && entry.lifecycleStatus === "active");
    let includeActive = false;
    if (action === "archive" && activeChecked.length > 0) {
      // Active items feed the live generator — they are skipped unless the admin explicitly
      // confirms them here (the server enforces the same rule: includeActive defaults to false).
      includeActive = window.confirm(
        `Mezi označenými je ${activeChecked.length} aktivních položek, které používá generátor:\n` +
          activeChecked.map((entry) => `• ${entry.internalCode ?? entry.abfCode ?? ""} ${entry.displayName}`).join("\n") +
          "\n\nOK = archivovat i je, Zrušit = aktivní přeskočit.",
      );
    }
    setBulkBusy(true);
    setBulkMessage("");
    try {
      const result = await repository.bulkLifecycle({ ids: visibleCheckedIds, action, includeActive });
      setItems((current) => {
        const byId = new Map(result.items.map((item) => [item.id, item]));
        return (current ?? []).map((item) => byId.get(item.id) ?? item);
      });
      const done = result.outcomes.filter((outcome) => outcome.result !== "skipped").length;
      const skipped = result.outcomes.filter((outcome) => outcome.result === "skipped").length;
      setBulkMessage(`${action === "archive" ? "Archivováno" : "Obnoveno"}: ${done}${skipped ? `, přeskočeno: ${skipped}` : ""}.`);
      setCheckedIds(new Set());
    } catch (error) {
      setBulkMessage(error instanceof Error ? error.message : "Hromadná akce selhala.");
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">ADMINISTRACE</span>
          <h1>Katalog komponent</h1>
        </div>
        {items && <span className="catalogAdminCount">{filteredEntries.length} / {allItems.length} položek</span>}
      </div>

      {loadError && <p className="uploadError persistenceBanner">Katalog se nepodařilo načíst z databáze: {loadError}</p>}
      {!items && !loadError && <p className="workspaceEmpty">Načítám katalog z databáze…</p>}

      {items && (
        <>
          <div className="catalogAdminToolbar">
            <button type="button" className="primaryButton" onClick={() => { setPanel(panel === "create" ? "none" : "create"); setSelectedId(undefined); }}>
              + Nová položka
            </button>
            <button type="button" className="secondaryButton" onClick={() => setPanel(panel === "import" ? "none" : "import")}>
              Import ABF kódů (KODY.xlsm)
            </button>
            <button type="button" className="secondaryButton" onClick={() => setPanel(panel === "variants" ? "none" : "variants")}>
              Vzorníky
            </button>
            <button type="button" className="secondaryButton" onClick={() => setPanel(panel === "categories" ? "none" : "categories")}>
              Kategorie
            </button>
            {needsTypeReviewCount > 0 && (
              <button type="button" className="secondaryButton" onClick={() => setFilters({ ...filters, needsTypeReview: true, onlyArchived: false })}>
                K zařazení: {needsTypeReviewCount}
              </button>
            )}
          </div>

          {panel === "create" && <CatalogItemCreateForm repository={repository} onCancel={() => setPanel("none")} onCreated={handleCreated} />}
          {panel === "import" && <AbfImportPanel repository={repository} onClose={() => setPanel("none")} onApplied={() => void reload()} />}
          {panel === "categories" && <CatalogCategoriesPanel onClose={() => setPanel("none")} />}
          {panel === "variants" && <VariantSetsPanel variantSets={variantSets} allItems={allItems} onSave={handleSaveVariantSet} onClose={() => setPanel("none")} />}
          {variantSetsError && <p className="uploadError">{variantSetsError}</p>}

          <ComponentAdminFilters filters={filters} onChange={setFilters} />

          <div className="catalogBulkBar">
            <label className="checkboxRow">
              <input
                type="checkbox"
                checked={filteredEntries.length > 0 && visibleCheckedIds.length === filteredEntries.length}
                onChange={(event) => toggleAllVisible(event.target.checked)}
              />
              Označit vše ({visibleCheckedIds.length} označeno)
            </label>
            <button type="button" className="dangerText" disabled={bulkBusy || visibleCheckedIds.length === 0} onClick={() => void handleBulk("archive")}>
              Hromadně archivovat
            </button>
            <button type="button" className="secondaryButton" disabled={bulkBusy || visibleCheckedIds.length === 0} onClick={() => void handleBulk("restore")}>
              Hromadně obnovit
            </button>
            {bulkMessage && <small className="fieldHint">{bulkMessage}</small>}
          </div>

          <div className="adminSplit">
            <ComponentAdminList
              entries={filteredEntries}
              selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setPanel("none"); }}
              checkedIds={checkedIds}
              onToggleChecked={toggleChecked}
            />
            {selected && (
              <ComponentAdminDetail
                key={selected.id}
                item={selected}
                allItems={allItems}
                onSave={handleSave}
                onSavePackage={handleSavePackage}
                variantSets={variantSets}
                aliasRegister={aliasRegister}
                aliasLoadError={aliasLoadError}
                onSaveAliases={handleSaveAliases}
                onDuplicate={handleDuplicate}
                onOpenPricing={() => onOpenPricing(selected.id)}
                onOpenPriceVersion={onOpenPriceVersion}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

type ArchiveView = "current" | "archived" | "all";

function archiveViewOf(filters: CatalogItemAdminFilters): ArchiveView {
  if (filters.onlyArchived) return "archived";
  return filters.showArchived ? "all" : "current";
}

/** Shared filter bar: card type, archive view (aktivní / archivované / vše), status, readiness, asset, "K zařazení". */
export function ComponentAdminFilters({ filters, onChange }: { filters: CatalogItemAdminFilters; onChange: (filters: CatalogItemAdminFilters) => void }) {
  return (
    <div className="adminFilters catalogAdminFilters">
      <input value={filters.query ?? ""} onChange={(event) => onChange({ ...filters, query: event.target.value })} placeholder="Hledat interní kód, ABF kód nebo název…" />
      <select value={filters.itemType ?? ""} onChange={(event) => onChange({ ...filters, itemType: event.target.value as CatalogItemType | "" })}>
        <option value="">Typ: vše</option>
        {CATALOG_ITEM_TYPES.map((itemType) => (
          <option key={itemType} value={itemType}>{CATALOG_ITEM_TYPE_LABELS_CS[itemType]}</option>
        ))}
      </select>
      <select
        value={archiveViewOf(filters)}
        onChange={(event) => {
          const view = event.target.value as ArchiveView;
          onChange({ ...filters, onlyArchived: view === "archived", showArchived: view === "all" });
        }}
      >
        <option value="current">Katalog bez archivu</option>
        <option value="archived">Jen archivované</option>
        <option value="all">Vše včetně archivu</option>
      </select>
      <select value={filters.lifecycleStatus ?? ""} onChange={(event) => onChange({ ...filters, lifecycleStatus: event.target.value as CatalogItemStatus | "" })}>
        <option value="">Stav: vše</option>
        {CATALOG_ITEM_STATUSES.map((status) => (
          <option key={status} value={status}>{CATALOG_ITEM_STATUS_LABELS_CS[status]}</option>
        ))}
      </select>
      <select value={filters.kind ?? ""} onChange={(event) => onChange({ ...filters, kind: event.target.value as CatalogItemKind | "" })}>
        <option value="">Druh (kind): vše</option>
        {CATALOG_ITEM_KINDS.map((kind) => (
          <option key={kind} value={kind}>{CATALOG_ITEM_KIND_LABELS_CS[kind]}</option>
        ))}
      </select>
      <select value={filters.readiness ?? ""} onChange={(event) => onChange({ ...filters, readiness: event.target.value as CatalogItemAdminFilters["readiness"] })}>
        <option value="">Readiness: vše</option>
        <option value="ready">Připravené</option>
        <option value="not-ready">Nepřipravené</option>
      </select>
      <select value={filters.asset ?? ""} onChange={(event) => onChange({ ...filters, asset: event.target.value as CatalogItemAdminFilters["asset"] })}>
        <option value="">Asset: vše</option>
        <option value="has-3d">Má 3D</option>
        <option value="missing-3d">Chybí 3D</option>
      </select>
      <label className="checkboxRow adminFiltersArchivedToggle">
        <input type="checkbox" checked={Boolean(filters.needsTypeReview)} onChange={(event) => onChange({ ...filters, needsTypeReview: event.target.checked })} />
        Jen k zařazení
      </label>
    </div>
  );
}

function wrapHeader(selectable: boolean, header: ReactNode): ReactNode {
  return selectable ? <div className="catalogAdminSelectableRow"><span />{header}</div> : header;
}

/** Exported so BoothAdminPage.tsx can reuse the exact same list rendering. checkedIds/onToggleChecked enable bulk selection. */
export function ComponentAdminList({
  entries,
  selectedId,
  onSelect,
  checkedIds,
  onToggleChecked,
}: {
  entries: readonly CatalogItemAdminListEntry[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  checkedIds?: ReadonlySet<string>;
  onToggleChecked?: (id: string) => void;
}) {
  const selectable = Boolean(checkedIds && onToggleChecked);
  return (
    <div className="adminList catalogAdminTable">
      {wrapHeader(selectable,
        <div className="catalogAdminRow catalogAdminHeaderRow">
          <span>Náhled</span>
          <span>Kód / ABF</span>
          <span>Název</span>
          <span>Typ · kategorie</span>
          <span>Stav</span>
          <span>Rozměry</span>
          <span>3D</span>
          <span>Cena</span>
          <span>Generator</span>
        </div>,
      )}
      {entries.length === 0 && <p className="workspaceEmpty">Filtrům neodpovídá žádná položka.</p>}
      {entries.map((entry) => {
        const row = (
          <button key={entry.id} type="button" className={`catalogAdminRow ${entry.id === selectedId ? "active" : ""}`} onClick={() => onSelect(entry.id)}>
            <ThumbnailCell photoAsset={entry.photoAsset} photoUrl={entry.photoUrl} label={entry.displayName} />
            <span title={`Generátorový kód: ${entry.internalCode ?? "—"} · ABF kód: ${entry.abfCode ?? "—"}`}>
              {entry.internalCode ?? "—"}
              {entry.abfCode && entry.abfCode !== entry.internalCode ? <small className="catalogAbfCode"> ABF {entry.abfCode}</small> : null}
            </span>
            <span>{entry.displayName}</span>
            <span>
              {CATALOG_ITEM_TYPE_LABELS_CS[entry.itemType]}
              {entry.category ? ` · ${categoryLabelCs(entry.category)}` : ""}
              {entry.itemTypeNeedsReview ? " · k zařazení" : ""}
              {(entry.itemType === "BOOTH" || entry.itemType === "KIT") && entry.packageItemCount > 0 ? ` · ${entry.packageItemCount} pol.` : ""}
            </span>
            <span className={`lifecycleBadge ${entry.lifecycleStatus}`}>{CATALOG_ITEM_STATUS_LABELS_CS[entry.lifecycleStatus]}</span>
            <span>{entry.hasDimensions ? `${entry.widthMm} × ${entry.depthMm}${entry.heightMm ? ` × ${entry.heightMm}` : ""} mm` : "Chybí rozměry"}</span>
            <span>{entry.has3DAsset ? "3D ano" : "3D chybí"}</span>
            <span>{entry.basePriceCzk !== null ? `${entry.basePriceCzk.toLocaleString("cs-CZ")} Kč` : "Cena neuvedena"}</span>
            <span className={`readinessBadge ${entry.readiness.ready ? "ready" : "blocked"}`}>{entry.readiness.ready ? "Připraveno" : "Nepřipraveno"}</span>
          </button>
        );
        if (!selectable) return row;
        return (
          <div key={entry.id} className="catalogAdminSelectableRow">
            <input type="checkbox" aria-label={`Označit ${entry.displayName}`} checked={checkedIds!.has(entry.id)} onChange={() => onToggleChecked!(entry.id)} />
            {row}
          </div>
        );
      })}
    </div>
  );
}

/** List-row thumbnail — photoAsset (R2, resolved to a signed URL) wins when present, legacy static photoUrl is the fallback, otherwise a plain empty placeholder cell (never a fabricated image). */
function ThumbnailCell({ photoAsset, photoUrl, label }: { photoAsset: StoredAsset | undefined; photoUrl: string | undefined; label: string }) {
  const resolved = useAssetUrl(photoAsset, photoUrl);
  return (
    <span className="catalogThumbnailCell">
      {resolved.url ? <img className="catalogThumbnailImg" src={resolved.url} alt={`Náhled ${label}`} /> : <span className="catalogThumbnailPlaceholder" aria-hidden="true" />}
    </span>
  );
}

/** Exported so BoothAdminPage.tsx renders the SAME detail view (Foto/GLB/SKP/source files/readiness/reviewed/activation) for type-booths and booth components — never a second, parallel detail UI. */
export function ComponentAdminDetail({
  item,
  allItems,
  onSave,
  onSavePackage,
  variantSets,
  aliasRegister,
  aliasLoadError,
  onSaveAliases,
  onDuplicate,
  onOpenPricing,
  onOpenPriceVersion,
}: {
  item: CatalogItemAdmin;
  /** Whole catalog — needed for the BOOTH/KIT package editor (child item picker). */
  allItems?: readonly CatalogItemAdmin[];
  onSave: (edit: CatalogItemAdminEdit) => Promise<void>;
  /** Returns the stored lines and the non-blocking warnings (e.g. the same component on lines that differ only in quantity). */
  onSavePackage?: (lines: readonly CatalogPackageItemInput[]) => Promise<SavedKitContents>;
  /** Swatch books for the kit editor's variant pickers (V1-DATA-04). */
  variantSets?: readonly CatalogVariantSet[];
  /** Aliases + units + realization companies (V1-DATA-03). null while loading. */
  aliasRegister?: CatalogAliasRegister | null;
  aliasLoadError?: string;
  onSaveAliases?: (aliases: readonly CatalogItemAliasInput[]) => Promise<readonly CatalogItemAlias[]>;
  onDuplicate?: () => Promise<void>;
  onOpenPricing: () => void;
  onOpenPriceVersion?: (preselect: PriceVersionsPreselect) => void;
}) {
  const itemDocument = item.document;
  const currentItemType = itemTypeOf(item);
  const abfImport = documentAbfImport(itemDocument);
  const initialName = typeof itemDocument.name === "string" ? itemDocument.name : item.displayName;
  const dims = documentDimensions(itemDocument);
  const pricing = documentBasePricing(itemDocument);
  const trace = documentSourceTraceability(itemDocument);
  const readiness = computeReadiness(item);
  const generatorEligible = computeGeneratorEligibleLive(item);
  const reviewedAt = documentReviewedAt(itemDocument);

  const photoAsset = documentPhotoAsset(itemDocument);
  const legacyPhotoUrl = documentPhotoUrl(itemDocument);
  const hasPhoto = Boolean(photoAsset || legacyPhotoUrl);
  const photoResolved = useAssetUrl(photoAsset, legacyPhotoUrl);
  const galleryPhotos = documentGalleryPhotoAssets(itemDocument);
  const [galleryBusyId, setGalleryBusyId] = useState<string | undefined>(undefined);

  const modelAsset = documentModelAsset(itemDocument);
  const effectiveModel = documentEffectiveModelReference(itemDocument);
  const hasModel = Boolean(effectiveModel);
  const footprint2D = documentFootprint2D(itemDocument);
  const sourceAssets = documentSourceAssets(itemDocument);
  const hasSketchupSource = sourceAssets.some((entry) => entry.kind === "sketchup");
  /**
   * A multi-variant type-booth line (T04..T25) has NO parent-level runtime model or source file
   * of its own — every variant owns its own modelAsset/sourceAssets independently (see the
   * "Varianty" section below). Both the parent "3D model" AND "Zdrojové a výrobní soubory"
   * sections are gated by this SAME flag so they can never drift out of sync with each other.
   * Parent displayName/description/photoAsset/lifecycle are completely unaffected — this only
   * hides the two asset sections that would otherwise upload/show data nothing ever reads.
   */
  const isVariantBooth = item.kind === "booth" && documentVariants(itemDocument).length > 0;

  const [photoProgress, setPhotoProgress] = useState<UploadProgress | undefined>(undefined);
  const [photoActionError, setPhotoActionError] = useState("");
  const [modelProgress, setModelProgress] = useState<UploadProgress | undefined>(undefined);
  const [modelActionError, setModelActionError] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [sourceAssetKind, setSourceAssetKind] = useState<SourceAssetKind>("sketchup");
  const [sourceAssetProgress, setSourceAssetProgress] = useState<UploadProgress | undefined>(undefined);
  const [sourceAssetActionError, setSourceAssetActionError] = useState("");
  const [sourceAssetRemovingId, setSourceAssetRemovingId] = useState<string | undefined>(undefined);

  const ownerId = item.internalCode ?? item.id;

  async function handlePhotoUpload(file: File) {
    setPhotoActionError("");
    if (file.size === 0) {
      setPhotoActionError("Soubor je prázdný.");
      return;
    }
    if (!hasAllowedExtension(file.name, PHOTO_EXTENSIONS)) {
      setPhotoActionError("Podporované formáty: jpg, jpeg, png, webp.");
      return;
    }
    try {
      // Section 7 — replacement safety: upload to R2 first, THEN save the new DB reference.
      // If the save below fails, the OLD photoAsset in `item`/`current` is never touched —
      // the new R2 object may become orphaned, which is accepted (no auto-cleanup here).
      const asset = await uploadAsset(file, { category: "catalog-photo", ownerId }, setPhotoProgress);
      await onSave({ photoAsset: asset });
    } catch (uploadError) {
      setPhotoActionError(uploadError instanceof Error ? uploadError.message : "Nahrání fotografie selhalo.");
    }
  }

  async function handlePhotoRemove() {
    setPhotoActionError("");
    try {
      // Metadata-only — never a physical R2 delete (mirrors /api/assets/delete's reference-safety no-op).
      await onSave({ photoAsset: null });
    } catch (removeError) {
      setPhotoActionError(removeError instanceof Error ? removeError.message : "Odebrání fotografie selhalo.");
    }
  }

  async function handleGalleryAction(photoId: string, edit: CatalogItemAdminEdit) {
    setPhotoActionError("");
    setGalleryBusyId(photoId);
    try {
      // Metadata only — a removed gallery photo stays in R2 (no automatic deletes).
      await onSave(edit);
    } catch (galleryError) {
      setPhotoActionError(galleryError instanceof Error ? galleryError.message : "Úprava galerie selhala.");
    } finally {
      setGalleryBusyId(undefined);
    }
  }

  async function handleModelUpload(file: File) {
    setModelActionError("");
    if (file.size === 0) {
      setModelActionError("Soubor je prázdný.");
      return;
    }
    if (!hasAllowedExtension(file.name, MODEL_EXTENSIONS)) {
      setModelActionError("Podporovaný formát: pouze .glb.");
      return;
    }
    try {
      const asset = await uploadAsset(file, { category: "catalog-model", ownerId }, setModelProgress);
      await onSave({ modelAsset: asset });
    } catch (uploadError) {
      setModelActionError(uploadError instanceof Error ? uploadError.message : "Nahrání 3D modelu selhalo.");
    }
  }

  async function handleModelRemove() {
    setModelActionError("");
    try {
      await onSave({ modelAsset: null });
    } catch (removeError) {
      setModelActionError(removeError instanceof Error ? removeError.message : "Odebrání 3D modelu selhalo.");
    }
  }

  async function handleSourceAssetUpload(file: File) {
    setSourceAssetActionError("");
    if (file.size === 0) {
      setSourceAssetActionError("Soubor je prázdný.");
      return;
    }
    const allowed = SOURCE_ASSET_KIND_EXTENSIONS[sourceAssetKind];
    if (allowed.length > 0 && !hasAllowedExtension(file.name, allowed)) {
      setSourceAssetActionError(`Zvolený typ (${SOURCE_ASSET_KIND_LABELS_CS[sourceAssetKind]}) očekává příponu: ${allowed.join(", ")}.`);
      return;
    }
    try {
      const asset = await uploadAsset(file, { category: "catalog-source", ownerId }, setSourceAssetProgress);
      await onSave({ addSourceAsset: { kind: sourceAssetKind, asset } });
    } catch (uploadError) {
      setSourceAssetActionError(uploadError instanceof Error ? uploadError.message : "Nahrání souboru selhalo.");
    }
  }

  async function handleSourceAssetRemove(entry: SourceAssetEntry) {
    setSourceAssetActionError("");
    setSourceAssetRemovingId(entry.id);
    try {
      // Metadata-only — never a physical R2 delete (mirrors photoAsset/modelAsset removal above).
      await onSave({ removeSourceAssetId: entry.id });
    } catch (removeError) {
      setSourceAssetActionError(removeError instanceof Error ? removeError.message : "Odebrání souboru selhalo.");
    } finally {
      setSourceAssetRemovingId(undefined);
    }
  }

  async function handleMarkReviewed() {
    setReviewBusy(true);
    setReviewError("");
    try {
      await onSave({ markReviewed: true });
    } catch (markError) {
      setReviewError(markError instanceof Error ? markError.message : "Označení jako zkontrolované selhalo.");
    } finally {
      setReviewBusy(false);
    }
  }

  /**
   * Archive/restore reuse the SAME lifecycleStatus edit field the "Aktivovat" button already
   * uses — never a parallel isArchived boolean. Archiving is always allowed (no readiness check
   * — an incomplete/broken item must still be archivable) and never touches document/pricing/
   * assets/mappings/provenance, only the lifecycle_status column (see applyCatalogItemEdit).
   * Restoring ALWAYS lands on needs_review, never active — re-activation still has to pass
   * through the normal readiness/review/"Aktivovat" flow, enforced server-side by
   * saveCatalogItemAdmin's existing assertCanActivate guard on any transition INTO active.
   */
  async function handleArchive() {
    setArchiveBusy(true);
    setArchiveError("");
    try {
      await onSave({ lifecycleStatus: "archived" });
    } catch (archiveErr) {
      setArchiveError(archiveErr instanceof Error ? archiveErr.message : "Archivace selhala.");
    } finally {
      setArchiveBusy(false);
    }
  }

  async function handleRestore() {
    setArchiveBusy(true);
    setArchiveError("");
    try {
      // Server resolves the target: the pre-archive status, re-checked against readiness
      // (domain/catalogItemsAdmin.ts resolveRestoreStatus) — never blindly active.
      await onSave({ restoreFromArchive: true });
    } catch (restoreErr) {
      setArchiveError(restoreErr instanceof Error ? restoreErr.message : "Obnovení selhalo.");
    } finally {
      setArchiveBusy(false);
    }
  }

  const initialWidth = dims.widthMm !== null ? String(dims.widthMm) : "";
  const initialDepth = dims.depthMm !== null ? String(dims.depthMm) : "";
  const initialHeight = dims.heightMm !== null ? String(dims.heightMm) : "";
  // Undefined (never declared) reads as unchecked — section 3: never auto-set true from kind/internalCode.
  const initialShowIn2D = Boolean(itemDocument.showIn2D);
  const initialShowIn3D = Boolean(itemDocument.showIn3D);

  const [displayName, setDisplayName] = useState(item.displayName);
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState(item.category ?? "");
  const legacyUnit = normalizeCatalogUnit(item.unit);
  const initialUnitCode = item.unitCode ?? (legacyUnit.status === "known" ? legacyUnit.code : "");
  const [unitCode, setUnitCode] = useState(initialUnitCode);
  const [officialName, setOfficialName] = useState(item.officialName ?? "");
  const [officialNameEn, setOfficialNameEn] = useState(item.officialNameEn ?? "");
  const initialAttributes = documentAttributes(itemDocument);
  const [color, setColor] = useState(initialAttributes.color ?? "");
  const [material, setMaterial] = useState(initialAttributes.material ?? "");
  const [extraParams, setExtraParams] = useState<readonly { key: string; value: string }[]>(initialAttributes.extra ?? []);
  // Service cards: power (kW) and parameters stay in the EXISTING structured service metadata
  // (document.serviceTechnical.powerKw / .parameters — read by the customer catalog too). They are
  // edited in "Parametry komponenty" and saved by the card's normal "Uložit", never separately.
  const initialService = documentServiceTechnical(itemDocument);
  const [powerKw, setPowerKw] = useState(initialService?.powerKw !== undefined ? String(initialService.powerKw) : "");
  const [serviceParams, setServiceParams] = useState<readonly { key: string; value: string }[]>(initialService?.parameters ?? []);
  const isServiceCard = currentItemType === "SERVICE";
  const [widthMm, setWidthMm] = useState(initialWidth);
  const [depthMm, setDepthMm] = useState(initialDepth);
  const [heightMm, setHeightMm] = useState(initialHeight);
  const [showIn2D, setShowIn2D] = useState(initialShowIn2D);
  const [showIn3D, setShowIn3D] = useState(initialShowIn3D);
  const [abfCode, setAbfCode] = useState(item.abfCode ?? "");
  // Generator code: the ONE canonical value is catalog_items.internal_code. "Stejný jako ABF kód" is
  // not stored anywhere — it starts checked only when the two codes really are equal (or, for a card
  // without a code, when an ABF code exists), so opening a historical card never changes its data.
  const [codeSameAsAbf, setCodeSameAsAbf] = useState(item.internalCode ? codesMatch(item.internalCode, item.abfCode) : Boolean(item.abfCode));
  const [codeDraft, setCodeDraft] = useState(item.internalCode ?? "");
  const codeDerivedFromAbf = codeSameAsAbf && Boolean(abfCode.trim());
  const resultingCode = codeDerivedFromAbf ? abfCode.trim().toUpperCase() : codeDraft.trim();
  const codeWillChange = Boolean(item.internalCode && resultingCode && resultingCode !== item.internalCode);
  // Druh komponenty → Kategorie (domain/catalogClassification.ts). The user picks the group and a
  // category of it; the internal card type and kind follow from the category. Typové stánky and
  // komplety keep their own type/kind (specialized administration).
  const categoryRegister = useCatalogCategories();
  const storedGroup = groupOfCard(currentItemType, item.kind);
  const isSpecialCard = storedGroup === "booth" || storedGroup === "kit";
  const [group, setGroup] = useState<CardGroup>(storedGroup);
  const categoryDef = findCategory(categoryRegister.categories, category);
  const classificationTargetForCategory = !isSpecialCard && categoryDef && categoryDef.group === group ? classificationTarget(categoryDef, item.kind) : undefined;
  const itemType: CatalogItemType = isSpecialCard ? currentItemType : classificationTargetForCategory?.itemType ?? (isComponentGroup(group) ? COMPONENT_GROUP_TARGETS[group].itemType : currentItemType);
  const kind: CatalogItemKind = isSpecialCard ? item.kind : classificationTargetForCategory?.kind ?? item.kind;
  const classificationChanged = !isSpecialCard && (category !== (item.category ?? "") || group !== storedGroup);
  const classificationProblem = classificationChanged ? classificationIssue(categoryRegister.categories, { itemType, kind, category: category || null }, { requireActive: category !== (item.category ?? "") }) : undefined;
  const storedClassificationIssue = isSpecialCard ? undefined : classificationIssue(categoryRegister.categories, { itemType: currentItemType, kind: item.kind, category: item.category });
  const storedCategoryDef = findCategory(categoryRegister.categories, item.category);
  const [note, setNote] = useState(documentNote(itemDocument));
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"idle" | "saving" | "activating">("idle");
  const [error, setError] = useState("");

  function buildEdit(): CatalogItemAdminEdit {
    const edit: { -readonly [K in keyof CatalogItemAdminEdit]?: CatalogItemAdminEdit[K] } = {};
    if (displayName !== item.displayName) edit.displayName = displayName;
    if (name !== initialName) edit.name = name;
    if (category !== (item.category ?? "") && (isSpecialCard || category)) edit.category = category;
    if (unitCode !== (item.unitCode ?? "")) edit.unitCode = unitCode || null;
    if (officialName.trim() !== (item.officialName ?? "")) edit.officialName = officialName.trim() || null;
    if (officialNameEn.trim() !== (item.officialNameEn ?? "")) edit.officialNameEn = officialNameEn.trim() || null;
    const nextAttributes = { color: color.trim() || undefined, material: material.trim() || undefined, extra: extraParams.filter((param) => param.key.trim() && param.value.trim()) };
    if (JSON.stringify(nextAttributes) !== JSON.stringify({ color: initialAttributes.color, material: initialAttributes.material, extra: initialAttributes.extra ?? [] })) {
      edit.attributes = nextAttributes.color || nextAttributes.material || nextAttributes.extra.length ? nextAttributes : null;
    }
    if (widthMm !== initialWidth) {
      const parsed = Number(widthMm);
      if (Number.isFinite(parsed)) edit.widthMm = parsed;
    }
    if (depthMm !== initialDepth) {
      const parsed = Number(depthMm);
      if (Number.isFinite(parsed)) edit.depthMm = parsed;
    }
    if (heightMm !== initialHeight) {
      const parsed = Number(heightMm);
      if (Number.isFinite(parsed)) edit.heightMm = parsed;
    }
    if (showIn2D !== initialShowIn2D) edit.showIn2D = showIn2D;
    if (showIn3D !== initialShowIn3D) edit.showIn3D = showIn3D;
    if (abfCode.trim() !== (item.abfCode ?? "")) edit.abfCode = abfCode.trim() ? abfCode.trim() : null;
    if (!item.internalCode && resultingCode) edit.fillInternalCode = resultingCode;
    if (item.internalCode && codeWillChange) edit.changeInternalCode = { from: item.internalCode, to: resultingCode };
    if (!isSpecialCard && classificationChanged) {
      if (itemType !== currentItemType) edit.itemType = itemType;
      if (kind !== item.kind) edit.kind = kind;
    }
    if (note !== documentNote(itemDocument)) edit.note = note;
    if (isServiceCard) {
      const draft = serviceTechnicalDraft();
      if (JSON.stringify(draft) !== JSON.stringify(initialService ?? null)) edit.serviceTechnical = draft;
    }
    return edit;
  }

  /** The service metadata as the form currently has it — the technical category (derived from Kategorie) is kept as stored. */
  function serviceTechnicalDraft() {
    const draft: { serviceCategory?: string; powerKw?: number; parameters?: { key: string; value: string }[] } = {};
    if (initialService?.serviceCategory) draft.serviceCategory = initialService.serviceCategory;
    const parsedPower = Number(powerKw.trim().replace(",", "."));
    if (powerKw.trim() && Number.isFinite(parsedPower) && parsedPower >= 0) draft.powerKw = parsedPower;
    const cleaned = serviceParams.map((entry) => ({ key: entry.key.trim(), value: entry.value.trim() })).filter((entry) => entry.key);
    if (cleaned.length > 0) draft.parameters = cleaned;
    return Object.keys(draft).length > 0 ? draft : null;
  }
  const powerProblem = isServiceCard && powerKw.trim() && !(Number.isFinite(Number(powerKw.trim().replace(",", "."))) && Number(powerKw.trim().replace(",", ".")) >= 0) ? "Výkon musí být nezáporné číslo v kW (např. 2 nebo 2,5)." : undefined;

  // "Parametry komponenty": ONE generic list per card (services: serviceTechnical.parameters, others:
  // attributes.extra) holds the category's recommended parameters and the user's own ones.
  const parameterStore = isServiceCard ? serviceParams : extraParams;
  const setParameterStore = (next: readonly { key: string; value: string }[]) => { if (isServiceCard) setServiceParams(next); else setExtraParams(next); setDirty(true); };
  const recommendedTemplates = activeRecommendedParameters(categoryDef?.recommendedParameters);
  const recommendedKeys = new Set(recommendedTemplates.map(recommendedParameterKey));
  const showDimensions = catalogTypeHasField(itemType, "width_mm") || Boolean(initialWidth || initialDepth || initialHeight);
  const showMaterial = catalogTypeHasField(itemType, "color") || catalogTypeHasField(itemType, "material") || Boolean(initialAttributes.color || initialAttributes.material);
  const showPower = isServiceCard && (categoryDef?.serviceCategory === "electricity" || initialService?.powerKw !== undefined);
  const parametersProblem = parameterProblem({
    recommended: recommendedTemplates.map((parameter) => ({ parameter, value: parameterStore.find((entry) => entry.key === recommendedParameterKey(parameter))?.value ?? "" })),
    own: parameterStore.filter((entry) => !recommendedKeys.has(entry.key)),
    dimensions: showDimensions ? [{ label: "Šířka", value: widthMm }, { label: "Hloubka", value: depthMm }, { label: "Výška", value: heightMm }] : [],
  });
  const formProblem = classificationProblem ?? powerProblem ?? parametersProblem;

  function handleGroupChange(next: ComponentGroup) {
    setGroup(next);
    // A category of another group is never carried over and nothing is preselected — the user chooses.
    if (categoryDef?.group !== next) setCategory("");
    setDirty(true);
  }

  async function handleDuplicateClick() {
    if (!onDuplicate) return;
    setDuplicateBusy(true);
    setError("");
    try {
      await onDuplicate();
    } catch (duplicateError) {
      setError(duplicateError instanceof Error ? duplicateError.message : "Duplikace selhala.");
    } finally {
      setDuplicateBusy(false);
    }
  }

  async function handleConfirmType() {
    setError("");
    try {
      await onSave({ confirmItemType: true });
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Potvrzení typu selhalo.");
    }
  }

  async function handleSaveClick() {
    if (formProblem) {
      setError(formProblem);
      return;
    }
    setBusy("saving");
    setError("");
    try {
      await onSave(buildEdit());
      setDirty(false);
    } catch (saveError) {
      setError(
        saveError instanceof ConcurrencyConflictError
          ? "Data byla mezitím změněna jinde. Obnovte stránku před uložením."
          : saveError instanceof Error
            ? saveError.message
            : "Uložení se nezdařilo.",
      );
    } finally {
      setBusy("idle");
    }
  }

  async function handleActivate() {
    if (formProblem) {
      setError(formProblem);
      return;
    }
    setBusy("activating");
    setError("");
    try {
      await onSave({ ...buildEdit(), lifecycleStatus: "active" });
      setDirty(false);
    } catch (activateError) {
      setError(
        activateError instanceof ConcurrencyConflictError
          ? "Data byla mezitím změněna jinde. Obnovte stránku před uložením."
          : activateError instanceof Error
            ? activateError.message
            : "Aktivace se nezdařila.",
      );
    } finally {
      setBusy("idle");
    }
  }

  const stateLabel = dirty ? "dirty" : busy === "saving" ? "saving" : "saved";

  // Mode of the card from the EXISTING 2D/3D flags (the checkbox state, so switching shows/hides at
  // once). Hiding a section never deletes anything — hidden files are listed separately below.
  const model3DMode = ALWAYS_3D_KINDS.includes(item.kind) || (CAPABILITY_TOGGLE_KINDS.includes(item.kind) ? showIn3D : true);
  const cadMode = SOURCE_ASSET_APPLICABLE_KINDS.includes(item.kind) && !(CAD_ONLY_WITH_3D_KINDS.includes(item.kind) && !showIn3D);
  const cadSourceAssets = sourceAssets.filter((entry) => entry.kind !== "pdf");
  const documentAssets = sourceAssets.filter((entry) => entry.kind === "pdf");
  /** Batch upload targets follow the SAME gates as the sections they fill (no parent GLB/source files on a variant line). */
  const batchHasModel = hasModel && !isVariantBooth;
  const batchModelAllowed = model3DMode && !isVariantBooth;
  const batchCadAllowed = cadMode && !isVariantBooth;
  const batchDocumentsAllowed = !isVariantBooth;

  return (
    <div className="adminDetail catalogAdminDetail">
      <header className="catalogDetailHeader">
        <span>
          {CATALOG_ITEM_TYPE_LABELS_CS[currentItemType]} · {item.internalCode ?? "Bez interního kódu"}
          {item.abfCode ? ` · ABF ${item.abfCode}` : ""}
        </span>
        <h2>{item.displayName}</h2>
        <span className={`lifecycleBadge ${item.lifecycleStatus}`}>{CATALOG_ITEM_STATUS_LABELS_CS[item.lifecycleStatus]}</span>
      </header>

      <div className="eventSaveBar catalogAdminSaveBar">
        <span className={stateLabel}>
          {stateLabel === "dirty" ? "Neuložené změny" : stateLabel === "saving" ? "Ukládám…" : "Uloženo"}
          {error && <small className="uploadError">{error}</small>}
        </span>
        <button type="button" className="primaryButton" onClick={handleSaveClick} disabled={!dirty || busy !== "idle"}>Uložit změny</button>
      </div>

      <div className="catalogDetailSections">
        <section className="catalogDetailSection">
          <h3>Identita</h3>
          {storedClassificationIssue && !classificationChanged && (
            <p className="fieldWarning catalogClassificationWarning">
              Uložené zařazení neodpovídá pravidlům katalogu: {storedClassificationIssue} Zvolte platný Druh komponenty a Kategorii. Do té doby se karta ukládá beze změny zařazení — nic se samo nepřepisuje.
            </p>
          )}
          {!storedClassificationIssue && storedCategoryDef && !storedCategoryDef.isActive && !classificationChanged && (
            <p className="fieldHint">Kategorie „{storedCategoryDef.name}“ je neaktivní (historická). {storedCategoryDef.description ?? ""}</p>
          )}
          <dl>
            <EditRow label="Druh komponenty">
              {isSpecialCard ? (
                <span className="readOnlyField">{CATALOG_ITEM_TYPE_LABELS_CS[currentItemType]} <small className="fieldHint">— specializovaná karta (obsah, zahrnuté položky, náhrady); druh se zde nemění.</small></span>
              ) : (
                <>
                  <select
                    aria-label="Druh komponenty"
                    value={isComponentGroup(group) ? group : ""}
                    onChange={(event) => handleGroupChange(event.target.value as ComponentGroup)}
                    disabled={item.lifecycleStatus === "active"}
                    title={item.lifecycleStatus === "active" ? "Aktivní položce nelze měnit druh — používá ji generátor." : undefined}
                  >
                    {COMPONENT_GROUPS.map((value) => <option key={value} value={value}>{COMPONENT_GROUP_LABELS_CS[value]}</option>)}
                  </select>
                  {isComponentGroup(group) && <small className="fieldHint">{COMPONENT_GROUP_HINTS_CS[group]}</small>}
                  {group !== storedGroup && <small className="fieldWarning">Změna druhu změní interní typ karty a její cenové zařazení; formulář pak nabídne jiné sekce. Žádné přílohy ani údaje se nesmažou.</small>}
                </>
              )}
            </EditRow>
            <EditRow label="Kategorie">
              {isSpecialCard ? (
                <select value={category} onChange={(event) => { setCategory(event.target.value); setDirty(true); }}>
                  {category && !CATALOG_ITEM_CATEGORY_OPTIONS.some((option) => option.value === category) && <option value={category}>{category} (zachována)</option>}
                  {!category && <option value="">— nevybráno —</option>}
                  {CATALOG_ITEM_CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : (
                <>
                  <select aria-label="Kategorie" value={category} onChange={(event) => { setCategory(event.target.value); setDirty(true); }}>
                    <option value="">— vyberte kategorii —</option>
                    {item.category && category === item.category && (!storedCategoryDef || storedCategoryDef.group !== group || !storedCategoryDef.isActive) && (
                      <option value={item.category}>{storedCategoryDef?.name ?? item.category} (uloženo — {storedCategoryDef ? (storedCategoryDef.isActive ? `patří k druhu ${COMPONENT_GROUP_LABELS_CS[storedCategoryDef.group]}` : "neaktivní") : "není v registru"})</option>
                    )}
                    {isComponentGroup(group) && categoriesForGroup(categoryRegister.categories, group).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                  </select>
                  {classificationChanged && classificationProblem && <small className="fieldWarning">{classificationProblem}</small>}
                  {categoryDef && derivedPriceCategory(categoryDef) === "electricity" && <small className="fieldHint">Cenové zařazení: Elektřina → ceník elektřiny.</small>}
                  {categoryDef?.group === "technical_point" && <small className="fieldHint">Technický bod se samostatně neúčtuje.</small>}
                </>
              )}
            </EditRow>
            <EditRow label="ABF kód">
              <input
                value={abfCode}
                onChange={(event) => { setAbfCode(event.target.value); setDirty(true); }}
                placeholder={itemTypeExpectsAbfCode(itemType) ? "Bez ABF kódu" : "Interní komponenta — ABF kód není potřeba"}
              />
            </EditRow>
            <EditRow label="Interní / generátorový kód">
              <input
                aria-label="Interní / generátorový kód"
                className={codeDerivedFromAbf ? "derivedCodeField" : undefined}
                value={codeDerivedFromAbf ? resultingCode : codeDraft}
                readOnly={codeDerivedFromAbf}
                onChange={(event) => { setCodeDraft(event.target.value); setDirty(true); }}
                placeholder={abfCode.trim() ? "Vlastní kód" : "Vlastní kód interní komponenty, např. INT-SLOUPEK-2500"}
              />
              {abfCode.trim() && (
                <label className="checkboxRow">
                  <input type="checkbox" checked={codeSameAsAbf} onChange={(event) => { setCodeSameAsAbf(event.target.checked); if (!event.target.checked && !codeDraft.trim()) setCodeDraft(abfCode.trim().toUpperCase()); setDirty(true); }} />
                  Stejný jako ABF kód
                </label>
              )}
              {codeWillChange ? (
                <small className="fieldWarning">
                  Po uložení se generátorový kód změní z {item.internalCode} na {resultingCode}. Server změnu odmítne, pokud starý kód používá aplikace (služby, typové stánky, starý generátor) nebo uložený projekt. Ceny, aliasy a soubory jsou vázané na kartu, ne na kód.
                </small>
              ) : item.internalCode ? (
                <small className="fieldHint">Uloženo: {item.internalCode} · {codeModeLabel(item.internalCode, item.abfCode)}. Stabilní identita položky v generátoru a cenách.</small>
              ) : resultingCode ? (
                <small className="fieldHint">Po uložení: {resultingCode} · {codeModeLabel(resultingCode, abfCode.trim() || null)}.</small>
              ) : (
                <small className="fieldHint">{abfCode.trim() ? "Zadejte vlastní kód, nebo zaškrtněte „Stejný jako ABF kód“." : "Interní komponenta nepotřebuje ABF kód — stačí vlastní generátorový kód."}</small>
              )}
            </EditRow>
            <EditRow label="Oficiální název ABF (CZ)">
              <input value={officialName} onChange={(event) => { setOfficialName(event.target.value); setDirty(true); }} placeholder={itemTypeExpectsAbfCode(itemType) ? "Podle KODY.xlsm" : "Interní komponenta — obvykle bez ABF názvu"} />
            </EditRow>
            <EditRow label="Oficiální název ABF (EN)">
              <input value={officialNameEn} onChange={(event) => { setOfficialNameEn(event.target.value); setDirty(true); }} placeholder="Official ABF name (KODY.xlsm)" />
            </EditRow>
            <EditRow label="Interní název HomeworkStudio">
              <input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setDirty(true); }} />
            </EditRow>
            <EditRow label="CZ název (interní)">
              <input value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} />
            </EditRow>
            <EditRow label="Měrná jednotka">
              <select value={unitCode} onChange={(event) => { setUnitCode(event.target.value); setDirty(true); }}>
                <option value="">— nevybráno —</option>
                {CATALOG_UNITS.map((unit) => <option key={unit.code} value={unit.code}>{unit.symbol} — {unit.nameCs}</option>)}
              </select>
              {!item.unitCode && item.unit && legacyUnit.status !== "known" && (
                <small className="fieldHint">Původní text „{item.unit}“ nebyl převeden: {legacyUnit.status === "empty" ? "" : legacyUnit.message}</small>
              )}
            </EditRow>
            <EditRow label="Poznámka">
              <input value={note} onChange={(event) => { setNote(event.target.value); setDirty(true); }} placeholder="Interní poznámka" />
            </EditRow>
            <Row label="Zdroj (traceability)" value={trace.sourceSystem ? `${trace.sourceSystem} · ${trace.sourceKey ?? "—"}` : "—"} />
            <Row label="Import ABF" value={abfImport ? `${abfImport.sourceFile} · ř. ${abfImport.sourceRow} · „${abfImport.abfName}“` : "—"} />
          </dl>
          <p className="fieldHint">{CATALOG_ITEM_TYPE_HINTS_CS[itemType]}</p>
          {documentItemTypeNeedsReview(itemDocument) && (
            <div className="readinessIssues">
              <strong>K zařazení:</strong> typ karty nešel při importu z dat bezpečně určit. Zkontrolujte typ (a druh) a uložte, nebo potvrďte současný.
              <div className="assetActions">
                <button type="button" className="secondaryButton" onClick={() => void handleConfirmType()}>Potvrdit typ „{CATALOG_ITEM_TYPE_LABELS_CS[currentItemType]}“</button>
              </div>
            </div>
          )}
        </section>

        <section className="catalogDetailSection">
          <h3>Parametry komponenty</h3>
          <dl>
            {/* System parameters — bound to their structured fields (generator, 2D/3D, customer catalog). */}
            {showDimensions && (
              <>
                <EditRow label="Šířka (mm)">
                  <input type="number" min="0" value={widthMm} onChange={(event) => { setWidthMm(event.target.value); setDirty(true); }} placeholder="Neznámo" />
                </EditRow>
                <EditRow label="Hloubka (mm)">
                  <input type="number" min="0" value={depthMm} onChange={(event) => { setDepthMm(event.target.value); setDirty(true); }} placeholder="Neznámo" />
                </EditRow>
                <EditRow label="Výška (mm)">
                  <input type="number" min="0" value={heightMm} onChange={(event) => { setHeightMm(event.target.value); setDirty(true); }} placeholder="Neznámo" />
                </EditRow>
              </>
            )}
            {showMaterial && (
              <>
                <EditRow label="Barva">
                  <input value={color} onChange={(event) => { setColor(event.target.value); setDirty(true); }} placeholder="např. černá, RAL 9016" />
                </EditRow>
                <EditRow label="Materiál">
                  <input value={material} onChange={(event) => { setMaterial(event.target.value); setDirty(true); }} placeholder="např. lamino, hliník" />
                </EditRow>
              </>
            )}
            {showPower && (
              <EditRow label="Výkon (kW)">
                <span className="inlineFieldWithAction">
                  <input aria-label="Výkon (kW)" inputMode="decimal" value={powerKw} onChange={(event) => { setPowerKw(event.target.value); setDirty(true); }} placeholder="např. 2" />
                  <span className="fieldHint">kW</span>
                </span>
                {powerProblem && <small className="fieldWarning">{powerProblem}</small>}
              </EditRow>
            )}
            {/* Recommended parameters of the category (category administration) — always optional. */}
            {recommendedTemplates.map((parameter) => {
              const key = recommendedParameterKey(parameter);
              return (
                <EditRow key={parameter.id} label={parameter.unit ? `${parameter.name} (${parameter.unit})` : parameter.name}>
                  <input
                    aria-label={key}
                    inputMode={parameter.valueType === "number" ? "decimal" : undefined}
                    value={parameterStore.find((entry) => entry.key === key)?.value ?? ""}
                    onChange={(event) => setParameterStore(setParameterValue(parameterStore, key, event.target.value))}
                    placeholder={parameter.valueType === "number" ? "číslo (nepovinné)" : "nepovinné"}
                  />
                </EditRow>
              );
            })}
            {/* The card's own parameters (and historical values of renamed / deactivated recommended parameters). */}
            {parameterStore.map((param, index) => recommendedKeys.has(param.key) ? null : (
              <EditRow key={index} label="Vlastní parametr">
                <span className="inlineFieldWithAction">
                  <input aria-label="Název parametru" value={param.key} onChange={(event) => setParameterStore(parameterStore.map((entry, entryIndex) => entryIndex === index ? { ...entry, key: event.target.value } : entry))} placeholder="Název (např. napětí)" />
                  <input aria-label="Hodnota parametru" value={param.value} onChange={(event) => setParameterStore(parameterStore.map((entry, entryIndex) => entryIndex === index ? { ...entry, value: event.target.value } : entry))} placeholder="Hodnota (např. 230 V)" />
                  <button type="button" className="secondaryButton" onClick={() => setParameterStore(parameterStore.filter((_, entryIndex) => entryIndex !== index))}>Odebrat</button>
                </span>
              </EditRow>
            ))}
          </dl>
          <div className="assetActions">
            <button type="button" className="secondaryButton" onClick={() => setParameterStore([...parameterStore, { key: "", value: "" }])}>+ Přidat parametr</button>
          </div>
          {parametersProblem && <small className="fieldWarning">{parametersProblem}</small>}
          <p className="fieldHint">Vše se uloží tlačítkem Uložit spolu s ostatními údaji karty. Nevyplněné parametry nejsou povinné.</p>
        </section>

        {CAPABILITY_TOGGLE_KINDS.includes(item.kind) && (
          <section className="catalogDetailSection">
            <h3>Použití v generátoru</h3>
            <label className="checkboxRow">
              <input type="checkbox" checked={showIn2D} onChange={(event) => { setShowIn2D(event.target.checked); setDirty(true); }} />
              2D
            </label>
            {showIn2D && (
              <p className="capabilityStatus">
                <strong>2D:</strong> ✓ Zapnuto — Footprint: {footprint2D ? FOOTPRINT_SHAPE_LABELS_CS[footprint2D.shape] : "Chybí"}
              </p>
            )}
            <label className="checkboxRow">
              <input type="checkbox" checked={showIn3D} onChange={(event) => { setShowIn3D(event.target.checked); setDirty(true); }} />
              3D
            </label>
            {showIn3D && (
              <p className="capabilityStatus">
                <strong>3D:</strong> ✓ Zapnuto — Model: {hasModel ? "Nahrán" : "Chybí"}
              </p>
            )}
            <p className="fieldHint">
              {SCENE_CAPABILITY_KINDS.includes(item.kind)
                ? 'Aspoň jedno zaškrtnutí je nutné pro generator readiness (jinak "Chybí nastavení zobrazení ve 2D/3D"). Zobrazení ve 3D vyžaduje nahraný 3D model.'
                : "U služby 2D/3D jen určuje, které přílohy karta nabízí (bez 3D se nenabízí GLB). Připravenost služby na nich nezávisí."}
              {" "}Vypnutí 3D žádný soubor nemaže.
            </p>
          </section>
        )}

        <section className="catalogDetailSection">
          <h3>Lifecycle</h3>
          <dl>
            <Row label="Stav" value={CATALOG_ITEM_STATUS_LABELS_CS[item.lifecycleStatus]} />
            <Row label="Naposledy uloženo" value={new Date(item.updatedAt).toLocaleString("cs-CZ")} />
            <Row label="Zkontrolováno" value={reviewedAt ? new Date(reviewedAt).toLocaleString("cs-CZ") : "Zatím nezkontrolováno"} />
            <Row label="Generator" value={generatorEligible ? "Připraveno" : "Nepřipraveno"} />
          </dl>
          {!readiness.ready && (
            <div className="readinessIssues">
              <strong>Chybí:</strong>
              <ul>
                {readiness.issues.map((issue) => <li key={issue}>{READINESS_ISSUE_LABELS_CS[issue]}</li>)}
              </ul>
            </div>
          )}
          <div className="catalogAdminReviewActions">
            <button type="button" className="secondaryButton" onClick={handleMarkReviewed} disabled={reviewBusy}>
              {reviewBusy ? "Označuji…" : "Označit jako zkontrolované"}
            </button>
            {item.lifecycleStatus !== "active" && item.lifecycleStatus !== "archived" && (
              <button
                type="button"
                className="primaryButton"
                onClick={handleActivate}
                disabled={!readiness.ready || busy !== "idle"}
                title={!readiness.ready ? "Nelze aktivovat — položka nesplňuje readiness pravidla pro generátor." : undefined}
              >
                {busy === "activating" ? "Aktivuji…" : "Aktivovat"}
              </button>
            )}
            {onDuplicate && (
              <button type="button" className="secondaryButton" onClick={() => void handleDuplicateClick()} disabled={duplicateBusy} title="Vytvoří novou kartu (K doplnění) se stejným obsahem — bez kódů, cen a provenance.">
                {duplicateBusy ? "Duplikuji…" : "Duplikovat"}
              </button>
            )}
            {item.lifecycleStatus === "archived" ? (
              <button type="button" className="secondaryButton" onClick={handleRestore} disabled={archiveBusy} title="Vrátí položku do stavu před archivací; dříve aktivní položka se vrátí jako aktivní jen pokud stále splňuje readiness, jinak K doplnění.">
                {archiveBusy ? "Obnovuji…" : "Obnovit"}
              </button>
            ) : (
              <button type="button" className="dangerText" onClick={handleArchive} disabled={archiveBusy} title="Skryje položku z výchozího seznamu, zachová všechna data (ceny, assety, mappings, provenance). Nemaže nic.">
                {archiveBusy ? "Archivuji…" : "Archivovat"}
              </button>
            )}
          </div>
          {reviewError && <small className="uploadError">{reviewError}</small>}
          {archiveError && <small className="uploadError">{archiveError}</small>}
        </section>

        <CatalogBatchUpload
          ownerId={ownerId}
          hasMainPhoto={hasPhoto}
          hasModel={batchHasModel}
          modelAllowed={batchModelAllowed}
          cadAllowed={batchCadAllowed}
          documentsAllowed={batchDocumentsAllowed}
          currentMainPhoto={photoAsset}
          formDirty={dirty}
          onSave={onSave}
        />

        <section className="catalogDetailSection">
          <h3>Fotografie</h3>
          <dl>
            <Row label="Stav" value={hasPhoto ? "Fotografie existuje" : "Fotografie chybí"} />
            <Row label="Hlavní fotografie" value={photoAsset?.originalFileName ?? (legacyPhotoUrl ? legacyPhotoUrl.split("/").pop() : undefined)} />
            <Row label="Další fotografie" value={galleryPhotos.length ? `${galleryPhotos.length} v galerii` : "žádné"} />
          </dl>
          {photoResolved.url && <figure className="catalogMainPhoto"><img className="catalogPhotoPreview" src={photoResolved.url} alt={`Fotografie ${item.displayName}`} /><figcaption>Hlavní fotografie</figcaption></figure>}
          {galleryPhotos.length > 0 && (
            <ul className="catalogGallery">
              {galleryPhotos.map((photo) => (
                <GalleryPhoto
                  key={photo.id}
                  photo={photo}
                  busy={galleryBusyId === photo.id}
                  onPromote={() => void handleGalleryAction(photo.id, { promoteGalleryPhotoAssetId: photo.id })}
                  onRemove={() => void handleGalleryAction(photo.id, { removeGalleryPhotoAssetId: photo.id })}
                />
              ))}
            </ul>
          )}
          <div className="assetActions">
            <label className="smallUploadButton">
              {hasPhoto ? "Nahradit" : "Nahrát"}
              <input
                type="file"
                accept={PHOTO_ACCEPT}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handlePhotoUpload(file);
                }}
              />
            </label>
            {photoAsset && (
              <button type="button" className="dangerText" onClick={handlePhotoRemove} disabled={photoProgress?.state === "uploading"}>
                Odebrat referenci
              </button>
            )}
          </div>
          {photoProgress && (
            <div className={`assetUploadState ${photoProgress.state}`}>
              <progress max="100" value={photoProgress.percent} />
              <span>{photoProgress.state === "uploading" ? `Nahrávám ${photoProgress.percent} %` : photoProgress.state === "success" ? "Nahráno do R2" : photoProgress.message}</span>
            </div>
          )}
          {photoActionError && <small className="uploadError">{photoActionError}</small>}
        </section>

        {/* See isVariantBooth above — a multi-variant type-booth line has no parent-level
            runtime model at all; showing "Nahrát GLB" here would upload an asset nothing ever
            reads. A booth WITHOUT variants (P86, P87, ...) keeps this section as before. */}
        {!isVariantBooth && model3DMode && (
        <section className="catalogDetailSection">
          <h3>3D model</h3>
          <dl>
            <Row label="Stav" value={hasModel ? "Model existuje" : "3D model chybí"} />
            <Row label="Soubor" value={effectiveModel?.fileName} />
          </dl>
          <div className="assetActions">
            <label className="smallUploadButton">
              {hasModel ? "Nahradit GLB" : "Nahrát GLB"}
              <input
                type="file"
                accept=".glb"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handleModelUpload(file);
                }}
              />
            </label>
            {modelAsset && (
              <button type="button" className="dangerText" onClick={handleModelRemove} disabled={modelProgress?.state === "uploading"}>
                Odebrat referenci
              </button>
            )}
          </div>
          {modelProgress && (
            <div className={`assetUploadState ${modelProgress.state}`}>
              <progress max="100" value={modelProgress.percent} />
              <span>{modelProgress.state === "uploading" ? `Nahrávám ${modelProgress.percent} %` : modelProgress.state === "success" ? "Nahráno do R2" : modelProgress.message}</span>
            </div>
          )}
          {modelActionError && <small className="uploadError">{modelActionError}</small>}
        </section>
        )}

        {isVariantBooth && (
          <section className="catalogDetailSection">
            <h3>Varianty</h3>
            <p className="fieldHint">
              Tato typová řada má {documentVariants(itemDocument).length} varianty — každá má vlastní GLB a fotografii, nezávislé na ostatních variantách i na fotografii typové řady výše.
            </p>
            <div className="variantList">
              {documentVariants(itemDocument).map((variant) => (
                <VariantRow key={variant.id} variant={variant} ownerId={`${ownerId}-${variant.id}`} onSave={onSave} />
              ))}
            </div>
          </section>
        )}

        {/* See isVariantBooth above — a multi-variant type-booth line's SKP/DWG/DXF/PDF/Other
            files belong to each variant individually (see the "Varianty" section below), never
            to the parent; showing this section here would be confusing/orphaned data. */}
        {SOURCE_ASSET_APPLICABLE_KINDS.includes(item.kind) && !isVariantBooth && cadMode && (
        <section className="catalogDetailSection">
          <h3>Zdrojové a výrobní soubory</h3>
          <dl>
            <Row label="SKP (zdrojový soubor)" value={hasSketchupSource ? "Nahrán" : "Chybí"} />
          </dl>
          {cadSourceAssets.length > 0 && (
            <ul className="sourceAssetList">
              {cadSourceAssets.map((entry) => (
                <li key={entry.id} className="sourceAssetListItem">
                  <span className="sourceAssetKindBadge">{SOURCE_ASSET_KIND_LABELS_CS[entry.kind]}</span>
                  <span>{entry.label || entry.asset.originalFileName}</span>
                  <button type="button" className="dangerText" onClick={() => handleSourceAssetRemove(entry)} disabled={sourceAssetRemovingId === entry.id}>
                    {sourceAssetRemovingId === entry.id ? "Odebírám…" : "Odebrat referenci"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="assetActions">
            <select value={sourceAssetKind} onChange={(event) => setSourceAssetKind(event.target.value as SourceAssetKind)}>
              {SOURCE_ASSET_KINDS.filter((kind) => kind !== "pdf").map((kind) => (
                <option key={kind} value={kind}>{SOURCE_ASSET_KIND_LABELS_CS[kind]}</option>
              ))}
            </select>
            <label className="smallUploadButton">
              {sourceAssetKind === "sketchup" ? "Nahrát SKP" : "Nahrát soubor"}
              <input
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handleSourceAssetUpload(file);
                }}
              />
            </label>
          </div>
          {sourceAssetProgress && (
            <div className={`assetUploadState ${sourceAssetProgress.state}`}>
              <progress max="100" value={sourceAssetProgress.percent} />
              <span>{sourceAssetProgress.state === "uploading" ? `Nahrávám ${sourceAssetProgress.percent} %` : sourceAssetProgress.state === "success" ? "Nahráno do R2" : sourceAssetProgress.message}</span>
            </div>
          )}
          {sourceAssetActionError && <small className="uploadError">{sourceAssetActionError}</small>}
          <p className="fieldHint">
            {item.kind === "booth_component"
              ? "SKP je u komponent stánku povinný pro aktivaci (spolu s GLB)."
              : "SKP je evidence/výrobní podklad — u tohoto druhu položky není pro aktivaci povinný."}
            {" "}DWG, DXF, PDF a Ostatní nejsou nikdy vyžadované — jejich chybějící přítomnost aktivaci neblokuje.
          </p>
        </section>
        )}

        {!isVariantBooth && <CatalogDocumentsSection entries={documentAssets} ownerId={ownerId} onSave={onSave} />}

        {!isVariantBooth && (
          <CatalogHiddenAttachments
            model={!model3DMode && effectiveModel ? { fileName: effectiveModel.fileName ?? modelAsset?.originalFileName ?? "3D model", ...(modelAsset ? { asset: modelAsset } : {}) } : undefined}
            sources={cadMode ? [] : cadSourceAssets}
          />
        )}

        <CatalogCardPrices
          refreshKey={item.updatedAt}
          catalogItemId={item.id}
          itemFilter={item.abfCode ?? item.internalCode ?? item.displayName}
          legacy={pricing}
          onOpenPriceVersion={onOpenPriceVersion}
          onOpenLegacyPricing={onOpenPricing}
        />

        <CatalogPublicationSection item={item} ownerId={ownerId} onSave={onSave} />
        {aliasRegister && onSaveAliases && <CatalogAliasesSection key={item.id} item={item} register={aliasRegister} onSave={onSaveAliases} />}
        {!aliasRegister && aliasLoadError && <p className="uploadError">{aliasLoadError}</p>}
        {(currentItemType === "BOOTH" || currentItemType === "KIT") && onSavePackage && allItems && (
          <KitContentsSection item={item} allItems={allItems} variantSets={variantSets ?? []} onSavePackage={onSavePackage} />
        )}
        <TechnicalRasterSection item={item} ownerId={ownerId} onSave={onSave} />
      </div>
    </div>
  );
}

// ============================================================================
// TECHNICKÉ RASTRY (spec batch 11) — per-component override of
// domain/technicalRasterServicePresentation.ts's central defaults, via the
// domain/technicalRasterComponentPresentation.ts adapter (spec batch 10). A completely
// self-contained, independently-saved section (own local state, own "Uložit" action — same
// discipline as the Fotografie/3D model sections above, never mixed into the parent form's own
// dirty/buildEdit()) so it can never accidentally touch anything else. NOT wired into the real
// Technické rastry placement/render/export pipeline (see this module's own doc) — this section
// only reads/writes domain/catalogItemsAdmin.ts's `document.technicalRaster` and previews it.
// ============================================================================

const TECHNICAL_RASTER_PLACEMENT_OPTIONS: readonly Readonly<{ value: "" | TechnicalServicePlacementBehavior; label: string }>[] = [
  { value: "", label: "Automaticky (podle výchozích pravidel)" },
  { value: "point", label: "Bod v rastru" },
  { value: "informational", label: "Informační" },
  { value: "none", label: "Bez umístění" },
];

/** Simplified UI concept (spec batch 11 section 6: "běžný uživatel nemusí rozumět názvům rendererů") — maps onto the real, closed TechnicalServiceSymbolRenderer union only for the ONE case this V1 exposes ("Text" -> "textLabel"). Automatická/undefined leaves the central resolver's own renderer choice (powerLabel/refrigeratedStar/wifiIcon/waterDrop/fallback) untouched. "Ikona" is deliberately NOT offered as a renderer choice yet — see the section's own fieldHint for why. */
type TechnicalRasterRendererChoice = "" | "text";

function summarizeTechnicalRasterConfig(config: TechnicalRasterComponentConfig | undefined): string {
  if (!config || Object.keys(config).length === 0) return "Nenastaveno — používá výchozí pravidla";
  if (config.enabled === false) return "Skryto v rastru";
  const parts: string[] = [];
  const placementLabel = TECHNICAL_RASTER_PLACEMENT_OPTIONS.find((option) => option.value === config.placementBehavior)?.label;
  if (config.placementBehavior) parts.push(placementLabel ?? config.placementBehavior);
  if (config.displayLabel) parts.push(config.displayLabel);
  if (config.color) parts.push(config.color);
  if (config.iconAsset) parts.push("vlastní ikona");
  return parts.length > 0 ? parts.join(" • ") : "Nastaveno (bez konkrétních hodnot)";
}

/** A small, self-contained live preview — deliberately its OWN minimal renderer, not an import from components/workflow/technicalRasters/* (that whole module is explicitly protected this batch). Shows exactly what's been explicitly configured; unset fields render as an honest neutral placeholder rather than a fabricated "resolved" central value (a catalog component has no single real report category/label to resolve central defaults against). */
function TechnicalRasterPreview({ config, iconUrl }: { config: TechnicalRasterComponentConfig | undefined; iconUrl: string | undefined }) {
  const hidden = config?.enabled === false;
  const color = config?.color ?? "#6b6f72";
  return (
    <div className="technicalRasterConfigPreview">
      <div className={hidden ? "technicalRasterConfigPreviewDot hidden" : "technicalRasterConfigPreviewDot"} style={{ background: hidden ? "#c7c9cb" : color }}>
        {!hidden && iconUrl ? (
          <img src={iconUrl} alt="" className="technicalRasterConfigPreviewIcon" />
        ) : (
          <span>{hidden ? "—" : (config?.displayLabel ?? "?")}</span>
        )}
      </div>
      <div className="technicalRasterConfigPreviewCaption">
        {hidden ? "Skryto v rastru" : (config?.legendLabel ?? "Bez textu legendy")}
      </div>
    </div>
  );
}

function TechnicalRasterSection({
  item,
  ownerId,
  onSave,
}: {
  item: CatalogItemAdmin;
  ownerId: string;
  onSave: (edit: CatalogItemAdminEdit) => Promise<void>;
}) {
  const existingConfig = documentTechnicalRaster(item.document);

  const [enabledChoice, setEnabledChoice] = useState<"" | "true" | "false">(existingConfig?.enabled === true ? "true" : existingConfig?.enabled === false ? "false" : "");
  const [placementBehaviorChoice, setPlacementBehaviorChoice] = useState<"" | TechnicalServicePlacementBehavior>(existingConfig?.placementBehavior ?? "");
  const [rendererChoice, setRendererChoice] = useState<TechnicalRasterRendererChoice>(existingConfig?.renderer === "textLabel" ? "text" : "");
  const [displayLabel, setDisplayLabel] = useState(existingConfig?.displayLabel ?? "");
  const [color, setColor] = useState(existingConfig?.color ?? "");
  const [legendLabel, setLegendLabel] = useState(existingConfig?.legendLabel ?? "");
  const [iconAsset, setIconAsset] = useState<StoredAsset | undefined>(existingConfig?.iconAsset);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [iconProgress, setIconProgress] = useState<UploadProgress | undefined>(undefined);
  const [iconError, setIconError] = useState("");

  const iconResolved = useAssetUrl(iconAsset, undefined);

  function buildConfig(): TechnicalRasterComponentConfig | undefined {
    const config: { -readonly [K in keyof TechnicalRasterComponentConfig]?: TechnicalRasterComponentConfig[K] } = {};
    if (enabledChoice === "true") config.enabled = true;
    else if (enabledChoice === "false") config.enabled = false;
    if (placementBehaviorChoice) config.placementBehavior = placementBehaviorChoice;
    if (rendererChoice === "text") config.renderer = "textLabel";
    if (displayLabel.trim()) config.displayLabel = displayLabel.trim();
    if (color.trim()) config.color = color.trim();
    if (legendLabel.trim()) config.legendLabel = legendLabel.trim();
    if (iconAsset) config.iconAsset = iconAsset;
    return Object.keys(config).length > 0 ? config : undefined;
  }

  const draftConfig = buildConfig();
  // Section 19: comparing the DRAFT against what's actually persisted — opening the card and
  // saving without touching anything must never create/change an override. A plain JSON compare
  // is sufficient here (both sides are small, flat-ish, whitelisted objects).
  const dirty = JSON.stringify(draftConfig ?? null) !== JSON.stringify(existingConfig ?? null);

  async function handleSaveClick() {
    setBusy(true);
    setError("");
    try {
      await onSave({ technicalRaster: draftConfig ?? null });
    } catch (saveError) {
      setError(
        saveError instanceof ConcurrencyConflictError
          ? "Data byla mezitím změněna jinde. Obnovte stránku před uložením."
          : saveError instanceof Error ? saveError.message : "Uložení se nezdařilo.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleResetClick() {
    setBusy(true);
    setError("");
    try {
      await onSave({ technicalRaster: null });
      setEnabledChoice("");
      setPlacementBehaviorChoice("");
      setRendererChoice("");
      setDisplayLabel("");
      setColor("");
      setLegendLabel("");
      setIconAsset(undefined);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Obnovení výchozích hodnot se nezdařilo.");
    } finally {
      setBusy(false);
    }
  }

  // Icon upload/remove is immediate (mirrors Fotografie/3D model above) — always saved against the
  // LAST PERSISTED config, never the user's currently-unsaved draft of the other fields, so
  // uploading an icon can never accidentally commit an in-progress, not-yet-reviewed text/color edit.
  async function handleIconUpload(file: File) {
    setIconError("");
    if (file.size === 0) { setIconError("Soubor je prázdný."); return; }
    if (!hasAllowedExtension(file.name, TECHNICAL_ICON_EXTENSIONS)) { setIconError("Podporované formáty: SVG, PNG."); return; }
    try {
      const asset = await uploadAsset(file, { category: "catalog-technical-icon", ownerId }, setIconProgress);
      await onSave({ technicalRaster: { ...existingConfig, iconAsset: asset } });
      setIconAsset(asset);
    } catch (uploadError) {
      setIconError(uploadError instanceof Error ? uploadError.message : "Nahrání ikony selhalo.");
    }
  }

  async function handleIconRemove() {
    setIconError("");
    try {
      // Metadata-only reference removal — the underlying R2 object is never deleted here (no
      // reference-count lifecycle exists yet, spec section 15 — same discipline as photoAsset/
      // modelAsset removal elsewhere in this file).
      const { iconAsset: _unused, ...rest } = existingConfig ?? {};
      await onSave({ technicalRaster: Object.keys(rest).length > 0 ? rest : null });
      setIconAsset(undefined);
    } catch (removeError) {
      setIconError(removeError instanceof Error ? removeError.message : "Odebrání ikony selhalo.");
    }
  }

  return (
    <details className="catalogDetailSection technicalRasterConfigSection">
      <summary>
        <h3>Technické rastry</h3>
        <span className="fieldHint">{summarizeTechnicalRasterConfig(existingConfig)}</span>
      </summary>

      <p className="fieldHint">
        Tato sekce jen PŘIPRAVUJE prezentaci pro technické rastry (barva/text/ikona/legenda) — technický resolver, který o barvě/typu značky rozhoduje jako výchozí, zůstává
        {" "}<code>domain/technicalRasterServicePresentation.ts</code>. Bez jakéhokoli nastavení zde se aplikace chová přesně jako dnes.
      </p>

      <dl>
        <EditRow label="Zobrazovat v technickém rastru">
          <select value={enabledChoice} onChange={(event) => setEnabledChoice(event.target.value as "" | "true" | "false")}>
            <option value="">Automaticky</option>
            <option value="true">Ano</option>
            <option value="false">Ne</option>
          </select>
        </EditRow>
        <EditRow label="Způsob umístění">
          <select value={placementBehaviorChoice} onChange={(event) => setPlacementBehaviorChoice(event.target.value as "" | TechnicalServicePlacementBehavior)}>
            {TECHNICAL_RASTER_PLACEMENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </EditRow>
        <EditRow label="Typ značky">
          <select value={rendererChoice} onChange={(event) => setRendererChoice(event.target.value as TechnicalRasterRendererChoice)}>
            <option value="">Automatická</option>
            <option value="text">Text</option>
          </select>
        </EditRow>
        <EditRow label="Krátký text">
          <input value={displayLabel} onChange={(event) => setDisplayLabel(event.target.value)} placeholder="Automaticky" maxLength={16} />
        </EditRow>
        <EditRow label="Barva">
          <span className="technicalRasterColorInput">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#6b6f72"}
              onChange={(event) => setColor(event.target.value)}
            />
            <input value={color} onChange={(event) => setColor(event.target.value)} placeholder="Automaticky (#RRGGBB)" />
          </span>
        </EditRow>
        <EditRow label="Legenda">
          <input value={legendLabel} onChange={(event) => setLegendLabel(event.target.value)} placeholder="Automaticky" maxLength={80} />
        </EditRow>
      </dl>

      <div className="technicalRasterIconRow">
        <div>
          <strong>Ikona</strong>
          {iconAsset && <p className="fieldHint">{iconAsset.originalFileName}</p>}
          {!iconAsset && <p className="fieldHint">Není nahrána — použije se text/automatická značka.</p>}
        </div>
        {iconResolved.url && <img src={iconResolved.url} alt="" className="technicalRasterIconPreview" />}
        <div className="assetActions">
          <label className="smallUploadButton">
            {iconAsset ? "Nahradit" : "Nahrát"}
            <input type="file" accept={TECHNICAL_ICON_ACCEPT} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void handleIconUpload(file); }} />
          </label>
          {iconAsset && <button type="button" className="dangerText" onClick={() => void handleIconRemove()} disabled={iconProgress?.state === "uploading"}>Odebrat referenci</button>}
        </div>
      </div>
      {iconProgress && (
        <div className={`assetUploadState ${iconProgress.state}`}>
          <progress max="100" value={iconProgress.percent} />
          <span>{iconProgress.state === "uploading" ? `Nahrávám ${iconProgress.percent} %` : iconProgress.state === "success" ? "Nahráno do R2" : iconProgress.message}</span>
        </div>
      )}
      {iconError && <small className="uploadError">{iconError}</small>}
      <p className="fieldHint">
        SVG je preferováno (zůstává vektorové i ve vektorovém PDF exportu tam, kde to lze). PNG je povolený fallback — ve výstupním PDF se vloží jako samostatný malý obrázek (vlastní rastr haly zůstává vektorový beze změny), takže může ztratit část ostrosti při extrémním přiblížení.
        {" "}Vykreslení vlastní ikony v samotném rastru/exportu zatím není zapojeno — tato sekce ji zatím pouze ukládá a zobrazuje v náhledu.
      </p>

      <TechnicalRasterPreview config={draftConfig} iconUrl={iconResolved.url} />

      <div className="assetActions">
        <button type="button" className="primaryButton" onClick={() => void handleSaveClick()} disabled={!dirty || busy}>
          {busy ? "Ukládám…" : "Uložit technické rastry"}
        </button>
        <button type="button" className="secondaryButton" onClick={() => void handleResetClick()} disabled={busy || !existingConfig}>
          Obnovit výchozí nastavení
        </button>
      </div>
      {error && <small className="uploadError">{error}</small>}
    </details>
  );
}

/**
 * One row of the "Varianty" section — uploads/removes GLB and photo for exactly ONE variant of a
 * multi-variant type-booth line (T04..T25), by its stable id. Reuses the same uploadAsset/
 * useAssetUrl infrastructure as the parent photo/GLB sections above — never a second/parallel
 * upload system. Never creates/removes a variant itself (that's the canonical migration script's
 * job, not the admin edit form).
 */
function VariantRow({
  variant,
  ownerId,
  onSave,
}: {
  variant: BoothVariant;
  ownerId: string;
  onSave: (edit: CatalogItemAdminEdit) => Promise<void>;
}) {
  const hasModel = variantHas3DAsset(variant);
  const hasSketchupSource = variantHasSketchupSource(variant);
  const photoResolved = useAssetUrl(variant.photoAsset, undefined);
  const [modelProgress, setModelProgress] = useState<UploadProgress | undefined>(undefined);
  const [modelError, setModelError] = useState("");
  const [photoProgress, setPhotoProgress] = useState<UploadProgress | undefined>(undefined);
  const [photoError, setPhotoError] = useState("");
  const [sourceAssetKind, setSourceAssetKind] = useState<SourceAssetKind>("sketchup");
  const [sourceAssetProgress, setSourceAssetProgress] = useState<UploadProgress | undefined>(undefined);
  const [sourceAssetError, setSourceAssetError] = useState("");
  const [sourceAssetRemovingId, setSourceAssetRemovingId] = useState<string | undefined>(undefined);
  const sourceAssets = variant.sourceAssets ?? [];

  async function handleModelUpload(file: File) {
    setModelError("");
    if (file.size === 0) { setModelError("Soubor je prázdný."); return; }
    if (!hasAllowedExtension(file.name, MODEL_EXTENSIONS)) { setModelError("Podporovaný formát: pouze .glb."); return; }
    try {
      const asset = await uploadAsset(file, { category: "catalog-model", ownerId }, setModelProgress);
      await onSave({ setVariantModelAsset: { variantId: variant.id, asset } });
    } catch (uploadError) {
      setModelError(uploadError instanceof Error ? uploadError.message : "Nahrání 3D modelu selhalo.");
    }
  }

  async function handleModelRemove() {
    setModelError("");
    try {
      await onSave({ setVariantModelAsset: { variantId: variant.id, asset: null } });
    } catch (removeError) {
      setModelError(removeError instanceof Error ? removeError.message : "Odebrání 3D modelu selhalo.");
    }
  }

  async function handlePhotoUpload(file: File) {
    setPhotoError("");
    if (file.size === 0) { setPhotoError("Soubor je prázdný."); return; }
    if (!hasAllowedExtension(file.name, PHOTO_EXTENSIONS)) { setPhotoError("Podporované formáty: jpg, jpeg, png, webp."); return; }
    try {
      const asset = await uploadAsset(file, { category: "catalog-photo", ownerId }, setPhotoProgress);
      await onSave({ setVariantPhotoAsset: { variantId: variant.id, asset } });
    } catch (uploadError) {
      setPhotoError(uploadError instanceof Error ? uploadError.message : "Nahrání fotografie selhalo.");
    }
  }

  async function handlePhotoRemove() {
    setPhotoError("");
    try {
      await onSave({ setVariantPhotoAsset: { variantId: variant.id, asset: null } });
    } catch (removeError) {
      setPhotoError(removeError instanceof Error ? removeError.message : "Odebrání fotografie selhalo.");
    }
  }

  async function handleSourceAssetUpload(file: File) {
    setSourceAssetError("");
    if (file.size === 0) { setSourceAssetError("Soubor je prázdný."); return; }
    const allowed = SOURCE_ASSET_KIND_EXTENSIONS[sourceAssetKind];
    if (allowed.length > 0 && !hasAllowedExtension(file.name, allowed)) {
      setSourceAssetError(`Zvolený typ (${SOURCE_ASSET_KIND_LABELS_CS[sourceAssetKind]}) očekává příponu: ${allowed.join(", ")}.`);
      return;
    }
    try {
      const asset = await uploadAsset(file, { category: "catalog-source", ownerId }, setSourceAssetProgress);
      await onSave({ addVariantSourceAsset: { variantId: variant.id, kind: sourceAssetKind, asset } });
    } catch (uploadError) {
      setSourceAssetError(uploadError instanceof Error ? uploadError.message : "Nahrání souboru selhalo.");
    }
  }

  async function handleSourceAssetRemove(entry: SourceAssetEntry) {
    setSourceAssetError("");
    setSourceAssetRemovingId(entry.id);
    try {
      await onSave({ removeVariantSourceAssetId: { variantId: variant.id, sourceAssetId: entry.id } });
    } catch (removeError) {
      setSourceAssetError(removeError instanceof Error ? removeError.message : "Odebrání souboru selhalo.");
    } finally {
      setSourceAssetRemovingId(undefined);
    }
  }

  return (
    <div className="variantRow">
      <div className="variantRowHeader">
        <strong>{variant.name}</strong>
        <span className={`readinessBadge ${hasModel ? "ready" : "blocked"}`}>{hasModel ? "GLB nahráno" : "GLB chybí"}</span>
        <span className={`readinessBadge ${hasSketchupSource ? "ready" : "blocked"}`}>{hasSketchupSource ? "SKP nahrán" : "SKP chybí"}</span>
      </div>
      {photoResolved.url && <img className="catalogPhotoPreview" src={photoResolved.url} alt={`Fotografie ${variant.name}`} />}
      <div className="assetActions">
        <label className="smallUploadButton">
          {hasModel ? "Nahradit GLB" : "Nahrát GLB"}
          <input type="file" accept=".glb" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void handleModelUpload(file); }} />
        </label>
        {variant.modelAsset && (
          <button type="button" className="dangerText" onClick={handleModelRemove} disabled={modelProgress?.state === "uploading"}>Odebrat GLB</button>
        )}
        <label className="smallUploadButton">
          {variant.photoAsset ? "Nahradit foto" : "Nahrát foto"}
          <input type="file" accept={PHOTO_ACCEPT} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void handlePhotoUpload(file); }} />
        </label>
        {variant.photoAsset && (
          <button type="button" className="dangerText" onClick={handlePhotoRemove} disabled={photoProgress?.state === "uploading"}>Odebrat foto</button>
        )}
      </div>
      {modelProgress && (
        <div className={`assetUploadState ${modelProgress.state}`}>
          <progress max="100" value={modelProgress.percent} />
          <span>{modelProgress.state === "uploading" ? `Nahrávám ${modelProgress.percent} %` : modelProgress.state === "success" ? "Nahráno do R2" : modelProgress.message}</span>
        </div>
      )}
      {modelError && <small className="uploadError">{modelError}</small>}
      {photoProgress && (
        <div className={`assetUploadState ${photoProgress.state}`}>
          <progress max="100" value={photoProgress.percent} />
          <span>{photoProgress.state === "uploading" ? `Nahrávám ${photoProgress.percent} %` : photoProgress.state === "success" ? "Nahráno do R2" : photoProgress.message}</span>
        </div>
      )}
      {photoError && <small className="uploadError">{photoError}</small>}

      <div className="variantSourceAssets">
        {sourceAssets.length > 0 && (
          <ul className="sourceAssetList">
            {sourceAssets.map((entry) => (
              <li key={entry.id} className="sourceAssetListItem">
                <span className="sourceAssetKindBadge">{SOURCE_ASSET_KIND_LABELS_CS[entry.kind]}</span>
                <span>{entry.label || entry.asset.originalFileName}</span>
                <button type="button" className="dangerText" onClick={() => handleSourceAssetRemove(entry)} disabled={sourceAssetRemovingId === entry.id}>
                  {sourceAssetRemovingId === entry.id ? "Odebírám…" : "Odebrat referenci"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="assetActions">
          <select value={sourceAssetKind} onChange={(event) => setSourceAssetKind(event.target.value as SourceAssetKind)}>
            {SOURCE_ASSET_KINDS.map((kind) => (
              <option key={kind} value={kind}>{SOURCE_ASSET_KIND_LABELS_CS[kind]}</option>
            ))}
          </select>
          <label className="smallUploadButton">
            {sourceAssetKind === "sketchup" ? "Nahrát SKP" : "Nahrát soubor"}
            <input
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleSourceAssetUpload(file);
              }}
            />
          </label>
        </div>
        {sourceAssetProgress && (
          <div className={`assetUploadState ${sourceAssetProgress.state}`}>
            <progress max="100" value={sourceAssetProgress.percent} />
            <span>{sourceAssetProgress.state === "uploading" ? `Nahrávám ${sourceAssetProgress.percent} %` : sourceAssetProgress.state === "success" ? "Nahráno do R2" : sourceAssetProgress.message}</span>
          </div>
        )}
        {sourceAssetError && <small className="uploadError">{sourceAssetError}</small>}
        <p className="fieldHint">SKP je u variant typové řady povinný pro aktivaci (spolu s GLB). DWG, DXF, PDF a Ostatní nejsou nikdy vyžadované.</p>
      </div>
    </div>
  );
}

function codesMatch(internalCode: string, abfCode: string | null | undefined): boolean {
  return Boolean(abfCode) && abfCode!.trim().toLocaleUpperCase("cs") === internalCode.trim().toLocaleUpperCase("cs");
}

/** Generator code mode, read from the real stored values — the column code is the identity (also when it was taken over from the ABF code). */
function codeModeLabel(internalCode: string, abfCode: string | null | undefined): string {
  if (codesMatch(internalCode, abfCode)) return "stejný jako ABF kód";
  return abfCode ? `vlastní generátorový kód (ABF kód ${abfCode})` : "vlastní generátorový kód";
}

function GalleryPhoto({ photo, busy, onPromote, onRemove }: { photo: StoredAsset; busy: boolean; onPromote: () => void; onRemove: () => void }) {
  const resolved = useAssetUrl(photo, undefined);
  return (
    <li className="catalogGalleryItem">
      {resolved.url ? <img src={resolved.url} alt={photo.originalFileName} /> : <span className="catalogThumbnailPlaceholder" aria-hidden="true" />}
      <small title={photo.originalFileName}>{photo.originalFileName}</small>
      <span className="assetActions">
        <button type="button" className="linkButton" disabled={busy} onClick={onPromote}>Nastavit jako hlavní</button>
        <button type="button" className="dangerText" disabled={busy} onClick={onRemove}>Odebrat</button>
      </span>
    </li>
  );
}

function EditRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="catalogAdminEditRow">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}
