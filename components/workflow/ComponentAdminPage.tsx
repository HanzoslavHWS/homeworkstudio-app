"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  buildCatalogItemListEntry,
  categoryLabelCs,
  computeGeneratorEligibleLive,
  computeReadiness,
  documentBasePricing,
  documentDimensions,
  documentFootprint2D,
  documentHas3DAsset,
  documentModelAsset,
  documentModelUrl,
  documentPhotoAsset,
  documentPhotoUrl,
  documentReviewedAt,
  documentSourceAssets,
  documentSourceTraceability,
  documentVariants,
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
} from "../../domain/catalogItemsAdmin";
import { CATALOG_ITEM_STATUS_LABELS_CS, READINESS_ISSUE_LABELS_CS } from "../../domain/catalogReadiness";
import { CATALOG_ITEM_KINDS, CATALOG_ITEM_STATUSES, type BoothVariant, type CatalogItemKind, type CatalogItemStatus } from "../../domain/models";
import { SOURCE_ASSET_KINDS, SOURCE_ASSET_KIND_EXTENSIONS, SOURCE_ASSET_KIND_LABELS_CS, type SourceAssetEntry, type SourceAssetKind, type StoredAsset } from "../../domain/assets";
import { ConcurrencyConflictError } from "../../lib/db/concurrency";
import type { RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import { uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";

const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const MODEL_EXTENSIONS = ["glb"];

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

function hasAllowedExtension(fileName: string, allowed: readonly string[]): boolean {
  const extension = fileName.toLowerCase().split(".").pop();
  return Boolean(extension) && allowed.includes(extension!);
}

/**
 * Component Administration ("Administrace → Komponenty"), switched from the static
 * data/components.ts seed to the real remote catalog_items table. Deliberately does NOT touch
 * ComponentLibrary.tsx (the generator's component picker) — that stays on the static seed
 * until each imported item is individually reviewed and made generator-eligible.
 */
export function ComponentAdminPage({
  repository,
  onOpenPricing,
}: {
  repository: RemoteApiCatalogItemsAdminRepository;
  /** Section 17 — hands off to the existing Pricing Administration matrix, preselected for one item. Never a second/duplicate price editor. */
  onOpenPricing: (catalogItemId: string) => void;
}) {
  const [items, setItems] = useState<readonly CatalogItemAdmin[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<CatalogItemAdminFilters>({});

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

  // Complete type-booths (kind="booth" — P86, P87, T04..T25) live exclusively under "Knihovna
  // stánků → Typové stánky" (BoothAdminPage.tsx) now — this generic admin view never lists them,
  // so an operator can't accidentally edit a type-booth from the wrong screen. booth_component
  // stays visible here too (it's still a legitimate global-catalog kind), and also has its own
  // "Komponenty stánku" tab in BoothAdminPage.tsx — that intentional dual-visibility is unchanged.
  const nonBoothItems = useMemo(() => (items ?? []).filter((item) => item.kind !== "booth"), [items]);
  const listEntries = useMemo(() => nonBoothItems.map(buildCatalogItemListEntry), [nonBoothItems]);
  // Filter first, then sort the (smaller) result — never the DB/API return order. See
  // domain/catalogItemsAdmin.ts's sortCatalogItemsAdminByName: active items first, then A-Z
  // (cs locale) within each lifecycle group.
  const filteredEntries = useMemo(
    () => sortCatalogItemsAdminByName(filterCatalogItemsAdmin(listEntries, filters)),
    [listEntries, filters],
  );
  const selected = nonBoothItems.find((item) => item.id === selectedId);

  async function handleSave(edit: CatalogItemAdminEdit): Promise<void> {
    if (!selected) return;
    const saved = await repository.save(selected.id, edit, selected.updatedAt);
    setItems((current) => (current ?? []).map((item) => (item.id === saved.id ? saved : item)));
  }

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">ADMINISTRACE</span>
          <h1>Komponenty</h1>
        </div>
        {items && <span className="catalogAdminCount">{filteredEntries.length} / {nonBoothItems.length} položek</span>}
      </div>

      {loadError && <p className="uploadError persistenceBanner">Katalog se nepodařilo načíst z databáze: {loadError}</p>}
      {!items && !loadError && <p className="workspaceEmpty">Načítám katalog z databáze…</p>}

      {items && (
        <>
          <ComponentAdminFilters filters={filters} onChange={setFilters} />
          <div className="adminSplit">
            <ComponentAdminList
              entries={filteredEntries}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
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

/** Renders the shared filter bar for ComponentAdminPage's list (kind=booth is never an option here — type-booths live exclusively in BoothAdminPage.tsx's "Typové stánky" tab). */
export function ComponentAdminFilters({ filters, onChange }: { filters: CatalogItemAdminFilters; onChange: (filters: CatalogItemAdminFilters) => void }) {
  return (
    <div className="adminFilters">
      <input value={filters.query ?? ""} onChange={(event) => onChange({ ...filters, query: event.target.value })} placeholder="Hledat interní kód nebo název…" />
      <select value={filters.kind ?? ""} onChange={(event) => onChange({ ...filters, kind: event.target.value as CatalogItemKind | "" })}>
        <option value="">Kategorie: vše</option>
        {CATALOG_ITEM_KINDS.filter((kind) => kind !== "booth").map((kind) => (
          <option key={kind} value={kind}>{CATALOG_ITEM_KIND_LABELS_CS[kind]}</option>
        ))}
      </select>
      <select value={filters.lifecycleStatus ?? ""} onChange={(event) => onChange({ ...filters, lifecycleStatus: event.target.value as CatalogItemStatus | "" })}>
        <option value="">Stav: vše</option>
        {CATALOG_ITEM_STATUSES.map((status) => (
          <option key={status} value={status}>{CATALOG_ITEM_STATUS_LABELS_CS[status]}</option>
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
        <input type="checkbox" checked={Boolean(filters.showArchived)} onChange={(event) => onChange({ ...filters, showArchived: event.target.checked })} />
        Zobrazit archivované
      </label>
    </div>
  );
}

/** Exported so BoothAdminPage.tsx can reuse the exact same list rendering. */
export function ComponentAdminList({
  entries,
  selectedId,
  onSelect,
}: {
  entries: readonly CatalogItemAdminListEntry[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="adminList catalogAdminTable">
      <div className="catalogAdminRow catalogAdminHeaderRow">
        <span>Náhled</span>
        <span>Interní kód</span>
        <span>Název</span>
        <span>Kategorie / Kind</span>
        <span>Stav</span>
        <span>Rozměry</span>
        <span>3D</span>
        <span>Cena</span>
        <span>Generator</span>
      </div>
      {entries.length === 0 && <p className="workspaceEmpty">Filtrům neodpovídá žádná položka.</p>}
      {entries.map((entry) => (
        <button key={entry.id} type="button" className={`catalogAdminRow ${entry.id === selectedId ? "active" : ""}`} onClick={() => onSelect(entry.id)}>
          <ThumbnailCell photoAsset={entry.photoAsset} photoUrl={entry.photoUrl} label={entry.displayName} />
          <span>{entry.internalCode ?? "—"}</span>
          <span>{entry.displayName}</span>
          <span>{CATALOG_ITEM_KIND_LABELS_CS[entry.kind]}{entry.category ? ` · ${categoryLabelCs(entry.category)}` : ""}</span>
          <span className={`lifecycleBadge ${entry.lifecycleStatus}`}>{CATALOG_ITEM_STATUS_LABELS_CS[entry.lifecycleStatus]}</span>
          <span>{entry.hasDimensions ? `${entry.widthMm} × ${entry.depthMm}${entry.heightMm ? ` × ${entry.heightMm}` : ""} mm` : "Chybí rozměry"}</span>
          <span>{entry.has3DAsset ? "3D ano" : "3D chybí"}</span>
          <span>{entry.basePriceCzk !== null ? `${entry.basePriceCzk.toLocaleString("cs-CZ")} Kč` : "Cena neuvedena"}</span>
          <span className={`readinessBadge ${entry.readiness.ready ? "ready" : "blocked"}`}>{entry.readiness.ready ? "Připraveno" : "Nepřipraveno"}</span>
        </button>
      ))}
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
  onSave,
  onOpenPricing,
}: {
  item: CatalogItemAdmin;
  onSave: (edit: CatalogItemAdminEdit) => Promise<void>;
  onOpenPricing: () => void;
}) {
  const itemDocument = item.document;
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

  const modelAsset = documentModelAsset(itemDocument);
  const legacyModelUrl = documentModelUrl(itemDocument);
  const hasModel = documentHas3DAsset(itemDocument);
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
      await onSave({ lifecycleStatus: "needs_review" });
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
  const [unit, setUnit] = useState(item.unit ?? "");
  const [widthMm, setWidthMm] = useState(initialWidth);
  const [depthMm, setDepthMm] = useState(initialDepth);
  const [heightMm, setHeightMm] = useState(initialHeight);
  const [showIn2D, setShowIn2D] = useState(initialShowIn2D);
  const [showIn3D, setShowIn3D] = useState(initialShowIn3D);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"idle" | "saving" | "activating">("idle");
  const [error, setError] = useState("");

  function buildEdit(): CatalogItemAdminEdit {
    const edit: { -readonly [K in keyof CatalogItemAdminEdit]?: CatalogItemAdminEdit[K] } = {};
    if (displayName !== item.displayName) edit.displayName = displayName;
    if (name !== initialName) edit.name = name;
    if (category !== (item.category ?? "")) edit.category = category;
    if (unit !== (item.unit ?? "")) edit.unit = unit;
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
    return edit;
  }

  async function handleSaveClick() {
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

  return (
    <div className="adminDetail catalogAdminDetail">
      <header className="catalogDetailHeader">
        <span>{item.internalCode ?? "Bez interního kódu"}</span>
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
          <dl>
            <EditRow label="Interní kód"><span className="readOnlyField">{item.internalCode ?? "— (bez potvrzeného kódu)"}</span></EditRow>
            <EditRow label="Zobrazovaný název">
              <input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setDirty(true); }} />
            </EditRow>
            <EditRow label="CZ název (interní)">
              <input value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} />
            </EditRow>
            <EditRow label="EN název"><span className="readOnlyField">Model zatím nepodporuje samostatný anglický název.</span></EditRow>
            <EditRow label="Kind"><span className="readOnlyField">{CATALOG_ITEM_KIND_LABELS_CS[item.kind]}</span></EditRow>
            <EditRow label="Kategorie">
              <select value={category} onChange={(event) => { setCategory(event.target.value); setDirty(true); }}>
                {category && !CATALOG_ITEM_CATEGORY_OPTIONS.some((option) => option.value === category) && (
                  <option value={category}>{category} (nerozpoznaná hodnota, zachována)</option>
                )}
                {!category && <option value="">— nevybráno —</option>}
                {CATALOG_ITEM_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </EditRow>
            <EditRow label="Jednotka">
              <input value={unit} onChange={(event) => { setUnit(event.target.value); setDirty(true); }} />
            </EditRow>
            <Row label="Zdroj (traceability)" value={trace.sourceSystem ? `${trace.sourceSystem} · ${trace.sourceKey ?? "—"}` : "—"} />
          </dl>
        </section>

        <section className="catalogDetailSection">
          <h3>Rozměry</h3>
          <dl>
            <EditRow label="Šířka (mm)">
              <input type="number" value={widthMm} onChange={(event) => { setWidthMm(event.target.value); setDirty(true); }} placeholder="Neznámo" />
            </EditRow>
            <EditRow label="Hloubka (mm)">
              <input type="number" value={depthMm} onChange={(event) => { setDepthMm(event.target.value); setDirty(true); }} placeholder="Neznámo" />
            </EditRow>
            <EditRow label="Výška (mm)">
              <input type="number" value={heightMm} onChange={(event) => { setHeightMm(event.target.value); setDirty(true); }} placeholder="Neznámo" />
            </EditRow>
          </dl>
        </section>

        {SCENE_CAPABILITY_KINDS.includes(item.kind) && (
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
              Aspoň jedno zaškrtnutí je nutné pro generator readiness (jinak "Chybí nastavení zobrazení ve 2D/3D"). Zobrazení ve 3D vyžaduje nahraný 3D model.
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
            {item.lifecycleStatus === "archived" ? (
              <button type="button" className="secondaryButton" onClick={handleRestore} disabled={archiveBusy} title="Vrátí položku do stavu K doplnění — nikdy rovnou Aktivní.">
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

        <section className="catalogDetailSection">
          <h3>Fotografie</h3>
          <dl>
            <Row label="Stav" value={hasPhoto ? "Fotografie existuje" : "Fotografie chybí"} />
            <Row label="Soubor" value={photoAsset?.originalFileName ?? (legacyPhotoUrl ? legacyPhotoUrl.split("/").pop() : undefined)} />
          </dl>
          {photoResolved.url && <img className="catalogPhotoPreview" src={photoResolved.url} alt={`Fotografie ${item.displayName}`} />}
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
        {!isVariantBooth && (
        <section className="catalogDetailSection">
          <h3>3D model</h3>
          <dl>
            <Row label="Stav" value={hasModel ? "Model existuje" : "3D model chybí"} />
            <Row label="Soubor" value={modelAsset?.originalFileName ?? (legacyModelUrl ? legacyModelUrl.split("/").pop() : undefined)} />
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
        {SOURCE_ASSET_APPLICABLE_KINDS.includes(item.kind) && !isVariantBooth && (
        <section className="catalogDetailSection">
          <h3>Zdrojové a výrobní soubory</h3>
          <dl>
            <Row label="SKP (zdrojový soubor)" value={hasSketchupSource ? "Nahrán" : "Chybí"} />
          </dl>
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
          {sourceAssetActionError && <small className="uploadError">{sourceAssetActionError}</small>}
          <p className="fieldHint">
            {item.kind === "booth_component"
              ? "SKP je u komponent stánku povinný pro aktivaci (spolu s GLB)."
              : "SKP je evidence/výrobní podklad — u tohoto druhu položky není pro aktivaci povinný."}
            {" "}DWG, DXF, PDF a Ostatní nejsou nikdy vyžadované — jejich chybějící přítomnost aktivaci neblokuje.
          </p>
        </section>
        )}

        <section className="catalogDetailSection">
          <h3>Ceny</h3>
          <dl>
            <Row label="Base cena CZK" value={pricing.czk !== null ? `${pricing.czk.toLocaleString("cs-CZ")} Kč` : "Cena není nastavena"} />
            <Row label="Base cena EUR" value={pricing.eur !== null ? `${pricing.eur.toLocaleString("cs-CZ")} €` : "Cena není nastavena"} />
          </dl>
          <button type="button" className="secondaryButton" onClick={onOpenPricing}>Upravit ceny</button>
        </section>
      </div>
    </div>
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
