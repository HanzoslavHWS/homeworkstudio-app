"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  CATALOG_ITEM_CATEGORY_OPTIONS,
  CATALOG_ITEM_KIND_LABELS_CS,
  documentServiceTechnical,
  itemTypeOf,
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
import type { CatalogPackageItemInput } from "../../domain/catalogPackages";
import type { AbfImportPlan, AbfImportPlanRow } from "../../domain/catalogAbfImport";
import type { AbfImportApplyResult } from "../../lib/db/catalogAbfImport.supabase";
import type { RemoteApiCatalogItemsAdminRepository } from "../../lib/db/catalogItemsAdmin.remoteApi.client";

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
  const [itemType, setItemType] = useState<CatalogItemType | "">("");
  const [kind, setKind] = useState<CatalogItemKind | "">("");
  const [displayName, setDisplayName] = useState("");
  const [internalCode, setInternalCode] = useState("");
  const [abfCode, setAbfCode] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [depthMm, setDepthMm] = useState("");
  const [heightMm, setHeightMm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = Boolean(itemType) && displayName.trim().length > 0 && category.trim().length > 0 && !busy;

  function selectType(next: CatalogItemType) {
    setItemType(next);
    setKind(CATALOG_ITEM_KINDS_BY_TYPE[next][0]!);
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
      if (internalCode.trim()) input.internalCode = internalCode.trim();
      if (abfCode.trim()) input.abfCode = abfCode.trim();
      if (unit.trim()) input.unit = unit.trim();
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
      <p className="fieldHint">Nejdřív vyberte typ karty — podle něj se zobrazí relevantní pole. Nová položka vzniká ve stavu „K doplnění“.</p>
      <div className="catalogTypePicker" role="radiogroup" aria-label="Typ položky">
        {CATALOG_ITEM_TYPES.map((value) => (
          <button key={value} type="button" role="radio" aria-checked={itemType === value} className={itemType === value ? "active" : ""} onClick={() => selectType(value)}>
            <strong>{CATALOG_ITEM_TYPE_LABELS_CS[value]}</strong>
            <small>{CATALOG_ITEM_TYPE_HINTS_CS[value]}</small>
          </button>
        ))}
      </div>
      {itemType && (
        <dl>
          <Field label="Název *">
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label="Interní kód">
            <input value={internalCode} onChange={(event) => setInternalCode(event.target.value)} placeholder={itemType === "INTERNAL_COMPONENT" ? "např. INT-PANEL-950" : "Ponechte prázdné, pokud kód neznáte"} />
          </Field>
          <Field label={itemTypeExpectsAbfCode(itemType) ? "ABF kód" : "ABF kód (nepovinný)"}>
            <input value={abfCode} onChange={(event) => setAbfCode(event.target.value)} placeholder={itemTypeExpectsAbfCode(itemType) ? "např. M57" : "Interní komponenta obvykle ABF kód nemá"} />
          </Field>
          <Field label="Kategorie *">
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">— vyberte —</option>
              {CATALOG_ITEM_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          {CATALOG_ITEM_KINDS_BY_TYPE[itemType].length > 1 && (
            <Field label="Druh (pravidla readiness)">
              <select value={kind} onChange={(event) => setKind(event.target.value as CatalogItemKind)}>
                {CATALOG_ITEM_KINDS_BY_TYPE[itemType].map((value) => (
                  <option key={value} value={value}>{CATALOG_ITEM_KIND_LABELS_CS[value]}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Jednotka">
            <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={itemType === "SERVICE" ? "např. ks, den, m³" : "např. ks, m², bm"} />
          </Field>
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
      {itemType === "BOOTH" && <p className="fieldHint">Obsah balíčku (typovka, pult, židle, světla…) nastavíte po založení v detailu karty.</p>}
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
// BOOTH PACKAGE CONTENTS — booth -> item -> quantity -> included_in_package
// ============================================================================

type PackageDraftLine = Readonly<{ key: string; childItemId: string; quantity: string; includedInPackage: boolean; note: string }>;

function toDraft(item: CatalogItemAdmin): readonly PackageDraftLine[] {
  return (item.packageItems ?? []).map((line) => ({
    key: line.id,
    childItemId: line.childItemId,
    quantity: String(line.quantity),
    includedInPackage: line.includedInPackage,
    note: line.note ?? "",
  }));
}

function itemOptionLabel(item: CatalogItemAdmin): string {
  const code = item.abfCode ?? item.internalCode;
  return `${code ? `${code} · ` : ""}${item.displayName} (${CATALOG_ITEM_TYPE_LABELS_CS[itemTypeOf(item)]}${item.lifecycleStatus === "archived" ? ", archivováno" : ""})`;
}

export function PackageContentsSection({
  item,
  allItems,
  onSavePackage,
}: {
  item: CatalogItemAdmin;
  allItems: readonly CatalogItemAdmin[];
  onSavePackage: (lines: readonly CatalogPackageItemInput[]) => Promise<void>;
}) {
  const [lines, setLines] = useState<readonly PackageDraftLine[]>(() => toDraft(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedHint, setSavedHint] = useState("");

  const byId = useMemo(() => new Map(allItems.map((candidate) => [candidate.id, candidate])), [allItems]);
  // New lines may only pick non-archived items; an existing line keeps showing its (possibly
  // archived) child — archival never silently breaks an existing package.
  const pickable = useMemo(
    () =>
      allItems
        .filter((candidate) => candidate.id !== item.id && candidate.lifecycleStatus !== "archived")
        .slice()
        .sort((a, b) => itemOptionLabel(a).localeCompare(itemOptionLabel(b), "cs", { numeric: true })),
    [allItems, item.id],
  );
  const dirty = JSON.stringify(lines.map(({ key: _key, ...rest }) => rest)) !== JSON.stringify(toDraft(item).map(({ key: _key, ...rest }) => rest));

  function update(key: string, patch: Partial<PackageDraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    setSavedHint("");
  }

  async function handleSave() {
    setBusy(true);
    setError("");
    try {
      const payload: CatalogPackageItemInput[] = lines
        .filter((line) => line.childItemId)
        .map((line) => ({
          childItemId: line.childItemId,
          quantity: Number(line.quantity.replace(",", ".")),
          includedInPackage: line.includedInPackage,
          ...(line.note.trim() ? { note: line.note.trim() } : {}),
        }));
      await onSavePackage(payload);
      setSavedHint("Obsah stánku uložen.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Uložení obsahu selhalo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="catalogDetailSection catalogPackageSection">
      <h3>Obsah stánku / balíčku</h3>
      <p className="fieldHint">
        Položky „v ceně balíčku“ generátor může fyzicky použít a započítat jejich množství, ale zákazníkovi se znovu nepřičítají — cena je v ceně stánku. Ostatní řádky jsou volitelné doplňky s vlastní cenou z ceníku.
      </p>
      {lines.length === 0 && <p className="workspaceEmpty">Balíček zatím neobsahuje žádné položky.</p>}
      {lines.map((line) => {
        const child = byId.get(line.childItemId);
        return (
          <div key={line.key} className="catalogPackageLine">
            <select value={line.childItemId} onChange={(event) => update(line.key, { childItemId: event.target.value })}>
              <option value="">— vyberte položku —</option>
              {child && child.lifecycleStatus === "archived" && <option value={child.id}>{itemOptionLabel(child)}</option>}
              {pickable.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{itemOptionLabel(candidate)}</option>
              ))}
            </select>
            <input aria-label="Množství" inputMode="decimal" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} />
            <label className="checkboxRow">
              <input type="checkbox" checked={line.includedInPackage} onChange={(event) => update(line.key, { includedInPackage: event.target.checked })} />
              V ceně balíčku
            </label>
            <input aria-label="Poznámka" placeholder="Poznámka" value={line.note} onChange={(event) => update(line.key, { note: event.target.value })} />
            <button type="button" className="dangerText" onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}>Odebrat</button>
          </div>
        );
      })}
      <div className="assetActions">
        <button
          type="button"
          className="secondaryButton"
          onClick={() => setLines((current) => [...current, { key: `new-${Date.now()}-${current.length}`, childItemId: "", quantity: "1", includedInPackage: true, note: "" }])}
        >
          + Přidat položku
        </button>
        <button type="button" className="primaryButton" onClick={() => void handleSave()} disabled={!dirty || busy}>
          {busy ? "Ukládám…" : "Uložit obsah"}
        </button>
      </div>
      {savedHint && <small className="fieldHint">{savedHint}</small>}
      {error && <small className="uploadError">{error}</small>}
    </section>
  );
}

// ============================================================================
// SERVICE TECHNICAL METADATA — power + free parameters (placement/marker/icon stay in the
// "Technické rastry" section, never duplicated here).
// ============================================================================

export function ServiceTechnicalSection({ item, onSave }: { item: CatalogItemAdmin; onSave: (edit: CatalogItemAdminEdit) => Promise<void> }) {
  const existing = documentServiceTechnical(item.document);
  const [powerKw, setPowerKw] = useState(existing?.powerKw !== undefined ? String(existing.powerKw) : "");
  const [parameters, setParameters] = useState<readonly { key: string; value: string }[]>(existing?.parameters ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function buildDraft() {
    const draft: { powerKw?: number; parameters?: { key: string; value: string }[] } = {};
    const parsedPower = Number(powerKw.replace(",", "."));
    if (powerKw.trim() && Number.isFinite(parsedPower) && parsedPower >= 0) draft.powerKw = parsedPower;
    const cleaned = parameters.map((entry) => ({ key: entry.key.trim(), value: entry.value.trim() })).filter((entry) => entry.key);
    if (cleaned.length > 0) draft.parameters = cleaned;
    return Object.keys(draft).length > 0 ? draft : null;
  }

  const dirty = JSON.stringify(buildDraft()) !== JSON.stringify(existing ?? null);

  async function handleSave() {
    setBusy(true);
    setError("");
    try {
      await onSave({ serviceTechnical: buildDraft() });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Uložení selhalo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="catalogDetailSection">
      <h3>Technická metadata služby</h3>
      <dl>
        <Field label="Výkon (kW)">
          <input inputMode="decimal" value={powerKw} onChange={(event) => setPowerKw(event.target.value)} placeholder="Nevyplněno" />
        </Field>
      </dl>
      {parameters.map((entry, index) => (
        <div key={index} className="catalogPackageLine">
          <input aria-label="Parametr" placeholder="Parametr (např. napětí)" value={entry.key} onChange={(event) => setParameters((current) => current.map((candidate, i) => (i === index ? { ...candidate, key: event.target.value } : candidate)))} />
          <input aria-label="Hodnota" placeholder="Hodnota (např. 230 V)" value={entry.value} onChange={(event) => setParameters((current) => current.map((candidate, i) => (i === index ? { ...candidate, value: event.target.value } : candidate)))} />
          <button type="button" className="dangerText" onClick={() => setParameters((current) => current.filter((_, i) => i !== index))}>Odebrat</button>
        </div>
      ))}
      <div className="assetActions">
        <button type="button" className="secondaryButton" onClick={() => setParameters((current) => [...current, { key: "", value: "" }])}>+ Parametr</button>
        <button type="button" className="primaryButton" onClick={() => void handleSave()} disabled={!dirty || busy}>{busy ? "Ukládám…" : "Uložit metadata"}</button>
      </div>
      <p className="fieldHint">Umístění v technickém rastru, značka a ikona se nastavují v sekci „Technické rastry“.</p>
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
