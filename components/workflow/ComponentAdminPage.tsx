"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  buildCatalogItemListEntry,
  computeGeneratorEligibleLive,
  computeReadiness,
  documentBasePricing,
  documentDimensions,
  documentHas3DAsset,
  documentModelAsset,
  documentModelUrl,
  documentPhotoAsset,
  documentPhotoUrl,
  documentReviewedAt,
  documentSourceTraceability,
  filterCatalogItemsAdmin,
  CATALOG_ITEM_KIND_LABELS_CS,
  type CatalogItemAdmin,
  type CatalogItemAdminEdit,
  type CatalogItemAdminFilters,
  type CatalogItemAdminListEntry,
} from "../../domain/catalogItemsAdmin";
import { CATALOG_ITEM_STATUS_LABELS_CS, READINESS_ISSUE_LABELS_CS } from "../../domain/catalogReadiness";
import { CATALOG_ITEM_KINDS, CATALOG_ITEM_STATUSES, type CatalogItemKind, type CatalogItemStatus } from "../../domain/models";
import { ConcurrencyConflictError } from "../../lib/db/concurrency";
import type { RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import { uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";

const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const MODEL_EXTENSIONS = ["glb"];

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

  const listEntries = useMemo(() => (items ?? []).map(buildCatalogItemListEntry), [items]);
  const filteredEntries = useMemo(() => filterCatalogItemsAdmin(listEntries, filters), [listEntries, filters]);
  const selected = items?.find((item) => item.id === selectedId);

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
        {items && <span className="catalogAdminCount">{filteredEntries.length} / {items.length} položek</span>}
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

function ComponentAdminFilters({ filters, onChange }: { filters: CatalogItemAdminFilters; onChange: (filters: CatalogItemAdminFilters) => void }) {
  return (
    <div className="adminFilters">
      <input value={filters.query ?? ""} onChange={(event) => onChange({ ...filters, query: event.target.value })} placeholder="Hledat interní kód nebo název…" />
      <select value={filters.kind ?? ""} onChange={(event) => onChange({ ...filters, kind: event.target.value as CatalogItemKind | "" })}>
        <option value="">Kategorie: vše</option>
        {CATALOG_ITEM_KINDS.map((kind) => (
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
    </div>
  );
}

function ComponentAdminList({
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
          <span>{entry.internalCode ?? "—"}</span>
          <span>{entry.displayName}</span>
          <span>{CATALOG_ITEM_KIND_LABELS_CS[entry.kind]}{entry.category ? ` · ${entry.category}` : ""}</span>
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

function ComponentAdminDetail({
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

  const [photoProgress, setPhotoProgress] = useState<UploadProgress | undefined>(undefined);
  const [photoActionError, setPhotoActionError] = useState("");
  const [modelProgress, setModelProgress] = useState<UploadProgress | undefined>(undefined);
  const [modelActionError, setModelActionError] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");

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

  const initialWidth = dims.widthMm !== null ? String(dims.widthMm) : "";
  const initialDepth = dims.depthMm !== null ? String(dims.depthMm) : "";
  const initialHeight = dims.heightMm !== null ? String(dims.heightMm) : "";

  const [displayName, setDisplayName] = useState(item.displayName);
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState(item.category ?? "");
  const [unit, setUnit] = useState(item.unit ?? "");
  const [widthMm, setWidthMm] = useState(initialWidth);
  const [depthMm, setDepthMm] = useState(initialDepth);
  const [heightMm, setHeightMm] = useState(initialHeight);
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
              <input value={category} onChange={(event) => { setCategory(event.target.value); setDirty(true); }} />
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
            {item.lifecycleStatus !== "active" && (
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
          </div>
          {reviewError && <small className="uploadError">{reviewError}</small>}
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
