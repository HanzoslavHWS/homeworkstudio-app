"use client";

import { useState, type ReactNode } from "react";
import {
  CATALOG_ITEM_CATEGORY_OPTIONS,
  CATALOG_ITEM_KIND_LABELS_CS,
  CATALOG_PUBLICATION_DESCRIPTION_MAX,
  CATALOG_PUBLICATION_NAME_MAX,
  documentCatalogPublication,
  documentPhotoAsset,
  documentPhotoUrl,
  documentServiceTechnical,
  type CatalogItemAdmin,
  type CatalogItemAdminCreateInput,
  type CatalogItemAdminEdit,
} from "../../domain/catalogItemsAdmin";
import {
  CATALOG_ITEM_KINDS_BY_TYPE,
  CATALOG_ITEM_TYPE_HINTS_CS,
  CATALOG_ITEM_TYPE_LABELS_CS,
  itemTypeExpectsAbfCode,
} from "../../domain/catalogItemTypes";
import { CATALOG_ITEM_TYPES, type CatalogItemKind, type CatalogItemType } from "../../domain/models";
import type { AbfImportPlan, AbfImportPlanRow } from "../../domain/catalogAbfImport";
import type { AbfImportApplyResult } from "../../lib/db/catalogAbfImport.supabase";
import type { RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import { canPublishInCustomerCatalog } from "../../domain/customerCatalog";
import { uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { CATALOG_UNITS } from "../../domain/catalogUnits";
import { catalogTypeHasField } from "../../domain/catalogItemFields";
import { categoriesForGroup, COMPONENT_GROUP_HINTS_CS, COMPONENT_GROUP_LABELS_CS, COMPONENT_GROUP_TARGETS, COMPONENT_GROUPS, type ComponentGroup } from "../../domain/catalogClassification";
import { useCatalogCategories } from "../../lib/db/catalogCategories.remoteApi.client";

/** Types whose cards physically exist (dimensions make sense). SERVICE never needs them. */
const TYPES_WITH_DIMENSIONS: readonly CatalogItemType[] = ["PRODUCT", "BOOTH", "INTERNAL_COMPONENT"];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="catalogAdminEditRow">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ============================================================================
// NEW ITEM — manual founding of any of the four card types, no import needed.
// ============================================================================

export function CatalogItemCreateForm({
  repository,
  onCancel,
  onCreated,
}: {
  repository: RemoteApiCatalogItemsAdminRepository;
  onCancel: () => void;
  onCreated: (created: CatalogItemAdmin) => void;
}) {
  // Druh komponenty (five groups) or one of the two specialized card types (Typový stánek / Komplet).
  const [pick, setPick] = useState<ComponentGroup | "BOOTH" | "KIT" | "">("");
  const categoryRegister = useCatalogCategories();
  const itemType: CatalogItemType | "" = pick === "" ? "" : pick === "BOOTH" || pick === "KIT" ? pick : COMPONENT_GROUP_TARGETS[pick].itemType;
  const [displayName, setDisplayName] = useState("");
  const [internalCode, setInternalCode] = useState("");
  const [abfCode, setAbfCode] = useState("");
  const [category, setCategory] = useState("");
  const [unitCode, setUnitCode] = useState("");
  const [codeFromAbf, setCodeFromAbf] = useState(true);
  const [officialName, setOfficialName] = useState("");
  const [officialNameEn, setOfficialNameEn] = useState("");
  const [color, setColor] = useState("");
  const [material, setMaterial] = useState("");
  const [note, setNote] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [depthMm, setDepthMm] = useState("");
  const [heightMm, setHeightMm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isGroup = pick !== "" && pick !== "BOOTH" && pick !== "KIT";
  const groupCategories = isGroup ? categoriesForGroup(categoryRegister.categories, pick) : [];
  const categoryDef = isGroup ? groupCategories.find((candidate) => candidate.id === category) : undefined;
  const kind: CatalogItemKind | "" = !itemType ? "" : isGroup ? categoryDef?.kinds[0] ?? "" : CATALOG_ITEM_KINDS_BY_TYPE[itemType][0]!;
  const canSubmit = Boolean(itemType) && Boolean(kind) && displayName.trim().length > 0 && category.trim().length > 0 && !busy;

  function selectPick(next: ComponentGroup | "BOOTH" | "KIT") {
    setPick(next);
    // Never carry a category over into another group, never preselect one — the user chooses.
    setCategory("");
  }

  async function handleSubmit() {
    if (!itemType) return;
    setBusy(true);
    setError("");
    try {
      const input: { -readonly [K in keyof CatalogItemAdminCreateInput]?: CatalogItemAdminCreateInput[K] } = {
        itemType,
        kind: kind || CATALOG_ITEM_KINDS_BY_TYPE[itemType][0]!,
        displayName: displayName.trim(),
        category,
      };
      // Decision A8: the generator code defaults to the ABF code — only when the user keeps that choice.
      const generatorCode = codeFromAbf && abfCode.trim() ? abfCode.trim().toUpperCase() : internalCode.trim();
      if (generatorCode) input.internalCode = generatorCode;
      if (abfCode.trim()) input.abfCode = abfCode.trim();
      if (unitCode) input.unitCode = unitCode;
      if (officialName.trim()) input.officialName = officialName.trim();
      if (officialNameEn.trim()) input.officialNameEn = officialNameEn.trim();
      if (catalogTypeHasField(itemType, "color") && (color.trim() || material.trim())) {
        input.attributes = { ...(color.trim() ? { color: color.trim() } : {}), ...(material.trim() ? { material: material.trim() } : {}) };
      }
      if (note.trim()) input.note = note.trim();
      if (TYPES_WITH_DIMENSIONS.includes(itemType)) {
        const width = Number(widthMm);
        if (widthMm.trim() && Number.isFinite(width)) input.widthMm = width;
        const depth = Number(depthMm);
        if (depthMm.trim() && Number.isFinite(depth)) input.depthMm = depth;
        const height = Number(heightMm);
        if (heightMm.trim() && Number.isFinite(height)) input.heightMm = height;
      }
      onCreated(await repository.create(input as CatalogItemAdminCreateInput));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Vytvoření položky selhalo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="catalogDetailSection adminDetail catalogCreatePanel">
      <h3>Nová katalogová položka</h3>
      <p className="fieldHint">Nejdřív vyberte druh komponenty a pak kategorii — podle nich se zobrazí relevantní pole a odvodí cenové zařazení. Nová položka vzniká ve stavu „K doplnění“.</p>
      <div className="catalogTypePicker" role="radiogroup" aria-label="Druh komponenty">
        {COMPONENT_GROUPS.map((value) => (
          <button key={value} type="button" role="radio" aria-checked={pick === value} className={pick === value ? "active" : ""} onClick={() => selectPick(value)}>
            <strong>{COMPONENT_GROUP_LABELS_CS[value]}</strong>
            <small>{COMPONENT_GROUP_HINTS_CS[value]}</small>
          </button>
        ))}
        {(["BOOTH", "KIT"] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={pick === value} className={pick === value ? "active" : ""} onClick={() => selectPick(value)}>
            <strong>{CATALOG_ITEM_TYPE_LABELS_CS[value]}</strong>
            <small>{CATALOG_ITEM_TYPE_HINTS_CS[value]} Specializovaná správa obsahu.</small>
          </button>
        ))}
      </div>
      {itemType && (
        <dl>
          <Field label="Interní název HomeworkStudio *">
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label={itemTypeExpectsAbfCode(itemType) ? "ABF kód" : "ABF kód (nepovinný)"}>
            <input value={abfCode} onChange={(event) => setAbfCode(event.target.value)} placeholder={itemTypeExpectsAbfCode(itemType) ? "např. M57 (podle KODY.xlsm)" : "Interní komponenta obvykle ABF kód nemá"} />
          </Field>
          <Field label="Generátorový kód">
            {abfCode.trim() && (
              <label className="checkboxRow">
                <input type="checkbox" checked={codeFromAbf} onChange={(event) => setCodeFromAbf(event.target.checked)} /> Stejný jako ABF kód
              </label>
            )}
            {abfCode.trim() && codeFromAbf ? (
              <input value={abfCode.trim().toUpperCase()} readOnly disabled aria-label="Generátorový kód" />
            ) : (
              <input aria-label="Generátorový kód" value={internalCode} onChange={(event) => setInternalCode(event.target.value)} placeholder={itemType === "INTERNAL_COMPONENT" ? "např. INT-PANEL-950" : "Ponechte prázdné, pokud kód neznáte"} />
            )}
          </Field>
          {itemTypeExpectsAbfCode(itemType) && (
            <>
              <Field label="Oficiální název ABF (CZ)">
                <input value={officialName} onChange={(event) => setOfficialName(event.target.value)} placeholder="Podle KODY.xlsm" />
              </Field>
              <Field label="Oficiální název ABF (EN)">
                <input value={officialNameEn} onChange={(event) => setOfficialNameEn(event.target.value)} placeholder="Official ABF name" />
              </Field>
            </>
          )}
          <Field label="Kategorie *">
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">— vyberte —</option>
              {isGroup
                ? groupCategories.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)
                : CATALOG_ITEM_CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {categoryDef?.priceCategory === "electricity" && <small className="fieldHint">Cenové zařazení: Elektřina → ceník elektřiny.</small>}
            {isGroup && pick === "technical_point" && <small className="fieldHint">Technický bod se samostatně neúčtuje.</small>}
          </Field>
          <Field label="Měrná jednotka">
            <select aria-label="Měrná jednotka" value={unitCode} onChange={(event) => setUnitCode(event.target.value)}>
              <option value="">— nevybráno —</option>
              {CATALOG_UNITS.map((unit) => <option key={unit.code} value={unit.code}>{unit.symbol} — {unit.nameCs}</option>)}
            </select>
          </Field>
          {catalogTypeHasField(itemType, "color") && (
            <>
              <Field label="Barva"><input value={color} onChange={(event) => setColor(event.target.value)} placeholder="např. černá" /></Field>
              <Field label="Materiál"><input value={material} onChange={(event) => setMaterial(event.target.value)} placeholder="např. lamino" /></Field>
            </>
          )}
          {TYPES_WITH_DIMENSIONS.includes(itemType) && (
            <>
              <Field label="Šířka (mm)"><input type="number" value={widthMm} onChange={(event) => setWidthMm(event.target.value)} placeholder="Neznámo" /></Field>
              <Field label="Hloubka (mm)"><input type="number" value={depthMm} onChange={(event) => setDepthMm(event.target.value)} placeholder="Neznámo" /></Field>
              <Field label="Výška (mm)"><input type="number" value={heightMm} onChange={(event) => setHeightMm(event.target.value)} placeholder="Neznámo" /></Field>
            </>
          )}
          <Field label="Poznámka">
            <input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </dl>
      )}
      {(itemType === "BOOTH" || itemType === "KIT") && <p className="fieldHint">Obsah kompletu (komponenty, textové položky, náhrady, zahrnutá grafika) nastavíte po založení v detailu karty.</p>}
      {itemType === "KIT" && <p className="fieldHint">Obsah kompletu nastavíte po založení v detailu karty. Náhrady a doplatky přibudou ve V1-DATA-04.</p>}
      {itemType === "SERVICE" && <p className="fieldHint">Technická metadata (výkon, parametry) a prezentaci v technickém rastru nastavíte po založení v detailu karty.</p>}
      <div className="catalogAdminReviewActions">
        <button type="button" className="secondaryButton" onClick={onCancel} disabled={busy}>Zrušit</button>
        <button type="button" className="primaryButton" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {busy ? "Vytvářím…" : "Vytvořit"}
        </button>
      </div>
      {error && <small className="uploadError">{error}</small>}
    </div>
  );
}

// ============================================================================
// PUBLIKACE V KATALOGU — presentation metadata for the customer-facing "Katalog" module.
// Self-contained and independently saved, like the sections above; codes, type, dimensions
// and prices stay in their own sections.
// ============================================================================

const CATALOG_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
const CATALOG_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

export function CatalogPublicationSection({ item, ownerId, onSave }: { item: CatalogItemAdmin; ownerId: string; onSave: (edit: CatalogItemAdminEdit) => Promise<void> }) {
  const publication = documentCatalogPublication(item.document);
  const publishable = canPublishInCustomerCatalog(item);
  const [visible, setVisible] = useState(publication.visible);
  const [name, setName] = useState(publication.name ?? "");
  const [shortDescription, setShortDescription] = useState(publication.shortDescription ?? "");
  const [sortOrder, setSortOrder] = useState(publication.sortOrder !== undefined ? String(publication.sortOrder) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imageProgress, setImageProgress] = useState<UploadProgress | undefined>(undefined);
  // Preview what the catalog will actually use: the dedicated image, else the item's own photo.
  const imageResolved = useAssetUrl(publication.image ?? documentPhotoAsset(item.document), documentPhotoUrl(item.document));

  const parsedSortOrder = sortOrder.trim() ? Number(sortOrder) : null;
  const sortOrderValid = parsedSortOrder === null || (Number.isInteger(parsedSortOrder) && parsedSortOrder >= 0);
  const dirty =
    visible !== publication.visible ||
    name.trim() !== (publication.name ?? "") ||
    shortDescription.trim() !== (publication.shortDescription ?? "") ||
    parsedSortOrder !== (publication.sortOrder ?? null);

  async function run(edit: CatalogItemAdminEdit, fallbackMessage: string) {
    setBusy(true);
    setError("");
    try {
      await onSave(edit);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : fallbackMessage);
    } finally {
      setBusy(false);
    }
  }

  async function handleImageUpload(file: File) {
    const extension = file.name.toLowerCase().split(".").pop() ?? "";
    if (file.size === 0 || !CATALOG_IMAGE_EXTENSIONS.includes(extension)) {
      setError("Podporované formáty: jpg, jpeg, png, webp.");
      return;
    }
    setError("");
    try {
      const asset = await uploadAsset(file, { category: "catalog-photo", ownerId }, setImageProgress);
      await onSave({ catalogPublication: { image: asset } });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Nahrání obrázku selhalo.");
    }
  }

  if (!publishable) {
    return (
      <section className="catalogDetailSection">
        <h3>Publikace v katalogu</h3>
        <p className="fieldHint">Interní komponenta se do zákaznického katalogu nenabízí.</p>
      </section>
    );
  }

  return (
    <section className="catalogDetailSection">
      <h3>Publikace v katalogu</h3>
      <label className="checkboxRow">
        <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
        Zobrazovat v katalogu
      </label>
      {visible && item.lifecycleStatus === "archived" && <p className="fieldHint">Položka je archivovaná — v katalogu se neobjeví, dokud ji neobnovíte.</p>}
      <dl>
        <Field label="Katalogový název">
          <input value={name} maxLength={CATALOG_PUBLICATION_NAME_MAX} onChange={(event) => setName(event.target.value)} placeholder={item.displayName} />
        </Field>
        <Field label="Krátký popis">
          <textarea value={shortDescription} maxLength={CATALOG_PUBLICATION_DESCRIPTION_MAX} rows={3} onChange={(event) => setShortDescription(event.target.value)} placeholder="Text pro zákazníka" />
        </Field>
        <Field label="Pořadí">
          <input inputMode="numeric" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} placeholder="Podle názvu" />
        </Field>
      </dl>
      {imageResolved.url && <img className="catalogPhotoPreview" src={imageResolved.url} alt={`Katalogový obrázek ${item.displayName}`} />}
      <div className="assetActions">
        <label className="smallUploadButton">
          {publication.image ? "Nahradit obrázek" : "Nahrát katalogový obrázek"}
          <input
            type="file"
            accept={CATALOG_IMAGE_ACCEPT}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleImageUpload(file);
            }}
          />
        </label>
        {publication.image && (
          <button type="button" className="dangerText" disabled={busy} onClick={() => void run({ catalogPublication: { image: null } }, "Odebrání obrázku selhalo.")}>
            Odebrat obrázek
          </button>
        )}
        <button
          type="button"
          className="primaryButton"
          disabled={!dirty || !sortOrderValid || busy}
          onClick={() => void run({ catalogPublication: { visible, name: name.trim() || null, shortDescription: shortDescription.trim() || null, sortOrder: parsedSortOrder } }, "Uložení selhalo.")}
        >
          {busy ? "Ukládám…" : "Uložit publikaci"}
        </button>
      </div>
      {imageProgress?.state === "uploading" && (
        <div className="assetUploadState uploading">
          <progress max="100" value={imageProgress.percent} />
          <span>Nahrávám {imageProgress.percent} %</span>
        </div>
      )}
      <p className="fieldHint">
        {publication.image ? "Katalog použije tento obrázek." : "Bez vlastního obrázku použije katalog fotografii položky."} Bez katalogového názvu se zobrazí „{item.displayName}“.
      </p>
      {!sortOrderValid && <small className="uploadError">Pořadí musí být celé nezáporné číslo.</small>}
      {error && <small className="uploadError">{error}</small>}
    </section>
  );
}

