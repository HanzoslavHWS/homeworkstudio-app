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
import type { RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import { canPublishInCustomerCatalog } from "../../domain/customerCatalog";
import { uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { CATALOG_UNITS } from "../../domain/catalogUnits";
import { catalogTypeHasField } from "../../domain/catalogItemFields";
import { categoriesForGroup, COMPONENT_GROUP_HINTS_CS, COMPONENT_GROUP_LABELS_CS, COMPONENT_GROUP_TARGETS, COMPONENT_GROUPS, type ComponentGroup } from "../../domain/catalogClassification";
import { useCatalogCategories } from "../../lib/db/catalogCategories.remoteApi.client";
import { INTERNAL_COMPONENT_USAGE_HINTS_CS, INTERNAL_COMPONENT_USAGE_LABELS_CS, usagesForCategory, type InternalComponentUsage } from "../../domain/internalComponentUsage";

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
  // Interní komponenta → Použití komponenty: chosen explicitly when the category allows both.
  const [usage, setUsage] = useState<InternalComponentUsage | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isGroup = pick !== "" && pick !== "BOOTH" && pick !== "KIT";
  const groupCategories = isGroup ? categoriesForGroup(categoryRegister.categories, pick) : [];
  const categoryDef = isGroup ? groupCategories.find((candidate) => candidate.id === category) : undefined;
  const usageOptions = usagesForCategory(categoryDef);
  const resolvedUsage: InternalComponentUsage | "" = usageOptions.length === 1 ? usageOptions[0]! : usageOptions.includes(usage as InternalComponentUsage) ? usage : "";
  const kind: CatalogItemKind | "" = !itemType ? "" : isGroup ? (usageOptions.length > 0 ? resolvedUsage : categoryDef?.kinds[0] ?? "") : CATALOG_ITEM_KINDS_BY_TYPE[itemType][0]!;
  const isInternal = itemType === "INTERNAL_COMPONENT";
  const generatorCodeDraft = codeFromAbf && abfCode.trim() ? abfCode.trim() : internalCode.trim();
  const missingInternalCode = isInternal && !generatorCodeDraft;
  const canSubmit = Boolean(itemType) && Boolean(kind) && displayName.trim().length > 0 && category.trim().length > 0 && !missingInternalCode && !busy;

  function selectPick(next: ComponentGroup | "BOOTH" | "KIT") {
    setPick(next);
    // Never carry a category over into another group, never preselect one — the user chooses.
    setCategory("");
    setUsage("");
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
            <input value={abfCode} onChange={(event) => setAbfCode(event.target.value)} placeholder={itemTypeExpectsAbfCode(itemType) ? "např. M57 (podle oficiálního ceníku ABF)" : "Interní komponenta obvykle ABF kód nemá"} />
          </Field>
          <Field label={isInternal ? "Interní / generátorový kód *" : "Generátorový kód"}>
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
            {missingInternalCode && <small className="fieldWarning">Interní komponenta musí mít vlastní interní/generátorový kód — je to její hlavní identifikátor (ABF kód je nepovinný).</small>}
          </Field>
          {itemTypeExpectsAbfCode(itemType) && (
            <>
              <Field label="Oficiální název ABF (CZ)">
                <input value={officialName} onChange={(event) => setOfficialName(event.target.value)} placeholder="Oficiální název ABF" />
              </Field>
              <Field label="Oficiální název ABF (EN)">
                <input value={officialNameEn} onChange={(event) => setOfficialNameEn(event.target.value)} placeholder="Official ABF name" />
              </Field>
            </>
          )}
          <Field label="Kategorie *">
            <select value={category} onChange={(event) => { setCategory(event.target.value); setUsage(""); }}>
              <option value="">— vyberte —</option>
              {isGroup
                ? groupCategories.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)
                : CATALOG_ITEM_CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {categoryDef?.priceCategory === "electricity" && <small className="fieldHint">Cenové zařazení: Elektřina → ceník elektřiny.</small>}
            {isGroup && pick === "technical_point" && <small className="fieldHint">Technický bod se samostatně neúčtuje.</small>}
          </Field>
          {usageOptions.length > 0 && (
            <Field label={usageOptions.length > 1 ? "Použití komponenty *" : "Použití komponenty"}>
              {usageOptions.length > 1 ? (
                <div className="catalogUsageChoice" role="radiogroup" aria-label="Použití komponenty">
                  {usageOptions.map((option) => (
                    <label key={option} className="checkboxRow">
                      <input type="radio" name="catalogCreateUsage" checked={resolvedUsage === option} onChange={() => setUsage(option)} />
                      <span><strong>{INTERNAL_COMPONENT_USAGE_LABELS_CS[option]}</strong> — {INTERNAL_COMPONENT_USAGE_HINTS_CS[option]}</span>
                    </label>
                  ))}
                  {!resolvedUsage && <small className="fieldWarning">Vyberte, jak se komponenta bude používat.</small>}
                </div>
              ) : (
                <span>{INTERNAL_COMPONENT_USAGE_LABELS_CS[usageOptions[0]!]} <small className="fieldHint">— {INTERNAL_COMPONENT_USAGE_HINTS_CS[usageOptions[0]!]}</small></span>
              )}
            </Field>
          )}
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