// ============================================================================
// KODY.xlsm IMPORT — preview first, explicit confirmation second.
// ============================================================================

type PreviewResponse = Readonly<{ plan: AbfImportPlan; schemaReady: boolean }>;

const ACTION_LABELS_CS: Readonly<Record<AbfImportPlanRow["action"], string>> = {
  create: "Nová",
  update: "Aktualizace",
  unchanged: "Beze změny",
  conflict: "Konflikt",
};

function rowDetail(row: AbfImportPlanRow): string {
  switch (row.action) {
    case "create":
      return `${CATALOG_ITEM_TYPE_LABELS_CS[row.classification.itemType]}${row.classification.confident ? "" : " (k zařazení)"} · interní kód ${row.internalCode}${row.warnings.length ? ` · ${row.warnings.join(" ")}` : ""}`;
    case "update":
      return `${row.itemLabel} · ${row.changes.map((change) => change.field).join(", ")}${row.linkedVia !== "abf_code" ? ` · spárováno přes ${row.linkedVia === "internal_code" ? "interní kód" : "potvrzené propojení"}` : ""}${row.warnings.length ? ` · ${row.warnings.join(" ")}` : ""}`;
    case "unchanged":
      return row.itemLabel;
    case "conflict":
      return `${row.message}${row.candidateLabel ? ` (${row.candidateLabel})` : ""}`;
  }
}

export function AbfImportPanel({
  repository,
  onClose,
  onApplied,
}: {
  repository: RemoteApiCatalogItemsAdminRepository;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [links, setLinks] = useState<Readonly<Record<string, string>>>({});
  const [result, setResult] = useState<AbfImportApplyResult | null>(null);
  const [busy, setBusy] = useState<"idle" | "preview" | "apply">("idle");
  const [error, setError] = useState("");
  const [showUnchanged, setShowUnchanged] = useState(false);

  async function runPreview(nextFile: File, nextLinks: Readonly<Record<string, string>>) {
    setBusy("preview");
    setError("");
    setResult(null);
    try {
      setPreview(await repository.abfImport<PreviewResponse>(nextFile, "preview", nextLinks));
    } catch (previewError) {
      setPreview(null);
      setError(previewError instanceof Error ? previewError.message : "Náhled importu selhal.");
    } finally {
      setBusy("idle");
    }
  }

  async function handleApply() {
    if (!file || !preview) return;
    const { create, update } = preview.plan.summary;
    if (!window.confirm(`Importovat ${create} nových a aktualizovat ${update} existujících položek? Konflikty a řádky bez ABF kódu se přeskočí, nic se nearchivuje ani nesmaže.`)) return;
    setBusy("apply");
    setError("");
    try {
      const applied = await repository.abfImport<AbfImportApplyResult>(file, "apply", links);
      setResult(applied);
      setPreview(null);
      onApplied();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Import selhal.");
    } finally {
      setBusy("idle");
    }
  }

  function toggleLink(abfCode: string, itemId: string, checked: boolean) {
    const next = { ...links };
    if (checked) next[abfCode] = itemId;
    else delete next[abfCode];
    setLinks(next);
    if (file) void runPreview(file, next);
  }

  const plan = preview?.plan;
  const visibleRows = plan ? plan.rows.filter((row) => showUnchanged || row.action !== "unchanged") : [];

  return (
    <div className="catalogDetailSection adminDetail catalogImportPanel">
      <h3>Import ABF kódů z KODY.xlsm</h3>
      <p className="fieldHint">
        Importují se pouze řádky listu PRICELIST, které mají ve sloupci A vyplněný ABF kód. Řádky bez ABF kódu se ignorují. Existující položky se párují podle ABF kódu (bez duplicit) a aktualizují se jen pole spravovaná importem (ABF název, provenance, prázdný interní kód/jednotka) — kategorie, typ, 3D vazby, technické parametry a ceny zůstávají. Import nic nearchivuje.
      </p>
      <div className="assetActions">
        <label className="smallUploadButton">
          {file ? "Vybrat jiný soubor" : "Vybrat soubor"}
          <input
            type="file"
            accept=".xlsm,.xlsx"
            onChange={(event) => {
              const next = event.target.files?.[0];
              event.target.value = "";
              if (!next) return;
              setFile(next);
              setLinks({});
              void runPreview(next, {});
            }}
          />
        </label>
        {file && <span className="fieldHint">{file.name}</span>}
        <button type="button" className="secondaryButton" onClick={onClose}>Zavřít</button>
      </div>
      {busy === "preview" && <p className="workspaceEmpty">Připravuji náhled…</p>}
      {error && <p className="uploadError">{error}</p>}

      {plan && (
        <>
          {!preview!.schemaReady && (
            <p className="uploadError">Databáze ještě nemá migraci katalogu (abf_code / item_type). Náhled je jen orientační, import nelze potvrdit.</p>
          )}
          <dl className="catalogImportSummary">
            <Field label="Datové řádky v souboru">{plan.summary.dataRows}</Field>
            <Field label="S ABF kódem (importovatelné)">{plan.summary.withAbfCode}</Field>
            <Field label="Přeskočeno — bez ABF kódu">{plan.summary.skippedWithoutAbfCode}</Field>
            <Field label="Nové položky">{plan.summary.create}{plan.summary.createdNeedingTypeReview ? ` (z toho k zařazení: ${plan.summary.createdNeedingTypeReview})` : ""}</Field>
            <Field label="Aktualizované položky">{plan.summary.update}</Field>
            <Field label="Beze změny">{plan.summary.unchanged}</Field>
            <Field label="Konflikty">{plan.summary.conflicts}</Field>
            <Field label="Duplicitní ABF kódy v souboru">{plan.duplicateCodes.length ? plan.duplicateCodes.join(", ") : "0"}</Field>
          </dl>

          <label className="checkboxRow">
            <input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} />
            Zobrazit i řádky beze změny
          </label>
          <div className="catalogImportRows">
            {visibleRows.map((row) => (
              <div key={`${row.row.sourceRow}`} className={`catalogImportRow ${row.action}`}>
                <span>ř. {row.row.sourceRow}</span>
                <strong>{row.abfCode ?? "—"}</strong>
                <span>{row.row.nameCz}</span>
                <span className={`lifecycleBadge ${row.action === "conflict" ? "archived" : row.action === "create" ? "needs_review" : "active"}`}>{ACTION_LABELS_CS[row.action]}</span>
                <small>
                  {rowDetail(row)}
                  {row.action === "conflict" && row.reason === "possible_duplicate_by_name" && row.abfCode && row.candidateItemId && (
                    <label className="checkboxRow">
                      <input type="checkbox" checked={false} onChange={() => toggleLink(row.abfCode!, row.candidateItemId!, true)} />
                      Propojit s existující položkou (doplní jí ABF kód)
                    </label>
                  )}
                  {row.action === "update" && row.linkedVia === "confirmed_link" && (
                    <label className="checkboxRow">
                      <input type="checkbox" checked onChange={() => toggleLink(row.abfCode, row.itemId, false)} />
                      Propojeno s existující položkou (zrušit propojení)
                    </label>
                  )}
                </small>
              </div>
            ))}
          </div>

          {plan.skippedWithoutAbfCode.length > 0 && (
            <details className="catalogImportDetails">
              <summary>Přeskočené řádky bez ABF kódu ({plan.skippedWithoutAbfCode.length})</summary>
              <ul>
                {plan.skippedWithoutAbfCode.map((row) => <li key={row.sourceRow}>ř. {row.sourceRow}: {row.nameCz}</li>)}
              </ul>
            </details>
          )}
          {plan.notInFile.length > 0 && (
            <details className="catalogImportDetails">
              <summary>Položky s ABF kódem, které v souboru nejsou ({plan.notInFile.length}) — import je nemění ani nearchivuje</summary>
              <ul>
                {plan.notInFile.map((entry) => <li key={entry.itemId}>{entry.abfCode} · {entry.label} ({entry.lifecycleStatus})</li>)}
              </ul>
            </details>
          )}

          <div className="catalogAdminReviewActions">
            <button
              type="button"
              className="primaryButton"
              onClick={() => void handleApply()}
              disabled={busy !== "idle" || !preview!.schemaReady || plan.summary.create + plan.summary.update === 0}
            >
              {busy === "apply" ? "Importuji…" : `Potvrdit import (${plan.summary.create} nových, ${plan.summary.update} aktualizací)`}
            </button>
          </div>
        </>
      )}

      {result && (
        <div className="catalogImportResult">
          <strong>Import dokončen.</strong> Vytvořeno: {result.created}, aktualizováno: {result.updated}
          {result.staleSkipped.length > 0 && <>, přeskočeno kvůli souběžné změně: {result.staleSkipped.map((row) => row.abfCode).join(", ")}</>}
          {result.failed.length > 0 && <>, chyby: {result.failed.map((row) => `${row.abfCode} (${row.message})`).join("; ")}</>}.
        </div>
      )}
    </div>
  );
}
